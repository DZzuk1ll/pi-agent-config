import { Type } from 'typebox';
import { type LspDiagnostic, type LspDocumentSymbol, type LspHover, type LspLocation } from './client.js';
export interface LspFormatServerState {
    client: {
        is_ready(): boolean;
        open_document_count?(): number;
    };
    language: string;
    workspace_root: string;
    command: string;
    active_request_count?: number;
    last_used_at?: number;
}
export interface LspToolErrorDetails {
    kind: 'unsupported_language' | 'server_start_failed' | 'tool_execution_failed';
    file: string;
    message: string;
    language?: string;
    command?: string;
    workspace_root?: string;
    install_hint?: string;
    code?: string;
}
export declare class LspToolError extends Error {
    details: LspToolErrorDetails;
    constructor(details: LspToolErrorDetails);
}
export declare const SYMBOL_KIND_NAMES: string[];
export declare const SYMBOL_KIND_SCHEMA: Type.TUnion<Type.TLiteral<string>[]>;
export declare function format_lsp_view(view: string, cwd: string, clients_by_server: Map<string, LspFormatServerState>, failed_servers: Map<string, LspToolErrorDetails>): string;
export declare function format_status_lines(cwd: string, clients_by_server: Map<string, LspFormatServerState>, failed_servers: Map<string, LspToolErrorDetails>): string[];
export declare function to_lsp_tool_error(file: string, language: string, workspace_root: string, command: string, install_hint: string | undefined, error: unknown): LspToolErrorDetails;
export declare function format_tool_error(details: LspToolErrorDetails): string;
export declare function format_diagnostics(file: string, diagnostics: LspDiagnostic[]): string;
export declare function format_hover(hover: LspHover | null): string;
export declare function format_locations(locations: LspLocation[], empty_message: string): string;
export declare function format_document_symbols(file: string, symbols: LspDocumentSymbol[]): string;
export declare function find_symbol_matches(symbols: LspDocumentSymbol[], query: string, options: {
    max_results: number;
    top_level_only: boolean;
    exact_match: boolean;
    kinds: ReadonlySet<string>;
}): Array<{
    symbol: LspDocumentSymbol;
    depth: number;
}>;
export declare function format_symbol_matches(file: string, query: string, matches: Array<{
    symbol: LspDocumentSymbol;
    depth: number;
}>): string;
