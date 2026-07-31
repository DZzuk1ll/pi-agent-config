import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type LspClientOptions, type LspDiagnostic, type LspDocumentSymbol, type LspHover, type LspLocation, type LspPosition } from './client.js';
import { type LspToolErrorDetails } from './format.js';
export interface LspClientLike {
    start(): Promise<void>;
    stop(): Promise<void>;
    is_ready(): boolean;
    ensure_document_open(uri: string, text: string): Promise<void>;
    close_document(uri: string): Promise<void>;
    open_document_count?(): number;
    hover(uri: string, position: LspPosition): Promise<LspHover | null>;
    definition(uri: string, position: LspPosition): Promise<LspLocation[]>;
    references(uri: string, position: LspPosition, include_declaration: boolean): Promise<LspLocation[]>;
    document_symbols(uri: string): Promise<LspDocumentSymbol[]>;
    wait_for_diagnostics(uri: string, timeout_ms?: number): Promise<LspDiagnostic[]>;
}
export interface ServerState {
    client: LspClientLike;
    key: string;
    language: string;
    workspace_root: string;
    root_uri: string;
    command: string;
    install_hint?: string;
    active_request_count: number;
    last_used_at?: number;
    open_documents: Map<string, number>;
    idle_timer?: NodeJS.Timeout;
}
export interface FileState {
    abs: string;
    uri: string;
    state: ServerState;
}
export type ResolveFileStateResult = {
    ok: true;
    result: FileState;
} | {
    ok: false;
    error: LspToolErrorDetails;
};
export interface CreateLspServerManagerOptions {
    create_client?: (options: LspClientOptions) => LspClientLike;
    read_file?: (path: string) => Promise<string>;
    cwd?: () => string;
    idle_timeout_ms?: number;
}
export declare class LspServerManager {
    #private;
    readonly cwd: string;
    readonly clients_by_server: Map<string, ServerState>;
    readonly failed_servers: Map<string, LspToolErrorDetails>;
    constructor(options?: CreateLspServerManagerOptions);
    resolve_abs(file: string): string;
    clear_language_state(language?: string): Promise<void>;
    resolve_file_state(file: string, ctx?: ExtensionContext): Promise<ResolveFileStateResult>;
    release_file_state(file_state: FileState): Promise<void>;
}
