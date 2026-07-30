import assert from "node:assert/strict";
import test from "node:test";
import {
	buildFdArgs,
	buildRgArgs,
	FD_MAX_DEPTH,
	FD_MAX_LIMIT,
	RG_MAX_CONTEXT,
	RG_MAX_LIMIT,
	normalizeSearchPath,
} from "../extensions/file-search/args.ts";

test("fd arguments preserve boundaries and clamp numeric limits", () => {
	assert.deepEqual(
		buildFdArgs({
			pattern: "*.ts",
			path: "@src",
			type: "file",
			extension: ".ts",
			glob: true,
			hidden: true,
			max_depth: FD_MAX_DEPTH + 10,
			limit: FD_MAX_LIMIT + 10,
		}),
		[
			"--color=never",
			"--hidden",
			"--glob",
			"--type",
			"f",
			"--extension",
			"ts",
			"--max-depth",
			String(FD_MAX_DEPTH),
			"--max-results",
			String(FD_MAX_LIMIT),
			"--",
			"*.ts",
			"src",
		],
	);
});

test("fd accepts an omitted pattern and protects dash-prefixed values", () => {
	assert.deepEqual(buildFdArgs({ path: "-fixtures", pattern: "-name" }), [
		"--color=never",
		"--max-results",
		"1000",
		"--",
		"-name",
		"-fixtures",
	]);
});

test("rg arguments expose literal, glob, type, hidden, and context controls", () => {
	assert.deepEqual(
		buildRgArgs({
			pattern: "hello.*world",
			path: "@src",
			glob: "**/*.ts",
			file_type: "ts",
			fixed_strings: true,
			hidden: true,
			context: RG_MAX_CONTEXT + 10,
			limit: RG_MAX_LIMIT + 10,
		}),
		[
			"--line-number",
			"--no-heading",
			"--color=never",
			"--fixed-strings",
			"--hidden",
			"--context",
			String(RG_MAX_CONTEXT),
			"--glob",
			"**/*.ts",
			"--type",
			"ts",
			"--max-count",
			String(RG_MAX_LIMIT),
			"--",
			"hello.*world",
			"src",
		],
	);
});

test("search paths normalize @ and home prefixes", () => {
	assert.equal(normalizeSearchPath("@src/components"), "src/components");
	assert.equal(normalizeSearchPath("~").startsWith("/"), true);
	assert.equal(normalizeSearchPath("~/project").endsWith("/project"), true);
});
