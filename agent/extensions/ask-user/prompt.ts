import { sanitizeForDisplay } from "../_shared/runtime/text.ts";

export const ASK_USER_TOOL_DESCRIPTION =
	"Ask the user one multiple-choice question with 2-5 options. A free-form answer option is appended automatically, and the user may dismiss the question.";

export const ASK_USER_PROMPT_SNIPPET =
	"Ask one multiple-choice question with 2-5 options plus a free-form answer";

export const ASK_USER_FREE_FORM_LABEL = "Write my own answer…";

export const ASK_USER_PROMPT_GUIDELINES = [
	"Use ask_user instead of plain text when the user's likely answers can be enumerated and the answer materially changes behavior, scope, or risk.",
	"Ask exactly one question per ask_user call, provide 2-5 concise and mutually distinct options, and ask follow-up questions in later calls.",
	"Do not call ask_user for facts that can be discovered directly from files, code, commands, or documentation.",
];

function normalizedOptionLabel(label: string): string {
	return sanitizeForDisplay(label).replace(/[\r\n\t]+/g, " ").trim().toLocaleLowerCase();
}

export function hasDistinctOptionLabels(labels: readonly string[]): boolean {
	const normalized = [...labels, ASK_USER_FREE_FORM_LABEL].map(normalizedOptionLabel);
	return normalized.every((label) => label.length > 0) && new Set(normalized).size === normalized.length;
}

export function buildAskUserResultMessage(
	outcome:
		| { kind: "no-ui" }
		| { kind: "cancelled" }
		| { kind: "dismissed" }
		| { kind: "custom"; answer: string }
		| { kind: "selected"; answer: string; index: number },
): string {
	switch (outcome.kind) {
		case "no-ui":
			return "No interactive UI is available. Ask the user in plain text instead.";
		case "cancelled":
			return "The question was cancelled before the user answered. Do not assume an answer.";
		case "dismissed":
			return "The user dismissed the question without answering. Do not assume an answer; proceed safely or ask differently.";
		case "custom":
			return `User wrote their own answer: ${outcome.answer}`;
		case "selected":
			return `User selected option ${outcome.index}: ${outcome.answer}`;
	}
}
