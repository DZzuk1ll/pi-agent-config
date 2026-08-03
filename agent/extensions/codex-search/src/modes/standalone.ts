import {
  CodexError,
  classifyHttpStatus,
  formatHttpErrorBody,
  isCloudflareChallenge,
} from "../errors.ts";
import type { CodexTransport } from "../transport.ts";
import type {
  CodexWebSearchResult,
  CodexCitation,
  CodexSearchCall,
  SearchContextSize,
  Freshness,
  StandaloneExternalWebAccess,
  ResponseLength,
} from "./types.ts";

export interface SearchQuery {
  q: string;
  recency?: number;
  domains?: string[];
}

export interface OpenCommand {
  refId: string;
  lineno?: number;
}

export interface FindCommand {
  refId: string;
  pattern: string;
}

export interface ClickCommand {
  refId: string;
  id: number;
}

export interface ScreenshotCommand {
  refId: string;
  pageno: number;
}

export interface FinanceCommand {
  ticker: string;
  type: "equity" | "fund" | "crypto" | "index";
  market?: string;
}

export interface WeatherCommand {
  location: string;
  start?: string;
  duration?: number;
}

export type SportsLeague =
  | "nba"
  | "wnba"
  | "nfl"
  | "nhl"
  | "mlb"
  | "epl"
  | "ncaamb"
  | "ncaawb"
  | "ipl";

export interface SportsCommand {
  fn: "schedule" | "standings";
  league: SportsLeague;
  team?: string;
  opponent?: string;
  date_from?: string;
  date_to?: string;
  num_games?: number;
  locale?: string;
}

export interface TimeCommand {
  utc_offset: string;
}

export interface StandaloneCommandsOptions {
  model: string;
  transport: CodexTransport;
  sessionId: string;
  searchQuery?: SearchQuery[];
  imageQuery?: SearchQuery[];
  open?: OpenCommand[];
  find?: FindCommand[];
  click?: ClickCommand[];
  screenshot?: ScreenshotCommand[];
  finance?: FinanceCommand[];
  weather?: WeatherCommand[];
  sports?: SportsCommand[];
  time?: TimeCommand[];
  freshness: Freshness;
  searchContextSize?: SearchContextSize;
  responseLength?: ResponseLength;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

interface StandaloneSearchResponse {
  encrypted_output?: string;
  output?: string;
  results?: unknown;
}

export function externalWebAccessForFreshness(freshness: Freshness): StandaloneExternalWebAccess {
  if (freshness === "cached") return false;
  if (freshness === "indexed") return "indexed";
  return true;
}

export function hasAnyCommand(options: StandaloneCommandsOptions): boolean {
  return countCommands(options) > 0;
}

export function isUnsupportedStandaloneCombination(
  searchContextSize: SearchContextSize | undefined,
  _freshness: Freshness,
): boolean {
  return (searchContextSize ?? "medium") === "low";
}

export function assertSupportedStandaloneCombination(
  searchContextSize: SearchContextSize | undefined,
  freshness: Freshness,
): void {
  if (isUnsupportedStandaloneCombination(searchContextSize, freshness)) {
    throw new CodexError(
      "schema",
      'standalone/low is disabled because Codex returns Cloudflare challenges for low-context standalone requests. Use search_context_size "medium" or "high".',
    );
  }
}

function countCommands(options: StandaloneCommandsOptions): number {
  return (
    (options.searchQuery?.length ?? 0) +
    (options.imageQuery?.length ?? 0) +
    (options.open?.length ?? 0) +
    (options.find?.length ?? 0) +
    (options.click?.length ?? 0) +
    (options.screenshot?.length ?? 0) +
    (options.finance?.length ?? 0) +
    (options.weather?.length ?? 0) +
    (options.sports?.length ?? 0) +
    (options.time?.length ?? 0)
  );
}

export async function runStandaloneCommands(
  options: StandaloneCommandsOptions,
): Promise<CodexWebSearchResult> {
  if (!hasAnyCommand(options)) {
    throw new CodexError("schema", "Codex standalone commands require at least one command");
  }
  if (countCommands(options) > 1) {
    throw new CodexError("schema", "Codex standalone actions must be sent one per request");
  }
  assertSupportedStandaloneCombination(options.searchContextSize, options.freshness);

  const {
    transport,
    model,
    sessionId,
    freshness,
    searchContextSize,
    responseLength,
    maxOutputTokens,
    signal,
  } = options;
  const headers = transport.buildHeaders("application/json");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("content-type", "application/json");

  const commands: Record<string, unknown> = {};
  if (options.searchQuery?.length) commands.search_query = options.searchQuery;
  if (options.imageQuery?.length) commands.image_query = options.imageQuery;
  if (options.open?.length)
    commands.open = options.open.map((c) => ({ ref_id: c.refId, lineno: c.lineno }));
  if (options.find?.length)
    commands.find = options.find.map((c) => ({ ref_id: c.refId, pattern: c.pattern }));
  if (options.click?.length)
    commands.click = options.click.map((c) => ({ ref_id: c.refId, id: c.id }));
  if (options.screenshot?.length) {
    commands.screenshot = options.screenshot.map((c) => ({ ref_id: c.refId, pageno: c.pageno }));
  }
  if (options.finance?.length) {
    commands.finance = options.finance.map((c) => ({
      ticker: c.ticker,
      type: c.type,
      market: c.market,
    }));
  }
  if (options.weather?.length) {
    commands.weather = options.weather.map((c) => ({
      location: c.location,
      start: c.start,
      duration: c.duration,
    }));
  }
  if (options.sports?.length) {
    commands.sports = options.sports.map((c) => ({
      fn: c.fn,
      league: c.league,
      team: c.team,
      opponent: c.opponent,
      date_from: c.date_from,
      date_to: c.date_to,
      num_games: c.num_games,
      locale: c.locale,
    }));
  }
  if (options.time?.length) commands.time = options.time.map((c) => ({ utc_offset: c.utc_offset }));
  if (responseLength) commands.response_length = responseLength;

  const body: Record<string, unknown> = {
    id: sessionId,
    model,
    input: buildInput(options),
    commands,
    settings: {
      search_context_size: searchContextSize ?? "medium",
      allowed_callers: ["direct"],
      external_web_access: externalWebAccessForFreshness(freshness),
    },
  };
  body.max_output_tokens = maxOutputTokens ?? 8000;

  const bodyText = JSON.stringify(body);
  let response = await transport.fetch(transport.resolveSearchEndpoint(), {
    method: "POST",
    headers,
    body: bodyText,
    signal,
  });

  if (!response.ok) {
    let status = response.status;
    let rawText = await response.text();
    if (status === 403 && isCloudflareChallenge(rawText) && !signal?.aborted) {
      await delay(750, signal);
      if (signal?.aborted) {
        throw new CodexError("timeout", "Codex standalone request was aborted before retry.");
      }
      response = await transport.fetch(transport.resolveSearchEndpoint(), {
        method: "POST",
        headers,
        body: bodyText,
        signal,
      });
      if (!response.ok) {
        status = response.status;
        rawText = await response.text();
      }
    }
    if (!response.ok) {
      const text = formatHttpErrorBody(rawText, "standalone");
      throw new CodexError(
        classifyHttpStatus(status),
        `Codex standalone search request failed: HTTP ${status}: ${text}`,
        status,
      );
    }
  }

  const data = (await response.json()) as StandaloneSearchResponse;
  const text = typeof data.output === "string" ? data.output : "";
  const structuredResults = Array.isArray(data.results) ? data.results : undefined;
  const refIds = {
    ...extractRefIds(text),
    ...extractStructuredRefIds(structuredResults),
  };
  const searchCalls = inferSearchCalls(options);

  const result: CodexWebSearchResult = {
    model,
    text,
    searchCalls,
    citations: extractCitations(structuredResults, text),
    refIds,
  };
  if (data.encrypted_output !== undefined) result.encryptedOutput = data.encrypted_output;
  if (structuredResults !== undefined) result.results = structuredResults;
  return result;
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function buildInput(options: StandaloneCommandsOptions): unknown[] {
  const texts: string[] = [];
  for (const query of options.searchQuery ?? []) texts.push(query.q);
  for (const query of options.imageQuery ?? []) texts.push(query.q);
  for (const command of options.open ?? []) texts.push(command.refId);
  for (const command of options.find ?? []) texts.push(`find "${command.pattern}" in ${command.refId}`);
  for (const command of options.click ?? []) texts.push(`click ${command.id} in ${command.refId}`);
  for (const command of options.screenshot ?? []) texts.push(`screenshot ${command.pageno} of ${command.refId}`);
  for (const command of options.finance ?? []) texts.push(`finance ${command.ticker} ${command.type} ${command.market ?? ""}`);
  for (const command of options.weather ?? []) texts.push(`weather ${command.location}`);
  for (const command of options.sports ?? []) texts.push(`sports ${command.fn} ${command.league}`);
  for (const command of options.time ?? []) texts.push(`time ${command.utc_offset}`);

  const prompt = texts.filter(Boolean).join("\n");
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  ];
}

function inferSearchCalls(options: StandaloneCommandsOptions): CodexSearchCall[] {
  const calls: CodexSearchCall[] = [];
  for (const query of options.searchQuery ?? [])
    calls.push({ status: "completed", query: query.q, actionType: "search_query" });
  for (const query of options.imageQuery ?? [])
    calls.push({ status: "completed", query: query.q, actionType: "image_query" });
  for (const command of options.open ?? [])
    calls.push({ status: "completed", refId: command.refId, actionType: "open_page" });
  for (const command of options.find ?? [])
    calls.push({ status: "completed", refId: command.refId, actionType: "find_in_page" });
  for (const command of options.click ?? [])
    calls.push({ status: "completed", refId: command.refId, actionType: "click" });
  for (const command of options.screenshot ?? [])
    calls.push({ status: "completed", refId: command.refId, actionType: "screenshot" });
  for (const command of options.finance ?? [])
    calls.push({ status: "completed", query: `${command.ticker}`, actionType: "finance" });
  for (const command of options.weather ?? [])
    calls.push({ status: "completed", query: command.location, actionType: "weather" });
  for (const command of options.sports ?? [])
    calls.push({ status: "completed", query: `${command.fn} ${command.league}`, actionType: "sports" });
  for (const command of options.time ?? [])
    calls.push({ status: "completed", query: command.utc_offset, actionType: "time" });
  return calls;
}

const REF_ID_PATTERN = /\b(turn\d+(?:search|fetch|view)\d+)\b/g;
const EXACT_REF_ID_PATTERN = /^turn\d+(?:search|fetch|view)\d+$/;

function extractRefIds(text: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const match of text.matchAll(REF_ID_PATTERN)) {
    const refId = match[1];
    if (refId) refs[refId] = refId;
  }
  return refs;
}

function extractStructuredRefIds(results: unknown[] | undefined): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const result of results ?? []) {
    if (!isRecord(result)) continue;
    const refId = result.ref_id;
    if (typeof refId === "string" && EXACT_REF_ID_PATTERN.test(refId)) refs[refId] = refId;
  }
  return refs;
}

function extractCitations(results: unknown[] | undefined, text: string): CodexCitation[] {
  const citations = new Map<string, CodexCitation>();
  for (const result of results ?? []) {
    if (!isRecord(result) || typeof result.url !== "string" || !isHttpUrl(result.url)) continue;
    citations.set(result.url, {
      title: typeof result.title === "string" ? result.title : undefined,
      url: result.url,
    });
  }
  for (const citation of extractMarkdownCitations(text)) {
    if (!citations.has(citation.url)) citations.set(citation.url, citation);
  }
  return [...citations.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function extractMarkdownCitations(text: string): CodexCitation[] {
  const citations = new Map<string, CodexCitation>();
  const markdownLinkPattern = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!url || citations.has(url)) continue;
    citations.set(url, { title: title || url, url, startIndex: match.index });
  }
  return [...citations.values()];
}
