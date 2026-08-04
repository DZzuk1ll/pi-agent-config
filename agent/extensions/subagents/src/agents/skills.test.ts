import { describe, expect, it } from "vitest";
import { normalizeSkillInput } from "./skills.ts";

describe("normalizeSkillInput", () => {
	it("accepts only string elements in JSON-encoded arrays", () => {
		expect(normalizeSkillInput('["one", "two", "one"]')).toEqual(["one", "two"]);
		expect(() => normalizeSkillInput("[1]")).not.toThrow();
		expect(normalizeSkillInput("[1]")).toEqual(["[1]"]);
	});
});
