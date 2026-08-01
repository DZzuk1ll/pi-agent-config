import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const PROBE_WIDGET_KEY = "working-above-editor:layout-probe";

type ContainerLike = Component & { children: Component[] };

interface RenderPatch {
	container: ContainerLike;
	originalRender: ContainerLike["render"];
	patchedRender: ContainerLike["render"];
}

interface AppliedLayout {
	tui: TUI;
	statusContainer: Component;
	widgetContainer: Component;
	movedStatus: boolean;
	widgetSpacerPatch?: RenderPatch;
}

function asContainer(component: Component | undefined): ContainerLike | undefined {
	if (!component) return undefined;
	const children = (component as Partial<ContainerLike>).children;
	return Array.isArray(children) ? (component as ContainerLike) : undefined;
}

function containsComponent(root: Component, target: Component): boolean {
	if (root === target) return true;
	const container = asContainer(root);
	return container?.children.some((child) => containsComponent(child, target)) ?? false;
}

function isEditorContainer(component: Component | undefined): boolean {
	const container = asContainer(component);
	return container?.children.some(
		(child) => typeof child.handleInput === "function" && "focused" in child,
	) ?? false;
}

function placeStatusAfterWidgets(tui: TUI, probe: Component): AppliedLayout | undefined {
	const widgetIndex = tui.children.findIndex((child) => containsComponent(child, probe));
	if (widgetIndex < 0) return undefined;

	const widgetContainer = tui.children[widgetIndex];
	if (!widgetContainer) return undefined;

	// Pi <= 0.83 layout: status, above-editor widgets, editor.
	if (isEditorContainer(tui.children[widgetIndex + 1])) {
		const statusContainer = tui.children[widgetIndex - 1];
		if (!statusContainer || !asContainer(statusContainer)) return undefined;

		tui.children.splice(widgetIndex - 1, 1);
		const nextWidgetIndex = tui.children.indexOf(widgetContainer);
		tui.children.splice(nextWidgetIndex + 1, 0, statusContainer);
		tui.requestRender();
		return { tui, statusContainer, widgetContainer, movedStatus: true };
	}

	// A newer Pi, or a resource reload that retained the previous extension
	// layout, may already use: chat, pending, widgets, status, editor.
	if (isEditorContainer(tui.children[widgetIndex + 2])) {
		const statusContainer = tui.children[widgetIndex + 1];
		if (!statusContainer || !asContainer(statusContainer)) return undefined;
		return { tui, statusContainer, widgetContainer, movedStatus: false };
	}

	return undefined;
}

function compactDefaultWidgetSpacer(component: Component): RenderPatch | undefined {
	const container = asContainer(component);
	const spacer = container?.children[0];
	if (!container || !spacer) return undefined;

	// Pi always places its one-line Spacer first in the above-editor widget
	// container. Capture its constructor so later renderWidgets() calls can
	// replace the Spacer instance without defeating this narrow filter.
	const sample = spacer.render(1);
	const spacerConstructor = spacer.constructor;
	if (sample.length !== 1 || sample[0]?.trim() !== "") return undefined;

	const originalRender = container.render;
	const patchedRender: ContainerLike["render"] = (width) => {
		const lines = originalRender.call(container, width);
		const onlyChild = container.children.length === 1 ? container.children[0] : undefined;
		if (
			onlyChild?.constructor === spacerConstructor
			&& lines.length === 1
			&& lines[0]?.trim() === ""
		) {
			return [];
		}
		return lines;
	};
	container.render = patchedRender;
	return { container, originalRender, patchedRender };
}

function restoreRenderPatch(patch: RenderPatch | undefined): void {
	if (patch && patch.container.render === patch.patchedRender) {
		patch.container.render = patch.originalRender;
	}
}

function restoreOriginalLayout(layout: AppliedLayout | undefined): void {
	if (!layout) return;
	const { tui, statusContainer, widgetContainer } = layout;
	restoreRenderPatch(layout.widgetSpacerPatch);

	if (layout.movedStatus) {
		const statusIndex = tui.children.indexOf(statusContainer);
		const widgetIndex = tui.children.indexOf(widgetContainer);
		if (statusIndex >= 0 && widgetIndex >= 0 && statusIndex === widgetIndex + 1) {
			tui.children.splice(statusIndex, 1);
			const nextWidgetIndex = tui.children.indexOf(widgetContainer);
			tui.children.splice(nextWidgetIndex, 0, statusContainer);
		}
	}
	tui.requestRender();
}

export default function workingAboveEditor(pi: ExtensionAPI): void {
	let appliedLayout: AppliedLayout | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		let tui: TUI | undefined;
		const probe: Component = {
			render: () => [],
			invalidate() {},
		};

		// setWidget is the supported extension hook that exposes the root TUI.
		// The zero-height probe lets us identify the above-editor widget container.
		ctx.ui.setWidget(PROBE_WIDGET_KEY, (rootTui) => {
			tui = rootTui;
			return probe;
		});

		if (tui) appliedLayout = placeStatusAfterWidgets(tui, probe);
		ctx.ui.setWidget(PROBE_WIDGET_KEY, undefined);

		if (appliedLayout) {
			const widgetSpacerPatch = compactDefaultWidgetSpacer(appliedLayout.widgetContainer);
			if (widgetSpacerPatch) appliedLayout.widgetSpacerPatch = widgetSpacerPatch;
			appliedLayout.tui.requestRender();
		}
	});

	pi.on("session_shutdown", () => {
		restoreOriginalLayout(appliedLayout);
		appliedLayout = undefined;
	});
}
