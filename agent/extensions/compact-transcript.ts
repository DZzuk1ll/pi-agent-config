import { existsSync, readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	formatDoneLineSpacing,
	isToolComponent,
	renderPlannedChildren,
	resolveTodoGrouping,
	resolveToolGrouping,
} from "../lib/tool-grouping.ts";
import {
	formatCompactUserMessageLines,
	OSC133_ZONE_RE,
} from "./shared/compact-transcript-format.ts";

const USER_RENDER_PATCH = Symbol.for("compact-transcript:user-render:v4");
const ASSISTANT_RENDER_PATCH = Symbol.for("compact-transcript:assistant-render:v4");
const WORKING_MESSAGE_PATCH = Symbol.for("compact-transcript:working-message");
const TOOL_PREVIEW_PATCH = Symbol.for("compact-transcript:tool-preview");
const TOOL_GROUPING_PATCH = Symbol.for("compact-transcript:tool-grouping:v4");
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

function readUiSettings(): Record<string, unknown> {
	const projectPath = `${process.cwd()}/.pi/settings.json`;
	const userPath = `${process.env.HOME ?? ""}/.pi/settings.json`;
	let settings: Record<string, unknown> = {};
	for (const path of [userPath, projectPath]) {
		try {
			if (!existsSync(path)) continue;
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				settings = { ...settings, ...parsed };
			}
		} catch {
			// Ignore invalid or temporarily unavailable settings.
		}
	}
	return settings;
}

function previewLines(text: string): string[] {
	const configured = readUiSettings().previewLines;
	const limit = typeof configured === "number" && configured > 0
		? Math.floor(configured)
		: 3;
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(0, limit)
		.map((line) => line.length > 140 ? `${line.slice(0, 139)}…` : line);
}

function patchCollapsedToolPreviews(): void {
	const prototype = ToolExecutionComponent.prototype as any;
	if (prototype[TOOL_PREVIEW_PATCH] || typeof prototype.getResultRenderer !== "function") return;

	const getResultRenderer = prototype.getResultRenderer;
	prototype.getResultRenderer = function compactResultRenderer() {
		const renderer = getResultRenderer.call(this);
		const toolName = typeof this.toolName === "string" ? this.toolName : "";
		if (typeof renderer !== "function" || !["read", "grep", "find", "ls"].includes(toolName)) {
			return renderer;
		}

		return (result: any, options: any, theme: any, context: any) => {
			const rendered = renderer(result, options, theme, context);
			if (options?.isPartial || options?.expanded) return rendered;

			const settings = readUiSettings();
			const mode = toolName === "read" ? settings.readOutputMode : settings.searchOutputMode;
			const text = result?.content?.find((block: any) => block?.type === "text")?.text;
			if (mode !== "preview" || typeof text !== "string") return rendered;

			const lines = previewLines(text);
			if (lines.length === 0) return rendered;

			const container = new Container();
			container.addChild(rendered);
			container.addChild(new Text(
				lines.map((line) => theme.fg("dim", `     ${line}`)).join("\n"),
				0,
				0,
			));
			return container;
		};
	};
	prototype[TOOL_PREVIEW_PATCH] = true;
}

function patchToolGrouping(): void {
	const prototype = Container.prototype as any;
	if (prototype[TOOL_GROUPING_PATCH] || typeof prototype.render !== "function") return;

	const render = prototype.render;
	prototype.render = function compactGroupedRender(width: number): string[] {
		const children = Array.isArray(this.children) ? this.children : [];
		if (isToolComponent(this) || !children.some(isToolComponent)) {
			return render.call(this, width);
		}
		const settings = readUiSettings();
		return renderPlannedChildren(
			children,
			resolveToolGrouping(settings),
			width,
			isEmptyToolRoundAssistant,
			resolveTodoGrouping(settings),
		);
	};
	prototype[TOOL_GROUPING_PATCH] = true;
}

function isEmptyToolRoundAssistant(child: any): boolean {
	if (!(child instanceof AssistantMessageComponent)) return false;
	const content = child.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	const hasToolCall = content.some((block: any) => block?.type === "toolCall");
	const hasVisibleAssistantContent = content.some((block: any) =>
		(block?.type === "text" && typeof block.text === "string" && block.text.trim())
		|| (
			child.hideThinkingBlock !== true
			&& block?.type === "thinking"
			&& typeof block.thinking === "string"
			&& block.thinking.trim()
		)
	);
	return hasToolCall && !hasVisibleAssistantContent;
}

function patchUserPrefix(): void {
	const prototype = UserMessageComponent.prototype as any;
	if (prototype[USER_RENDER_PATCH] || typeof prototype.render !== "function") return;

	const render = prototype.render;
	prototype.render = function compactUserRender(width: number): string[] {
		const lines = render.call(this, width);
		if (!Array.isArray(lines)) return lines;
		return formatCompactUserMessageLines(lines);
	};
	prototype[USER_RENDER_PATCH] = true;
}

function patchDoneLine(): void {
	const prototype = AssistantMessageComponent.prototype as any;
	if (prototype[ASSISTANT_RENDER_PATCH] || typeof prototype.render !== "function") return;

	const render = prototype.render;
	prototype.render = function compactAssistantRender(width: number): string[] {
		const lines = render.call(this, width);
		if (!Array.isArray(lines)) return lines;
		const normalized = formatDoneLineSpacing(
			lines.map((line) =>
				line
					.replace(OSC133_ZONE_RE, "")
					.replace("✻ Done for ", "Done in "),
			),
		);
		if (this.hideThinkingBlock !== true || !Array.isArray(this.lastMessage?.content)) {
			return normalized;
		}
		const hasThinking = this.lastMessage.content.some((block: any) =>
			block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()
		);
		if (!hasThinking) return normalized;
		const hasText = this.lastMessage.content.some((block: any) =>
			block?.type === "text" && typeof block.text === "string" && block.text.trim()
		);
		if (!hasText) return [];

		const label = typeof this.hiddenThinkingLabel === "string" ? this.hiddenThinkingLabel.trim() : "";
		const visible = label
			? normalized.filter((line) => line.replace(ANSI_SGR_RE, "").trim() !== label)
			: normalized;
		while (visible.length > 0 && !visible[0]!.replace(ANSI_SGR_RE, "").trim()) visible.shift();
		return visible;
	};
	prototype[ASSISTANT_RENDER_PATCH] = true;
}

function patchWorkingMessage(ui: ExtensionUIContext): void {
	const target = ui as any;
	if (target[WORKING_MESSAGE_PATCH] || typeof target.setWorkingMessage !== "function") return;

	const setWorkingMessage = target.setWorkingMessage.bind(target);
	target.setWorkingMessage = (message?: string): void => {
		setWorkingMessage(
			typeof message === "string"
				? message.replace("✻ Worked for ", "Done in ")
				: message,
		);
	};
	target[WORKING_MESSAGE_PATCH] = true;
}

export default function compactTranscript(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, context) => {
		// Package extensions load after user extensions, so patch after all factories initialize.
		patchUserPrefix();
		patchDoneLine();
		patchCollapsedToolPreviews();
		patchToolGrouping();
		patchWorkingMessage(context.ui);
	});
}
