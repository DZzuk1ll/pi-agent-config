import { spawn, type ChildProcess } from "node:child_process";

interface PostExitStdioGuardOptions {
	idleMs: number;
	hardMs: number;
}

interface ChildWithPipedStdio {
	stdout: ChildProcess["stdout"];
	stderr: ChildProcess["stderr"];
	on: ChildProcess["on"];
}

interface ChildWithKill {
	pid?: number;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export function trySignalChild(child: ChildWithKill, signal: NodeJS.Signals): boolean {
	try {
		return child.kill(signal);
	} catch {
		return false;
	}
}

export function isChildProcessTreeAlive(
	child: ChildWithKill,
	options: { processGroup?: boolean } = {},
): boolean {
	if (process.platform !== "win32" && options.processGroup && child.pid) {
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}
	try {
		return child.kill(0);
	} catch {
		return false;
	}
}

export interface EscalatingTermination {
	terminate(): void;
	dispose(): void;
}

export function createEscalatingTermination(options: {
	signal: (signal: NodeJS.Signals) => boolean;
	isInactive: () => boolean;
	hardKillMs: number;
}): EscalatingTermination {
	let disposed = false;
	let hardKillTimer: NodeJS.Timeout | undefined;

	return {
		terminate() {
			if (disposed || hardKillTimer || options.isInactive()) return;
			options.signal("SIGTERM");
			hardKillTimer = setTimeout(() => {
				hardKillTimer = undefined;
				if (!disposed && !options.isInactive()) options.signal("SIGKILL");
			}, options.hardKillMs);
			hardKillTimer.unref?.();
		},
		dispose() {
			disposed = true;
			if (!hardKillTimer) return;
			clearTimeout(hardKillTimer);
			hardKillTimer = undefined;
		},
	};
}

export function trySignalChildTree(
	child: ChildWithKill,
	signal: NodeJS.Signals,
	options: { processGroup?: boolean } = {},
): boolean {
	if (process.platform !== "win32" && options.processGroup && child.pid) {
		try {
			process.kill(-child.pid, signal);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
			return trySignalChild(child, signal);
		}
	}

	if (process.platform === "win32" && signal !== "SIGINT" && child.pid) {
		try {
			const killer = spawn("taskkill.exe", [
				"/pid",
				String(child.pid),
				"/t",
				...(signal === "SIGKILL" ? ["/f"] : []),
			], {
				stdio: "ignore",
				windowsHide: true,
			});
			let fellBack = false;
			const fallback = () => {
				if (fellBack) return;
				fellBack = true;
				trySignalChild(child, signal);
			};
			killer.once("error", fallback);
			killer.once("exit", (code) => {
				if (code !== 0) fallback();
			});
			killer.unref();
			return true;
		} catch {
			return trySignalChild(child, signal);
		}
	}

	return trySignalChild(child, signal);
}

export function attachPostExitStdioGuard(
	child: ChildWithPipedStdio,
	options: PostExitStdioGuardOptions,
): () => void {
	const { idleMs, hardMs } = options;
	let exited = false;
	let stdoutEnded = false;
	let stderrEnded = false;
	let idleTimer: NodeJS.Timeout | undefined;
	let hardTimer: NodeJS.Timeout | undefined;

	const destroyUnendedStdio = () => {
		if (!stdoutEnded) {
			try { child.stdout?.destroy(); } catch {}
		}
		if (!stderrEnded) {
			try { child.stderr?.destroy(); } catch {}
		}
	};

	const clearTimers = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
		if (hardTimer) {
			clearTimeout(hardTimer);
			hardTimer = undefined;
		}
	};

	const armIdleTimer = () => {
		if (!exited) return;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(destroyUnendedStdio, idleMs);
		idleTimer.unref?.();
	};

	child.stdout?.on("data", armIdleTimer);
	child.stderr?.on("data", armIdleTimer);
	child.stdout?.on("end", () => {
		stdoutEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.stderr?.on("end", () => {
		stderrEnded = true;
		if (stdoutEnded && stderrEnded) clearTimers();
	});
	child.on("exit", () => {
		exited = true;
		armIdleTimer();
		if (hardTimer) return;
		hardTimer = setTimeout(destroyUnendedStdio, hardMs);
		hardTimer.unref?.();
	});
	child.on("close", clearTimers);
	child.on("error", clearTimers);

	return clearTimers;
}
