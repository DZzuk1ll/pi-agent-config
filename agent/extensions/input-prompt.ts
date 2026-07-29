import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

const PREFIX = "›";
const PADDING = 2;

export default function inputPrompt(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		class PromptEditor extends CustomEditor {
			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings, { paddingX: PADDING });
			}

			override setPaddingX(_padding: number): void {
				super.setPaddingX(PADDING);
			}

			override render(width: number): string[] {
				const lines = super.render(width);
				const input = lines[1];
				if (input?.startsWith(" ".repeat(PADDING))) {
					lines[1] = `${ctx.ui.theme.fg("accent", PREFIX)} ${input.slice(PADDING)}`;
				}
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new PromptEditor(tui, theme, keybindings)
		);
	});
}
