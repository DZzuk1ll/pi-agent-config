import { EventEmitter } from 'node:events';
export interface LspPosition {
    line: number;
    character: number;
}
export interface LspRange {
    start: LspPosition;
    end: LspPosition;
}
export interface LspLocation {
    uri: string;
    range: LspRange;
}
export interface LspLocationLink {
    targetUri: string;
    targetRange: LspRange;
    targetSelectionRange?: LspRange;
    originSelectionRange?: LspRange;
}
export interface LspDocumentSymbol {
    name: string;
    kind: number;
    detail?: string;
    range: LspRange;
    selectionRange: LspRange;
    children?: LspDocumentSymbol[];
    uri?: string;
    containerName?: string;
}
export interface LspDiagnostic {
    range: LspRange;
    severity?: 1 | 2 | 3 | 4;
    code?: string | number;
    source?: string;
    message: string;
}
export interface LspHover {
    contents: string | {
        language?: string;
        value: string;
    } | {
        kind: string;
        value: string;
    } | Array<string | {
        language?: string;
        value: string;
    } | {
        kind: string;
        value: string;
    }>;
    range?: LspRange;
}
export interface LspClientOptions {
    command: string;
    args: string[];
    root_uri: string;
    language_id_for_uri: (uri: string) => string | undefined;
    request_timeout_ms?: number;
}
export declare class LspClientStartError extends Error {
    command: string;
    args: string[];
    code?: string;
    constructor(message: string, options: {
        command: string;
        args: string[];
        cause?: unknown;
        code?: string;
    });
}
export declare class LspClient extends EventEmitter {
    #private;
    constructor(options: LspClientOptions);
    start(): Promise<void>;
    is_ready(): boolean;
    ensure_document_open(uri: string, text: string): Promise<void>;
    close_document(uri: string): Promise<void>;
    open_document_count(): number;
    hover(uri: string, position: LspPosition): Promise<LspHover | null>;
    definition(uri: string, position: LspPosition): Promise<LspLocation[]>;
    references(uri: string, position: LspPosition, include_declaration: boolean): Promise<LspLocation[]>;
    document_symbols(uri: string): Promise<LspDocumentSymbol[]>;
    get_diagnostics(uri: string): LspDiagnostic[];
    wait_for_diagnostics(uri: string, timeout_ms?: number): Promise<LspDiagnostic[]>;
    stop(): Promise<void>;
}
export declare function normalize_location_result(result: LspLocation | LspLocation[] | LspLocationLink | LspLocationLink[] | null): LspLocation[];
export declare function normalize_document_symbol_result(result: LspDocumentSymbol[] | Array<{
    name: string;
    kind: number;
    location: LspLocation;
    containerName?: string;
}> | null): LspDocumentSymbol[];
export declare function file_path_to_uri(file_path: string): string;
