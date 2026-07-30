import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { backgroundEnvironment } from "../extensions/background-terminals/environment.ts";
import { BackgroundTerminalManager, MAX_RUNNING_TERMINALS, SPILL_BYTES_PER_STREAM, resolveProjectCwd } from "../extensions/background-terminals/manager.ts";
import type { TerminalSnapshot } from "../extensions/background-terminals/types.ts";

function project(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-test-"));
}

function nodeCommand(source: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function waitForTerminal(manager: BackgroundTerminalManager, id: string, timeoutMs = 5_000): Promise<TerminalSnapshot> {
	const existing = manager.get(id);
	if (existing && existing.state !== "running" && existing.state !== "starting") return Promise.resolve(existing);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for ${id}`));
		}, timeoutMs);
		const unsubscribe = manager.subscribe(() => {
			const snapshot = manager.get(id);
			if (!snapshot || snapshot.state === "running" || snapshot.state === "starting") return;
			clearTimeout(timer);
			unsubscribe();
			resolve(snapshot);
		});
	});
}

function waitForStdout(manager: BackgroundTerminalManager, id: string, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const inspect = () => {
			const text = manager.get(id)?.stdout.text ?? "";
			if (!pattern.test(text)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(text);
		};
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error(`Timed out waiting for stdout from ${id}`));
		}, timeoutMs);
		const unsubscribe = manager.subscribe(inspect);
		inspect();
	});
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("cwd resolution accepts descendants and rejects traversal and symlink escape", () => {
	const root = project();
	const outside = project();
	try {
		const child = path.join(root, "child");
		fs.mkdirSync(child);
		fs.symlinkSync(outside, path.join(root, "escape"));
		assert.equal(resolveProjectCwd(root), fs.realpathSync(root));
		assert.equal(resolveProjectCwd(root, "child"), fs.realpathSync(child));
		assert.throws(() => resolveProjectCwd(root, "../"), /inside the current project/);
		assert.throws(() => resolveProjectCwd(root, outside), /inside the current project/);
		assert.throws(() => resolveProjectCwd(root, "escape"), /inside the current project/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("manager startup scavenges private spill sessions owned by dead processes", async () => {
	const base = path.join(os.tmpdir(), "pi-background-terminals");
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const stale = fs.mkdtempSync(path.join(base, "session-stale-test-"));
	fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify({ pid: 2_147_000_000 }), { mode: 0o600 });
	fs.writeFileSync(path.join(stale, "output.log"), "private", { mode: 0o600 });
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		assert.equal(fs.existsSync(stale), false);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(stale, { recursive: true, force: true });
	}
});

test("stale scavenging rejects a reused live PID with a different process identity", { skip: process.platform === "win32" }, async () => {
	const base = path.join(os.tmpdir(), "pi-background-terminals");
	fs.mkdirSync(base, { recursive: true, mode: 0o700 });
	const stale = fs.mkdtempSync(path.join(base, "session-reused-pid-test-"));
	fs.writeFileSync(path.join(stale, "owner.json"), JSON.stringify({
		pid: process.pid,
		createdAt: Date.now(),
		heartbeatAt: Date.now(),
		processIdentity: "definitely-not-the-current-process",
	}), { mode: 0o600 });
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		assert.equal(fs.existsSync(stale), false);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(stale, { recursive: true, force: true });
	}
});

test("background environment excludes credentials and retains shell essentials", () => {
	const env = backgroundEnvironment({ PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8", LC_ALL: "C", API_TOKEN: "secret", COOKIE: "secret" });
	assert.deepEqual(env, { PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8", LC_ALL: "C" });
});

test("natural completion captures stdout and stderr separately", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		const started = await manager.start({ command: nodeCommand("console.log('out'); console.error('err')"), title: "capture" });
		const done = await waitForTerminal(manager, started.id);
		assert.equal(done.state, "done");
		assert.equal(done.exitCode, 0);
		assert.match(done.stdout.text, /out/);
		assert.match(done.stderr.text, /err/);
		assert.ok(done.stdout.spillPath && fs.existsSync(done.stdout.spillPath));
		assert.equal(fs.statSync(done.stdout.spillPath!).mode & 0o777, 0o600);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("non-zero exit becomes failed exactly once", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	const settled: TerminalSnapshot[] = [];
	manager.setOnSettled((snapshot) => settled.push(snapshot));
	try {
		const started = await manager.start({ command: nodeCommand("process.exit(7)") });
		const done = await waitForTerminal(manager, started.id);
		assert.equal(done.state, "failed");
		assert.equal(done.exitCode, 7);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(settled.filter((item) => item.id === started.id).length, 1);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("kill consumes the terminal settlement and removes the process", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	const consumed: boolean[] = [];
	manager.setOnSettled((_snapshot, wasConsumed) => consumed.push(wasConsumed));
	try {
		const started = await manager.start({ command: nodeCommand("setInterval(() => {}, 1000)"), title: "long" });
		const [done] = await manager.kill([started.id], true);
		assert.equal(done.state, "killed");
		assert.deepEqual(consumed, [true]);
		if (started.pid && process.platform !== "win32") assert.throws(() => process.kill(started.pid!, 0));
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("POSIX kill terminates descendants in the shell process group", { skip: process.platform === "win32" }, async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	let childPid: number | undefined;
	try {
		const child = nodeCommand("setInterval(() => {}, 1000)");
		const started = await manager.start({ command: `${child} & echo $!; wait`, title: "tree" });
		const output = await waitForStdout(manager, started.id, /\d+/);
		childPid = Number(output.match(/\d+/)?.[0]);
		assert.ok(Number.isSafeInteger(childPid) && childPid! > 1);
		assert.equal(processExists(childPid!), true);
		const [done] = await manager.kill([started.id]);
		assert.equal(done.state, "killed");
		for (let attempt = 0; attempt < 20 && processExists(childPid!); attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(processExists(childPid!), false);
	} finally {
		if (childPid && processExists(childPid)) {
			try { process.kill(childPid, "SIGKILL"); } catch {}
		}
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("natural shell exit cleans a background descendant with redirected stdio", { skip: process.platform === "win32" }, async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	let childPid: number | undefined;
	try {
		const child = nodeCommand("setInterval(() => {}, 1000)");
		const started = await manager.start({ command: `${child} >/dev/null 2>&1 & echo $!`, title: "detached-output" });
		const done = await waitForTerminal(manager, started.id, 8_000);
		childPid = Number(done.stdout.text.match(/\d+/)?.[0]);
		assert.ok(Number.isSafeInteger(childPid) && childPid! > 1);
		assert.equal(done.state, "done");
		assert.equal(processExists(childPid!), false);
	} finally {
		if (childPid && processExists(childPid)) {
			try { process.kill(childPid, "SIGKILL"); } catch {}
		}
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("shell supervision cleans a background job that creates its own session", {
	skip: process.platform === "win32" || spawnSync("python3", ["-c", "import os; assert hasattr(os, 'setsid')"], { stdio: "ignore" }).status !== 0,
}, async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	let childPid: number | undefined;
	try {
		const pidFile = path.join(root, "detached.pid");
		const quotedPidFile = JSON.stringify(pidFile);
		const command = `python3 -c 'import os,time; os.setsid(); print(os.getpid(), flush=True); time.sleep(60)' > ${quotedPidFile} & while [ ! -s ${quotedPidFile} ]; do /bin/sleep 0.01; done; cat ${quotedPidFile}`;
		const started = await manager.start({ command, title: "detached-session" });
		const done = await waitForTerminal(manager, started.id, 8_000);
		childPid = Number(done.stdout.text.match(/\d+/)?.[0]);
		assert.ok(Number.isSafeInteger(childPid) && childPid! > 1);
		assert.equal(done.state, "done");
		assert.equal(processExists(childPid!), false);
	} finally {
		if (childPid && processExists(childPid)) {
			try { process.kill(childPid, "SIGKILL"); } catch {}
		}
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("settled record eviction deletes private spill files", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		let firstSpill: string | undefined;
		for (let index = 0; index < 51; index++) {
			const started = await manager.start({ command: `printf '${index}\\n'`, title: `short-${index}` });
			const done = await waitForTerminal(manager, started.id);
			if (index === 0) firstSpill = done.stdout.spillPath;
		}
		assert.ok(firstSpill);
		assert.equal(manager.get("bt-1"), undefined);
		assert.equal(fs.existsSync(firstSpill!), false);
		assert.equal(manager.list(true).length, 50);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent reservations cannot exceed the terminal cap", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		await Promise.all(Array.from({ length: MAX_RUNNING_TERMINALS }, (_, index) => manager.start({
			command: nodeCommand("setInterval(() => {}, 1000)"),
			title: `long-${index}`,
		})));
		await assert.rejects(manager.start({ command: "echo overflow" }), /At most/);
		assert.equal(manager.list(false).length, MAX_RUNNING_TERMINALS);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("spill capture caps at 32 MiB while continuing to drain stdout", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		const started = await manager.start({ command: nodeCommand(`process.stdout.write(Buffer.alloc(${SPILL_BYTES_PER_STREAM + 1024 * 1024}, 120))`) });
		const done = await waitForTerminal(manager, started.id, 15_000);
		assert.equal(done.state, "done");
		assert.equal(done.stdout.spillCapped, true);
		assert.equal(done.stdout.spillBytes, SPILL_BYTES_PER_STREAM);
		assert.ok(done.stdout.spillPath);
		assert.equal(fs.statSync(done.stdout.spillPath!).size, SPILL_BYTES_PER_STREAM);
		assert.ok(done.stdout.omittedBytes > 0);
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("dispose aborts active processes and removes private spill files", async () => {
	const root = project();
	const manager = new BackgroundTerminalManager(root);
	try {
		const started = await manager.start({ command: nodeCommand("console.log('ready'); setInterval(() => {}, 1000)") });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const spill = manager.get(started.id)?.stdout.spillPath;
		assert.ok(spill && fs.existsSync(spill));
		await manager.dispose();
		assert.equal(fs.existsSync(spill!), false);
		if (started.pid && process.platform !== "win32") assert.throws(() => process.kill(started.pid!, 0));
	} finally {
		await manager.dispose();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
