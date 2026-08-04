import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { sanitizeForDisplay } from "../_shared/runtime/text.ts";
import { workflowRoot } from "./artifacts.ts";
import type { WorkflowAgentRecord, WorkflowDetails } from "./controller.ts";
import type { WorkflowTranscriptEvent, WorkflowTranscriptPage } from "./transcript.ts";
import {
	findWorkflowEntry,
	mergeWorkflowDashboardEntries,
	type WorkflowDashboardEntry,
} from "./dashboard-model.ts";
import { requirePresent } from "../_shared/runtime/require-present.ts";


const REFRESH_MS = 400;
const CANCEL_CONFIRM_MS = 3_000;
const TOOL_PREVIEW_LINES = 7;
const MIN_WIDTH = 50;
const MIN_FRAME_HEIGHT = 10;
const MAX_FRAME_HEIGHT = 36;

export interface WorkflowDashboardSource {
	getActive(): ReadonlyMap<string, WorkflowDetails>;
	loadHistory(): WorkflowDetails[];
	cancel(runId: string, reason: string): boolean;
	loadTranscript(runId: string, childIndex: number, cursor: number, limit: number, signal: AbortSignal): Promise<WorkflowTranscriptPage>;
}

type WorkflowRosterItem =
	| { key: string; kind: "workflow"; runId: string; entry: WorkflowDashboardEntry }
	| { key: string; kind: "agent"; runId: string; nodeId: string; entry: WorkflowDashboardEntry; agent: WorkflowAgentRecord; isLast: boolean };

type DetailSections = {
	header: string[];
	body: string[];
};

function clean(value: unknown, maxLength = 500): string {
	const result = sanitizeForDisplay(String(value ?? "")).replace(/\s+/g, " ").trim();
	return result.length <= maxLength ? result : `${result.slice(0, Math.max(0, maxLength - 1))}…`;
}

function elapsed(startedAt: number, endedAt?: number): string {
	const duration = Math.max(0, (endedAt ?? Date.now()) - startedAt);
	if (duration < 1_000) return `${duration}ms`;
	if (duration < 60_000) return `${(duration / 1_000).toFixed(1)}s`;
	return `${Math.floor(duration / 60_000)}m ${Math.floor((duration % 60_000) / 1_000)}s`;
}

function countAgents(details: WorkflowDetails): { done: number; failed: number } {
	let done = 0;
	let failed = 0;
	for (const agent of details.agents) {
		if (agent.state === "done") done++;
		else if (agent.state === "failed" || agent.state === "aborted") failed++;
	}
	return { done, failed };
}

function marker(state: string, theme: Theme): string {
	if (state === "completed" || state === "done") return theme.fg("success", "■");
	if (state === "failed" || state === "aborted") return theme.fg("error", "■");
	if (state === "running") return theme.fg("warning", "◆");
	return theme.fg("dim", "□");
}

function entryState(entry: WorkflowDashboardEntry): string {
	return entry.stale ? "stale" : entry.details.state;
}

function runKey(runId: string): string {
	return `workflow:${runId}`;
}

function agentKey(runId: string, nodeId: string): string {
	return `agent:${runId}:${nodeId}`;
}

function fitText(text: string, width: number): string {
	const clamped = truncateToWidth(text, Math.max(0, width), "");
	return clamped + " ".repeat(Math.max(0, width - visibleWidth(clamped)));
}

function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeftWidth = Math.max(0, width - rightWidth - 1);
	const clamped = truncateToWidth(left, maxLeftWidth, "");
	const gap = Math.max(1, width - visibleWidth(clamped) - rightWidth);
	return truncateToWidth(`${clamped}${" ".repeat(gap)}${right}`, width, "");
}

function wrapLines(values: readonly string[], width: number): string[] {
	const lines: string[] = [];
	for (const value of values) {
		const wrapped = wrapTextWithAnsi(value, Math.max(1, width));
		lines.push(...(wrapped.length > 0 ? wrapped : [""]));
	}
	return lines;
}

export class WorkflowDashboard {
	private history: WorkflowDetails[];
	private entries: WorkflowDashboardEntry[] = [];
	private expandedRunId: string | undefined;
	private selectedKey: string | undefined;
	private notice: string | undefined;
	private noticeAt = 0;
	private cancelConfirmation: { runId: string; expiresAt: number } | undefined;
	private lastActiveIds = new Set<string>();
	private transcript: (WorkflowTranscriptPage & { runId: string; loading?: boolean; loadedAt: number }) | undefined;
	private transcriptRequest?: AbortController;
	private detailScroll = 0;
	private detailAutoFollow = false;
	private detailLineCount = 0;
	private detailViewportHeight = 8;
	private expandedTools = false;
	private bodyHeight = 8;
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;
	private readonly onAbort: () => void;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly source: WorkflowDashboardSource,
		private readonly close: () => void,
		private readonly lifetimeSignal?: AbortSignal,
		initialRunId?: string,
		initialNodeId?: string,
		_openInitialTranscript = false,
		_closeOnBack = false,
	) {
		this.history = source.loadHistory();
		this.refresh();
		const initial = findWorkflowEntry(this.entries, initialRunId) ?? this.entries[0];
		if (initial) {
			this.expandedRunId = initial.runId;
			const agent = initial.details.agents.find((candidate) => candidate.nodeId === initialNodeId);
			this.selectedKey = agent ? agentKey(initial.runId, agent.nodeId) : runKey(initial.runId);
			this.detailAutoFollow = Boolean(agent?.runId);
		} else if (initialRunId) {
			this.showNotice(`No workflow run matches ${clean(initialRunId, 80)}`);
		}
		this.clampSelection();
		this.onAbort = () => this.closeDashboard();
		this.lifetimeSignal?.addEventListener("abort", this.onAbort, { once: true });
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.refresh();
			this.tui.requestRender();
			const item = this.selectedItem();
			if (item?.kind === "agent" && item.agent.runId && item.entry.live && !this.transcript?.loading && Date.now() - (this.transcript?.loadedAt ?? 0) >= 1_000) {
				void this.loadTranscript(false);
			}
		}, REFRESH_MS);
		this.timer.unref?.();
		if (this.selectedAgent()?.runId) queueMicrotask(() => {
			if (!this.disposed) void this.loadTranscript(false);
		});
		if (this.lifetimeSignal?.aborted) queueMicrotask(() => this.closeDashboard());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.transcriptRequest?.abort();
		this.lifetimeSignal?.removeEventListener("abort", this.onAbort);
	}

	invalidate(): void {
		this.refresh();
	}

	private closeDashboard(): void {
		if (this.disposed) return;
		this.dispose();
		this.close();
	}

	private showNotice(message: string): void {
		this.notice = message;
		this.noticeAt = Date.now();
	}

	private refresh(): void {
		const active = this.source.getActive();
		const activeIds = new Set(active.keys());
		const runSettled = [...this.lastActiveIds].some((runId) => !activeIds.has(runId));
		if (runSettled) this.history = this.source.loadHistory();
		this.lastActiveIds = activeIds;
		this.entries = mergeWorkflowDashboardEntries(active, this.history);
		if (!this.expandedRunId || !this.entries.some((entry) => entry.runId === this.expandedRunId)) {
			this.expandedRunId = this.entries[0]?.runId;
		}
		this.clampSelection();
		if (this.notice && Date.now() - this.noticeAt > 4_000) this.notice = undefined;
		if (this.cancelConfirmation && Date.now() > this.cancelConfirmation.expiresAt) this.cancelConfirmation = undefined;
	}

	private rosterItems(): WorkflowRosterItem[] {
		const items: WorkflowRosterItem[] = [];
		for (const entry of this.entries) {
			items.push({ key: runKey(entry.runId), kind: "workflow", runId: entry.runId, entry });
			if (entry.runId !== this.expandedRunId) continue;
			const agents = [...entry.details.agents].sort((left, right) => left.index - right.index);
			for (const [index, agent] of agents.entries()) {
				items.push({
					key: agentKey(entry.runId, agent.nodeId),
					kind: "agent",
					runId: entry.runId,
					nodeId: agent.nodeId,
					entry,
					agent,
					isLast: index === agents.length - 1,
				});
			}
		}
		return items;
	}

	private clampSelection(): void {
		const roster = this.rosterItems();
		if (!this.selectedKey || !roster.some((item) => item.key === this.selectedKey)) {
			this.selectedKey = this.expandedRunId ? runKey(this.expandedRunId) : roster[0]?.key;
		}
	}

	private selectedItem(): WorkflowRosterItem | undefined {
		return this.rosterItems().find((item) => item.key === this.selectedKey);
	}

	private selectedEntry(): WorkflowDashboardEntry | undefined {
		return this.selectedItem()?.entry;
	}

	private selectedAgent(): WorkflowAgentRecord | undefined {
		const item = this.selectedItem();
		return item?.kind === "agent" ? item.agent : undefined;
	}

	private selectItem(item: WorkflowRosterItem): void {
		const previousRunId = this.selectedAgent()?.runId;
		this.expandedRunId = item.runId;
		this.selectedKey = item.key;
		this.detailScroll = 0;
		this.detailAutoFollow = item.kind === "agent" && Boolean(item.agent.runId);
		if (item.kind !== "agent" || item.agent.runId !== previousRunId) {
			this.transcriptRequest?.abort();
			this.transcript = undefined;
		}
		if (item.kind === "agent" && item.agent.runId) void this.loadTranscript(false);
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		const roster = this.rosterItems();
		if (roster.length === 0) return;
		const current = Math.max(0, roster.findIndex((item) => item.key === this.selectedKey));
		const target = roster[Math.max(0, Math.min(roster.length - 1, current + delta))];
		if (target) this.selectItem(target);
	}

	private scrollDetail(delta: number): void {
		const maximum = Math.max(0, this.detailLineCount - this.detailViewportHeight);
		this.detailScroll = Math.max(0, Math.min(maximum, this.detailScroll + delta));
		this.detailAutoFollow = this.detailScroll >= maximum;
		this.tui.requestRender();
	}

	private async loadTranscript(append: boolean): Promise<void> {
		const item = this.selectedItem();
		if (item?.kind !== "agent" || !item.agent.runId || this.disposed) return;
		const childRunId = item.agent.runId;
		const cursor = append ? this.transcript?.nextCursor : 0;
		if (cursor === undefined || this.transcript?.loading && this.transcript.loadedAt > 0) return;
		this.transcriptRequest?.abort();
		const request = new AbortController();
		this.transcriptRequest = request;
		const previous = this.transcript;
		this.transcript = {
			...(previous ?? { status: "ok", events: [], truncated: false }),
			cursor,
			runId: childRunId,
			loading: true,
			loadedAt: previous?.loadedAt ?? 0,
		};
		this.tui.requestRender();
		let page: WorkflowTranscriptPage;
		try {
			page = await this.source.loadTranscript(childRunId, 0, cursor, 50, request.signal);
		} catch (error) {
			page = {
				status: "unavailable",
				events: [],
				cursor,
				truncated: previous?.truncated ?? false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		if (this.disposed || request.signal.aborted || this.selectedAgent()?.runId !== childRunId) return;
		const preserved = page.status !== "ok" && (previous?.events.length ?? 0) > 0;
		const events = preserved ? requirePresent(previous).events : append ? [...(previous?.events ?? []), ...page.events] : page.events;
		this.transcript = {
			...page,
			events,
			...(preserved && previous?.nextCursor !== undefined ? { nextCursor: previous.nextCursor } : {}),
			runId: childRunId,
			loading: false,
			loadedAt: Date.now(),
		};
		this.tui.requestRender();
	}

	private cancelSelected(): void {
		const entry = this.selectedEntry();
		if (!entry?.live) {
			this.showNotice("Only a live workflow can be cancelled");
			return;
		}
		const now = Date.now();
		if (!this.cancelConfirmation || this.cancelConfirmation.runId !== entry.runId || now > this.cancelConfirmation.expiresAt) {
			this.cancelConfirmation = { runId: entry.runId, expiresAt: now + CANCEL_CONFIRM_MS };
			this.showNotice("Press c again within 3 seconds to cancel this workflow");
			return;
		}
		this.cancelConfirmation = undefined;
		this.showNotice(this.source.cancel(entry.runId, "Cancelled from /workflows") ? "Cancellation requested" : "Workflow is no longer active");
		this.refresh();
	}

	handleInput(data: string): void {
		const up = this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k");
		const down = this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j");
		const cancel = this.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape");
		if (cancel || matchesKey(data, "q")) {
			this.closeDashboard();
			return;
		}
		if (matchesKey(data, Key.shift("k"))) {
			this.scrollDetail(-1);
			return;
		}
		if (matchesKey(data, Key.shift("j"))) {
			this.scrollDetail(1);
			return;
		}
		if (up) {
			this.moveSelection(-1);
			return;
		}
		if (down) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "home")) {
			this.moveSelection(-this.rosterItems().length);
			return;
		}
		if (matchesKey(data, "end")) {
			this.moveSelection(this.rosterItems().length);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollDetail(-this.detailViewportHeight);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollDetail(this.detailViewportHeight);
			return;
		}
		if (data === "c") {
			this.cancelSelected();
			this.tui.requestRender();
			return;
		}
		if (data === "n" && this.transcript?.nextCursor !== undefined) {
			void this.loadTranscript(true);
			return;
		}
		if (data.toLowerCase() === "x" || matchesKey(data, "ctrl+o")) {
			this.expandedTools = !this.expandedTools;
			this.detailAutoFollow = Boolean(this.selectedAgent()?.runId);
			this.tui.requestRender();
			return;
		}
		if (data === "r" || this.keybindings.matches(data, "tui.select.confirm")) {
			if (this.selectedAgent()?.runId) void this.loadTranscript(false);
			else {
				this.history = this.source.loadHistory();
				this.refresh();
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		this.refresh();
		if (width < MIN_WIDTH) {
			return [truncateToWidth("Workflow inspector needs at least 50 columns. Esc closes.", width, "")];
		}
		const innerWidth = width - 2;
		const rows = this.tui.terminal?.rows ?? 32;
		const availableHeight = Math.max(1, Math.floor(rows * 0.85));
		if (availableHeight < MIN_FRAME_HEIGHT) {
			return [truncateToWidth("Workflow inspector needs at least 12 terminal rows. Esc closes.", width, "")];
		}
		const frameHeight = Math.min(MAX_FRAME_HEIGHT, availableHeight);
		this.bodyHeight = Math.max(4, frameHeight - 6);
		const rosterWidth = Math.max(24, Math.min(50, Math.floor((innerWidth - 1) * 0.38)));
		const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
		const roster = this.rosterLines(rosterWidth);
		const detail = this.detailSections(detailWidth);
		const detailHeader = detail.header.slice(0, Math.max(0, this.bodyHeight - 1));
		this.detailViewportHeight = Math.max(1, this.bodyHeight - detailHeader.length);
		this.detailLineCount = detail.body.length;
		const maximum = Math.max(0, detail.body.length - this.detailViewportHeight);
		if (this.detailAutoFollow) this.detailScroll = maximum;
		else this.detailScroll = Math.min(this.detailScroll, maximum);
		const visibleDetail = [
			...detailHeader,
			...detail.body.slice(this.detailScroll, this.detailScroll + this.detailViewportHeight),
		];

		const selected = this.selectedItem();
		const title = ` ${this.theme.bold("Workflow fleet inspector")} ${this.theme.fg("dim", "· live + history")}`;
		const selectedStatus = selected
			? `${marker(selected.kind === "agent" ? selected.agent.state : entryState(selected.entry), this.theme)} ${clean(selected.kind === "agent" ? selected.agent.label : selected.entry.details.name, 80)} `
			: this.theme.fg("dim", "no workflows ");
		const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
		lines.push(this.theme.fg("border", "│") + rightAligned(title, selectedStatus, innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`));
		for (let index = 0; index < this.bodyHeight; index++) {
			lines.push(
				this.theme.fg("border", "│")
						+ fitText(roster[index] ?? "", rosterWidth)
					+ this.theme.fg("border", "│")
						+ fitText(visibleDetail[index] ?? "", detailWidth)
					+ this.theme.fg("border", "│"),
			);
		}
		lines.push(this.theme.fg("border", `├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
		const rosterItems = this.rosterItems();
		const position = rosterItems.length ? `${Math.max(0, rosterItems.findIndex((item) => item.key === this.selectedKey)) + 1}/${rosterItems.length}` : "0/0";
		const pagination = this.transcript?.nextCursor !== undefined ? " · n next" : "";
		const toolToggle = this.expandedTools ? "x collapse tools" : "x expand tools";
		const footerText = this.notice
			?? ` ↑↓/jk workflow/agent · ⇧k/⇧j scroll · PgUp/PgDn page · ${toolToggle} · r refresh${pagination} · c cancel · Esc close · ${position}`;
		lines.push(this.theme.fg("border", "│") + fitText(this.theme.fg("dim", footerText), innerWidth) + this.theme.fg("border", "│"));
		lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	private rosterLines(width: number): string[] {
		const roster = this.rosterItems();
		if (roster.length === 0) return [this.theme.fg("dim", " No workflow runs")];
		const selected = Math.max(0, roster.findIndex((item) => item.key === this.selectedKey));
		const start = Math.max(0, Math.min(selected - this.bodyHeight + 1, Math.max(0, roster.length - this.bodyHeight)));
		return roster.slice(start, start + this.bodyHeight).map((item, offset) => {
			const index = start + offset;
			const pointer = index === selected ? this.theme.fg("accent", "›") : " ";
			if (item.kind === "workflow") {
				const state = entryState(item.entry);
				const name = index === selected ? this.theme.bold(clean(item.entry.details.name, 120)) : clean(item.entry.details.name, 120);
				const count = countAgents(item.entry.details);
				const left = `${pointer} ${marker(state, this.theme)} ${name}`;
				return rightAligned(left, this.theme.fg("dim", `${count.done}/${item.entry.details.agents.length}`), width);
			}
			const branch = item.isLast ? "└" : "├";
			const label = index === selected ? this.theme.bold(clean(item.agent.label, 100)) : clean(item.agent.label, 100);
			const left = `${pointer}   ${this.theme.fg("dim", branch)} ${marker(item.agent.state, this.theme)} ${label}`;
			return rightAligned(left, this.theme.fg("dim", item.agent.state), width);
		});
	}

	private detailSections(width: number): DetailSections {
		const item = this.selectedItem();
		if (!item) return { header: [], body: [this.theme.fg("dim", "No workflow selected.")] };
		return item.kind === "workflow"
			? this.workflowDetail(item.entry, width)
			: this.agentDetail(item.entry, item.agent, width);
	}

	private workflowDetail(entry: WorkflowDashboardEntry, width: number): DetailSections {
		const details = entry.details;
		const state = entryState(entry);
		const count = countAgents(details);
		const header = wrapLines([
			this.theme.bold(clean(details.name, 500)),
			this.theme.fg("dim", `${details.runId} · ${state} · ${count.done}/${details.agents.length} done · ${count.failed} failed · ${elapsed(details.startedAt, details.endedAt)}`),
		], width);
		const body: string[] = [];
		if (details.description) body.push(...wrapLines([clean(details.description, 2_000), ""], width));
		if (details.currentPhase) body.push(...wrapLines([this.theme.fg("accent", `Current phase: ${clean(details.currentPhase, 300)}`)], width));
		if (details.phases.length > 0) body.push(...wrapLines([this.theme.fg("muted", `Phases: ${details.phases.map((phase) => clean(phase, 120)).join(" → ")}`)], width));
		body.push("");
		for (const agent of [...details.agents].sort((left, right) => left.index - right.index)) {
			const runtime = agent.startedAt === undefined ? "" : ` · ${elapsed(agent.startedAt, agent.endedAt)}`;
			body.push(...wrapLines([
				`${marker(agent.state, this.theme)} ${this.theme.bold(clean(agent.label, 200))} ${this.theme.fg("dim", `· ${clean(agent.agent)} · ${agent.state}${runtime}`)}`,
			], width));
		}
		if (details.error) body.push("", ...wrapLines([this.theme.fg("error", `Error: ${clean(details.error, 2_000)}`)], width));
		if (details.result !== undefined) {
			let result = clean(details.result, 2_000);
			try { result = sanitizeForDisplay(JSON.stringify(details.result, null, 2)); } catch {}
			body.push("", this.theme.fg("muted", "Result:"), ...wrapLines(result.split("\n").slice(0, 50), width));
		}
		body.push("", ...wrapLines([this.theme.fg("dim", `Artifacts: ${workflowRoot()}/${details.runId}`)], width));
		return { header, body };
	}

	private agentDetail(entry: WorkflowDashboardEntry, agent: WorkflowAgentRecord, width: number): DetailSections {
		const runtime = elapsed(agent.startedAt ?? entry.details.startedAt, agent.endedAt);
		const header = wrapLines([
			this.theme.bold(clean(agent.label, 500)),
			this.theme.fg("dim", `${clean(agent.agent)} · ${agent.state} · ${runtime}${agent.phase ? ` · ${clean(agent.phase)}` : ""}`),
			this.theme.fg("muted", [agent.model, agent.currentTool, agent.toolCount !== undefined ? `${agent.toolCount} tools` : undefined, agent.tokens !== undefined ? `${agent.tokens} tokens` : undefined].filter(Boolean).join(" · ")),
		], width);
		const body: string[] = [];
		if (agent.error) body.push(...wrapLines([this.theme.fg("error", clean(agent.error, 2_000)), ""], width));
		else if (agent.preview) body.push(...wrapLines([this.theme.fg("dim", clean(agent.preview, 2_000)), ""], width));
		if (!agent.runId) {
			body.push(this.theme.fg("dim", "Child run ID is not available yet."));
			return { header, body };
		}
		body.push(this.theme.fg("muted", `Child run: ${clean(agent.runId, 160)}`), "");
		const transcript = this.transcript?.runId === agent.runId ? this.transcript : undefined;
		if (!transcript || transcript.loading && transcript.events.length === 0) {
			body.push(this.theme.fg("dim", "Loading transcript…"));
			return { header, body };
		}
		if (transcript.status !== "ok") body.push(...wrapLines([this.theme.fg("warning", clean(transcript.error ?? "Transcript API unavailable", 1_000)), ""], width));
		if (transcript.events.length === 0) {
			body.push(this.theme.fg("dim", transcript.status === "ok" ? "No transcript events yet." : "Use /subagents-fleet for the full transcript."));
			return { header, body };
		}
		if (transcript.warning) body.push(...wrapLines([this.theme.fg("warning", clean(transcript.warning, 1_000)), ""], width));
		for (const event of transcript.events) body.push(...this.formatTranscriptEvent(event, width));
		if (transcript.nextCursor !== undefined) body.push("", this.theme.fg("dim", "Press n to load the next transcript page."));
		return { header, body };
	}

	private formatTranscriptEvent(event: WorkflowTranscriptEvent, width: number): string[] {
		if (event.kind === "user") return wrapLines([`${this.theme.fg("accent", "USER")} ${this.theme.fg("toolOutput", clean(event.text, 2_000))}`], width);
		if (event.kind === "assistant") return wrapLines([`${this.theme.fg("success", "ASSISTANT")}${event.model ? this.theme.fg("dim", ` ${clean(event.model, 100)}`) : ""} ${this.theme.fg("toolOutput", clean(event.text, 2_000))}`], width);
		if (event.kind === "notice") return wrapLines([`${this.theme.fg(event.tone === "error" ? "error" : event.tone === "warning" ? "warning" : "muted", "NOTICE")} ${this.theme.fg("dim", clean(event.text, 2_000))}`], width);
		return this.formatToolEvent(event, width);
	}

	private formatToolEvent(event: Extract<WorkflowTranscriptEvent, { kind: "tool" }>, width: number): string[] {
		const glyphColor = event.status === "error" ? "error" : event.status === "running" ? "warning" : "success";
		const glyph = this.theme.fg(glyphColor, event.status === "error" ? "✗" : event.status === "running" ? "●" : "✓");
		const duration = event.startedAt !== undefined && event.endedAt !== undefined
			? `${((event.endedAt - event.startedAt) / 1_000).toFixed(1)}s`
			: undefined;
		const rail = (content: string) => truncateToWidth(`${this.theme.fg("borderMuted", "│")} ${content}`, width, "");
		const title = `${this.theme.fg("borderMuted", "├─")} ${glyph} ${this.theme.fg("toolTitle", this.theme.bold(clean(event.name, 160)))}`;
		const hasDetails = Boolean(event.args || event.output || event.error);

		if (!this.expandedTools || !hasDetails) {
			const args = event.args ? ` ${this.theme.fg("dim", clean(event.args, 500))}` : "";
			const running = event.status === "running" ? this.theme.fg("warning", " running") : "";
			const lines = [truncateToWidth(`${title}${args}${running}`, width, "…")];
			if (event.error) {
				lines.push(rail(this.theme.fg("error", `  ${truncateToWidth(clean(event.error, 2_000), Math.max(1, width - 18), "…")} · x to expand`)));
				return lines;
			}
			if (event.output && event.name === "bash") {
				const outputLines = event.output.replace(/\s+$/, "").split(/\r?\n/);
				const visible = outputLines.slice(-TOOL_PREVIEW_LINES);
				const hidden = Math.max(0, outputLines.length - visible.length);
				for (const outputLine of visible) {
					lines.push(rail(this.theme.fg("toolOutput", `  ${truncateToWidth(outputLine, Math.max(1, width - 6), "…")}`)));
				}
				if (hidden > 0) lines.push(rail(this.theme.fg("dim", `  … ${hidden} earlier lines · x to expand`)));
				if (duration) lines.push(rail(this.theme.fg("dim", `  Took ${duration}`)));
			} else if (event.output) {
				const summary = truncateToWidth(clean(event.output, 4_000), Math.max(1, width - 18), "…");
				if (summary) lines.push(rail(this.theme.fg("dim", `  ${summary} · x to expand`)));
			} else if (hasDetails) {
				lines.push(rail(this.theme.fg("dim", "  x to expand")));
			}
			return lines;
		}

		const lines = [title];
		if (event.args) {
			lines.push(rail(this.theme.fg("dim", "  args")));
			for (const line of event.args.split(/\r?\n/)) {
				for (const wrapped of wrapLines([this.theme.fg("muted", line)], Math.max(1, width - 4))) lines.push(rail(`  ${wrapped}`));
			}
		}
		const output = event.error ?? event.output;
		if (output) {
			lines.push(rail(this.theme.fg(event.error ? "error" : "dim", event.error ? "  error" : "  output")));
			for (const line of output.split(/\r?\n/)) {
				for (const wrapped of wrapLines([this.theme.fg(event.error ? "error" : "toolOutput", line)], Math.max(1, width - 4))) lines.push(rail(`  ${wrapped}`));
			}
		}
		if (duration) lines.push(rail(this.theme.fg("dim", `  Took ${duration}`)));
		lines.push(rail(this.theme.fg("dim", "  x to collapse")));
		return lines;
	}
}

export async function showWorkflowDashboard(
	ctx: ExtensionContext,
	source: WorkflowDashboardSource,
	initialRunId?: string,
	lifetimeSignal?: AbortSignal,
	initialNodeId?: string,
	openInitialTranscript = false,
	closeOnBack = false,
): Promise<void> {
	let dashboard: WorkflowDashboard | undefined;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				dashboard = new WorkflowDashboard(
					tui,
					theme,
					keybindings,
					source,
					() => done(undefined),
					lifetimeSignal,
					initialRunId,
					initialNodeId,
					openInitialTranscript,
					closeOnBack,
				);
				return dashboard;
			},
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 },
			},
		);
	} finally {
		dashboard?.dispose();
	}
}
