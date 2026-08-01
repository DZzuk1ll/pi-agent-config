import assert from "node:assert/strict";
import test from "node:test";

import {
	formatCompactUserMessageLines,
	OSC133_ZONE_RE,
} from "../extensions/_shared/runtime/compact-transcript-format.ts";

const OSC_START = "\x1b]133;A\x07";
const OSC_END = "\x1b]133;B\x07";
const OSC_FINAL = "\x1b]133;C\x07";

test("user-message formatting removes the previous wrapper's trailing spacer", () => {
	const rendered = formatCompactUserMessageLines([
		`${OSC_START}❯ 测试${OSC_END}${OSC_FINAL}`,
		"",
	]);

	assert.deepEqual(rendered, ["› 测试"]);
	assert.notEqual(rendered.at(-1), "");
});

test("user-message formatting replaces only the first prompt glyph", () => {
	assert.deepEqual(
		formatCompactUserMessageLines(["❯ first", "❯ quoted"]),
		["› first", "❯ quoted"],
	);
});

test("OSC 133 marker expression remains global for all transcript lines", () => {
	const line = `${OSC_START}a${OSC_END}${OSC_FINAL}`;
	assert.equal(line.replace(OSC133_ZONE_RE, ""), "a");
});
