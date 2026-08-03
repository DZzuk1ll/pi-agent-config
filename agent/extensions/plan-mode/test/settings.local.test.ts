import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { readPlanModeSettings } from "../src/settings.js";

const CANONICAL_RELATIVE_PATH = join("extensions", "plan-mode", "config.json");

async function withAgentDir(run: (agentDir: string) => Promise<void>) {
	const agentDir = await mkdtemp(join(tmpdir(), "personal-plan-mode-settings-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await run(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

test("nested local config takes precedence over upstream-compatible root files", async () => {
	await withAgentDir(async (agentDir) => {
		const canonicalPath = join(agentDir, CANONICAL_RELATIVE_PATH);
		await mkdir(dirname(canonicalPath), { recursive: true });
		await writeFile(
			canonicalPath,
			JSON.stringify({ thinkingLevel: "high", defaultPlanTools: ["read", "codex_search"] }),
		);
		await writeFile(join(agentDir, "pi-plan-mode.json"), JSON.stringify({ thinkingLevel: "low" }));

		const result = await readPlanModeSettings();

		assert.equal(result.kind, "loaded");
		if (result.kind !== "loaded") return;
		assert.equal(result.settings.thinkingLevel, "high");
		assert.deepEqual(result.settings.defaultPlanTools, ["read", "codex_search"]);
		assert.match(result.notice ?? "", /ignored.*config\.json.*takes precedence/i);
	});
});

test("a root pi-plan-mode config migrates into the locally controlled nested path", async () => {
	await withAgentDir(async (agentDir) => {
		const canonicalPath = join(agentDir, CANONICAL_RELATIVE_PATH);
		const legacyPath = join(agentDir, "pi-plan-mode.json");
		const contents = JSON.stringify({ thinkingLevel: "medium", defaultPlanTools: ["read", "bash"] });
		await writeFile(legacyPath, contents);

		const result = await readPlanModeSettings();

		assert.equal(result.kind, "loaded");
		assert.equal(await readFile(canonicalPath, "utf8"), contents);
		await assert.rejects(access(legacyPath));
		assert.match(result.notice ?? "", /migrated.*config\.json/i);
	});
});

test("checked-in config keeps Codex Search and LSP enabled by default", async () => {
	const configPath = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");
	const result = await readPlanModeSettings(configPath);

	assert.equal(result.kind, "loaded");
	if (result.kind !== "loaded") return;
	assert.ok(result.settings.defaultPlanTools?.includes("codex_search"));
	assert.ok(result.settings.defaultPlanTools?.includes("lsp_diagnostics_many"));
	assert.ok(result.settings.defaultPlanTools?.includes("lsp_references"));
});
