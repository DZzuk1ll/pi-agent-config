import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorComponent, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	claimInteractiveWidgetFocus,
	interactiveWidgetFocusedByOther,
	releaseInteractiveWidgetFocus,
} from "../_shared/runtime/interactive-widget-focus.ts";
import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { omitUndefined } from "../_shared/runtime/omit-undefined.ts";
import type { WorkflowAgentRecord, WorkflowDetails } from "./controller.ts";

export const WORKFLOW_LIVE_WIDGET_KEY = "workflow-live-status";

const FOCUS_OWNER = "workflow-live-status";
const MAX_VISIBLE_ROWS = 7;
const REFRESH_MS = 400;
const CANCEL_CONFIRM_MS = 3_000;

type Theme = ExtensionContext["ui"]["theme"];
type WorkflowLiveTui = {
	requestRender(): void;
};

export interface WorkflowLiveStatusSource {
	getActive(): ReadonlyMap<string, WorkflowDetails>;
	cancel(runId: string, reason: string): boolean;
}

export interface WorkflowLiveTarget {
	runId: string;
	nodeId?: string;
	openTranscript: boolean;
}

export interface WorkflowLiveStatusEntry {
	key: string;
	kind: "workflow" | "agent";
	runId: string;
	nodeId?: string;
	childRunId?: string;
	name: string;
	agent?: string;
	phase?: string;
	state: string;
	startedAt: number;
	endedAt?: number;
	currentTool?: string;
	tokens: number;
	done?: number;
	total?: number;
	isLastAgent?: boolean;
}

function clean(value: unknown, maxLength = 240): string {
	const result = sanitizeForDisplay(String(value ?? "")).replace(/\s+/g, " ").trim();
	return result.length <= maxLength ? result : `${result.slice(0, Math.max(0, maxLength - 1))}…`;
}

function elapsed(milliseconds: number): string {
	const duration = Math.max(0, milliseconds);
	if (duration < 1_000) return `${duration}ms`;
	if (duration < 60_000) return `${Math.round(duration / 1_000)}s`;
	return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1_000)}s`;
}

function compactTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${Math.max(0, Math.round(count))}`;
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const leftClamped = truncateToWidth(left, maxLeftWidth);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightWidth);
	return truncateToWidth(`${leftClamped}${" ".repeat(gap)}${right}`, width);
}

function workflowDone(details: WorkflowDetails): number {
	return details.agents.filter((agent) => agent.state === "done").length;
}

export function collectWorkflowLiveStatusEntries(active: ReadonlyMap<string, WorkflowDetails>): WorkflowLiveStatusEntry[] {
	const entries: WorkflowLiveStatusEntry[] = [];
	const workflows = [...active.values()].sort((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId));
	for (const details of workflows) {
		entries.push(omitUndefined({
			key: `workflow:${details.runId}`,
			kind: "workflow",
			runId: details.runId,
			name: details.name,
			phase: details.currentPhase,
			state: details.state,
			startedAt: details.startedAt,
			endedAt: details.endedAt,
			tokens: details.agents.reduce((total, agent) => total + (agent.tokens ?? 0), 0),
			done: workflowDone(details),
			total: details.agents.length,
		}));
		const agents = [...details.agents].sort((left, right) => left.index - right.index);
		for (const [index, agent] of agents.entries()) {
			entries.push(agentEntry(details, agent, index === agents.length - 1));
		}
	}
	return entries;
}

function agentEntry(details: WorkflowDetails, agent: WorkflowAgentRecord, isLastAgent: boolean): WorkflowLiveStatusEntry {
	return omitUndefined({
		key: `agent:${details.runId}:${agent.nodeId}`,
		kind: "agent",
		runId: details.runId,
		nodeId: agent.nodeId,
		childRunId: agent.runId,
		name: agent.label,
		agent: agent.agent,
		phase: agent.phase,
		state: agent.state,
		startedAt: agent.startedAt ?? details.startedAt,
		endedAt: agent.endedAt,
		currentTool: agent.currentTool,
		tokens: agent.tokens ?? 0,
		isLastAgent,
	});
}

function stateMarker(state: string, theme: Theme): string {
	if (state === "completed" || state === "done") return theme.fg("success", "✓");
	if (state === "failed" || state === "aborted") return theme.fg("error", "✗");
	if (state === "running") return theme.fg("warning", "●");
	return theme.fg("dim", "○");
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error
		&& (error.message.includes("This extension ctx is stale")
			|| error.message.includes("Extension context no longer active"));
}

function visibleWindow<T>(values: readonly T[], selected: number, capacity: number): { values: readonly T[]; start: number } {
	if (capacity <= 0) return { values: [], start: 0 };
	if (values.length <= capacity) return { values, start: 0 };
	const start = Math.max(0, Math.min(selected - Math.floor(capacity / 2), values.length - capacity));
	return { values: values.slice(start, start + capacity), start };
}

export class WorkflowLiveStatus {
	private ctx: ExtensionContext | undefined;
	private ui: ExtensionContext["ui"] | undefined;
	private tui: WorkflowLiveTui | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private active = false;
	private inspectorOpen = false;
	private selectedKey = "";
	private entries: WorkflowLiveStatusEntry[] = [];
	private lastRenderKey = "";
	private notice: string | undefined;
	private noticeAt = 0;
	private cancelConfirmation: { runId: string; expiresAt: number } | undefined;

	constructor(
		private readonly source: WorkflowLiveStatusSource,
		private readonly openInspector: (ctx: ExtensionContext, target: WorkflowLiveTarget) => Promise<void> | void,
	) {}

	setContext(ctx: ExtensionContext): void {
		if (!ctx.hasUI) {
			this.dispose();
			return;
		}
		const ui = ctx.ui;
		if (this.ui === ui) {
			this.ctx = ctx;
			this.refresh();
			return;
		}
		this.dispose();
		this.ctx = ctx;
		this.ui = ui;
		this.inputUnsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
		this.timer = setInterval(() => this.refresh(), REFRESH_MS);
		this.timer.unref?.();
		this.refresh();
	}

	dispose(): void {
		this.clearUiRegistration();
		this.ctx = undefined;
		this.ui = undefined;
		this.entries = [];
		this.active = false;
		this.inspectorOpen = false;
		this.selectedKey = "";
		this.lastRenderKey = "";
	}

	refresh(): void {
		const ctx = this.getActiveUiContext();
		if (!ctx) return;
		this.entries = collectWorkflowLiveStatusEntries(this.source.getActive());
		this.clampSelection();
		const now = Date.now();
		if (this.notice && now - this.noticeAt > 4_000) this.notice = undefined;
		if (this.cancelConfirmation && now > this.cancelConfirmation.expiresAt) this.cancelConfirmation = undefined;

		if (this.inspectorOpen) {
			this.lastRenderKey = "";
			this.removeWidget(ctx);
			return;
		}
		if (this.entries.length === 0) {
			releaseInteractiveWidgetFocus(FOCUS_OWNER);
			this.active = false;
			this.selectedKey = "";
			this.lastRenderKey = "";
			this.removeWidget(ctx);
			return;
		}

		const renderKey = this.getRenderKey();
		if (!this.widgetRegistered) {
			ctx.ui.setWidget(WORKFLOW_LIVE_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {
						this.lastRenderKey = "";
					},
					dispose: () => {
						if (this.tui !== tui) return;
						this.widgetRegistered = false;
						this.tui = undefined;
					},
				};
			}, { placement: "belowEditor" });
			this.widgetRegistered = true;
			this.lastRenderKey = renderKey;
			return;
		}
		if (renderKey === this.lastRenderKey) return;
		this.lastRenderKey = renderKey;
		this.tui?.requestRender();
	}

	async runInspector<T>(action: () => Promise<T> | T): Promise<T> {
		if (this.inspectorOpen) throw new Error("Workflow inspector is already open");
		releaseInteractiveWidgetFocus(FOCUS_OWNER);
		this.active = false;
		this.inspectorOpen = true;
		this.refresh();
		try {
			return await action();
		} finally {
			this.inspectorOpen = false;
			this.refresh();
		}
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		const ctx = this.getActiveUiContext();
		if (!ctx || this.entries.length === 0 || isKeyRelease(data) || this.inspectorOpen) return undefined;
		if (interactiveWidgetFocusedByOther(FOCUS_OWNER)) {
			if (this.active) this.deactivate();
			return undefined;
		}
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			const activates = matchesKey(data, "down") || matchesKey(data, "right");
			if (!activates || !claimInteractiveWidgetFocus(FOCUS_OWNER)) return undefined;
			this.active = true;
			this.selectedKey = this.entries[0]?.key ?? "";
			this.refresh();
			return { consume: true };
		}

		const selected = Math.max(0, this.entries.findIndex((entry) => entry.key === this.selectedKey));
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedKey = this.entries[Math.min(this.entries.length - 1, selected + 1)]?.key ?? this.selectedKey;
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (selected === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedKey = this.entries[selected - 1]?.key ?? this.selectedKey;
			this.refresh();
			return { consume: true };
		}
		if (matchesKey(data, "escape") || matchesKey(data, "left")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			const entry = this.entries[selected];
			if (!entry) return { consume: true };
			void this.runInspector(() => this.openInspector(ctx, {
				runId: entry.runId,
				...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
				openTranscript: entry.kind === "agent" && Boolean(entry.childRunId),
			})).catch((error) => {
				try {
					this.getActiveUiContext()?.ui.notify(error instanceof Error ? error.message : String(error), "error");
				} catch {
					// A failed or stale notification must not create an unhandled rejection.
				}
			});
			return { consume: true };
		}
		if (data === "c") {
			this.cancelSelected();
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	render(width: number, theme: Theme): string[] {
		if (this.entries.length === 0) return [];
		const selected = Math.max(0, this.entries.findIndex((entry) => entry.key === this.selectedKey));
		const hint = this.active
			? "↑↓/jk select · enter inspect · c cancel · esc back"
			: "↓/→ workflow · esc interrupt";
		const lines = [truncateToWidth(`  ${theme.fg("dim", this.notice ?? hint)}`, width), ""];
		const window = visibleWindow(this.entries, selected, MAX_VISIBLE_ROWS);
		if (window.start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${window.start} more`), width));
		for (const [offset, entry] of window.values.entries()) {
			lines.push(this.renderEntry(entry, window.start + offset === selected, width, theme));
		}
		const hiddenBelow = this.entries.length - (window.start + window.values.length);
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
		return lines;
	}

	private renderEntry(entry: WorkflowLiveStatusEntry, selected: boolean, width: number, theme: Theme): string {
		const bullet = selected && this.active ? theme.fg("accent", "⏺") : theme.fg("dim", "◯");
		const runtime = elapsed((entry.endedAt ?? Date.now()) - entry.startedAt);
		if (entry.kind === "workflow") {
			const phase = entry.phase ? ` · ${clean(entry.phase, 120)}` : "";
			const left = `  ${bullet} ${stateMarker(entry.state, theme)} ${theme.fg("accent", `Workflow ${clean(entry.name, 160)}`)}${theme.fg("muted", phase)}`;
			const right = theme.fg("dim", `${entry.done ?? 0}/${entry.total ?? 0} · ${runtime}`);
			return rightAlign(left, right, width);
		}
		const branch = entry.isLastAgent ? "└" : "├";
		const activity = entry.currentTool ? ` · ${clean(entry.currentTool, 80)}` : "";
		const identity = entry.agent && entry.agent !== entry.name ? ` · ${clean(entry.agent, 80)}` : "";
		const left = `  ${bullet}   ${theme.fg("dim", branch)} ${stateMarker(entry.state, theme)} ${theme.fg("muted", clean(entry.name, 140))}${theme.fg("dim", `${identity}${activity}`)}`;
		const tokens = entry.tokens > 0 ? ` · ${compactTokens(entry.tokens)} tok` : "";
		return rightAlign(left, theme.fg("dim", `${runtime}${tokens}`), width);
	}

	private cancelSelected(): void {
		const entry = this.entries.find((item) => item.key === this.selectedKey) ?? this.entries[0];
		if (!entry) return;
		const now = Date.now();
		if (!this.cancelConfirmation || this.cancelConfirmation.runId !== entry.runId || now > this.cancelConfirmation.expiresAt) {
			this.cancelConfirmation = { runId: entry.runId, expiresAt: now + CANCEL_CONFIRM_MS };
			this.showNotice("Press c again within 3 seconds to cancel this workflow");
			this.refresh();
			return;
		}
		this.cancelConfirmation = undefined;
		this.showNotice(this.source.cancel(entry.runId, "Cancelled from workflow live panel") ? "Cancellation requested" : "Workflow is no longer active");
		this.refresh();
	}

	private showNotice(message: string): void {
		this.notice = message;
		this.noticeAt = Date.now();
	}

	private clampSelection(): void {
		if (!this.entries.some((entry) => entry.key === this.selectedKey)) this.selectedKey = this.entries[0]?.key ?? "";
	}

	private deactivate(): void {
		releaseInteractiveWidgetFocus(FOCUS_OWNER);
		this.active = false;
		this.selectedKey = this.entries[0]?.key ?? "";
		this.refresh();
	}

	private editorHasFocus(): boolean {
		const focused = (this.tui as unknown as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		if (!focused || typeof focused !== "object") return false;
		const candidate = focused as Partial<EditorComponent>;
		return typeof candidate.render === "function"
			&& typeof candidate.invalidate === "function"
			&& typeof candidate.handleInput === "function"
			&& typeof candidate.getText === "function"
			&& typeof candidate.setText === "function";
	}

	private getRenderKey(): string {
		const now = Date.now();
		return JSON.stringify({
			active: this.active,
			selected: this.selectedKey,
			inspectorOpen: this.inspectorOpen,
			notice: this.notice,
			entries: this.entries.map((entry) => [
				entry.key,
				entry.state,
				entry.phase,
				entry.currentTool,
				entry.tokens,
				entry.done,
				entry.total,
				Math.round((now - entry.startedAt) / 1_000),
			]),
		});
	}

	private removeWidget(ctx: ExtensionContext): void {
		if (!this.widgetRegistered) return;
		ctx.ui.setWidget(WORKFLOW_LIVE_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private getActiveUiContext(): ExtensionContext | undefined {
		const ctx = this.ctx;
		if (!ctx) return undefined;
		try {
			if (!ctx.hasUI) {
				this.clearUiRegistration();
				return undefined;
			}
			return ctx;
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			this.clearUiRegistration();
			return undefined;
		}
	}

	private clearUiRegistration(): void {
		releaseInteractiveWidgetFocus(FOCUS_OWNER);
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		const inputUnsubscribe = this.inputUnsubscribe;
		const ui = this.ui;
		const widgetRegistered = this.widgetRegistered;
		this.inputUnsubscribe = undefined;
		this.ctx = undefined;
		this.ui = undefined;
		this.widgetRegistered = false;
		this.tui = undefined;

		const cleanupErrors: unknown[] = [];
		try {
			inputUnsubscribe?.();
		} catch (error) {
			if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
		}
		if (ui && widgetRegistered) {
			try {
				ui.setWidget(WORKFLOW_LIVE_WIDGET_KEY, undefined);
			} catch (error) {
				if (!isStaleExtensionContextError(error)) cleanupErrors.push(error);
			}
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Failed to clean up Workflow live UI registration");
	}
}
