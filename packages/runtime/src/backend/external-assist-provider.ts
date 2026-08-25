import path from "node:path";
import { ExternalAssistHintSchema, type ExternalAssistHint, type ExternalAssistProviderConfigDiagnostics } from "@samurai-agent/core-schemas";
import type { ExternalAssistPrefetchInput, ExternalAssistProvider, ExternalAssistSyncInput } from "../agent-runtime";

export interface LocalFileExternalAssistProviderOptions {
  id?: string;
  filePath: string;
  maxHints?: number;
  readText?: (filePath: string) => Promise<string>;
}

export type ExternalAssistFileReader = (filePath: string) => Promise<string>;

export interface HttpExternalAssistProviderOptions {
  id?: string;
  url: string;
  token?: string;
  authHeader?: string;
  /**
   * Raw conversation context is never sent unless the host explicitly opts
   * in.  A configured endpoint alone is not proof that the user approved
   * sharing message contents or search text with that endpoint.
   */
  shareRawContext?: boolean;
  timeoutMs?: number;
  maxHints?: number;
  fetchImpl?: typeof fetch;
}

interface LocalExternalAssistItem {
  id?: string;
  title?: string;
  summary?: string;
  content?: string;
  source_uri?: string;
  source_label?: string;
  keywords?: string[];
  confidence?: number;
}

interface ScoredExternalAssistItem {
  item: LocalExternalAssistItem;
  index: number;
  score: number;
}

export class LocalFileExternalAssistProvider implements ExternalAssistProvider {
  readonly id: string;
  private readonly maxHints: number;

  constructor(private readonly options: LocalFileExternalAssistProviderOptions) {
    this.id = options.id?.trim() || "local-file-external-assist";
    this.maxHints = normalizeMaxHints(options.maxHints);
  }

  async prefetch(input: ExternalAssistPrefetchInput): Promise<ExternalAssistHint[]> {
    if (!this.options.readText) throw new Error("external_assist_file_reader_unavailable");
    const items = parseLocalExternalAssistItems(await this.options.readText(this.options.filePath));
    const terms = tokenize([
      input.query,
      ...input.recentMessages.map((message) => message.content),
      ...input.sessionSearch.flatMap((item) => [item.title, item.summary])
    ].join(" "));
    if (terms.length === 0) {
      return [];
    }

    return items
      .map((item, index) => ({ item, index, score: scoreExternalAssistItem(item, terms) }))
      .filter((scored) => scored.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, this.maxHints)
      .map((scored) => externalAssistHintFromItem(scored, this.options.filePath));
  }
}

export class HttpExternalAssistProvider implements ExternalAssistProvider {
  readonly id: string;
  private readonly url: URL;
  private readonly maxHints: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpExternalAssistProviderOptions) {
    this.id = options.id?.trim() || "http-external-assist";
    this.url = normalizeHttpExternalAssistUrl(options.url);
    this.maxHints = normalizeMaxHints(options.maxHints);
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async prefetch(input: ExternalAssistPrefetchInput): Promise<ExternalAssistHint[]> {
    const rawContext = this.options.shareRawContext === true;
    return this.requestHints({
      phase: "prefetch",
      session_id: input.sessionId,
      query: rawContext ? input.query : "",
      recent_messages: rawContext
        ? input.recentMessages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          created_at: message.created_at
        }))
        : input.recentMessages.map((message) => ({
          id: message.id,
          role: message.role,
          created_at: message.created_at
        })),
      session_search: rawContext
        ? input.sessionSearch
        : input.sessionSearch.map((item) => ({ kind: item.kind, id: item.id })),
      context_redacted: !rawContext
    });
  }

  async syncTurn(input: ExternalAssistSyncInput): Promise<ExternalAssistHint[]> {
    const rawContext = this.options.shareRawContext === true;
    return this.requestHints({
      phase: "sync",
      session_id: input.sessionId,
      run_id: input.runId,
      input_message_id: input.inputMessageId,
      query: rawContext ? input.query : "",
      ...(rawContext
        ? {
          user_content: input.userContent,
          assistant_content: input.assistantContent
        }
        : {}),
      context_redacted: !rawContext
    });
  }

  private async requestHints(payload: Record<string, unknown>): Promise<ExternalAssistHint[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`external_assist_http_${response.status}`);
      }
      const body = await response.json() as unknown;
      return normalizeHttpExternalAssistHints(body, this.maxHints);
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    const token = this.options.token?.trim();
    if (token) {
      const headerName = this.options.authHeader?.trim() || "authorization";
      headers[headerName] = headerName.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
    }
    return headers;
  }
}

export function createExternalAssistProviderFromEnv(env: NodeJS.ProcessEnv = process.env, readText?: ExternalAssistFileReader): ExternalAssistProvider | undefined {
  return createExternalAssistProvidersFromEnv(env, readText)[0];
}

export function createExternalAssistProvidersFromEnv(env: NodeJS.ProcessEnv = process.env, readText?: ExternalAssistFileReader): ExternalAssistProvider[] {
  const diagnostics = describeExternalAssistProviderConfig(env);
  if (!diagnostics.configured) {
    return [];
  }
  const httpUrl = env.SAMURAI_EXTERNAL_ASSIST_URL?.trim();
  if (httpUrl) {
    return [new HttpExternalAssistProvider({
      id: env.SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID,
      url: httpUrl,
      token: env.SAMURAI_EXTERNAL_ASSIST_TOKEN,
      authHeader: env.SAMURAI_EXTERNAL_ASSIST_AUTH_HEADER,
      shareRawContext: env.SAMURAI_EXTERNAL_ASSIST_SHARE_RAW_CONTEXT === "1",
      timeoutMs: Number.parseInt(env.SAMURAI_EXTERNAL_ASSIST_TIMEOUT_MS ?? "", 10),
      maxHints: Number.parseInt(env.SAMURAI_EXTERNAL_ASSIST_MAX_HINTS ?? "", 10)
    })];
  }
  const filePaths = externalAssistFilePaths(env);
  const providerIds = externalAssistProviderIds(env, filePaths.length);
  return filePaths.map((filePath, index) => new LocalFileExternalAssistProvider({
    id: providerIds[index],
    filePath: path.resolve(filePath),
    readText,
    maxHints: Number.parseInt(env.SAMURAI_EXTERNAL_ASSIST_MAX_HINTS ?? "", 10)
  }));
}

export function describeExternalAssistProviderConfig(env: NodeJS.ProcessEnv = process.env): ExternalAssistProviderConfigDiagnostics {
  const httpUrl = env.SAMURAI_EXTERNAL_ASSIST_URL?.trim();
  const filePaths = externalAssistFilePaths(env);
  const providerId = stringValue(env.SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID) ?? null;
  const maxHints = normalizeMaxHints(Number.parseInt(env.SAMURAI_EXTERNAL_ASSIST_MAX_HINTS ?? "", 10));
  const timeoutMs = normalizeTimeoutMs(Number.parseInt(env.SAMURAI_EXTERNAL_ASSIST_TIMEOUT_MS ?? "", 10));
  const tokenConfigured = Boolean(env.SAMURAI_EXTERNAL_ASSIST_TOKEN?.trim());
  const authHeader = stringValue(env.SAMURAI_EXTERNAL_ASSIST_AUTH_HEADER) ?? null;
  const rawContextShared = env.SAMURAI_EXTERNAL_ASSIST_SHARE_RAW_CONTEXT === "1";

  if (httpUrl) {
    const warnings = [
      ...(filePaths.length > 0 ? ["external_assist_file_ignored_because_url_is_set"] : []),
      ...(rawContextShared ? [] : ["external_assist_raw_context_redacted_by_default"])
    ];
    try {
      const url = normalizeHttpExternalAssistUrl(httpUrl);
      return {
        configured: true,
        source: "http",
        provider_id: providerId ?? "http-external-assist",
        provider_ids: [providerId ?? "http-external-assist"],
        provider_count: 1,
        provider_kind: "http",
        max_hints: maxHints,
        timeout_ms: timeoutMs,
        token_configured: tokenConfigured,
        auth_header: authHeader,
        raw_context_shared: rawContextShared,
        endpoint_origin: url.origin,
        endpoint_path_configured: Boolean(url.pathname && url.pathname !== "/"),
        errors: [],
        warnings
      };
    } catch {
      return {
        configured: false,
        source: "invalid",
        provider_id: providerId,
        provider_ids: providerId ? [providerId] : [],
        provider_count: 0,
        provider_kind: "http",
        max_hints: maxHints,
        timeout_ms: timeoutMs,
        token_configured: tokenConfigured,
        auth_header: authHeader,
        raw_context_shared: rawContextShared,
        errors: ["invalid_external_assist_url"],
        warnings
      };
    }
  }

  if (filePaths.length > 1) {
    const providerIds = externalAssistProviderIds(env, filePaths.length);
    return {
      configured: true,
      source: "multiple",
      provider_id: providerIds.join(", "),
      provider_ids: providerIds,
      provider_count: filePaths.length,
      provider_kind: "multiple",
      max_hints: maxHints,
      timeout_ms: null,
      token_configured: tokenConfigured,
      auth_header: authHeader,
      raw_context_shared: false,
      file_name: filePaths.map((filePath) => path.basename(filePath)).join(", "),
      errors: [],
      warnings: tokenConfigured ? ["external_assist_token_ignored_without_url"] : []
    };
  }

  if (filePaths.length === 1) {
    const providerIds = externalAssistProviderIds(env, 1);
    const filePath = filePaths[0] ?? "";
    return {
      configured: true,
      source: "local_file",
      provider_id: providerIds[0] ?? "local-file-external-assist",
      provider_ids: providerIds,
      provider_count: 1,
      provider_kind: "local_file",
      max_hints: maxHints,
      timeout_ms: null,
      token_configured: tokenConfigured,
      auth_header: authHeader,
      raw_context_shared: false,
      file_name: path.basename(filePath),
      errors: [],
      warnings: tokenConfigured ? ["external_assist_token_ignored_without_url"] : []
    };
  }

  return {
    configured: false,
    source: "none",
    provider_id: null,
    provider_ids: [],
    provider_count: 0,
    provider_kind: null,
    max_hints: maxHints,
    timeout_ms: null,
    token_configured: tokenConfigured,
    auth_header: authHeader,
    raw_context_shared: false,
    errors: [],
    warnings: tokenConfigured ? ["external_assist_token_ignored_without_provider"] : []
  };
}

function externalAssistFilePaths(env: NodeJS.ProcessEnv): string[] {
  const paths = [
    stringValue(env.SAMURAI_EXTERNAL_ASSIST_FILE),
    ...splitExternalAssistList(env.SAMURAI_EXTERNAL_ASSIST_FILES)
  ].filter((value): value is string => Boolean(value));
  return [...new Set(paths)];
}

function externalAssistProviderIds(env: NodeJS.ProcessEnv, count: number): string[] {
  const configuredIds = splitExternalAssistList(env.SAMURAI_EXTERNAL_ASSIST_PROVIDER_IDS);
  const singleProviderId = stringValue(env.SAMURAI_EXTERNAL_ASSIST_PROVIDER_ID);
  return Array.from({ length: count }, (_value, index) => (
    configuredIds[index]
      ?? (count === 1 ? singleProviderId : undefined)
      ?? `local-file-external-assist-${index + 1}`
  ));
}

function splitExternalAssistList(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  const separators = new Set([path.delimiter, ","]);
  const pattern = new RegExp(`[${[...separators].map(escapeRegExp).join("")}]`, "u");
  return value.split(pattern).map((item) => item.trim()).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function parseLocalExternalAssistItems(raw: string): LocalExternalAssistItem[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parsed = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter(isRecord)
    .map((item) => ({
      id: stringValue(item.id),
      title: stringValue(item.title),
      summary: stringValue(item.summary),
      content: stringValue(item.content),
      source_uri: stringValue(item.source_uri),
      source_label: stringValue(item.source_label),
      keywords: Array.isArray(item.keywords) ? item.keywords.map(stringValue).filter((value): value is string => Boolean(value)) : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : undefined
    }))
    .filter((item) => item.summary || item.content);
}

function externalAssistHintFromItem(scored: ScoredExternalAssistItem, filePath: string): ExternalAssistHint {
  const { item, index, score } = scored;
  const id = item.id?.trim() || `local_external_hint_${index + 1}`;
  return {
    id,
    ...(item.title?.trim() ? { title: item.title.trim() } : {}),
    summary: (item.summary ?? item.content ?? "").trim(),
    ...(item.source_uri?.trim() ? { source_uri: item.source_uri.trim() } : {}),
    source_label: item.source_label?.trim() || path.basename(filePath),
    confidence: item.confidence !== undefined ? clampConfidence(item.confidence) : confidenceFromScore(score)
  };
}

function scoreExternalAssistItem(item: LocalExternalAssistItem, terms: string[]): number {
  const title = tokenize(item.title ?? "");
  const summary = tokenize(`${item.summary ?? ""} ${item.content ?? ""}`);
  const source = tokenize(item.source_label ?? "");
  const keywords = (item.keywords ?? []).flatMap(tokenize);
  let score = 0;
  for (const term of terms) {
    if (keywords.includes(term)) {
      score += 4;
    }
    if (title.includes(term)) {
      score += 3;
    }
    if (summary.includes(term)) {
      score += 1;
    }
    if (source.includes(term)) {
      score += 1;
    }
  }
  return score;
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/u).map((term) => term.trim()).filter(Boolean))];
}

function normalizeMaxHints(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5;
  }
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 5000;
  }
  return Math.min(30000, Math.max(250, Math.trunc(value)));
}

function normalizeHttpExternalAssistUrl(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("external_assist_url_must_be_http");
  }
  return url;
}

function normalizeHttpExternalAssistHints(body: unknown, maxHints: number): ExternalAssistHint[] {
  const rawHints = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.hints)
      ? body.hints
      : [];
  return rawHints
    .filter(isRecord)
    .map((hint, index) => ({
      id: stringValue(hint.id) ?? `http_external_hint_${index + 1}`,
      title: stringValue(hint.title),
      summary: stringValue(hint.summary) ?? stringValue(hint.content) ?? "",
      source_uri: stringValue(hint.source_uri),
      source_label: stringValue(hint.source_label),
      confidence: typeof hint.confidence === "number" ? clampConfidence(hint.confidence) : undefined
    }))
    .filter((hint) => hint.summary.trim())
    .slice(0, maxHints)
    .map((hint) => ExternalAssistHintSchema.parse({
      id: hint.id,
      ...(hint.title ? { title: hint.title.trim() } : {}),
      summary: hint.summary.trim(),
      ...(hint.source_uri ? { source_uri: hint.source_uri.trim() } : {}),
      ...(hint.source_label ? { source_label: hint.source_label.trim() } : {}),
      ...(hint.confidence !== undefined ? { confidence: hint.confidence } : {})
    }));
}

function confidenceFromScore(score: number): number {
  return Math.min(0.95, Math.max(0.35, 0.35 + score * 0.08));
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
