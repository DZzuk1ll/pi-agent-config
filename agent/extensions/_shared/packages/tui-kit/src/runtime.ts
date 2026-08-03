import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createMenuScreenComponent,
	type MenuInputSubmit,
	type MenuMultiSelectChange,
	type MenuScreenComponent,
	type MenuScreenEvent,
	type MenuSettingChange,
	reviewDialogPages,
	safeMenuText,
} from "./components/index.js";
import { resolveMenuScreen } from "./model.js";
import { createMenuNavigator } from "./navigator.js";
import { runTask } from "./task.js";
import type {
	ActionMenuItem,
	MenuActionHandler,
	MenuActionResult,
	MenuContext,
	MenuDefinition,
	MenuScreen,
	MenuTransition,
} from "./types.js";

type ExtensionMode = MenuContext["mode"];

export type RunMenuResult =
	| { kind: "closed" }
	| { kind: "stale" }
	| { kind: "unsupported"; mode: ExtensionMode }
	| { kind: "error"; error: unknown };

export interface RunMenuOptions<State, Context extends MenuContext = ExtensionCommandContext> {
	getState(context: { ctx: Context; signal: AbortSignal }): State | Promise<State>;
	signal?: AbortSignal;
	isCurrent?(): boolean;
	onError?(ctx: Context, error: unknown): void | Promise<void>;
	onUnsupportedMode?(ctx: Context, mode: ExtensionMode): void | Promise<void>;
}

interface ActionInvocation<ScreenId extends string> {
	accepted: boolean;
	stale: boolean;
	transition: MenuTransition<ScreenId>;
}

type InternalScreenEvent<ScreenId extends string> =
	| MenuScreenEvent
	| { kind: "transition"; transition: MenuTransition<ScreenId> };

export async function runMenu<
	State,
	ScreenId extends string,
	ActionId extends string,
	Context extends MenuContext = ExtensionCommandContext,
>(
	ctx: Context,
	definition: MenuDefinition<State, ScreenId, ActionId, Context>,
	options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
	if (ctx.mode === "tui" && ctx.hasUI) return runTuiMenu(ctx, definition, options);
	if (ctx.mode === "rpc" && ctx.hasUI) return runDialogMenu(ctx, definition, options);
	await options.onUnsupportedMode?.(ctx, ctx.mode);
	return { kind: "unsupported", mode: ctx.mode };
}

async function runTuiMenu<
	State,
	ScreenId extends string,
	ActionId extends string,
	Context extends MenuContext,
>(
	ctx: Context,
	definition: MenuDefinition<State, ScreenId, ActionId, Context>,
	options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
	const menuController = new AbortController();
	const menuSignal = options.signal
		? AbortSignal.any([menuController.signal, options.signal])
		: menuController.signal;
	const navigator = createMenuNavigator(definition.start);
	try {
		while (!navigator.closed) {
			const loaded = await loadState(ctx, options, menuSignal);
			if (loaded.kind !== "loaded") return loaded.result;
			const state = loaded.state;
			const screen = resolveMenuScreen(definition, navigator.current, state);
			let staleAction = false;
			const event = await showTuiScreen(
				ctx,
				screen,
				navigator.selectionFor(navigator.current, selectableItemIds(screen)),
				menuSignal,
				{
					onSelectionChange: (itemId) => navigator.rememberSelection(navigator.current, itemId),
					onSettingChange: async (change, signal) => {
						const item =
							screen.kind === "settings"
								? screen.items.find((candidate) => candidate.id === change.itemId)
								: undefined;
						if (!item || item.disabled) return rejected();
						navigator.rememberSelection(navigator.current, change.itemId);
						const invocation = await invokeAction(
							ctx,
							definition.actions[item.action],
							state,
							AbortSignal.any([menuSignal, signal]),
							change.itemId,
							options,
							{ value: change.value },
						);
						if (invocation.stale) staleAction = true;
						return invocation;
					},
					onMultiSelectChange: async (change, signal) => {
						if (screen.kind !== "multiSelect") return rejected();
						const item = screen.items.find((candidate) => candidate.id === change.itemId);
						if (!item || item.disabled) return rejected();
						navigator.rememberSelection(navigator.current, change.itemId);
						const invocation = await invokeAction(
							ctx,
							definition.actions[screen.action],
							state,
							AbortSignal.any([menuSignal, signal]),
							change.itemId,
							options,
							{ selected: change.selected },
						);
						if (invocation.stale) staleAction = true;
						return invocation;
					},
					onInputSubmit: async (change, signal) => {
						if (screen.kind !== "input") return rejected();
						const invocation = await invokeAction(
							ctx,
							definition.actions[screen.action],
							state,
							AbortSignal.any([menuSignal, signal]),
							"input",
							options,
							{ value: change.value },
						);
						if (invocation.stale) {
							staleAction = true;
							return accepted({ kind: "close" });
						}
						return invocation;
					},
				},
			);
			if (staleAction || !isCurrent(options) || menuSignal.aborted) {
				return { kind: "stale" };
			}
			if (!event) {
				navigator.apply({ kind: "close" });
				continue;
			}
			if (event.kind === "back" || event.kind === "close") {
				navigator.apply({ kind: event.kind });
				continue;
			}
			if (event.kind === "transition") {
				navigator.apply(event.transition);
				continue;
			}
			if (screen.kind === "choice") {
				const item = screen.items.find((candidate) => candidate.id === event.itemId);
				if (!item || item.disabled) continue;
				navigator.rememberSelection(navigator.current, item.id);
				const outcome = await invokeAction(
					ctx,
					definition.actions[screen.action],
					state,
					menuSignal,
					item.id,
					options,
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			if (screen.kind === "review") {
				if (!screen.confirm || screen.confirm.id !== event.itemId) continue;
				const outcome = await invokeAction(
					ctx,
					definition.actions[screen.confirm.action],
					state,
					menuSignal,
					screen.confirm.id,
					options,
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			const actionItems =
				screen.kind === "actions"
					? screen.items
					: screen.kind === "multiSelect"
						? (screen.actions ?? [])
						: [];
			const item = actionItems.find((candidate) => candidate.id === event.itemId);
			if (!item || item.disabled) continue;
			navigator.rememberSelection(navigator.current, item.id);
			const outcome = await activateActionItem(ctx, definition, item, state, menuSignal, options);
			if (outcome.stale) return { kind: "stale" };
			navigator.apply(outcome.transition);
		}
		return { kind: "closed" };
	} catch (error) {
		if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
		await reportError(ctx, options, error);
		if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
		return { kind: "error", error };
	} finally {
		menuController.abort(new DOMException("Menu closed", "AbortError"));
	}
}

function selectableItemIds<ScreenId extends string, ActionId extends string>(
	screen: MenuScreen<ScreenId, ActionId>,
) {
	if (!("items" in screen)) return [];
	if (screen.kind === "multiSelect") {
		return [...screen.items, ...(screen.actions ?? [])].map((item) => item.id);
	}
	const itemIds = screen.items.map((item) => item.id);
	if (screen.kind !== "choice") return itemIds;
	const preferred = [screen.initialItemId, screen.currentItemId].find(
		(itemId): itemId is string => itemId !== undefined && itemIds.includes(itemId),
	);
	return preferred ? [preferred, ...itemIds.filter((itemId) => itemId !== preferred)] : itemIds;
}

async function showTuiScreen<
	ScreenId extends string,
	ActionId extends string,
	Context extends MenuContext,
>(
	ctx: Context,
	screen: MenuScreen<ScreenId, ActionId>,
	selectedItemId: string | undefined,
	menuSignal: AbortSignal,
	callbacks: {
		onSelectionChange(itemId: string): void;
		onSettingChange(
			change: MenuSettingChange,
			signal: AbortSignal,
		): Promise<ActionInvocation<ScreenId>>;
		onMultiSelectChange(
			change: MenuMultiSelectChange,
			signal: AbortSignal,
		): Promise<ActionInvocation<ScreenId>>;
		onInputSubmit(
			change: MenuInputSubmit,
			signal: AbortSignal,
		): Promise<ActionInvocation<ScreenId>>;
	},
): Promise<InternalScreenEvent<ScreenId> | undefined> {
	let component: MenuScreenComponent | undefined;
	let removeAbortListener = () => {};
	try {
		return await uiFor(ctx).custom<InternalScreenEvent<ScreenId> | undefined>(
			(tui, theme, keybindings, done) => {
				const screenController = new AbortController();
				let finished = false;
				const finish = (event: InternalScreenEvent<ScreenId>) => {
					if (finished) return;
					finished = true;
					done(event);
				};
				const abortScreen = () => {
					screenController.abort(new DOMException("Menu owner disposed", "AbortError"));
					finish({ kind: "close" });
				};
				menuSignal.addEventListener("abort", abortScreen, { once: true });
				removeAbortListener = () => menuSignal.removeEventListener("abort", abortScreen);
				if (menuSignal.aborted) abortScreen();
				component = createMenuScreenComponent({
					screen,
					selectedItemId,
					tui,
					theme,
					keybindings,
					onEvent: finish,
					onSelectionChange: callbacks.onSelectionChange,
					onSettingChange: (change) => callbacks.onSettingChange(change, screenController.signal),
					onMultiSelectChange: (change) =>
						callbacks.onMultiSelectChange(change, screenController.signal),
					onInputSubmit: (change) => callbacks.onInputSubmit(change, screenController.signal),
					onTransition: (transition) => finish({ kind: "transition", transition }),
					onDispose: () => {
						removeAbortListener();
						screenController.abort(new DOMException("Menu screen disposed", "AbortError"));
					},
				});
				return component;
			},
		);
	} finally {
		removeAbortListener();
		await component?.waitForPending();
	}
}

async function activateActionItem<
	State,
	ScreenId extends string,
	ActionId extends string,
	Context extends MenuContext,
>(
	ctx: Context,
	definition: MenuDefinition<State, ScreenId, ActionId, Context>,
	item: ActionMenuItem<ScreenId, ActionId>,
	state: State,
	menuSignal: AbortSignal,
	options: RunMenuOptions<State, Context>,
): Promise<ActionInvocation<ScreenId>> {
	if ("to" in item && item.to !== undefined) return accepted({ kind: "to", screen: item.to });
	if ("close" in item) return accepted({ kind: "close" });
	if (!("action" in item) || item.action === undefined) return rejected();
	const handler = definition.actions[item.action];
	if ("busyLabel" in item && item.busyLabel && ctx.mode === "tui" && ctx.hasUI) {
		return invokeBusyAction(ctx, handler, state, item.id, item.busyLabel, menuSignal, options);
	}
	return invokeAction(ctx, handler, state, menuSignal, item.id, options);
}

async function invokeBusyAction<State, ScreenId extends string, Context extends MenuContext>(
	ctx: Context,
	handler: MenuActionHandler<State, ScreenId, Context>,
	state: State,
	itemId: string,
	label: string,
	menuSignal: AbortSignal,
	options: RunMenuOptions<State, Context>,
): Promise<ActionInvocation<ScreenId>> {
	const result = await runTask(ctx, {
		label,
		signal: menuSignal,
		isCurrent: options.isCurrent,
		onError: () => undefined,
		task: ({ signal }) => invokeAction(ctx, handler, state, signal, itemId, options, {}, false),
	});
	switch (result.kind) {
		case "completed":
			return result.value;
		case "cancelled":
			return rejected();
		case "stale":
			return { ...rejected<ScreenId>(), stale: true };
		case "error":
			throw result.error;
	}
}

async function invokeAction<State, ScreenId extends string, Context extends MenuContext>(
	ctx: Context,
	handler: MenuActionHandler<State, ScreenId, Context>,
	state: State,
	signal: AbortSignal,
	itemId: string,
	options: RunMenuOptions<State, Context>,
	input: { value?: string; selected?: boolean } = {},
	abortIsStale = true,
): Promise<ActionInvocation<ScreenId>> {
	if (!isCurrent(options)) return { ...rejected<ScreenId>(), stale: true };
	if (signal.aborted) {
		return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
	}
	let result: MenuActionResult<ScreenId>;
	try {
		result = await handler({ ctx, state, signal, itemId, ...input });
	} catch (error) {
		if (!isCurrent(options)) return { ...rejected<ScreenId>(), stale: true };
		if (signal.aborted) {
			return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
		}
		await reportError(ctx, options, error);
		if (!isCurrent(options)) return { ...rejected<ScreenId>(), stale: true };
		if (signal.aborted) {
			return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
		}
		return rejected();
	}
	if (!isCurrent(options)) return { ...rejected<ScreenId>(), stale: true };
	if (signal.aborted) {
		return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
	}
	if (result?.kind === "rejected") {
		if (result.error !== undefined) await reportError(ctx, options, result.error);
		if (!isCurrent(options)) return { ...rejected<ScreenId>(), stale: true };
		if (signal.aborted) {
			return abortIsStale ? { ...rejected<ScreenId>(), stale: true } : rejected();
		}
		return rejected();
	}
	return accepted(result ?? { kind: "stay" });
}

async function runDialogMenu<
	State,
	ScreenId extends string,
	ActionId extends string,
	Context extends MenuContext,
>(
	ctx: Context,
	definition: MenuDefinition<State, ScreenId, ActionId, Context>,
	options: RunMenuOptions<State, Context>,
): Promise<RunMenuResult> {
	const controller = new AbortController();
	const menuSignal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	const navigator = createMenuNavigator(definition.start);
	try {
		while (!navigator.closed) {
			const loaded = await loadState(ctx, options, menuSignal);
			if (loaded.kind !== "loaded") return loaded.result;
			const state = loaded.state;
			const screen = resolveMenuScreen(definition, navigator.current, state);
			if (screen.kind === "input") {
				const value = await uiFor(ctx).input(
					dialogTitle(screen),
					safeMenuText(screen.placeholder ?? ""),
					{ signal: menuSignal },
				);
				if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
				if (value === undefined) {
					navigator.apply({ kind: screen.hint ?? "back" });
					continue;
				}
				const outcome = await invokeAction(
					ctx,
					definition.actions[screen.action],
					state,
					menuSignal,
					"input",
					options,
					{ value },
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			if (screen.kind === "review") {
				const pages = reviewDialogPages(screen);
				let pageIndex = 0;
				let finished = false;
				while (!finished) {
					const choices = uniqueReviewChoices([
						...(pageIndex > 0 ? [{ kind: "previous" as const, label: "Previous" }] : []),
						...(pageIndex < pages.length - 1 ? [{ kind: "next" as const, label: "Next" }] : []),
						...(screen.confirm
							? [{ kind: "confirm" as const, label: safeMenuText(screen.confirm.label) }]
							: []),
						{ kind: "exit" as const, label: dialogExitChoice(screen) },
					]);
					const pageTitle = [
						dialogTitle(screen),
						pages[pageIndex]?.join("\n") ?? "",
						...(pages.length > 1 ? [`Page ${pageIndex + 1}/${pages.length}`] : []),
					]
						.filter(Boolean)
						.join("\n");
					const choice = await uiFor(ctx).select(
						pageTitle,
						choices.map((row) => row.label),
						{ signal: menuSignal },
					);
					if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
					const selected = choices.find((row) => row.label === choice);
					if (!selected || selected.kind === "exit") {
						navigator.apply({ kind: screen.hint ?? "back" });
						finished = true;
					} else if (selected.kind === "previous") pageIndex = Math.max(0, pageIndex - 1);
					else if (selected.kind === "next") {
						pageIndex = Math.min(pages.length - 1, pageIndex + 1);
					} else if (screen.confirm) {
						const outcome = await invokeAction(
							ctx,
							definition.actions[screen.confirm.action],
							state,
							menuSignal,
							screen.confirm.id,
							options,
						);
						if (outcome.stale) return { kind: "stale" };
						if (outcome.accepted) {
							navigator.apply(outcome.transition);
							finished = true;
						}
					}
				}
				continue;
			}
			const rows = dialogRows(screen);
			const choice = await uiFor(ctx).select(
				dialogTitle(screen),
				rows.map((row) => row.label),
				{ signal: menuSignal },
			);
			if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
			if (!choice) {
				navigator.apply({ kind: "back" });
				continue;
			}
			const selectedRow = rows.find((row) => row.label === choice);
			if (!selectedRow) continue;
			if (selectedRow.kind === "exit" || screen.kind === "detail") {
				const destination = "hint" in screen ? (screen.hint ?? "back") : "back";
				navigator.apply({ kind: destination });
				continue;
			}
			if (screen.kind === "actions") {
				const item = screen.items[selectedRow.index];
				if (!item || item.disabled) continue;
				const outcome = await activateActionItem(ctx, definition, item, state, menuSignal, options);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			if (screen.kind === "settings") {
				const item = screen.items[selectedRow.index];
				if (!item || item.disabled) continue;
				const values = item.values ?? [item.currentValue];
				const currentIndex = Math.max(0, values.indexOf(item.currentValue));
				const value = values[(currentIndex + 1) % values.length] ?? item.currentValue;
				const outcome = await invokeAction(
					ctx,
					definition.actions[item.action],
					state,
					menuSignal,
					item.id,
					options,
					{ value },
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			if (screen.kind === "choice") {
				const item = screen.items[selectedRow.index];
				if (!item || item.disabled) continue;
				const outcome = await invokeAction(
					ctx,
					definition.actions[screen.action],
					state,
					menuSignal,
					item.id,
					options,
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			if (selectedRow.kind === "action") {
				const actionItem = screen.actions?.[selectedRow.index];
				if (!actionItem || actionItem.disabled) continue;
				const outcome = await activateActionItem(
					ctx,
					definition,
					actionItem,
					state,
					menuSignal,
					options,
				);
				if (outcome.stale) return { kind: "stale" };
				navigator.apply(outcome.transition);
				continue;
			}
			const item = screen.items[selectedRow.index];
			if (!item || item.disabled) continue;
			const outcome = await invokeAction(
				ctx,
				definition.actions[screen.action],
				state,
				menuSignal,
				item.id,
				options,
				{ selected: !item.selected },
			);
			if (outcome.stale) return { kind: "stale" };
			navigator.apply(outcome.transition);
		}
		return { kind: "closed" };
	} catch (error) {
		if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
		await reportError(ctx, options, error);
		if (!isCurrent(options) || menuSignal.aborted) return { kind: "stale" };
		return { kind: "error", error };
	} finally {
		controller.abort(new DOMException("Menu closed", "AbortError"));
	}
}

function dialogTitle<ScreenId extends string, ActionId extends string>(
	screen: MenuScreen<ScreenId, ActionId>,
) {
	return [
		safeMenuText(screen.title),
		...(("lines" in screen && screen.lines) || []).map(safeMenuText),
	]
		.filter(Boolean)
		.join("\n");
}

interface DialogRow {
	kind: "item" | "action" | "exit";
	index: number;
	label: string;
}

interface ReviewDialogChoice {
	kind: "previous" | "next" | "confirm" | "exit";
	label: string;
}

function dialogRows<ScreenId extends string, ActionId extends string>(
	screen: MenuScreen<ScreenId, ActionId>,
): DialogRow[] {
	let rows: DialogRow[];
	if (screen.kind === "detail") {
		rows = [{ kind: "exit", index: 0, label: dialogExitChoice(screen) }];
	} else if (screen.kind === "actions") {
		rows = screen.items.map((item, index) => ({
			kind: "item",
			index,
			label: safeMenuText(item.label),
		}));
	} else if (screen.kind === "settings") {
		rows = [
			...screen.items.map((item, index) => ({
				kind: "item" as const,
				index,
				label: `${safeMenuText(item.label)} (${safeMenuText(item.currentValue)})`,
			})),
			{ kind: "exit", index: 0, label: dialogExitChoice(screen) },
		];
	} else if (screen.kind === "input" || screen.kind === "review") {
		rows = [];
	} else if (screen.kind === "choice") {
		rows = [
			...screen.items.map((item, index) => {
				const label = safeMenuText(item.label);
				const current = item.id === screen.currentItemId ? " (current)" : "";
				const unavailable = item.disabled
					? `[-] ${label} (unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""})`
					: `${label}${current}`;
				return { kind: "item" as const, index, label: unavailable };
			}),
			{ kind: "exit", index: 0, label: dialogExitChoice(screen) },
		];
	} else {
		rows = [
			...screen.items.map((item, index) => ({
				kind: "item" as const,
				index,
				label: item.disabled
					? `[-] ${safeMenuText(item.label)} (unavailable${item.disabledReason ? `: ${safeMenuText(item.disabledReason)}` : ""})`
					: `${item.selected ? "[x]" : "[ ]"} ${safeMenuText(item.label)}`,
			})),
			...(screen.actions ?? []).map((item, index) => ({
				kind: "action" as const,
				index,
				label: safeMenuText(item.label),
			})),
			{ kind: "exit", index: 0, label: dialogExitChoice(screen) },
		];
	}
	return uniqueDialogRows(rows);
}

function uniqueReviewChoices(rows: readonly ReviewDialogChoice[]): ReviewDialogChoice[] {
	const used = new Set<string>();
	return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueDialogRows(rows: readonly DialogRow[]): DialogRow[] {
	const used = new Set<string>();
	return rows.map((row) => ({ ...row, label: uniqueDialogLabel(row.label, used) }));
}

function uniqueDialogLabel(base: string, used: Set<string>) {
	let label = base;
	let suffix = 2;
	while (used.has(label)) {
		label = `${base} [${suffix}]`;
		suffix += 1;
	}
	used.add(label);
	return label;
}

function dialogExitChoice<ScreenId extends string, ActionId extends string>(
	screen: MenuScreen<ScreenId, ActionId>,
) {
	if (screen.kind === "multiSelect" && screen.doneLabel) return safeMenuText(screen.doneLabel);
	return "hint" in screen && screen.hint === "close" ? "Done" : "Back";
}

async function loadState<State, Context extends MenuContext>(
	ctx: Context,
	options: RunMenuOptions<State, Context>,
	signal: AbortSignal,
): Promise<{ kind: "loaded"; state: State } | { kind: "result"; result: RunMenuResult }> {
	if (signal.aborted || !isCurrent(options)) return { kind: "result", result: { kind: "stale" } };
	try {
		const state = await options.getState({ ctx, signal });
		if (signal.aborted || !isCurrent(options)) {
			return { kind: "result", result: { kind: "stale" } };
		}
		return { kind: "loaded", state };
	} catch (error) {
		if (signal.aborted || !isCurrent(options)) {
			return { kind: "result", result: { kind: "stale" } };
		}
		await reportError(ctx, options, error);
		if (signal.aborted || !isCurrent(options)) {
			return { kind: "result", result: { kind: "stale" } };
		}
		return { kind: "result", result: { kind: "error", error } };
	}
}

async function reportError<State, Context extends MenuContext>(
	ctx: Context,
	options: RunMenuOptions<State, Context>,
	error: unknown,
) {
	if (options.onError) {
		try {
			await options.onError(ctx, error);
			return;
		} catch {
			// Fall back to Pi's notifier when a custom reporter is no longer available.
		}
	}
	if (ctx.hasUI) {
		const message = error instanceof Error ? error.message : String(error);
		try {
			uiFor(ctx).notify(`Menu action failed: ${safeMenuText(message)}`, "error");
		} catch {
			// Error reporting must never escape the documented menu result contract.
		}
	}
}

function accepted<ScreenId extends string>(
	transition: MenuTransition<ScreenId>,
): ActionInvocation<ScreenId> {
	return { accepted: true, stale: false, transition };
}

function rejected<ScreenId extends string>(): ActionInvocation<ScreenId> {
	return { accepted: false, stale: false, transition: { kind: "stay" } };
}

function isCurrent<State, Context extends MenuContext>(options: RunMenuOptions<State, Context>) {
	return options.isCurrent?.() ?? true;
}

function uiFor(ctx: MenuContext): ExtensionCommandContext["ui"] {
	// Pi core packages are peers and can be typechecked at multiple compatible versions in one tree.
	// The runtime uses only this stable UI surface and never adds command-only context capabilities.
	return ctx.ui as ExtensionCommandContext["ui"];
}
