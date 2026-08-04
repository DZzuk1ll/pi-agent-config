import { describe, expect, it } from "vitest";
import { decodePublishDiagnosticsParams } from "./lsp-diagnostics.ts";

const diagnostic = {
	range: {
		start: { line: 0, character: 1 },
		end: { line: 0, character: 2 },
	},
	severity: 1,
	message: "problem",
};
const params = { uri: "file:///tmp/example.ts", diagnostics: [diagnostic] };

describe("watchdog LSP diagnostic boundary", () => {
	it("decodes complete publishDiagnostics params", () => {
		expect(decodePublishDiagnosticsParams(params)).toEqual(params);
	});

	it("rejects malformed nested coordinates and severities", () => {
		expect(decodePublishDiagnosticsParams({
			...params,
			diagnostics: [{ ...diagnostic, range: { ...diagnostic.range, start: { line: "0", character: 1 } } }],
		})).toBeUndefined();
		expect(decodePublishDiagnosticsParams({
			...params,
			diagnostics: [{ ...diagnostic, severity: "1" }],
		})).toBeUndefined();
		expect(decodePublishDiagnosticsParams({
			...params,
			diagnostics: [{ ...diagnostic, range: { ...diagnostic.range, end: undefined } }],
		})).toBeUndefined();
	});
});
