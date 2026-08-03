import { stripVTControlCharacters } from "node:util";
import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { MenuScreen, ReviewScreen } from "../types.js";
import type { MenuScreenComponent, MenuScreenComponentOptions } from "./contracts.js";
import { renderFrame, safeMenuText } from "./rendering.js";

const DEFAULT_REVIEW_VIEWPORT_SIZE = 14;
const RPC_REVIEW_VIEWPORT_SIZE = 8;
const RPC_REVIEW_LINE_WIDTH = 120;
const TAB_SIZE = 4;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export type ReviewOptions<
	ScreenId extends string,
	ActionId extends string,
> = MenuScreenComponentOptions<ScreenId, ActionId> & {
	screen: Extract<MenuScreen<ScreenId, ActionId>, { kind: "review" }>;
};

export function createReviewComponent<ScreenId extends string, ActionId extends string>(
	options: ReviewOptions<ScreenId, ActionId>,
): MenuScreenComponent {
	let scrollOffset = 0;
	let lastMaximumScroll = 0;
	let disposed = false;

	const moveTo = (offset: number) => {
		scrollOffset = Math.max(0, Math.min(offset, lastMaximumScroll));
		options.tui.requestRender();
	};

	return {
		render(width) {
			const safeWidth = Math.max(1, width);
			const allLines = formatReviewLines(options.screen, safeWidth, options.theme);
			const viewportSize = reviewViewportSize(options.screen);
			lastMaximumScroll = Math.max(0, allLines.length - viewportSize);
			scrollOffset = Math.max(0, Math.min(scrollOffset, lastMaximumScroll));
			const visible = allLines.slice(scrollOffset, scrollOffset + viewportSize);
			const first = allLines.length === 0 ? 0 : scrollOffset + 1;
			const last = Math.min(allLines.length, scrollOffset + viewportSize);
			const position =
				allLines.length > viewportSize
					? [options.theme.fg("dim", `${first}-${last}/${allLines.length}`)]
					: [];
			return renderFrame(
				options.screen.title,
				options.screen.lines ?? [],
				[...visible, ...position],
				options.screen.hint ?? "back",
				safeWidth,
				options,
				options.screen.confirm ? safeMenuText(options.screen.confirm.label) : "",
			);
		},
		invalidate() {},
		handleInput(data) {
			if (disposed) return;
			if (matchesKey(data, Key.ctrl("c"))) options.onEvent({ kind: "close" });
			else if (options.keybindings.matches(data, "tui.select.cancel")) {
				options.onEvent({ kind: options.screen.hint ?? "back" });
			} else if (options.keybindings.matches(data, "tui.select.up")) {
				moveTo(scrollOffset - 1);
			} else if (options.keybindings.matches(data, "tui.select.down")) {
				moveTo(scrollOffset + 1);
			} else if (options.keybindings.matches(data, "tui.select.pageUp")) {
				moveTo(scrollOffset - reviewViewportSize(options.screen));
			} else if (options.keybindings.matches(data, "tui.select.pageDown")) {
				moveTo(scrollOffset + reviewViewportSize(options.screen));
			} else if (matchesKey(data, Key.home)) moveTo(0);
			else if (matchesKey(data, Key.end)) moveTo(lastMaximumScroll);
			else if (options.screen.confirm && options.keybindings.matches(data, "tui.select.confirm")) {
				options.onEvent({ kind: "activate", itemId: options.screen.confirm.id });
			}
		},
		async waitForPending() {},
		dispose() {
			if (disposed) return;
			disposed = true;
			options.onDispose?.();
		},
	};
}

export function reviewDialogPages<ActionId extends string>(
	screen: ReviewScreen<ActionId>,
): string[][] {
	const lines = plainReviewLines(screen.content, RPC_REVIEW_LINE_WIDTH);
	const pageSize = Math.min(reviewViewportSize(screen), RPC_REVIEW_VIEWPORT_SIZE);
	const pages: string[][] = [];
	for (let index = 0; index < lines.length; index += pageSize) {
		pages.push(lines.slice(index, index + pageSize));
	}
	return pages.length > 0 ? pages : [[""]];
}

function formatReviewLines<ActionId extends string>(
	screen: ReviewScreen<ActionId>,
	width: number,
	theme: MenuScreenComponentOptions<string, ActionId>["theme"],
): string[] {
	const segments = reviewSegments(screen.content, width);
	const format = screen.format ?? { kind: "text" as const };
	if (format.kind === "code") {
		const language =
			format.language ?? (format.filePath ? getLanguageFromPath(format.filePath) : undefined);
		return segments.map(({ text }) =>
			theme.fg("mdCodeBlock", highlightCode(text, language)[0] ?? text),
		);
	}
	if (format.kind === "diff") {
		return segments.map(({ source, text }) => {
			if (source.startsWith("@@")) return theme.fg("accent", text);
			if (source.startsWith("+") && !source.startsWith("+++")) {
				return theme.fg("toolDiffAdded", text);
			}
			if (source.startsWith("-") && !source.startsWith("---")) {
				return theme.fg("toolDiffRemoved", text);
			}
			return theme.fg("toolDiffContext", text);
		});
	}
	return segments.map(({ text }) => theme.fg("text", text));
}

function plainReviewLines(content: string, width: number): string[] {
	return reviewSegments(content, width).map(({ text }) => text);
}

function reviewSegments(content: string, width: number) {
	const safe = sanitizeDocumentText(content);
	return safe.split("\n").flatMap((line) => {
		const source = expandTabs(line);
		return hardWrapLine(source, width).map((text) => ({ source, text }));
	});
}

export function sanitizeDocumentText(value: unknown): string {
	const stripped = stripVTControlCharacters(String(value)).replace(/\r\n?/gu, "\n");
	return Array.from(stripped, (character) => {
		if (character === "\n" || character === "\t") return character;
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	}).join("");
}

function expandTabs(line: string): string {
	let column = 0;
	let result = "";
	for (const { segment } of graphemeSegmenter.segment(line)) {
		if (segment === "\t") {
			const count = TAB_SIZE - (column % TAB_SIZE);
			result += " ".repeat(count);
			column += count;
			continue;
		}
		result += segment;
		column += visibleWidth(segment);
	}
	return result;
}

function hardWrapLine(line: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (line.length === 0) return [""];
	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	const flush = () => {
		lines.push(current);
		current = "";
		currentWidth = 0;
	};
	for (const { segment } of graphemeSegmenter.segment(line)) {
		const segmentWidth = visibleWidth(segment);
		if (segmentWidth > safeWidth) {
			if (current.length > 0) flush();
			lines.push("?".repeat(safeWidth));
			continue;
		}
		if (currentWidth + segmentWidth > safeWidth && current.length > 0) flush();
		current += segment;
		currentWidth += segmentWidth;
	}
	if (current.length > 0 || lines.length === 0) lines.push(current);
	return lines;
}

function reviewViewportSize<ActionId extends string>(screen: ReviewScreen<ActionId>) {
	return screen.viewportSize ?? DEFAULT_REVIEW_VIEWPORT_SIZE;
}
