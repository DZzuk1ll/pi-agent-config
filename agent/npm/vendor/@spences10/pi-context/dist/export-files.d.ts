import type { ContextRetentionPolicy } from './types.js';
export declare function context_export_dir(): string;
export declare function default_context_export_path(source_id: string, chunk_id?: string): string;
export declare function resolve_context_export_path(file_path: string | undefined, cwd: string, source_id: string, chunk_id?: string): string;
export declare function write_context_export_file(file_path: string, content: string): void;
export declare function cleanup_context_exports(policy?: ContextRetentionPolicy, now?: number): {
    deleted: number;
    dir: string;
};
