import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";

const REQUIRED_THEME_COLORS = [
	"accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
	"selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel",
	"toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
	"mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
	"toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
	"syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
	"thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
] as const;

test("github-dark-default defines every required Pi theme color", () => {
	const themePath = new URL("../themes/github-dark-default.json", import.meta.url);
	const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
	assert.equal(theme.name, "github-dark-default");
	for (const color of REQUIRED_THEME_COLORS) assert.equal(typeof theme.colors[color], "string", `missing ${color}`);
	assert.equal(typeof theme.colors.thinkingMax, "string");
	for (const value of Object.values(theme.colors) as string[]) {
		if (!value || value.startsWith("#")) continue;
		assert.equal(Object.hasOwn(theme.vars, value), true, `unknown theme variable ${value}`);
	}
});
