import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { detectSubagentError } from "../extensions/subagents/src/shared/utils.ts";

function toolResult(toolName: string, isError: boolean, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: `${toolName}-call`,
		toolName,
		isError,
		content: [{ type: "text", text }],
	} as Message;
}

test("successful structured output resolves earlier recoverable tool errors", () => {
	const result = detectSubagentError([
		toolResult("bash", true, "Command exited with code 1"),
		toolResult("structured_output", false, "Structured output captured."),
	]);

	assert.deepEqual(result, { hasError: false });
});

test("failed structured output remains a terminal error", () => {
	const result = detectSubagentError([
		toolResult("bash", true, "Command exited with code 1"),
		toolResult("structured_output", true, "Structured output validation failed"),
	]);

	assert.equal(result.hasError, true);
	assert.equal(result.errorType, "structured_output");
});

test("ordinary successful tools do not hide an unresolved tool error", () => {
	const result = detectSubagentError([
		toolResult("bash", true, "Command exited with code 1"),
		toolResult("read", false, "file contents"),
	]);

	assert.equal(result.hasError, true);
	assert.equal(result.errorType, "bash");
});
