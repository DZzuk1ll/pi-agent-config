import * as fs from "node:fs";
import * as path from "node:path";
import type { TokenUsage } from "./types.ts";

function findLatestSessionFile(sessionDir: string): string | null {
	try {
		const files = fs.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(sessionDir, f));
		if (files.length === 0) return null;
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0] ?? null;
	} catch {
		// Session token lookup is optional metadata.
		return null;
	}
}

export function parseSessionTokens(sessionDir: string): TokenUsage | null {
	const sessionFile = findLatestSessionFile(sessionDir);
	if (!sessionFile) return null;
	try {
		const content = fs.readFileSync(sessionFile, "utf-8");
		let input = 0;
		let output = 0;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				const entry = parsed as Record<string, unknown>;
				const message = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
					? entry.message as Record<string, unknown>
					: undefined;
				const rawUsage = entry.usage ?? message?.usage;
				if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) continue;
				const usage = rawUsage as Record<string, unknown>;
				const inputValue = typeof usage.inputTokens === "number" ? usage.inputTokens : typeof usage.input === "number" ? usage.input : 0;
				const outputValue = typeof usage.outputTokens === "number" ? usage.outputTokens : typeof usage.output === "number" ? usage.output : 0;
				if (Number.isFinite(inputValue)) input += inputValue;
				if (Number.isFinite(outputValue)) output += outputValue;
			} catch {
				// Ignore malformed lines while scanning usage entries.
			}
		}
		return { input, output, total: input + output };
	} catch {
		// Usage extraction should not fail the run.
		return null;
	}
}
