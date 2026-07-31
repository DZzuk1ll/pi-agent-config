export const OSC133_ZONE_RE = /\x1b\]133;[ABC](?:\x07|\x1b\\)/g;

export function formatCompactUserMessageLines(lines: readonly string[]): string[] {
	let replaced = false;
	const rendered = lines.map((line) => {
		const cleanLine = line.replace(OSC133_ZONE_RE, "");
		if (replaced || !cleanLine.includes("❯")) return cleanLine;
		replaced = true;
		return cleanLine.replace("❯", "›");
	});

	// A hot reload can leave the previous v3 prototype wrapper installed below
	// this one. Remove its exact trailing spacer as well as avoiding a new one.
	return rendered.at(-1) === "" ? rendered.slice(0, -1) : rendered;
}
