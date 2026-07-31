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

test("overview returns ordered names and folded category ids only", () => {
	const response = queryCliTools({ action: "overview" }, [
		available("rg"),
		available("fd"),
		available("just"),
		available("uv"),
	]);

	assert.equal(response.text, [
		"Default",
		"rg",
		"fd",
		"",
		"Additional categories",
		"task-automation",
		"python-development",
	].join("\n"));
	assert.deepEqual(response.tools, ["rg", "fd"]);
	assert.deepEqual(response.categories, ["task-automation", "python-development"]);
	assert.doesNotMatch(response.text, /\/tools\/|—|Recursive|Command runner/);
});

test("category and search return ordered available names only", () => {
	const tools = [available("rg"), available("shellcheck"), available("shfmt"), available("just")];
	const category = queryCliTools({ action: "category", category: "shell-development" }, tools);
	assert.equal(category.text, "shellcheck\nshfmt");
	assert.deepEqual(category.tools, ["shellcheck", "shfmt"]);

	const search = queryCliTools({ action: "search", query: "search" }, tools);
	assert.equal(search.text, "rg");
	assert.deepEqual(search.tools, ["rg"]);

	const missing = queryCliTools({ action: "search", query: "python" }, tools);
	assert.equal(missing.text, "No available CLI tools.");
	assert.deepEqual(missing.tools, []);
	assert.doesNotMatch(missing.text, /uv|not installed|unavailable/i);
});

test("query actions require their corresponding selector", () => {
	assert.throws(() => queryCliTools({ action: "category" }, []), /category is required/);
	assert.throws(() => queryCliTools({ action: "search" }, []), /query is required/);
});
