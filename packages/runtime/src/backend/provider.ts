import type { MemoryCandidate } from "@samurai-agent/memory";
import type { ExternalAssistContext, FreezeSnapshot, GatewayBoundaryRuntimeSnapshot, HostContextAssembly, MessageEnvelope, MessageRecord, SupportedLocale } from "@samurai-agent/core-schemas";
import type { TemporaryContextAttachment } from "@samurai-agent/agent-backends";
import { defaultModelForProvider, providerProfiles, type ProviderCredential, type ProviderProfile } from "../provider-profiles";

export type ProviderId = "openai" | "gemini" | "anthropic" | "openrouter" | "openai-compatible";
export type ProviderToolName = "create_artifact" | "request_external_send" | "request_delete" | "remember_topic";

export interface ProviderToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderDiagnostics {
  provider?: string;
  model?: string;
  status?: number;
  reason: "not_configured" | "auth_failed" | "rate_limited" | "temporary_unavailable" | "model_not_found" | "invalid_model" | "invalid_response" | "network" | "unknown";
  retryable: boolean;
  message?: string;
}

export interface ProviderOutput {
  content: string;
  toolCalls: ProviderToolCall[];
  finishReason?: string;
  usage?: Record<string, unknown>;
  diagnostics?: ProviderDiagnostics[];
}

export interface ProviderInput {
  envelope: MessageEnvelope;
  freezeSnapshot?: FreezeSnapshot;
  gatewayBoundary?: GatewayBoundaryRuntimeSnapshot;
  activeMemory: MemoryCandidate[];
  knowledgeWiki: Array<{ id: string; slug: string; title: string; content: string }>;
  collectionNotes: Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>;
  selectedSkills: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    allowed_scopes?: string[];
    required_capabilities: string[];
    disclosure_level?: "catalog" | "body" | "support";
    selection_reason?: string;
    selection?: {
      score: number;
      matched_terms: string[];
      matched_capabilities: string[];
      missing_capabilities: string[];
      unsupported_scopes: string[];
      reasons: string[];
    };
    usage?: {
      use_count: number;
      last_used_at?: string;
    };
    content?: string;
    support_file_refs?: Array<{ path: string }>;
    support_files?: Array<{ path: string; content: string }>;
  }>;
  sessionSearch: Array<{ kind: string; id: string; title: string; summary: string }>;
  sessionSummary?: {
    session_key: string;
    title: string;
    ui_locale: SupportedLocale;
    output_locale: SupportedLocale;
    message_count: number;
    operation_count: number;
    backend_run_count: number;
    tool_run_count: number;
    workspace_change_count: number;
    last_message_at?: string;
    last_backend_run_id?: string;
    last_backend_run_status?: string;
  };
  externalAssist?: ExternalAssistContext;
  contextAssembly?: HostContextAssembly;
  availableTools: string[];
  recentMessages: MessageRecord[];
  temporaryContext: TemporaryContextAttachment[];
}

export interface ProviderAdapter {
  readonly id: ProviderId | "fake";
  readonly model: string;
  generate(input: ProviderInput): Promise<ProviderOutput>;
}

export interface ProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
}

export class ProviderRequestError extends Error {
  constructor(
    readonly code: "provider_not_configured" | "provider_failed",
    message: string,
    readonly diagnostics: ProviderDiagnostics = {
      reason: code === "provider_not_configured" ? "not_configured" : "unknown",
      retryable: false,
      message: safeDiagnosticMessage(message)
    }
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export class ProviderRegistry implements ProviderAdapter {
  readonly id = "fake" as const;
  readonly model: string;

  constructor(private readonly candidates: ProviderAdapter[]) {
    this.model = candidates[0]?.model ?? "unconfigured";
  }

  getStatus(): { configured: boolean; primary?: ProviderStatus; fallbacks: ProviderStatus[] } {
    const [primary, ...fallbacks] = this.candidates.map((candidate) => ({
      provider: candidate.id,
      model: candidate.model,
      configured: true
    }));
    return {
      configured: this.candidates.length > 0,
      ...(primary ? { primary } : {}),
      fallbacks
    };
  }

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    if (this.candidates.length === 0) {
      throw new ProviderRequestError("provider_not_configured", "No LLM provider is configured.", {
        reason: "not_configured",
        retryable: false
      });
    }

    const failures: ProviderDiagnostics[] = [];
    for (const candidate of this.candidates) {
      try {
        return await candidate.generate(input);
      } catch (error) {
        failures.push(providerFailureDiagnostic(candidate, error));
      }
    }

    throw new ProviderRequestError("provider_failed", "All configured LLM providers failed.", combineFailureDiagnostics(failures));
  }
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake" as const;

  constructor(
    readonly model: string,
    private readonly output: ProviderOutput | ((input: ProviderInput) => ProviderOutput | Promise<ProviderOutput>)
  ) {}

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    const output = typeof this.output === "function" ? await this.output(input) : this.output;
    return validateProviderOutput(output);
  }
}

export function createProviderRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const refs = resolveModelRefs(env);
  const adapters = refs.map((ref) => adapterForRef(ref, env)).filter((adapter): adapter is ProviderAdapter => Boolean(adapter));
  return new ProviderRegistry(adapters);
}

interface ModelRef {
  provider: ProviderId;
  model: string;
}

function resolveModelRefs(env: NodeJS.ProcessEnv): ModelRef[] {
  const refs: ModelRef[] = [];
  const primary = env.SAMURAI_LLM_MODEL?.trim();
  if (primary) {
    refs.push(parseModelRef(primary));
  } else {
    const automatic = firstAvailableDefault(env);
    if (automatic) {
      refs.push(automatic);
    }
  }

  for (const fallback of splitCsv(env.SAMURAI_LLM_FALLBACKS)) {
    refs.push(parseModelRef(fallback));
  }

  return dedupeRefs(refs);
}

function firstAvailableDefault(env: NodeJS.ProcessEnv): ModelRef | undefined {
  const providerOrder: ProviderId[] = ["gemini", "openai", "anthropic", "openrouter", "openai-compatible"];
  for (const provider of providerOrder) {
    if (providerProfiles[provider].resolveCredential(env)) {
      return { provider, model: defaultModelForProvider(provider) };
    }
  }
  return undefined;
}

function adapterForRef(ref: ModelRef, env: NodeJS.ProcessEnv): ProviderAdapter | undefined {
  const profile = providerProfiles[ref.provider];
  const credential = profile.resolveCredential(env);
  return credential ? new ProfileProviderAdapter(profile, ref.model, credential) : undefined;
}

class ProfileProviderAdapter implements ProviderAdapter {
  readonly id: ProviderId;

  constructor(
    private readonly profile: ProviderProfile,
    readonly model: string,
    private readonly credential: ProviderCredential
  ) {
    this.id = profile.id;
  }

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    const request = this.profile.buildRequest(this.model, this.credential, input);
    const response = await postJson(this.profile, request.url, request.headers, request.body);
    try {
      return this.profile.normalizeResponse(response);
    } catch (error) {
      throw new ProviderRequestError("provider_failed", error instanceof Error ? error.message : "Provider response was invalid.", {
        reason: "invalid_response",
        retryable: false,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider response was invalid.")
      });
    }
  }
}

function parseModelRef(value: string): ModelRef {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ProviderRequestError("provider_not_configured", `LLM model must use provider/model format: ${value}`, {
      reason: "invalid_model",
      retryable: false
    });
  }
  const provider = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!isProviderId(provider)) {
    throw new ProviderRequestError("provider_not_configured", `Unsupported LLM provider: ${provider}`, {
      reason: "not_configured",
      retryable: false
    });
  }
  return { provider, model };
}

function isProviderId(value: string): value is ProviderId {
  return value === "openai" || value === "gemini" || value === "anthropic" || value === "openrouter" || value === "openai-compatible";
}

function dedupeRefs(refs: ModelRef[]): ModelRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function splitCsv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

async function postJson(profile: ProviderProfile, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (error) {
    throw new ProviderRequestError("provider_failed", "Provider request failed.", {
      reason: "network",
      retryable: true,
      message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider request failed.")
    });
  }

  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new ProviderRequestError("provider_failed", `Provider returned ${response.status}.`, {
      status: response.status,
      reason: profile.classifyError(response.status, message),
      retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
      message: safeDiagnosticMessage(message)
    });
  }

  return response.json() as Promise<unknown>;
}

function validateProviderOutput(value: unknown): ProviderOutput {
  if (!isRecord(value)) {
    throw invalidResponse("Provider output was not an object.");
  }
  if (typeof value.agentMessage === "string") {
    return normalizeLegacyProviderOutput(value);
  }
  const content = stringValue(value.content).trim();
  if (!content) {
    throw invalidResponse("Provider output was missing content.");
  }
  return {
    content,
    toolCalls: normalizeToolCalls(value.toolCalls),
    ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage } : {}),
    ...(Array.isArray(value.diagnostics) ? { diagnostics: value.diagnostics.filter(isProviderDiagnostics) } : {})
  };
}

function normalizeLegacyProviderOutput(value: Record<string, unknown>): ProviderOutput {
  const content = stringValue(value.agentMessage).trim();
  if (!content) {
    throw invalidResponse("Provider output was missing agentMessage.");
  }
  const toolCalls: ProviderToolCall[] = [];
  if (value.artifact !== undefined && value.artifact !== null) {
    toolCalls.push({ name: "create_artifact", arguments: isRecord(value.artifact) ? value.artifact : {} });
  }
  if (value.wantsTopicMemory === true) {
    toolCalls.push({ name: "remember_topic", arguments: {} });
  }
  if (value.outboundIntent === true) {
    toolCalls.push({ name: "request_external_send", arguments: {} });
  }
  if (value.deleteIntent === true) {
    toolCalls.push({ name: "request_delete", arguments: {} });
  }
  return { content, toolCalls };
}

function normalizeToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeToolCall).filter((item): item is ProviderToolCall => Boolean(item));
}

function normalizeToolCall(value: unknown): ProviderToolCall | undefined {
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    name: value.name,
    arguments: parseToolArguments(value.arguments)
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function invalidResponse(message: string): ProviderRequestError {
  return new ProviderRequestError("provider_failed", message, {
    reason: "invalid_response",
    retryable: false,
    message: safeDiagnosticMessage(message)
  });
}

function isProviderDiagnostics(value: unknown): value is ProviderDiagnostics {
  return isRecord(value) && typeof value.reason === "string" && typeof value.retryable === "boolean";
}

function providerFailureDiagnostic(candidate: ProviderAdapter, error: unknown): ProviderDiagnostics {
  const diagnostic = error instanceof ProviderRequestError ? error.diagnostics : undefined;
  return {
    provider: candidate.id,
    model: candidate.model,
    status: diagnostic?.status,
    reason: diagnostic?.reason ?? "unknown",
    retryable: diagnostic?.retryable ?? false,
    message: diagnostic?.message
  };
}

function combineFailureDiagnostics(failures: ProviderDiagnostics[]): ProviderDiagnostics {
  const firstRetryable = failures.find((failure) => failure.retryable);
  const first = firstRetryable ?? failures[0];
  return {
    provider: first?.provider,
    model: first?.model,
    status: first?.status,
    reason: first?.reason ?? "unknown",
    retryable: failures.some((failure) => failure.retryable),
    message: failures.map((failure) => [failure.provider, failure.model, failure.status, failure.reason].filter(Boolean).join("/")).join(" | ")
  };
}

function safeDiagnosticMessage(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/key=([A-Za-z0-9._~+/=-]+)/gi, "key=[redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "api_key=[redacted]")
    .slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
