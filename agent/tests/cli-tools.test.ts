import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CLI_TOOL_CATALOG } from "../extensions/cli-tools/catalog.ts";
import { queryCliTools } from "../extensions/cli-tools/query.ts";
import {
	scanAvailableCliTools,
	type AvailableCliTool,
} from "../extensions/cli-tools/inventory.ts";

function catalogEntry(name: string) {
	const entry = CLI_TOOL_CATALOG.find((candidate) => candidate.name === name);
	assert.ok(entry, `missing catalog entry ${name}`);
	return entry;
}

function available(name: string): AvailableCliTool {
	const entry = catalogEntry(name);
	return {
		entry,
		command: entry.commands[0],
		path: `/tools/${entry.commands[0]}`,
	};
}

function makeExecutable(directory: string, name: string): void {
	const file = path.join(directory, name);
	fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test("catalog contains the agreed tools and default disclosure set", () => {
	assert.deepEqual(CLI_TOOL_CATALOG.map((entry) => entry.name), [
		"rg",
		"fd",
		"ast-grep",
		"yq",
		"shellcheck",
		"shfmt",
		"just",
		"uv",
		"universal-ctags",
		"tokei",
	]);
	assert.deepEqual(
		CLI_TOOL_CATALOG.filter((entry) => entry.defaultDisclosure).map((entry) => entry.name),
		["rg", "fd", "ast-grep", "yq", "shellcheck", "shfmt"],
	);
});

test("inventory exposes only executable catalog entries and verifies Universal Ctags", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cli-tools-"));
	try {
		makeExecutable(directory, "rg");
		makeExecutable(directory, "ctags");
		makeExecutable(directory, "unknown-tool");

		const withSystemCtags = scanAvailableCliTools({
			path: directory,
			readProbeOutput: (_toolPath, entry) => entry.name === "universal-ctags" ? "Exuberant Ctags 5.8" : undefined,
		});
		assert.deepEqual(withSystemCtags.map((tool) => tool.entry.name), ["rg"]);

		const withUniversalCtags = scanAvailableCliTools({
			path: directory,
			readProbeOutput: (_toolPath, entry) => entry.name === "universal-ctags" ? "Universal Ctags 6.2.1" : undefined,
		});
		assert.deepEqual(withUniversalCtags.map((tool) => tool.entry.name), ["rg", "universal-ctags"]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("overview uses horizontal defaults and nonzero additional category counts", () => {
	const response = queryCliTools({ action: "overview" }, [
		available("rg"),
		available("fd"),
		available("just"),
		available("uv"),
	]);

	assert.equal(response.text, [
		"[default]",
		"rg, fd",
		"",
		"[categories]",
		"task-automation: 1",
		"python-development: 1",
	].join("\n"));
	assert.deepEqual(response.tools, ["rg", "fd"]);
	assert.deepEqual(response.categories, ["task-automation", "python-development"]);
	assert.doesNotMatch(response.text, /code-navigation|code-metrics|\/tools\/|—|Recursive|Command runner/);
});

test("category output excludes defaults while search can still match them", () => {
	const tools = [available("rg"), available("shellcheck"), available("shfmt"), available("just")];
	const category = queryCliTools({ action: "category", category: "task-automation" }, tools);
	assert.equal(category.text, "[category: task-automation]\njust");
	assert.deepEqual(category.tools, ["just"]);

	const defaultCategory = queryCliTools({ action: "category", category: "shell-development" }, tools);
	assert.equal(defaultCategory.text, "[tools]");
	assert.deepEqual(defaultCategory.tools, []);

	const search = queryCliTools({ action: "search", query: "shell" }, tools);
	assert.equal(search.text, "[search: shell]\nshellcheck, shfmt");
	assert.deepEqual(search.tools, ["shellcheck", "shfmt"]);

	const missing = queryCliTools({ action: "search", query: "python" }, tools);
	assert.equal(missing.text, "[tools]");
	assert.deepEqual(missing.tools, []);
	assert.doesNotMatch(missing.text, /uv|not installed|unavailable/i);
});

test("query actions require their corresponding selector", () => {
	assert.throws(() => queryCliTools({ action: "category" }, []), /category is required/);
	assert.throws(() => queryCliTools({ action: "search" }, []), /query is required/);
});
