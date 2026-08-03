import { fileURLToPath } from 'node:url';
import {
	LspClientStartError,
	type LspDiagnostic,
	type LspHover,
	type LspLocation,
} from './client.js';
import {
	get_server_config,
	list_supported_languages,
} from './servers.js';

export interface LspFormatServerState {
	client: { is_ready(): boolean; open_document_count?(): number };
	language: string;
	workspace_root: string;
	command: string;
	active_request_count?: number;
	last_used_at?: number;
}

export interface LspToolErrorDetails {
	kind:
		| 'unsupported_language'
		| 'server_start_failed'
		| 'tool_execution_failed';
	file: string;
	message: string;
	language?: string;
	command?: string;
	workspace_root?: string;
	install_hint?: string;
	code?: string;
}

export class LspToolError extends Error {
	details: LspToolErrorDetails;

	constructor(details: LspToolErrorDetails) {
		super(details.message);
		this.name = 'LspToolError';
		this.details = details;
	}
}

export function format_lsp_view(
	view: string,
	cwd: string,
	clients_by_server: Map<string, LspFormatServerState>,
	failed_servers: Map<string, LspToolErrorDetails>,
): string {
	if (view === 'running') {
		const lines = format_running_server_lines(clients_by_server);
		return lines.length > 0
			? lines.join('\n')
			: 'No running language servers.';
	}
	if (view === 'failed') {
		const lines = format_failed_server_lines(failed_servers);
		return lines.length > 0
			? lines.join('\n')
			: 'No failed language servers.';
	}
	return format_status_lines(
		cwd,
		clients_by_server,
		failed_servers,
	).join('\n');
}

function format_running_server_lines(
	clients_by_server: Map<string, LspFormatServerState>,
): string[] {
	return Array.from(clients_by_server.values())
		.sort(
			(a, b) =>
				a.language.localeCompare(b.language) ||
				a.workspace_root.localeCompare(b.workspace_root),
		)
		.map((state) => format_running_server_line(state));
}

function format_running_server_line(
	state: LspFormatServerState,
): string {
	const open_documents =
		state.client.open_document_count?.() ??
		state.active_request_count ??
		0;
	const idle_suffix = state.last_used_at
		? `, idle=${Math.max(0, Math.round((Date.now() - state.last_used_at) / 1000))}s`
		: '';
	return `${state.language}: running (ready=${state.client.is_ready()}, open_docs=${open_documents}, active=${state.active_request_count ?? 0}${idle_suffix}) — ${state.command} [workspace ${state.workspace_root}]`;
}

function format_failed_server_lines(
	failed_servers: Map<string, LspToolErrorDetails>,
): string[] {
	return Array.from(failed_servers.values())
		.sort(
			(a, b) =>
				(a.language ?? '').localeCompare(b.language ?? '') ||
				(a.workspace_root ?? '').localeCompare(
					b.workspace_root ?? '',
				),
		)
		.map((failure) => {
			const workspace = failure.workspace_root
				? ` [workspace ${failure.workspace_root}]`
				: '';
			return `${failure.language ?? 'unknown'}: failed — ${failure.message}${workspace}`;
		});
}

export function format_status_lines(
	cwd: string,
	clients_by_server: Map<string, LspFormatServerState>,
	failed_servers: Map<string, LspToolErrorDetails>,
): string[] {
	const lines: string[] = [];
	const active_languages = new Set<string>();
	const running_states = Array.from(clients_by_server.values()).sort(
		(a, b) =>
			a.language.localeCompare(b.language) ||
			a.workspace_root.localeCompare(b.workspace_root),
	);
	for (const running of running_states) {
		active_languages.add(running.language);
		lines.push(format_running_server_line(running));
	}

	const failures = Array.from(failed_servers.values()).sort(
		(a, b) =>
			(a.language ?? '').localeCompare(b.language ?? '') ||
			(a.workspace_root ?? '').localeCompare(b.workspace_root ?? ''),
	);
	for (const failure of failures) {
		if (failure.language) {
			active_languages.add(failure.language);
		}
		const workspace = failure.workspace_root
			? ` [workspace ${failure.workspace_root}]`
			: '';
		const language = failure.language ?? 'unknown';
		lines.push(
			`${language}: failed — ${failure.message}${workspace}`,
		);
	}

	for (const language of list_supported_languages()) {
		if (active_languages.has(language)) continue;
		const config = get_server_config(language, cwd);
		if (config) {
			lines.push(`${language}: idle — ${config.command}`);
		}
	}
	return lines.length > 0
		? lines
		: ['No language servers configured for this project.'];
}

export function to_lsp_tool_error(
	file: string,
	language: string,
	workspace_root: string,
	command: string,
	install_hint: string | undefined,
	error: unknown,
): LspToolErrorDetails {
	if (error instanceof LspToolError) {
		return error.details;
	}
	if (error instanceof LspClientStartError) {
		const missing_binary = error.code === 'ENOENT';
		return {
			kind: 'server_start_failed',
			file,
			language,
			workspace_root,
			command,
			install_hint,
			code: error.code,
			message: missing_binary
				? `command "${command}" not found`
				: error.message,
		};
	}
	return {
		kind: 'tool_execution_failed',
		file,
		language,
		workspace_root,
		command,
		install_hint,
		message: error instanceof Error ? error.message : String(error),
		code:
			typeof error === 'object' &&
			error !== null &&
			'code' in error &&
			typeof (error as { code?: unknown }).code === 'string'
				? (error as { code: string }).code
				: undefined,
	};
}

export function format_tool_error(
	details: LspToolErrorDetails,
): string {
	if (details.kind === 'unsupported_language') {
		return details.message;
	}
	const lines = [
		details.language
			? `${details.language} LSP unavailable for ${details.file}`
			: `LSP request failed for ${details.file}`,
		`Reason: ${details.message}`,
	];
	if (details.command) {
		lines.push(`Command: ${details.command}`);
	}
	if (details.workspace_root) {
		lines.push(`Workspace: ${details.workspace_root}`);
	}
	if (details.install_hint) {
		lines.push(`Hint: ${details.install_hint}`);
	}
	return lines.join('\n');
}

function severity_label(severity: LspDiagnostic['severity']): string {
	switch (severity) {
		case 1:
			return 'error';
		case 2:
			return 'warning';
		case 3:
			return 'info';
		case 4:
			return 'hint';
		default:
			return 'info';
	}
}

export function format_diagnostics(
	file: string,
	diagnostics: LspDiagnostic[],
): string {
	if (diagnostics.length === 0) {
		return `${file}: no diagnostics`;
	}
	const lines = [`${file}: ${diagnostics.length} diagnostic(s)`];
	for (const d of diagnostics) {
		const position = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
		const source = d.source ? ` [${d.source}]` : '';
		const code = d.code != null ? ` (${d.code})` : '';
		lines.push(
			`  ${position} ${severity_label(d.severity)}${source}${code}: ${d.message}`,
		);
	}
	return lines.join('\n');
}

export function format_hover(hover: LspHover | null): string {
	if (!hover) return 'No hover info.';
	const contents = hover.contents;
	const extract = (
		item:
			| string
			| { language?: string; value: string }
			| { kind: string; value: string },
	): string => (typeof item === 'string' ? item : (item.value ?? ''));

	if (Array.isArray(contents)) {
		return (
			contents.map(extract).join('\n\n').trim() || 'No hover info.'
		);
	}
	return extract(contents).trim() || 'No hover info.';
}

export function format_locations(
	locations: LspLocation[],
	empty_message: string,
): string {
	if (locations.length === 0) return empty_message;
	return locations
		.map((loc) => {
			const path = file_url_to_path_or_value(loc.uri);
			return `${path}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
		})
		.join('\n');
}

function file_url_to_path_or_value(uri: string): string {
	try {
		return uri.startsWith('file:') ? fileURLToPath(uri) : uri;
	} catch {
		return uri;
	}
}
