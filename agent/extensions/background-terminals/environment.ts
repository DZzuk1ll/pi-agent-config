const EXACT_KEYS = new Set([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"CI",
	"NO_COLOR",
	"FORCE_COLOR",
]);

export function backgroundEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (EXACT_KEYS.has(key) || key.startsWith("LC_")) env[key] = value;
	}
	return env;
}
