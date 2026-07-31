import { create_project_trust_wrapper, } from '@spences10/pi-project-trust';
const LSP_PROJECT_BINARY_ENV = 'MY_PI_LSP_PROJECT_BINARY';
const lsp_binary_trust = create_project_trust_wrapper({
    store_filename: 'trusted-lsp-binaries.json',
    legacy_matcher: (entry, subject) => {
        const legacy_entry = entry;
        return legacy_entry?.binary_path === subject.id;
    },
});
export function default_lsp_trust_store_path() {
    return lsp_binary_trust.default_trust_store_path();
}
export function create_lsp_binary_trust_subject(binary_path) {
    return {
        kind: 'lsp-binary',
        id: binary_path,
        store_key: binary_path,
        env_key: LSP_PROJECT_BINARY_ENV,
        prompt_title: 'Trust project-local LSP binary?',
        fallback: 'global',
        choices: {
            allow_once: 'Allow once for this session',
            trust: 'Trust this binary path',
            skip: 'Use global PATH binary instead',
        },
    };
}
export function is_lsp_binary_trusted(binary_path, trust_store_path = default_lsp_trust_store_path()) {
    return lsp_binary_trust.is_trusted(create_lsp_binary_trust_subject(binary_path), trust_store_path);
}
export function trust_lsp_binary(binary_path, trust_store_path = default_lsp_trust_store_path()) {
    lsp_binary_trust.trust(create_lsp_binary_trust_subject(binary_path), trust_store_path);
}
//# sourceMappingURL=trust.js.map