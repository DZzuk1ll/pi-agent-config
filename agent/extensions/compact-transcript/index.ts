import { existsSync, readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import {
	formatDoneLineSpacing,
	isToolComponent,
	renderPlannedChildren,
	resolveTodoGrouping,
	resolveToolGrouping,
} from "../_shared/runtime/tool-grouping.ts";
import {
	formatCompactUserMessageLines,
	OSC133_ZONE_RE,
} from "../_shared/runtime/compact-transcript-format.ts";
import { registerPrototypePatch } from "../_shared/runtime/prototype-patch.ts";
import { requirePresent } from "../_shared/runtime/require-present.ts";


const WORKING_MESSAGE_PATCH = Symbol.for("compact-transcript:working-message");
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

interface MessageBlock {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
}

interface AssistantMessageBridge {
	lastMessage?: { content?: unknown };
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
}

interface ToolResultBridge {
	content?: unknown;
}

interface ToolRenderOptionsBridge {
	isPartial?: boolean;
	expanded?: boolean;
}

interface ThemeBridge {
	fg(color: string, text: string): string;
}

type ToolResultRenderer = (
	result: ToolResultBridge,
	options: ToolRenderOptionsBridge,
	theme: ThemeBridge,
	context: unknown,
) => Component;

type WorkingMessageSetter = (message?: string) => void;
type WorkingMessageUi = ExtensionUIContext & {
	[WORKING_MESSAGE_PATCH]?: WorkingMessageSetter;
};

function requireStringLines(value: unknown, source: string): string[] {
	if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value;
	throw new TypeError(`${source} returned a non-string-lines value`);
}

function messageBlock(value: unknown): MessageBlock {
	return value && typeof value === "object" ? value as MessageBlock : {};
}

function readUiSettings(): Record<string, unknown> {
	const projectPath = `${process.cwd()}/.pi/settings.json`;
	const userPath = `${process.env.HOME ?? ""}/.pi/settings.json`;
	let settings: Record<string, unknown> = {};
	for (const path of [userPath, projectPath]) {
		try {
			if (!existsSync(path)) continue;
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
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

function patchCollapsedToolPreviews(): () => void {
	const prototype = ToolExecutionComponent.prototype;
	return registerPrototypePatch(prototype, "getResultRenderer", {
		name: "compact-transcript:tool-preview",
		order: 200,
		wrap: (getResultRenderer) => function compactResultRenderer(this: { toolName?: unknown }) {
		const renderer = getResultRenderer.call(this);
		const toolName = typeof this.toolName === "string" ? this.toolName : "";
		if (typeof renderer !== "function" || !["read", "grep", "find", "ls"].includes(toolName)) {
			return renderer;
		}

		const typedRenderer = renderer as ToolResultRenderer;
		return (result: ToolResultBridge, options: ToolRenderOptionsBridge, theme: ThemeBridge, context: unknown) => {
			const rendered = typedRenderer(result, options, theme, context);
			if (options?.isPartial || options?.expanded) return rendered;

			const settings = readUiSettings();
			const mode = toolName === "read" ? settings.readOutputMode : settings.searchOutputMode;
			const text = Array.isArray(result.content)
				? result.content.map(messageBlock).find((block) => block.type === "text")?.text
				: undefined;
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
		},
	});
}

function patchToolGrouping(): () => void {
	const prototype = Container.prototype;
	return registerPrototypePatch(prototype, "render", {
		name: "compact-transcript:tool-grouping",
		order: 200,
		wrap: (render) => function compactGroupedRender(this: Container, width: number): string[] {
		const children = Array.isArray(this.children) ? this.children : [];
		if (isToolComponent(this) || !children.some(isToolComponent)) {
			return requireStringLines(render.call(this, width), "Container.render");
		}
		const settings = readUiSettings();
		return renderPlannedChildren(
			children,
			resolveToolGrouping(settings),
			width,
			isEmptyToolRoundAssistant,
			resolveTodoGrouping(settings),
		);
		},
	});
}

function isEmptyToolRoundAssistant(child: unknown): boolean {
	if (!(child instanceof AssistantMessageComponent)) return false;
	const assistant = child as unknown as AssistantMessageBridge;
	const content = assistant.lastMessage?.content;
	if (!Array.isArray(content)) return false;
	const blocks = content.map(messageBlock);
	const hasToolCall = blocks.some((block) => block.type === "toolCall");
	const hasVisibleAssistantContent = blocks.some((block) =>
		(block?.type === "text" && typeof block.text === "string" && block.text.trim())
		|| (
			assistant.hideThinkingBlock !== true
			&& block?.type === "thinking"
			&& typeof block.thinking === "string"
			&& block.thinking.trim()
		)
	);
	return hasToolCall && !hasVisibleAssistantContent;
}

function patchUserPrefix(): () => void {
	const prototype = UserMessageComponent.prototype;
	return registerPrototypePatch(prototype, "render", {
		name: "compact-transcript:user-render",
		order: 200,
		wrap: (render) => function compactUserRender(this: object, width: number): string[] {
		const lines = requireStringLines(render.call(this, width), "UserMessageComponent.render");
		return formatCompactUserMessageLines(lines);
		},
	});
}

function patchDoneLine(): () => void {
	const prototype = AssistantMessageComponent.prototype;
	return registerPrototypePatch(prototype, "render", {
		name: "compact-transcript:assistant-render",
		order: 200,
		wrap: (render) => function compactAssistantRender(this: AssistantMessageBridge & object, width: number): string[] {
		const lines = requireStringLines(render.call(this, width), "AssistantMessageComponent.render");
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
		const blocks = (this.lastMessage.content as unknown[]).map(messageBlock);
		const hasThinking = blocks.some((block) =>
			block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()
		);
		if (!hasThinking) return normalized;
		const hasText = blocks.some((block) =>
			block.type === "text" && typeof block.text === "string" && block.text.trim()
		);
		if (!hasText) return [];

		const label = typeof this.hiddenThinkingLabel === "string" ? this.hiddenThinkingLabel.trim() : "";
		const visible = label
			? normalized.filter((line) => line.replace(ANSI_SGR_RE, "").trim() !== label)
			: normalized;
		while (visible.length > 0 && !requirePresent(visible[0]).replace(ANSI_SGR_RE, "").trim()) visible.shift();
		return visible;
		},
	});
}

function patchWorkingMessage(ui: ExtensionUIContext): () => void {
	const target = ui as WorkingMessageUi;
	if (target[WORKING_MESSAGE_PATCH] || typeof target.setWorkingMessage !== "function") return () => {};

	const original = target.setWorkingMessage;
	const patched = (message?: string): void => {
		original.call(target,
			typeof message === "string"
				? message.replace("✻ Worked for ", "Done in ")
				: message,
		);
	};
	target.setWorkingMessage = patched;
	target[WORKING_MESSAGE_PATCH] = patched;
	return () => {
		if (target[WORKING_MESSAGE_PATCH] !== patched) return;
		if (target.setWorkingMessage === patched) target.setWorkingMessage = original;
		delete target[WORKING_MESSAGE_PATCH];
	};
}

export default function compactTranscript(pi: ExtensionAPI): void {
	let disposers: Array<() => void> = [];
	const disposePatches = (): void => {
		for (const dispose of disposers.splice(0).reverse()) dispose();
	};
	pi.on("session_start", async (_event, context) => {
		// Package extensions load after user extensions, so patch after all factories initialize.
		disposePatches();
		disposers = [
			patchUserPrefix(),
			patchDoneLine(),
			patchCollapsedToolPreviews(),
			patchToolGrouping(),
			patchWorkingMessage(context.ui),
		];
	});
	pi.on("session_shutdown", disposePatches);
}
