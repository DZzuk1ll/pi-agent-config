import assert from "node:assert/strict";
import test from "node:test";

import workingAboveEditor from "../extensions/working-above-editor/index.ts";

interface FakeComponent {
	children?: FakeComponent[];
	focused?: boolean;
	handleInput?: () => void;
	render(width: number): string[];
	invalidate(): void;
}

class FakeSpacer implements FakeComponent {
	render(width: number): string[] {
		return [" ".repeat(width)];
	}

	invalidate(): void {}
}

class FakeBlankWidget implements FakeComponent {
	render(width: number): string[] {
		return [" ".repeat(width)];
	}

	invalidate(): void {}
}

function fakeText(text: string): FakeComponent {
	return {
		render: () => [text],
		invalidate() {},
	};
}

function fakeContainer(children: FakeComponent[] = []): FakeComponent & { children: FakeComponent[] } {
	return {
		children,
		render(width) {
			return this.children.flatMap((child) => child.render(width));
		},
		invalidate() {
			for (const child of this.children) child.invalidate();
		},
	};
}

test("compacts only Pi's empty above-editor spacer across initial load and reload", () => {
	const chat = fakeContainer();
	const pending = fakeContainer();
	const status = fakeContainer([fakeText("Working…")]);
	const widget = fakeContainer([new FakeSpacer()]);
	const editor = fakeContainer([{
		focused: true,
		handleInput() {},
		render: () => [">"],
		invalidate() {},
	}]);
	const footer = fakeText("footer");
	let renderRequests = 0;
	const tui = {
		children: [chat, pending, status, widget, editor, footer],
		requestRender() {
			renderRequests += 1;
		},
	};

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	workingAboveEditor({
		on(event: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(event, handler);
		},
	} as never);

	const sessionStart = handlers.get("session_start");
	if (!sessionStart) throw new Error("session_start handler was not registered");
	const sessionShutdown = handlers.get("session_shutdown");
	if (!sessionShutdown) throw new Error("session_shutdown handler was not registered");
	const context = {
		mode: "tui",
		ui: {
			setWidget(_key: string, factory: ((root: typeof tui) => FakeComponent) | undefined) {
				widget.children = factory
					? [new FakeSpacer(), factory(tui)]
					: [new FakeSpacer()];
			},
		},
	};

	sessionStart({}, context);
	assert.deepEqual(tui.children, [chat, pending, widget, status, editor, footer]);
	assert.deepEqual(widget.render(8), []);

	const actualWidget = fakeText("extension widget");
	widget.children = [new FakeSpacer(), actualWidget];
	assert.deepEqual(widget.render(8), ["        ", "extension widget"]);

	widget.children = [new FakeBlankWidget()];
	assert.deepEqual(widget.render(8), ["        "]);

	widget.children = [new FakeSpacer()];
	assert.deepEqual(widget.render(8), []);

	sessionShutdown();
	assert.deepEqual(tui.children, [chat, pending, status, widget, editor, footer]);
	assert.deepEqual(widget.render(8), ["        "]);

	// A resource reload can retain the already-moved widget/status order.
	tui.children = [chat, pending, widget, status, editor, footer];
	sessionStart({}, context);
	assert.deepEqual(tui.children, [chat, pending, widget, status, editor, footer]);
	assert.deepEqual(widget.render(8), []);

	sessionShutdown();
	assert.deepEqual(tui.children, [chat, pending, widget, status, editor, footer]);
	assert.deepEqual(widget.render(8), ["        "]);
	assert.ok(renderRequests >= 5);
});
