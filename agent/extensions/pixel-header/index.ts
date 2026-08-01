import { homedir } from "node:os";
import { basename, relative, sep } from "node:path";

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeForDisplay } from "../_shared/runtime/text.ts";

const BLOCK = "██";
const SPACE = "  ";
const LOGO = [
	`${BLOCK}${BLOCK}${BLOCK}${SPACE}`,
	`${BLOCK}${SPACE}${BLOCK}${SPACE}`,
	`${BLOCK}${BLOCK}${SPACE}${BLOCK}`,
	`${BLOCK}${SPACE}${SPACE}${BLOCK}`,
];

function compactPath(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}${sep}`)) return `~${sep}${relative(home, cwd)}`;
	return cwd;
}

function center(text: string, width: number): string {
	const available = Math.max(0, width - visibleWidth(text));
	return `${" ".repeat(Math.floor(available / 2))}${text}`;
}

function styledPath(path: string, theme: Theme): string {
	const leaf = basename(path);
	if (!leaf || leaf === path) return theme.fg("accent", path);
	const prefix = path.slice(0, -leaf.length);
	return `${theme.fg("muted", prefix)}${theme.fg("accent", theme.bold(leaf))}`;
}

export default function pixelHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				const logo = LOGO.map((line) => center(theme.fg("accent", line), width));
				const safePath = sanitizeForDisplay(compactPath(ctx.cwd)).replace(/[\r\n\t]+/g, " ");
				const path = truncateToWidth(styledPath(safePath, theme), Math.max(1, width));
				return ["", ...logo, "", center(path, width), ""];
			},
			invalidate() {},
		}));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
	});

	pi.registerCommand("default-header", {
		description: "Restore Pi's built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
