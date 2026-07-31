import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": piPackage,
		"@earendil-works/pi-agent-core": join(piPackage, "node_modules/@earendil-works/pi-agent-core"),
		"@earendil-works/pi-ai": join(piPackage, "node_modules/@earendil-works/pi-ai"),
		"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});

const claudify = await jiti.import<{
	formatVisualLineOmissionHint: (count: number) => string;
	layoutVisualLinePreview: (
		logicalLines: readonly string[],
		width: number,
		maxVisualLines: number,
	) => { visibleLines: string[]; omittedVisualLines: number };
	renderBashPreviewRows: (
		statusText: string,
		outputLines: readonly string[],
		width: number,
		maxVisualLines: number,
		styleHint?: (text: string) => string,
	) => { visibleLines: string[]; omittedVisualLines: number };
}>("../extensions/community/@owlburtoe/pi-claudify/extensions/index.ts");
const tui = await jiti.import<{
	visibleWidth: (text: string) => number;
}>("@earendil-works/pi-tui");

const { formatVisualLineOmissionHint, layoutVisualLinePreview, renderBashPreviewRows } = claudify;

test("collapsed Bash preview caps repr-like long logical lines by visual rows", () => {
	const lengths = [2258, 1341, 1634];
	const logicalLines = lengths.map((length, index) => `${index}: ${"x".repeat(length)}`);
	const preview = layoutVisualLinePreview(logicalLines, 200, 3);

	assert.equal(preview.visibleLines.length, 3);
	assert.ok(preview.omittedVisualLines > 20);
	assert.ok(preview.visibleLines.every((line) => tui.visibleWidth(line) <= 200));
});

test("Bash preview rows keep the status and hint outside the output row budget", () => {
	const preview = renderBashPreviewRows("Done (6 lines)", ["x".repeat(500), "tail"], 100, 3);
	const plainText = preview.visibleLines.join("\n").replaceAll(/\x1b\[[0-9;]*m/g, "");

	assert.equal(preview.visibleLines.length, 5);
	assert.match(plainText, /Done \(6 lines\)/);
	assert.match(plainText, /visual lines \(ctrl\+o to expand\)/);
	assert.ok(preview.visibleLines.every((line) => tui.visibleWidth(line) <= 100));
});

test("short Bash output is not truncated", () => {
	const preview = layoutVisualLinePreview(["alpha", "beta"], 80, 3);

	assert.deepEqual(preview.visibleLines, ["alpha", "beta"]);
	assert.equal(preview.omittedVisualLines, 0);
});

test("one long logical line can consume the whole visual row budget", () => {
	const preview = layoutVisualLinePreview(["x".repeat(35)], 10, 2);

	assert.equal(preview.visibleLines.length, 2);
	assert.equal(preview.omittedVisualLines, 2);
	assert.equal(preview.visibleLines.map((line) => line.replaceAll(/\x1b\[[0-9;]*m/g, "")).join(""), "x".repeat(20));
});

test("ANSI styling and wide characters remain within the requested width with branch chrome", () => {
	const coloredWideText = `\x1b[31m${"中文🙂".repeat(8)}\x1b[0m`;
	const preview = renderBashPreviewRows("Done", [coloredWideText], 10, 20);

	assert.ok(preview.visibleLines.length > 2);
	assert.equal(preview.omittedVisualLines, 0);
	assert.ok(preview.visibleLines.every((line) => tui.visibleWidth(line) <= 10));
	assert.ok(preview.visibleLines.some((line) => line.includes("\x1b[31m")));
});

test("branch chrome is clamped when the terminal is narrower than its prefix", () => {
	for (let width = 1; width <= 5; width++) {
		const preview = renderBashPreviewRows("Done", ["output"], width, 1);
		assert.ok(preview.visibleLines.every((line) => tui.visibleWidth(line) <= width), `width ${width}`);
	}
});

test("terminal resize recalculates the number of omitted visual rows", () => {
	const output = ["x".repeat(1200)];
	const wide = layoutVisualLinePreview(output, 200, 3);
	const narrow = layoutVisualLinePreview(output, 80, 3);

	assert.equal(wide.visibleLines.length, 3);
	assert.equal(narrow.visibleLines.length, 3);
	assert.ok(narrow.omittedVisualLines > wide.omittedVisualLines);
});

test("zero visual rows keeps all Bash output behind the expansion hint", () => {
	const layout = layoutVisualLinePreview(["alpha", "beta"], 80, 0);
	const preview = renderBashPreviewRows("Done (2 lines)", ["alpha", "beta"], 80, 0);
	const plainText = preview.visibleLines.join("\n").replaceAll(/\x1b\[[0-9;]*m/g, "");

	assert.deepEqual(layout.visibleLines, []);
	assert.equal(layout.omittedVisualLines, 2);
	assert.equal(preview.visibleLines.length, 2);
	assert.match(plainText, /Done \(2 lines\)/);
	assert.match(plainText, /\+2 visual lines \(ctrl\+o to expand\)/);
	assert.doesNotMatch(plainText, /alpha|beta/);
});

test("visual row boundary only reports output beyond the limit", () => {
	const exact = layoutVisualLinePreview(["1234567890", "abcdefghij"], 10, 2);
	const overflow = layoutVisualLinePreview(["1234567890", "abcdefghij", "extra"], 10, 2);

	assert.equal(exact.omittedVisualLines, 0);
	assert.equal(overflow.omittedVisualLines, 1);
});

test("visual row omission hint uses singular and plural wording", () => {
	assert.equal(formatVisualLineOmissionHint(1), "… +1 visual line (ctrl+o to expand)");
	assert.equal(formatVisualLineOmissionHint(2), "… +2 visual lines (ctrl+o to expand)");
});
