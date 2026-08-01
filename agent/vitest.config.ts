import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const globalNodeModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piPackage = join(globalNodeModules, "@earendil-works/pi-coding-agent");

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-coding-agent": piPackage,
			"@earendil-works/pi-agent-core": join(piPackage, "node_modules/@earendil-works/pi-agent-core"),
			"@earendil-works/pi-ai": join(piPackage, "node_modules/@earendil-works/pi-ai"),
			"@earendil-works/pi-tui": join(piPackage, "node_modules/@earendil-works/pi-tui"),
		},
	},
	test: {
		include: ["extensions/**/*.test.ts"],
	},
});
