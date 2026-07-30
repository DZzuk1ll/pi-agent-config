import assert from "node:assert/strict";
import test from "node:test";
import { buildAskUserResultMessage, hasDistinctOptionLabels } from "../extensions/ask-user/prompt.ts";

test("ask_user requires non-empty, case-insensitively unique labels", () => {
	assert.equal(hasDistinctOptionLabels(["Proceed", "Cancel"]), true);
	assert.equal(hasDistinctOptionLabels(["Proceed", " proceed "]), false);
	assert.equal(hasDistinctOptionLabels(["Proceed", "   "]), false);
	assert.equal(hasDistinctOptionLabels(["Write my own answer…", "Cancel"]), false);
	assert.equal(hasDistinctOptionLabels(["Proceed\u001b]0;hidden\u0007", "Proceed"]), false);
});

test("ask_user result messages preserve each user outcome", () => {
	assert.match(buildAskUserResultMessage({ kind: "no-ui" }), /plain text/);
	assert.match(buildAskUserResultMessage({ kind: "cancelled" }), /cancelled/i);
	assert.match(buildAskUserResultMessage({ kind: "dismissed" }), /dismissed/i);
	assert.equal(
		buildAskUserResultMessage({ kind: "custom", answer: "Ship next week" }),
		"User wrote their own answer: Ship next week",
	);
	assert.equal(
		buildAskUserResultMessage({ kind: "selected", answer: "Proceed", index: 2 }),
		"User selected option 2: Proceed",
	);
});
