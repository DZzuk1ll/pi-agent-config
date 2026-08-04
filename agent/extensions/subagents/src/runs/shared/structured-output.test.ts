import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { createStructuredOutputToolParameters } from "./structured-output.ts";

describe("structured output tool schema", () => {
	it("keeps the dynamic JSON Schema visible while preserving typed tool parameters", () => {
		const parameters = createStructuredOutputToolParameters({
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
			additionalProperties: false,
		});

		expect(Value.Check(parameters, { value: { answer: "yes" } })).toBe(true);
		expect(Value.Check(parameters, { value: { answer: 1 } })).toBe(false);
		expect(Value.Check(parameters, { value: { answer: "yes" }, extra: true })).toBe(false);
	});

	it("rewrites local root references beneath the tool value property", () => {
		const parameters = createStructuredOutputToolParameters({
			type: "object",
			properties: { child: { $ref: "#/$defs/node" } },
			$defs: { node: { type: "string" } },
		});

		expect(Value.Check(parameters, { value: { child: "ok" } })).toBe(true);
		expect(Value.Check(parameters, { value: { child: 1 } })).toBe(false);
	});
});
