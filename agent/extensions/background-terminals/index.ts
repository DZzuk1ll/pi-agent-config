import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BackgroundTerminalManager } from "./manager.ts";
import type { TerminalSnapshot } from "./types.ts";
import { DeferredResultDelivery } from "../_shared/runtime/lifecycle.ts";
import { boundToolText, sanitizeForDisplay, tailLines } from "../_shared/runtime/text.ts";

const WIDGET_KEY = "background-terminals";

function elapsed(snapshot: TerminalSnapshot): string {
	const milliseconds = (snapshot.endedAt ?? Date.now()) - snapshot.startedAt;
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
	return `${Math.floor(milliseconds / 60_000)}m ${Math.floor((milliseconds % 60_000) / 1_000)}s`;
}

function statusLine(snapshot: TerminalSnapshot): string {
	const exit = snapshot.exitCode === undefined ? "" : ` exit=${snapshot.exitCode}`;
	return `${snapshot.id} ${snapshot.state}${exit} ${elapsed(snapshot)} — ${snapshot.title}`;
}

function streamSection(label: string, stream: TerminalSnapshot["stdout"], lineLimit: number): string {
	const display = sanitizeForDisplay(tailLines(stream.text, lineLimit));
	const notes = [
		stream.omittedBytes > 0 ? `[${stream.omittedBytes} earlier in-memory bytes omitted]` : "",
		stream.spillCapped ? `[full log capped at ${stream.spillBytes} bytes]` : "",
		stream.spillEvicted ? "[full log evicted by the session storage budget]" : "",
		stream.spillPath ? `[full log: ${stream.spillPath}]` : "",
	].filter(Boolean);
	return `${label}\n${display || "(no output)"}${notes.length ? `\n${notes.join("\n")}` : ""}`;
}

function formatSnapshot(snapshot: TerminalSnapshot, lineLimit = 120): string {
	const lines = [
		statusLine(snapshot),
		`cwd: ${snapshot.cwd}`,
		...(snapshot.pid ? [`pid: ${snapshot.pid}`] : []),
		...(snapshot.signal ? [`signal: ${snapshot.signal}`] : []),
		...(snapshot.error ? [`error: ${sanitizeForDisplay(snapshot.error)}`] : []),
		...(snapshot.residualTreeTerminated ? ["note: residual processes were terminated after the shell exited"] : []),
		"",
		streamSection("STDOUT", snapshot.stdout, lineLimit),
		"",
		streamSection("STDERR", snapshot.stderr, lineLimit),
	];
	return boundToolText(lines.join("\n")).text;
}

function compactSnapshot(snapshot: TerminalSnapshot) {
	const compactStream = (stream: TerminalSnapshot["stdout"]) => ({
		omittedBytes: stream.omittedBytes,
		spillPath: stream.spillPath,
		spillBytes: stream.spillBytes,
		spillCapped: stream.spillCapped,
		spillEvicted: stream.spillEvicted,
	});
	return {
		id: snapshot.id,
		title: snapshot.title,
		cwd: snapshot.cwd,
		pid: snapshot.pid,
		state: snapshot.state,
		startedAt: snapshot.startedAt,
		endedAt: snapshot.endedAt,
		exitCode: snapshot.exitCode,
		signal: snapshot.signal,
		error: snapshot.error,
		residualTreeTerminated: snapshot.residualTreeTerminated,
		stdout: compactStream(snapshot.stdout),
		stderr: compactStream(snapshot.stderr),
	};
}

export default function backgroundTerminals(pi: ExtensionAPI): void {
	let manager: BackgroundTerminalManager | undefined;
	let ui: { setWidget: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void; notify: (message: string, level?: "info" | "warning" | "error") => void } | undefined;
	let unsubscribe: (() => void) | undefined;
	let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
	const delivery = new DeferredResultDelivery<TerminalSnapshot>();

	const updateWidget = () => {
		if (!ui || !manager) return;
		const active = manager.list(false);
		if (active.length === 0) {
			ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const latest = active[0];
		ui.setWidget(WIDGET_KEY, [`BG ${active.length}/${8}  ${latest.id} ${elapsed(latest)} — ${sanitizeForDisplay(latest.title)}`], {
			placement: "belowEditor",
		});
	};

	const flushDelivery = () => {
		deliveryTimer = undefined;
		for (const snapshot of delivery.drain()) {
			try {
				pi.sendMessage(
					{
						customType: "background-terminal-result",
						content: formatSnapshot(snapshot, 80),
						display: true,
						details: { id: snapshot.id, state: snapshot.state },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch {
				// The session may be shutting down. Do not leak the result into a future session.
			}
		}
	};

	const scheduleDelivery = (snapshot: TerminalSnapshot, consumed: boolean) => {
		if (consumed) {
			delivery.consume([snapshot.id]);
			return;
		}
		delivery.queue(snapshot);
		if (!deliveryTimer) deliveryTimer = setTimeout(flushDelivery, 25);
	};

	const requireManager = (): BackgroundTerminalManager => {
		if (!manager) throw new Error("Background terminals are not attached to an active Pi session");
		return manager;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (manager) await manager.dispose();
		manager = new BackgroundTerminalManager(ctx.cwd);
		manager.setOnSettled(scheduleDelivery);
		unsubscribe?.();
		unsubscribe = manager.subscribe(updateWidget);
		ui = ctx.ui;
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		if (deliveryTimer) clearTimeout(deliveryTimer);
		deliveryTimer = undefined;
		delivery.clear();
		unsubscribe?.();
		unsubscribe = undefined;
		ui?.setWidget(WIDGET_KEY, undefined);
		ui = undefined;
		const current = manager;
		manager = undefined;
		await current?.dispose();
	});

	pi.registerTool({
		name: "bg_start",
		label: "Start Background Terminal",
		description: "Start a non-interactive background shell command inside the current project. Use for servers, watchers, and long-running commands; do not poll after launch.",
		promptSnippet: "Start a bounded background terminal task",
		promptGuidelines: [
			"Use bg_start only for commands that should continue while the agent does other work.",
			"After bg_start, continue useful work and rely on the automatic completion follow-up instead of polling.",
		],
		parameters: Type.Object({
			command: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
			title: Type.Optional(Type.String({ maxLength: 120 })),
			cwd: Type.Optional(Type.String({ description: "Existing project-relative directory, or an absolute directory inside the current project" })),
		}),
		async execute(_id, params) {
			const snapshot = await requireManager().start(params);
			return {
				content: [{ type: "text", text: `${statusLine(snapshot)}\nCompletion will be delivered automatically; do not poll.` }],
				details: compactSnapshot(snapshot),
			};
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background Terminal Status",
		description: "Inspect one background terminal when its current state or output is actually needed.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, maxLength: 64 }),
			tailLines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 120 })),
		}),
		async execute(_id, params) {
			const snapshot = requireManager().get(params.id);
			if (!snapshot) throw new Error(`Unknown background terminal: ${params.id}`);
			if (snapshot.state !== "running" && snapshot.state !== "starting") delivery.consume([snapshot.id]);
			return { content: [{ type: "text", text: formatSnapshot(snapshot, params.tailLines ?? 120) }], details: compactSnapshot(snapshot) };
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List Background Terminals",
		description: "List active background terminals, optionally including up to 50 recently settled tasks.",
		parameters: Type.Object({
			includeSettled: Type.Optional(Type.Boolean({ default: false })),
		}),
		async execute(_id, params) {
			const snapshots = requireManager().list(params.includeSettled ?? false);
			const text = snapshots.length === 0 ? "No background terminals." : snapshots.map(statusLine).join("\n");
			return { content: [{ type: "text", text }], details: { terminals: snapshots.map(compactSnapshot) } };
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Stop Background Terminals",
		description: "Stop one or more background terminals and their process trees, then return their final states.",
		parameters: Type.Object({
			ids: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 8 }),
		}),
		async execute(_id, params) {
			const snapshots = await requireManager().kill(params.ids, true);
			delivery.consume(snapshots.map((snapshot) => snapshot.id));
			const combined = snapshots.map((snapshot) => formatSnapshot(snapshot, 80)).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text: boundToolText(combined).text }],
				details: { terminals: snapshots.map(compactSnapshot) },
			};
		},
	});

	pi.registerCommand("ps", {
		description: "Inspect and stop background terminal tasks",
		handler: async (_args, ctx) => {
			const current = manager;
			if (!current) {
				ctx.ui.notify("No active background terminal manager.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				pi.sendMessage({
					customType: "background-terminal-list",
					content: current.list(true).map(statusLine).join("\n") || "No background terminals.",
					display: true,
				}, { triggerTurn: false });
				return;
			}
			while (true) {
				const snapshots = current.list(true);
				const labels = snapshots.map(statusLine);
				const choice = await ctx.ui.select("Background terminals", [...labels, "Refresh", "Close"]);
				if (!choice || choice === "Close") return;
				if (choice === "Refresh") continue;
				const snapshot = snapshots[labels.indexOf(choice)];
				if (!snapshot) continue;
				const active = snapshot.state === "running" || snapshot.state === "starting";
				const action = await ctx.ui.select(snapshot.id, ["View output", ...(active ? ["Stop process tree"] : []), "Back"]);
				if (action === "View output") ctx.ui.notify(formatSnapshot(current.get(snapshot.id) ?? snapshot, 200), "info");
				if (action === "Stop process tree") current.requestKill(snapshot.id);
			}
		},
	});
}
