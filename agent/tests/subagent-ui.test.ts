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
const renderModule = await jiti.import<{
	buildWidgetLines: (jobs: unknown[], theme: unknown, width?: number, expanded?: boolean) => string[];
	runningGlyph: (seed?: number, now?: number) => string;
}>("../extensions/subagents/src/tui/render.ts");
const trackerModule = await jiti.import<{
	collectSubagentWidgetJobs: (state: unknown) => Array<Record<string, unknown>>;
}>("../extensions/subagents/src/runs/background/async-job-tracker.ts");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

test("running subagent spinner advances every 80 ms", () => {
	assert.notEqual(renderModule.runningGlyph(0, 0), renderModule.runningGlyph(0, 80));
});

test("async widget omits live-detail guidance and artifact paths", () => {
	const lines = renderModule.buildWidgetLines([
		{
			asyncId: "async-1",
			asyncDir: "/var/folders/example/async-subagent-runs/async-1",
			status: "running",
			mode: "single",
			agents: ["Explore"],
			stepsTotal: 1,
			runningSteps: 1,
			completedSteps: 0,
			startedAt: 0,
			updatedAt: 1000,
			steps: [{ agent: "Explore", index: 0, status: "running", startedAt: 0, durationMs: 1000 }],
		},
	], theme, 120, false);
	const output = lines.join("\n");

	assert.match(output, /async subagent Explore · background/);
	assert.doesNotMatch(output, /Press ctrl\+o for live detail/i);
	assert.doesNotMatch(output, /async-subagent-runs|\boutput:/);
});

test("foreground controls are projected into the same status widget", () => {
	const child = {
		index: 0,
		agent: "Explore",
		startedAt: 100,
		updatedAt: 300,
		currentActivityState: "tool",
		currentTool: "read",
		currentToolStartedAt: 250,
		turnCount: 2,
		toolCount: 4,
		tokens: 1200,
		inputTokens: 900,
		outputTokens: 300,
		model: "gpt-test",
		thinking: "high",
	};
	const state = {
		currentSessionId: "parent-session",
		asyncJobs: new Map(),
		foregroundControls: new Map([
			["foreground-1", {
				runId: "foreground-1",
				sessionId: "parent-session",
				mode: "single",
				startedAt: 100,
				updatedAt: 300,
				currentAgent: "Explore",
				currentIndex: 0,
				description: "Inspect the project",
				activeChildren: new Map([[0, child]]),
			}],
			["sessionless", {
				runId: "sessionless",
				mode: "single",
				startedAt: 100,
				updatedAt: 300,
				activeChildren: new Map([[0, child]]),
			}],
			["other-session", {
				runId: "other-session",
				sessionId: "other-session",
				mode: "single",
				startedAt: 100,
				updatedAt: 300,
				activeChildren: new Map([[0, child]]),
			}],
			["workflow-child", {
				runId: "workflow-child",
				sessionId: "parent-session",
				uiOwnerRunId: "wf_test",
				mode: "single",
				startedAt: 100,
				updatedAt: 300,
				activeChildren: new Map([[0, child]]),
			}],
		]),
	};

	const jobs = trackerModule.collectSubagentWidgetJobs(state);
	assert.equal(jobs.length, 1);
	assert.equal(jobs[0]?.source, "foreground");
	const output = renderModule.buildWidgetLines(jobs, theme, 120, false).join("\n");
	assert.match(output, /subagent Explore · foreground/);
	assert.match(output, /gpt-test · high/);
	assert.doesNotMatch(output, /thinking high|active now|\bturns?\b/i);
	assert.doesNotMatch(output, /Press ctrl\+o|async-subagent-runs|\boutput:/i);
	assert.ok(output.split("\n").every((line) => line.length <= 120));
});

test("mixed foreground and async rows retain their execution source", () => {
	const base = {
		asyncDir: "",
		status: "running",
		mode: "single",
		stepsTotal: 1,
		runningSteps: 1,
		completedSteps: 0,
		startedAt: 0,
		updatedAt: 1000,
	};
	const output = renderModule.buildWidgetLines([
		{ ...base, asyncId: "background-1", source: "async", agents: ["Explore"] },
		{ ...base, asyncId: "foreground-1", source: "foreground", agents: ["Explore"] },
	], theme, 120, false).join("\n");

	assert.match(output, /Subagents · mixed/);
	assert.match(output, /Explore · background/);
	assert.match(output, /Explore · foreground/);
});
