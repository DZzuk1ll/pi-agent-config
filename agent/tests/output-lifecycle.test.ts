import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ensurePrivateDir, prunePrivateRunDirs, safeStringify, writeFileAtomic } from "../extensions/shared/artifacts.ts";
import { DeferredResultDelivery, Semaphore } from "../extensions/shared/lifecycle.ts";
import { boundToolText, sanitizeForDisplay, truncateUtf8, utf8ByteLength, Utf8TailBuffer } from "../extensions/shared/text.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-output-test-"));
}

test("UTF-8 truncation never splits a surrogate pair or exceeds the byte budget", () => {
	const value = "前缀🙂🙂🙂tail";
	for (let bytes = 1; bytes < utf8ByteLength(value); bytes++) {
		const result = truncateUtf8(value, bytes);
		assert.ok(utf8ByteLength(result) <= bytes);
		const first = result.charCodeAt(0);
		const last = result.charCodeAt(result.length - 1);
		assert.ok(!(first >= 0xdc00 && first <= 0xdfff));
		assert.ok(!(last >= 0xd800 && last <= 0xdbff));
		assert.doesNotMatch(result, /�/);
	}
});

test("tool output applies line and byte bounds with a visible marker", () => {
	const value = Array.from({ length: 3_000 }, (_, index) => `${index} ${"x".repeat(40)}`).join("\n");
	const result = boundToolText(value, { fullOutputPath: "/private/full.log" });
	assert.equal(result.truncated, true);
	assert.ok(utf8ByteLength(result.text) <= 50 * 1024);
	assert.ok(result.text.split("\n").length <= 2_000);
	assert.match(result.text, /output truncated/);
	assert.match(result.text, /\/private\/full\.log/);
});

test("line-only truncation never duplicates the bounded source", () => {
	const value = Array.from({ length: 3_000 }, () => "x").join("\n");
	const result = boundToolText(value, { maxBytes: 1024 * 1024, maxLines: 2_000 });
	assert.equal(result.truncated, true);
	assert.ok(result.text.split("\n").length <= 2_000);
});

test("display sanitization removes ANSI and OSC while retaining newlines and tabs", () => {
	const dirty = "\x1b[31mred\x1b[0m\n\x1b]0;owned\x07ok\t\u0001";
	const clean = sanitizeForDisplay(dirty);
	assert.equal(clean, "red\nok\t�");
});

test("UTF-8 tail buffer remains bounded and reports omitted bytes", () => {
	const buffer = new Utf8TailBuffer(16);
	buffer.push(Buffer.from("alpha🙂beta🙂gamma"));
	buffer.finish();
	const view = buffer.view();
	assert.ok(utf8ByteLength(view.text) <= 16);
	assert.ok(view.omittedBytes > 0);
	assert.doesNotMatch(view.text, /�/);
});

test("deferred delivery is exactly-once and consume wins", () => {
	const delivery = new DeferredResultDelivery<{ id: string; value: number }>();
	delivery.queue({ id: "a", value: 1 });
	delivery.queue({ id: "a", value: 2 });
	delivery.queue({ id: "b", value: 3 });
	delivery.consume(["a"]);
	assert.deepEqual(delivery.drain(), [{ id: "b", value: 3 }]);
	assert.deepEqual(delivery.drain(), []);
});

test("semaphore transfers slots without exceeding its limit", async () => {
	const semaphore = new Semaphore(2);
	let active = 0;
	let maximum = 0;
	await Promise.all(Array.from({ length: 20 }, async () => {
		const release = await semaphore.acquire();
		active++;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 2));
		active--;
		release();
	}));
	assert.equal(maximum, 2);
});

test("atomic artifacts are private and replace old contents", () => {
	const directory = tempDir();
	try {
		ensurePrivateDir(directory);
		const file = path.join(directory, "artifact.json");
		writeFileAtomic(file, "one");
		writeFileAtomic(file, "two");
		assert.equal(fs.readFileSync(file, "utf8"), "two");
		assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")).length, 0);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("serialization handles cycles and applies byte bounds", () => {
	const value: Record<string, unknown> = { secret: "x" };
	value.self = value;
	assert.match(safeStringify(value), /\[circular\]/);
	assert.throws(() => safeStringify({ value: "x".repeat(1_000) }, { maxBytes: 100, maxStringBytes: 1_000 }), /exceeds/);
});

test("run directory pruning enforces both age and count", () => {
	const root = tempDir();
	try {
		for (const [name, age] of [["new", 10], ["second", 20], ["old", 10_000]] as const) {
			const directory = path.join(root, name);
			fs.mkdirSync(directory);
			fs.utimesSync(directory, new Date(20_000 - age), new Date(20_000 - age));
		}
		const removed = prunePrivateRunDirs(root, { maxAgeMs: 5_000, maxEntries: 1, now: 20_000 });
		assert.equal(removed.length, 2);
		assert.deepEqual(fs.readdirSync(root), ["new"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
