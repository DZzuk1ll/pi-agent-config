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
		"@earendil-works/pi-agent-core": join(piPackage, "node_modules/@earendil-works/pi-agent-core"),
		"@earendil-works/pi-ai": join(piPackage, "node_modules/@earendil-works/pi-ai"),
		"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
	},
});

const claudify = await jiti.import<{
	shouldUseGenericToolRenderer: (name: unknown) => boolean;
}>("../extensions/claudify/extensions/index.ts");

test("Claudify preserves Plan mode's native Markdown result renderer", () => {
	assert.equal(claudify.shouldUseGenericToolRenderer("plan_mode_complete"), false);
	assert.equal(claudify.shouldUseGenericToolRenderer("read"), false);
	assert.equal(claudify.shouldUseGenericToolRenderer("custom_tool_without_renderer"), true);
});
