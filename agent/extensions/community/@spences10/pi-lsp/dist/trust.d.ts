import { type ProjectTrustSubject } from '@spences10/pi-project-trust';
export declare function default_lsp_trust_store_path(): string;
export declare function create_lsp_binary_trust_subject(binary_path: string): ProjectTrustSubject;
export declare function is_lsp_binary_trusted(binary_path: string, trust_store_path?: string): boolean;
export declare function trust_lsp_binary(binary_path: string, trust_store_path?: string): void;
