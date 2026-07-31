import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve, } from 'node:path';
const EXTENSION_LANGUAGES = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.js': 'typescript',
    '.jsx': 'typescript',
    '.mjs': 'typescript',
    '.cjs': 'typescript',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.rb': 'ruby',
    '.java': 'java',
    '.lua': 'lua',
    '.svelte': 'svelte',
};
const LANGUAGE_SERVERS = {
    typescript: {
        language: 'typescript',
        command: 'typescript-language-server',
        args: ['--stdio'],
        install_hint: 'Install TypeScript LSP with: pnpm add -D typescript typescript-language-server',
    },
    python: {
        language: 'python',
        command: 'pylsp',
        args: [],
        install_hint: 'Install Python LSP with: pip install python-lsp-server',
    },
    rust: {
        language: 'rust',
        command: 'rust-analyzer',
        args: [],
        install_hint: 'Install Rust Analyzer and ensure the rust-analyzer binary is on PATH.',
    },
    go: {
        language: 'go',
        command: 'gopls',
        args: ['serve'],
        install_hint: 'Install Go LSP with: go install golang.org/x/tools/gopls@latest',
    },
    ruby: {
        language: 'ruby',
        command: 'solargraph',
        args: ['stdio'],
        install_hint: 'Install Ruby LSP with: gem install solargraph',
    },
    java: {
        language: 'java',
        command: 'jdtls',
        args: [],
        install_hint: 'Install Eclipse JDT Language Server and ensure the jdtls binary is on PATH.',
    },
    lua: {
        language: 'lua',
        command: 'lua-language-server',
        args: [],
        install_hint: 'Install Lua LSP and ensure the lua-language-server binary is on PATH.',
    },
    svelte: {
        language: 'svelte',
        command: 'svelteserver',
        args: ['--stdio'],
        install_hint: 'Install Svelte LSP with: pnpm add -D svelte-language-server (or volta install svelte-language-server)',
    },
};
const WORKSPACE_MARKERS = [
    'svelte.config.js',
    'svelte.config.ts',
    'tsconfig.json',
    'jsconfig.json',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
];
const REPOSITORY_MARKERS = [
    'pnpm-workspace.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lockb',
    'bun.lock',
    '.git',
];
export function detect_language(file_path) {
    return EXTENSION_LANGUAGES[extname(file_path).toLowerCase()];
}
export function list_supported_languages() {
    return Object.keys(LANGUAGE_SERVERS).sort();
}
export function resolve_server_command_info(command, cwd = process.cwd()) {
    if (!command ||
        isAbsolute(command) ||
        command.includes('/') ||
        command.includes('\\')) {
        return { command, is_project_local: false };
    }
    for (const dir of ancestor_directories(cwd)) {
        const local_bin = resolve_local_binary(dir, command);
        if (local_bin) {
            return { command: local_bin, is_project_local: true };
        }
    }
    return { command, is_project_local: false };
}
export function resolve_server_command(command, cwd = process.cwd()) {
    return resolve_server_command_info(command, cwd).command;
}
export function get_server_config(language, cwd = process.cwd()) {
    const base = LANGUAGE_SERVERS[language];
    if (!base)
        return undefined;
    const resolved = resolve_server_command_info(base.command, cwd);
    return {
        ...base,
        command: resolved.command,
        is_project_local: resolved.is_project_local,
    };
}
export function language_id_for_file(file_path) {
    return detect_language(file_path);
}
export function find_workspace_root(file_path, fallback = process.cwd()) {
    const start = resolve(dirname(file_path));
    const project_root = find_nearest_marker_directory(start, WORKSPACE_MARKERS);
    if (project_root)
        return project_root;
    const repo_root = find_nearest_marker_directory(start, REPOSITORY_MARKERS);
    if (repo_root)
        return repo_root;
    return resolve(fallback);
}
function find_nearest_marker_directory(start, markers) {
    for (const dir of ancestor_directories(start)) {
        if (markers.some((marker) => existsSync(join(dir, marker)))) {
            return dir;
        }
    }
    return undefined;
}
function ancestor_directories(start) {
    const dirs = [];
    let current = resolve(start);
    while (true) {
        dirs.push(current);
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    }
    return dirs;
}
function resolve_local_binary(directory, command) {
    const candidates = [
        join(directory, 'node_modules', '.bin', command),
        join(directory, 'node_modules', '.bin', `${command}.cmd`),
    ];
    return candidates.find((candidate) => existsSync(candidate));
}
//# sourceMappingURL=servers.js.map