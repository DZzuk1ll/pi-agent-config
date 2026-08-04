import { describe, expect, it } from "vitest";
import { fetchCodexModels } from "./codex.ts";
import type { FetchLike } from "./cookies.ts";
import { runResponsesSearch } from "./modes/responses.ts";
import { runStandaloneCommands } from "./modes/standalone.ts";
import type { CodexTransport } from "./transport.ts";

function transport(response: Response): CodexTransport {
	return {
		fetch: async () => response,
		baseUrl: "https://example.test",
		token: "token",
		accountId: "account",
		buildHeaders: () => new Headers(),
		resolveEndpoint: (path) => `https://example.test/${path}`,
		resolveSearchEndpoint: () => "https://example.test/search",
	};
}

describe("Codex response schemas", () => {
	it("rejects null and malformed model payloads as schema errors", async () => {
		for (const body of ["null", JSON.stringify({ models: [{ slug: 1 }] })]) {
			const fetchImpl: FetchLike = async () => new Response(body, { status: 200 });
			await expect(fetchCodexModels({ token: "token", accountId: "account", fetchImpl }))
				.rejects.toMatchObject({ kind: "schema" });
		}
	});

	it("rejects invalid standalone response fields", async () => {
		await expect(runStandaloneCommands({
			model: "model",
			transport: transport(new Response(JSON.stringify({ output: 1 }), { status: 200 })),
			sessionId: "session",
			searchQuery: [{ q: "query" }],
			freshness: "live",
		})).rejects.toMatchObject({ kind: "schema" });
	});

	it("rejects malformed known SSE events but ignores unknown events", async () => {
		await expect(runResponsesSearch({
			query: "query",
			model: "model",
			transport: transport(new Response("event: response.output_text.delta\ndata: null\n\n")),
			externalWebAccess: true,
		})).rejects.toMatchObject({ kind: "schema" });

		const result = await runResponsesSearch({
			query: "query",
			model: "model",
			transport: transport(new Response("event: future.event\ndata: not-json\n\n")),
			externalWebAccess: true,
		});
		expect(result.text).toBe("");
	});
});
