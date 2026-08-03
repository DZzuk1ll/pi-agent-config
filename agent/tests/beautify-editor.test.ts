import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { createJiti } from "../node_modules/jiti/lib/jiti.mjs";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = join(globalNodeModules, "@earendil-works/pi-coding-agent");
const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": piPackage,
		"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});
const beautifyModule = await jiti.import<{
	default: (pi: { on: (name: string, handler: (...args: any[]) => any) => void }) => void;
}>(
	"../extensions/beautify/index.ts",
);
const beautify = beautifyModule.default;

test("one beautify editor preserves the prompt chrome and image token round trip", async () => {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	beautify({
		on(name, handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
	});

	let text = "";
	let padding = 0;
	const inner = {
		getText: () => text,
		setText: (value: string) => { text = value; },
		insertTextAtCursor: (value: string) => { text += value; },
		setPaddingX: (value: number) => { padding = value; },
		handleInput: () => {},
		render: () => ["", `${" ".repeat(padding)}${text}`],
	};
	let editorFactory: ((...args: any[]) => any) | undefined;
	let editorRegistrations = 0;
	const theme = {
		fg: (_color: string, value: string) => value,
		inverse: (value: string) => value,
	};
	const context = {
		hasUI: true,
		mode: "tui",
		ui: {
			theme,
			getEditorComponent: () => () => inner,
			setEditorComponent: (factory: (...args: any[]) => any) => {
				editorRegistrations += 1;
				editorFactory = factory;
			},
			setStatus: () => {},
		},
	};

	await handlers.get("session_start")?.[0]?.({}, context);
	assert.equal(editorRegistrations, 1);
	assert.ok(editorFactory);
	const editor = editorFactory(
		{ requestRender: () => {} },
		{},
		{ matches: () => false },
	);

	const imagePath = "/tmp/pi-clipboard-deadbeef.png";
	editor.insertTextAtCursor(imagePath);
	assert.equal(text, "[image1]");
	assert.equal(padding, 2);
	assert.equal(editor.render(80)[1], "› [image1]");

	const transformed = await handlers.get("input")?.[0]?.({ text, images: [] });
	assert.deepEqual(transformed, { action: "transform", text: imagePath, images: [] });
});
