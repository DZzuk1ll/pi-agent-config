import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	ASK_USER_FREE_FORM_LABEL,
	ASK_USER_PROMPT_GUIDELINES,
	ASK_USER_PROMPT_SNIPPET,
	ASK_USER_TOOL_DESCRIPTION,
	buildAskUserResultMessage,
	hasDistinctOptionLabels,
} from "./prompt.ts";
import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { requirePresent } from "../_shared/runtime/require-present.ts";


const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 120, description: "Short display label for this option." }),
	description: Type.Optional(Type.String({ maxLength: 240, description: "Optional concise explanation shown below the label." })),
});

const AskUserParams = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 1_000, description: "The single question to ask the user." }),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description: "Two to five choices. Do not add an 'other' choice; a free-form option is appended automatically.",
	}),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
	selectedIndex?: number;
	outcome: "selected" | "custom" | "dismissed" | "cancelled" | "no-ui";
}

interface DisplayOption {
	label: string;
	description?: string;
	isOther?: boolean;
}

type SelectionResult = {
	answer: string;
	wasCustom: boolean;
	index?: number;
} | null;

function safeDisplay(value: unknown, singleLine = false): string {
	const sanitized = sanitizeForDisplay(String(value ?? ""));
	return singleLine ? sanitized.replace(/[\r\n\t]+/g, " ") : sanitized;
}

export default function askUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: ASK_USER_TOOL_DESCRIPTION,
		promptSnippet: ASK_USER_PROMPT_SNIPPET,
		promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params: AskUserInput, signal, _onUpdate, ctx) {
			const labels = params.options.map((option) => option.label);
			const reply = (
				text: string,
				outcome: AskUserDetails["outcome"],
				answer: string | null = null,
				wasCustom = false,
				selectedIndex?: number,
			) => ({
				content: [{ type: "text" as const, text }],
				details: {
					question: params.question,
					options: labels,
					answer,
					wasCustom,
					...(selectedIndex === undefined ? {} : { selectedIndex }),
					outcome,
				} satisfies AskUserDetails,
			});

			if (ctx.mode !== "tui") {
				return reply(buildAskUserResultMessage({ kind: "no-ui" }), "no-ui");
			}
			if (signal?.aborted) {
				return reply(buildAskUserResultMessage({ kind: "cancelled" }), "cancelled");
			}
			if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
				throw new Error(`ask_user requires ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
			}
			if (!hasDistinctOptionLabels(labels)) {
				throw new Error("ask_user option labels must be non-empty and unique (case-insensitive).");
			}

			const allOptions: DisplayOption[] = [
				...params.options,
				{ label: ASK_USER_FREE_FORM_LABEL, isOther: true },
			];
			let toolCancelled = false;

			const result = await ctx.ui.custom<SelectionResult>((tui, theme, _keybindings, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;
				let settled = false;

				const editorTheme: EditorTheme = {
					borderColor: (text: string) => theme.fg("borderAccent", text),
					selectList: {
						selectedPrefix: (text: string) => theme.fg("accent", text),
						selectedText: (text: string) => theme.fg("accent", text),
						description: (text: string) => theme.fg("muted", text),
						scrollInfo: (text: string) => theme.fg("dim", text),
						noMatch: (text: string) => theme.fg("warning", text),
					},
				};
				const editor = new Editor(tui, editorTheme);

				const finish = (value: SelectionResult) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", cancel);
					done(value);
				};
				const cancel = () => {
					toolCancelled = true;
					finish(null);
				};
				signal?.addEventListener("abort", cancel, { once: true });
				if (signal?.aborted) queueMicrotask(cancel);

				const refresh = () => {
					cachedLines = undefined;
					tui.requestRender();
				};

				editor.onSubmit = (value) => {
					const answer = value.trim();
					if (answer) {
						finish({ answer, wasCustom: true });
						return;
					}
					editMode = false;
					editor.setText("");
					refresh();
				};

				const select = (index: number) => {
					const selected = allOptions[index];
					if (!selected) return;
					if (selected.isOther) {
						optionIndex = index;
						editMode = true;
						refresh();
						return;
					}
					finish({ answer: selected.label, wasCustom: false, index: index + 1 });
				};

				const handleInput = (data: string) => {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						const entered = editor.getText();
						const sanitized = safeDisplay(entered);
						if (sanitized !== entered) editor.setText(sanitized);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = (optionIndex - 1 + allOptions.length) % allOptions.length;
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = (optionIndex + 1) % allOptions.length;
						refresh();
						return;
					}
					if (data.length === 1 && data >= "1" && data <= String(allOptions.length)) {
						select(Number(data) - 1);
						return;
					}
					if (matchesKey(data, Key.enter)) {
						select(optionIndex);
						return;
					}
					if (matchesKey(data, Key.escape)) finish(null);
				};

				const addWrapped = (lines: string[], prefix: string, text: string, width: number) => {
					const prefixWidth = visibleWidth(prefix);
					const available = Math.max(1, width - prefixWidth);
					const wrapped = wrapTextWithAnsi(text, available);
					for (let index = 0; index < wrapped.length; index += 1) {
						lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${wrapped[index]}`);
					}
				};

				const render = (rawWidth: number): string[] => {
					if (cachedLines) return cachedLines;
					const width = Math.max(24, rawWidth);
					const lines: string[] = [];
					const title = " Ask user ";
					lines.push(theme.fg("borderAccent", `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`));
					addWrapped(lines, " ", theme.fg("text", theme.bold(safeDisplay(params.question))), width);
					lines.push("");

					for (let index = 0; index < allOptions.length; index += 1) {
						const option = requirePresent(allOptions[index]);
						const selected = index === optionIndex;
						const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
						const marker = option.isOther ? "✎" : `${index + 1}.`;
						const color = selected ? "accent" : option.isOther ? "muted" : "text";
						addWrapped(lines, prefix, theme.fg(color, `${marker} ${safeDisplay(option.label, true)}`), width);
						if (option.description) {
							addWrapped(lines, "      ", theme.fg("muted", safeDisplay(option.description, true)), width);
						}
					}

					if (editMode) {
						lines.push("");
						lines.push(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(Math.max(1, width - 2))) lines.push(` ${line}`);
					}

					lines.push("");
					lines.push(theme.fg("dim", editMode
						? " Enter submit • Esc back to options"
						: ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`));
					lines.push(theme.fg("borderAccent", "─".repeat(width)));
					cachedLines = lines;
					return lines;
				};

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
					dispose: () => signal?.removeEventListener("abort", cancel),
				};
			});

			if (toolCancelled) {
				return reply(buildAskUserResultMessage({ kind: "cancelled" }), "cancelled");
			}
			if (!result) {
				return reply(buildAskUserResultMessage({ kind: "dismissed" }), "dismissed");
			}
			if (result.wasCustom) {
				return reply(
					buildAskUserResultMessage({ kind: "custom", answer: result.answer }),
					"custom",
					result.answer,
					true,
				);
			}
			const selectedIndex = result.index ?? 1;
			return reply(
				buildAskUserResultMessage({ kind: "selected", answer: result.answer, index: selectedIndex }),
				"selected",
				result.answer,
				false,
				selectedIndex,
			);
		},

		renderCall(args, theme) {
			let text = `${theme.fg("toolTitle", theme.bold("ask_user "))}${theme.fg("muted", safeDisplay(args.question, true))}`;
			if (Array.isArray(args.options)) {
				const numbered = args.options.map((option, index) => `${index + 1}. ${safeDisplay(option.label, true)}`);
				text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.answer === null) {
				const label = details.outcome === "cancelled" ? "cancelled" : "dismissed";
				return new Text(theme.fg("warning", `✗ ${label}`), 0, 0);
			}
			if (details.wasCustom) {
				return new Text(`${theme.fg("success", "✓ ")}${theme.fg("muted", "(wrote) ")}${theme.fg("accent", safeDisplay(details.answer))}`, 0, 0);
			}
			const index = details.selectedIndex ?? details.options.indexOf(details.answer) + 1;
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", `${index}. ${safeDisplay(details.answer, true)}`)}`, 0, 0);
		},
	});
}
