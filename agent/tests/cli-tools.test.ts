import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CLI_TOOL_CATALOG } from "../extensions/cli-tools/catalog.ts";
import { queryCliTools } from "../extensions/cli-tools/query.ts";
import {
	extractCliToolVersion,
	scanAvailableCliTools,
	type AvailableCliTool,
} from "../extensions/cli-tools/inventory.ts";

function catalogEntry(name: string) {
	const entry = CLI_TOOL_CATALOG.find((candidate) => candidate.name === name);
	assert.ok(entry, `missing catalog entry ${name}`);
	return entry;
}

function available(name: string, versionOutput?: string): AvailableCliTool {
	const entry = catalogEntry(name);
	return {
		entry,
		command: entry.commands[0],
		path: `/tools/${entry.commands[0]}`,
		...(versionOutput ? { versionOutput } : {}),
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
			readVersionOutput: (_toolPath, entry) => entry.name === "universal-ctags" ? "Exuberant Ctags 5.8" : undefined,
		});
		assert.deepEqual(withSystemCtags.map((tool) => tool.entry.name), ["rg"]);

		const withUniversalCtags = scanAvailableCliTools({
			path: directory,
			readVersionOutput: (_toolPath, entry) => entry.name === "universal-ctags" ? "Universal Ctags 6.2.1" : undefined,
		});
		assert.deepEqual(withUniversalCtags.map((tool) => tool.entry.name), ["rg", "universal-ctags"]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("overview expands defaults and discloses only counts for additional categories", () => {
	const response = queryCliTools({ action: "overview" }, [
		available("rg"),
		available("just"),
		available("uv"),
	]);

	assert.match(response.text, /Default/);
	assert.match(response.text, /rg/);
	assert.match(response.text, /Task automation \(task-automation\): 1 available/);
	assert.match(response.text, /Python development \(python-development\): 1 available/);
	assert.doesNotMatch(response.text, /\/tools\/just/);
	assert.doesNotMatch(response.text, /\/tools\/uv/);
	assert.deepEqual(response.tools.map((tool) => tool.name), ["rg"]);
	assert.deepEqual(response.categories.map((category) => category.id), ["task-automation", "python-development"]);
});

test("category and search queries never disclose unavailable catalog entries", () => {
	const tools = [available("rg"), available("just"), available("uv")];
	const category = queryCliTools({ action: "category", category: "task-automation" }, tools);
	assert.deepEqual(category.tools.map((tool) => tool.name), ["just"]);
	assert.doesNotMatch(category.text, /uv/);

	const search = queryCliTools({ action: "search", query: "python" }, tools);
	assert.deepEqual(search.tools.map((tool) => tool.name), ["uv"]);

	const missing = queryCliTools({ action: "search", query: "shell" }, tools);
	assert.deepEqual(missing.tools, []);
	assert.doesNotMatch(missing.text, /not installed|unavailable/i);
	assert.doesNotMatch(missing.text, /shellcheck|shfmt/);
});

test("details reports facts for available tools and stays neutral otherwise", () => {
	const tools = [available("universal-ctags", "Universal Ctags 6.2.1, Copyright")];
	const details = queryCliTools({ action: "details", name: "ctags" }, tools);
	assert.match(details.text, /name: universal-ctags/);
	assert.match(details.text, /version: 6\.2\.1/);
	assert.match(details.text, /path: \/tools\/ctags/);

	const missing = queryCliTools({ action: "details", name: "tokei" }, tools);
	assert.deepEqual(missing.tools, []);
	assert.doesNotMatch(missing.text, /not installed|unavailable/i);
});

test("version extraction uses catalog-specific output patterns", () => {
	const shellcheck = available("shellcheck");
	const version = extractCliToolVersion(shellcheck, () => "ShellCheck - shell script analysis tool\nversion: 0.11.0");
	assert.equal(version, "0.11.0");
});

test("query actions require their corresponding selector", () => {
	assert.throws(() => queryCliTools({ action: "category" }, []), /category is required/);
	assert.throws(() => queryCliTools({ action: "search" }, []), /query is required/);
	assert.throws(() => queryCliTools({ action: "details" }, []), /name is required/);
});
