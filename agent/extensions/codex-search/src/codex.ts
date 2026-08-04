export {
  CodexError,
  classifyError,
  classifyHttpStatus,
  classifyEventErrorMessage,
} from "./errors.ts";
export type { CodexErrorKind } from "./errors.ts";
export type {
  CodexCitation,
  CodexSearchCall,
  CodexWebSearchResult,
  Freshness,
  ResponseLength,
  SearchContextSize,
  StandaloneExternalWebAccess,
} from "./modes/types.ts";
export type { CodexModel } from "./modes/types.ts";
export { runResponsesSearch } from "./modes/responses.ts";
export {
  runStandaloneCommands,
  externalWebAccessForFreshness,
  hasAnyCommand,
  assertSupportedStandaloneCombination,
  isUnsupportedStandaloneCombination,
} from "./modes/standalone.ts";
export type {
  SearchQuery,
  OpenCommand,
  FindCommand,
  ClickCommand,
  ScreenshotCommand,
  FinanceCommand,
  WeatherCommand,
  SportsCommand,
  TimeCommand,
  StandaloneCommandsOptions,
} from "./modes/standalone.ts";
export {
  createTransport,
  normalizeCodexBaseUrl,
  resolveCodexEndpoint,
  resolveCodexSearchEndpoint,
} from "./transport.ts";
export type { CodexTransport } from "./transport.ts";
export { createRefStore } from "./ref-store.ts";
export type { RefStore } from "./ref-store.ts";
export { buildCodexUserAgent, getCodexOriginator } from "./ua.ts";
export {
  getSharedCookieStore,
  wrapFetchWithCookies,
  ChatGptCloudflareCookieStore,
} from "./cookies.ts";
export type { FetchLike } from "./cookies.ts";

import { Type } from "typebox";
import { Value } from "typebox/value";
import { omitUndefined } from "../../_shared/runtime/omit-undefined.ts";

const CodexModelsResponseSchema = Type.Object({
  models: Type.Optional(Type.Array(Type.Object({
    slug: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    display_name: Type.Optional(Type.String()),
    is_default: Type.Optional(Type.Boolean()),
  }, { additionalProperties: true }))),
}, { additionalProperties: true });

export interface FetchCodexModelsOptions {
  token: string;
  accountId: string;
  baseUrl?: string;
  clientVersion?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function fetchCodexModels(
  options: FetchCodexModelsOptions,
): Promise<import("./modes/types.ts").CodexModel[]> {
  const { CodexError, classifyHttpStatus } = await import("./errors.ts");
  const { createTransport } = await import("./transport.ts");
  const transport = createTransport(omitUndefined({
    token: options.token,
    accountId: options.accountId,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
  }));

  const endpoint = new URL(transport.resolveEndpoint("models"));
  endpoint.searchParams.set(
    "client_version",
    options.clientVersion ?? process.env.PI_CODEX_WEB_SEARCH_CLIENT_VERSION ?? "1.0.0",
  );

  const response = await transport.fetch(endpoint.toString(), omitUndefined({
    headers: transport.buildHeaders("application/json"),
    signal: options.signal,
  }));

  if (!response.ok) {
    const status = response.status;
    const text = await response.text();
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex models request failed: HTTP ${status}: ${text}`,
      status,
    );
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new CodexError("schema", `Codex models response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Value.Check(CodexModelsResponseSchema, raw)) {
    throw new CodexError("schema", "Codex models response did not match the expected schema.");
  }
  const data = raw;
  return (data.models ?? [])
    .map((model) => omitUndefined({
      id: model.slug ?? model.id ?? model.model ?? "",
      name: model.display_name,
      isDefault: model.is_default,
    }))
    .filter((model) => model.id.length > 0);
}

export function selectDefaultModel(
  models: import("./modes/types.ts").CodexModel[],
): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

export function extractAccountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const auth = Reflect.get(payload, "https://api.openai.com/auth");
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
    const accountId = Reflect.get(auth, "chatgpt_account_id");
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}
