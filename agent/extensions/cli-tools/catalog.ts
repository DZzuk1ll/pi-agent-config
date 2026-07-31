export type CliToolCategoryId =
	| "file-and-code-search"
	| "structured-data"
	| "shell-development"
	| "task-automation"
	| "python-development"
	| "code-navigation"
	| "code-metrics";

export interface CliToolCategory {
	id: CliToolCategoryId;
	label: string;
	description: string;
}

export interface CliToolCatalogEntry {
	name: string;
	commands: readonly string[];
	category: CliToolCategoryId;
	description: string;
	keywords: readonly string[];
	defaultDisclosure?: boolean;
	probeArgs?: readonly string[];
	identityPattern?: RegExp;
}

export const CLI_TOOL_CATEGORIES: readonly CliToolCategory[] = [
	{
		id: "file-and-code-search",
		label: "File and code search",
		description: "Filesystem, text, and syntax-tree search commands.",
	},
	{
		id: "structured-data",
		label: "Structured data",
		description: "Structured configuration and data processing commands.",
	},
	{
		id: "shell-development",
		label: "Shell development",
		description: "Static analysis and formatting commands for shell programs.",
	},
	{
		id: "task-automation",
		label: "Task automation",
		description: "Project task runner commands.",
	},
	{
		id: "python-development",
		label: "Python development",
		description: "Python project, package, and environment commands.",
	},
	{
		id: "code-navigation",
		label: "Code navigation",
		description: "Source symbol indexing commands.",
	},
	{
		id: "code-metrics",
		label: "Code metrics",
		description: "Source code statistics commands.",
	},
];

export const CLI_TOOL_CATALOG: readonly CliToolCatalogEntry[] = [
	{
		name: "rg",
		commands: ["rg"],
		category: "file-and-code-search",
		description: "Recursive line-oriented text search command.",
		keywords: ["text", "content", "regex", "search", "files"],
		defaultDisclosure: true,
	},
	{
		name: "fd",
		commands: ["fd", "fdfind"],
		category: "file-and-code-search",
		description: "Filesystem entry search command with name, path, type, and extension filters.",
		keywords: ["file", "directory", "path", "name", "extension", "search"],
		defaultDisclosure: true,
	},
	{
		name: "ast-grep",
		commands: ["ast-grep", "sg"],
		category: "file-and-code-search",
		description: "Syntax-tree pattern search and rewrite command for source code.",
		keywords: ["ast", "syntax", "structural", "code", "search", "rewrite"],
		defaultDisclosure: true,
	},
	{
		name: "yq",
		commands: ["yq"],
		category: "structured-data",
		description: "YAML, JSON, XML, CSV, and properties query and transformation command.",
		keywords: ["yaml", "json", "xml", "csv", "properties", "query", "transform"],
		defaultDisclosure: true,
	},
	{
		name: "shellcheck",
		commands: ["shellcheck"],
		category: "shell-development",
		description: "Static analysis command for shell scripts.",
		keywords: ["shell", "bash", "static", "analysis", "lint"],
		defaultDisclosure: true,
	},
	{
		name: "shfmt",
		commands: ["shfmt"],
		category: "shell-development",
		description: "Parser and formatter command for shell programs.",
		keywords: ["shell", "bash", "format", "parser"],
		defaultDisclosure: true,
	},
	{
		name: "just",
		commands: ["just"],
		category: "task-automation",
		description: "Command runner backed by project Justfiles.",
		keywords: ["task", "runner", "justfile", "automation", "project"],
	},
	{
		name: "uv",
		commands: ["uv"],
		category: "python-development",
		description: "Python project, package, and environment management command.",
		keywords: ["python", "project", "package", "environment", "dependency"],
	},
	{
		name: "universal-ctags",
		commands: ["ctags"],
		category: "code-navigation",
		description: "Source-code symbol tag generation command.",
		keywords: ["ctags", "symbol", "tags", "index", "navigation", "source"],
		probeArgs: ["--version"],
		identityPattern: /^Universal Ctags\b/mi,
	},
	{
		name: "tokei",
		commands: ["tokei"],
		category: "code-metrics",
		description: "Source code statistics command grouped by language.",
		keywords: ["statistics", "lines", "language", "codebase", "metrics"],
	},
];
