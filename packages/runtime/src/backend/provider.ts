import type { MemoryCandidate } from "@samurai-agent/memory";
import type { ExternalAssistContext, FreezeSnapshot, GatewayBoundaryRuntimeSnapshot, HostContextAssembly, MessageEnvelope, MessageRecord, SupportedLocale } from "@samurai-agent/core-schemas";
import type { TemporaryContextAttachment } from "@samurai-agent/agent-backends";
import { defaultModelForProvider, providerProfiles, type ProviderCredential, type ProviderProfile } from "../provider-profiles";

export type ProviderId = "openai" | "gemini" | "anthropic" | "openrouter" | "openai-compatible";
export type ProviderToolName = "create_artifact" | "create_generated_surface" | "request_external_send" | "remember_topic";

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

/** A provider-owned increment. Text is deliberately kept untrimmed so that
 * whitespace between streamed model tokens is not lost at the Host boundary.
 */
export interface ProviderStreamChunk {
  content?: string;
  toolCalls?: ProviderToolCall[];
  finishReason?: string;
  usage?: Record<string, unknown>;
  /** Provider metadata that must not be rendered as assistant text. */
  ignored?: boolean;
  /** Explicit stream terminator (for example an SSE [DONE] sentinel). */
  terminal?: boolean;
}

export interface ProviderInput {
  abortSignal?: AbortSignal;
  envelope: MessageEnvelope;
  agentContext?: { id: string; name: string; role: string; instructions: string; authority: "supporting_context" };
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
  /** Optional native streaming path. Adapters without it keep generate(). */
  stream?(input: ProviderInput): AsyncIterable<ProviderStreamChunk>;
}

/** A single provider request must eventually settle, even if the transport never responds. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 120_000;

export interface ProviderStatus {
  provider: string;
  model: string;
  configured: boolean;
}

export type ProviderFailureDisposition = "not_started" | "provider_terminal_response" | "transport_lost" | "cancel_unconfirmed";

export class ProviderRequestError extends Error {
  constructor(
    readonly code: "provider_not_configured" | "provider_failed",
    message: string,
    readonly diagnostics: ProviderDiagnostics = {
      reason: code === "provider_not_configured" ? "not_configured" : "unknown",
      retryable: false,
      message: safeDiagnosticMessage(message)
    },
    readonly disposition: ProviderFailureDisposition = defaultFailureDisposition(code, diagnostics)
  ) {
    super(safeDiagnosticMessage(message));
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
    if (input.abortSignal?.aborted) {
      throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
        reason: "network",
        retryable: false,
        message: "Provider request was cancelled before starting."
      }, "not_started");
    }
    if (this.candidates.length === 0) {
      throw new ProviderRequestError("provider_not_configured", "No LLM provider is configured.", {
        reason: "not_configured",
        retryable: false
      });
    }

    const failures: Array<{ diagnostics: ProviderDiagnostics; disposition: ProviderFailureDisposition }> = [];
    for (const candidate of this.candidates) {
      if (input.abortSignal?.aborted) {
        throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
          reason: "network",
          retryable: false,
          message: "Provider request was cancelled before starting."
        }, "not_started");
      }
      try {
        return await candidate.generate(input);
      } catch (error) {
        const disposition = providerFailureDisposition(error);
        if (disposition === "transport_lost" || disposition === "cancel_unconfirmed") {
          if (error instanceof ProviderRequestError) {
            throw new ProviderRequestError(error.code, error.message, {
              ...error.diagnostics,
              provider: error.diagnostics.provider ?? candidate.id,
              model: error.diagnostics.model ?? candidate.model
            }, disposition);
          }
          throw new ProviderRequestError("provider_failed", error instanceof Error ? error.message : "Provider request failed.", providerFailureDiagnostic(candidate, error), disposition);
        }
        failures.push({
          diagnostics: providerFailureDiagnostic(candidate, error),
          disposition
        });
      }
    }

    throw new ProviderRequestError(
      "provider_failed",
      "All configured LLM providers failed.",
      combineFailureDiagnostics(failures.map((failure) => failure.diagnostics)),
      combineFailureDispositions(failures.map((failure) => failure.disposition))
    );
  }

  async *stream(input: ProviderInput): AsyncIterable<ProviderStreamChunk> {
    if (input.abortSignal?.aborted) {
      throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
        reason: "network",
        retryable: false,
        message: "Provider request was cancelled before starting."
      }, "not_started");
    }
    if (this.candidates.length === 0) {
      throw new ProviderRequestError("provider_not_configured", "No LLM provider is configured.", {
        reason: "not_configured",
        retryable: false
      });
    }

    const failures: Array<{ diagnostics: ProviderDiagnostics; disposition: ProviderFailureDisposition }> = [];
    for (const candidate of this.candidates) {
      if (input.abortSignal?.aborted) {
        throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
          reason: "network",
          retryable: false,
          message: "Provider request was cancelled before starting."
        }, "not_started");
      }
      let emitted = false;
      try {
        if (candidate.stream) {
          for await (const chunk of candidate.stream(input)) {
            const normalized = validateProviderStreamChunk(chunk);
            if (hasProviderStreamValue(normalized)) emitted = true;
            yield normalized;
          }
        } else {
          const output = await candidate.generate(input);
          emitted = true;
          yield {
            content: output.content,
            toolCalls: output.toolCalls,
            ...(output.finishReason ? { finishReason: output.finishReason } : {}),
            ...(output.usage ? { usage: output.usage } : {}),
            terminal: true
          };
        }
        return;
      } catch (error) {
        const disposition = providerFailureDisposition(error);
        // Once a stream has exposed output, retrying another provider could
        // duplicate visible work or a host-side effect. A transport loss is
        // also intentionally never retried, matching generate().
        if (emitted || disposition === "transport_lost" || disposition === "cancel_unconfirmed") {
          throw providerFailureForCandidate(candidate, error, disposition);
        }
        failures.push({
          diagnostics: providerFailureDiagnostic(candidate, error),
          disposition
        });
      }
    }

    throw new ProviderRequestError(
      "provider_failed",
      "All configured LLM providers failed.",
      combineFailureDiagnostics(failures.map((failure) => failure.diagnostics)),
      combineFailureDispositions(failures.map((failure) => failure.disposition))
    );
  }
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake" as const;

  constructor(
    readonly model: string,
    private readonly output: ProviderOutput | ((input: ProviderInput) => ProviderOutput | Promise<ProviderOutput>)
  ) {}

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    if (input.abortSignal?.aborted) {
      throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
        reason: "network",
        retryable: false,
        message: "Provider request was cancelled before starting."
      }, "not_started");
    }
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
  readonly stream?: (input: ProviderInput) => AsyncIterable<ProviderStreamChunk>;

  constructor(
    private readonly profile: ProviderProfile,
    readonly model: string,
    private readonly credential: ProviderCredential
  ) {
    this.id = profile.id;
    if (profile.buildStreamRequest && profile.normalizeStreamChunk) {
      this.stream = (input) => this.streamProfile(input);
    }
  }

  async generate(input: ProviderInput): Promise<ProviderOutput> {
    const request = this.profile.buildRequest(this.model, this.credential, input);
    const response = await postJson(this.profile, request.url, request.headers, request.body, input.abortSignal);
    try {
      const output = this.profile.normalizeResponse(response);
      return { ...output, toolCalls: ensureProviderToolCallIds(output.toolCalls) };
    } catch (error) {
      throw new ProviderRequestError("provider_failed", error instanceof Error ? error.message : "Provider response was invalid.", {
        reason: "invalid_response",
        retryable: false,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider response was invalid.")
      });
    }
  }

  private async *streamProfile(input: ProviderInput): AsyncIterable<ProviderStreamChunk> {
    const buildStreamRequest = this.profile.buildStreamRequest;
    const normalizeStreamChunk = this.profile.normalizeStreamChunk;
    if (!buildStreamRequest || !normalizeStreamChunk) return;
    const request = buildStreamRequest(this.model, this.credential, input);
    for await (const response of postSse(this.profile, request.url, request.headers, request.body, input.abortSignal)) {
      if (response === providerSseDoneMarker) {
        yield { terminal: true };
        return;
      }
      try {
        yield normalizeStreamChunk(response);
      } catch (error) {
        throw new ProviderRequestError("provider_failed", error instanceof Error ? error.message : "Provider response was invalid.", {
          provider: this.id,
          model: this.model,
          reason: "invalid_response",
          retryable: false,
          message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider response was invalid.")
        }, "provider_terminal_response");
      }
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

async function postJson(profile: ProviderProfile, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) {
    throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
      reason: "network",
      retryable: false,
      message: "Provider request was cancelled before starting."
    }, "not_started");
  }
  const control = createProviderRequestControl(signal);
  try {
    let response: Response;
    try {
      response = await awaitProviderRequest(fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: control.signal
      }), control);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const aborted = signal?.aborted === true || error instanceof Error && error.name === "AbortError";
      throw new ProviderRequestError("provider_failed", "Provider request failed.", {
        reason: "network",
        retryable: !aborted,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider request failed.", headerSecrets(headers))
      }, aborted ? "cancel_unconfirmed" : "transport_lost");
    }

    if (!response.ok) {
      const message = await awaitProviderRequest(response.text().catch(() => response.statusText), control);
      throw new ProviderRequestError("provider_failed", `Provider returned ${response.status}.`, {
        status: response.status,
        reason: profile.classifyError(response.status, message),
        retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
        message: safeDiagnosticMessage(message, headerSecrets(headers))
      });
    }

    try {
      return await awaitProviderRequest(response.json() as Promise<unknown>, control);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError("provider_failed", "Provider response was invalid.", {
        status: response.status,
        reason: "invalid_response",
        retryable: false,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider response was invalid.", headerSecrets(headers))
      }, "provider_terminal_response");
    }
  } finally {
    control.dispose();
  }
}

export interface ProviderSseEvent {
  event?: string;
  data: string;
}

/** Incremental SSE parser that safely carries an incomplete line across reads. */
export class ServerSentEventParser {
  private lineBuffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;

  push(chunk: string): ProviderSseEvent[] {
    this.lineBuffer += chunk;
    const events: ProviderSseEvent[] = [];
    while (true) {
      const lineEnd = findSseLineEnd(this.lineBuffer);
      if (!lineEnd) break;
      const rawLine = this.lineBuffer.slice(0, lineEnd.index);
      this.lineBuffer = this.lineBuffer.slice(lineEnd.nextIndex);
      this.consumeLine(rawLine, events);
    }
    return events;
  }

  finish(): ProviderSseEvent[] {
    const events: ProviderSseEvent[] = [];
    if (this.lineBuffer) {
      const rawLine = this.lineBuffer.endsWith("\r") ? this.lineBuffer.slice(0, -1) : this.lineBuffer;
      this.lineBuffer = "";
      this.consumeLine(rawLine, events);
    }
    this.dispatch(events);
    return events;
  }

  private consumeLine(line: string, events: ProviderSseEvent[]): void {
    if (line === "") {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventName = value;
    }
  }

  private dispatch(events: ProviderSseEvent[]): void {
    if (this.dataLines.length === 0 && this.eventName === undefined) return;
    events.push({
      ...(this.eventName !== undefined ? { event: this.eventName } : {}),
      data: this.dataLines.join("\n")
    });
    this.dataLines = [];
    this.eventName = undefined;
  }
}

function findSseLineEnd(value: string): { index: number; nextIndex: number } | undefined {
  const lineFeed = value.indexOf("\n");
  const carriageReturn = value.indexOf("\r");
  const index = lineFeed < 0 ? carriageReturn : carriageReturn < 0 ? lineFeed : Math.min(lineFeed, carriageReturn);
  if (index < 0) return undefined;
  if (value[index] === "\r" && index === value.length - 1) return undefined;
  return {
    index,
    nextIndex: value[index] === "\r" && value[index + 1] === "\n" ? index + 2 : index + 1
  };
}

export function parseServerSentEventData(event: ProviderSseEvent): unknown | undefined {
  const data = event.data.trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw invalidResponse("Provider stream response was invalid.");
  }
}

interface ProviderRequestControl {
  signal: AbortSignal;
  timeoutPromise: Promise<never>;
  abortPromise: Promise<never>;
  timedOut(): boolean;
  dispose(): void;
}

function createProviderRequestControl(parentSignal?: AbortSignal): ProviderRequestControl {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: (error: ProviderRequestError) => void = () => undefined;
  let rejectAbort: (error: ProviderRequestError) => void = () => undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // The race below observes this rejection while a request is active. Keep a
  // handler attached as well so a caller aborting just after a fast response
  // cannot create an unhandled rejection before dispose() removes the listener.
  void abortPromise.catch(() => undefined);
  const onAbort = () => {
    controller.abort();
    rejectAbort(providerRequestCancellationError());
  };
  if (parentSignal?.aborted) {
    onAbort();
  } else {
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(providerRequestTimeoutError());
    }, PROVIDER_REQUEST_TIMEOUT_MS);
  }
  return {
    signal: controller.signal,
    timeoutPromise,
    abortPromise,
    timedOut: () => timedOut,
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", onAbort);
    }
  };
}

function awaitProviderRequest<T>(operation: Promise<T>, control: ProviderRequestControl): Promise<T> {
  return Promise.race([operation, control.timeoutPromise, control.abortPromise]);
}

function providerRequestTimeoutError(): ProviderRequestError {
  return new ProviderRequestError("provider_failed", "Provider request timed out.", {
    reason: "network",
    retryable: true,
    message: "Provider request timed out."
  }, "transport_lost");
}

function providerRequestCancellationError(): ProviderRequestError {
  return new ProviderRequestError("provider_failed", "Provider request cancellation was not confirmed.", {
    reason: "network",
    retryable: false,
    message: "Provider request cancellation was not confirmed."
  }, "cancel_unconfirmed");
}

async function* postSse(profile: ProviderProfile, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): AsyncIterable<unknown> {
  if (signal?.aborted) {
    throw new ProviderRequestError("provider_failed", "Provider request was cancelled before starting.", {
      reason: "network",
      retryable: false,
      message: "Provider request was cancelled before starting."
    }, "not_started");
  }
  const control = createProviderRequestControl(signal);
  try {
    let response: Response;
    try {
      response = await awaitProviderRequest(fetch(url, {
        method: "POST",
        headers: { ...headers, Accept: "text/event-stream" },
        body: JSON.stringify(body),
        signal: control.signal
      }), control);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const aborted = signal?.aborted === true || error instanceof Error && error.name === "AbortError";
      throw new ProviderRequestError("provider_failed", "Provider request failed.", {
        reason: "network",
        retryable: !aborted,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider request failed.", headerSecrets(headers))
      }, aborted ? "cancel_unconfirmed" : "transport_lost");
    }

    if (!response.ok) {
      const message = await awaitProviderRequest(response.text().catch(() => response.statusText), control);
      throw new ProviderRequestError("provider_failed", `Provider returned ${response.status}.`, {
        status: response.status,
        reason: profile.classifyError(response.status, message),
        retryable: response.status === 408 || response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500,
        message: safeDiagnosticMessage(message, headerSecrets(headers))
      });
    }
    if (!response.body) {
      throw new ProviderRequestError("provider_failed", "Provider stream response was empty.", {
        status: response.status,
        reason: "invalid_response",
        retryable: false,
        message: "Provider stream response was empty."
      }, "provider_terminal_response");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new ServerSentEventParser();
    try {
      while (true) {
        const next = await awaitProviderRequest(reader.read(), control);
        if (next.done) break;
        const text = decoder.decode(next.value, { stream: true });
        for (const event of parser.push(text)) {
          const parsed = parseSseEventForStream(event);
          if (parsed !== undefined) yield parsed;
        }
      }
      const tail = decoder.decode();
      for (const event of parser.push(tail)) {
        const parsed = parseSseEventForStream(event);
        if (parsed !== undefined) yield parsed;
      }
      for (const event of parser.finish()) {
        const parsed = parseSseEventForStream(event);
        if (parsed !== undefined) yield parsed;
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      const aborted = signal?.aborted === true || error instanceof Error && error.name === "AbortError";
      throw new ProviderRequestError("provider_failed", "Provider stream was interrupted.", {
        status: response.status,
        reason: "network",
        retryable: !aborted,
        message: safeDiagnosticMessage(error instanceof Error ? error.message : "Provider stream was interrupted.", headerSecrets(headers))
      }, aborted ? "cancel_unconfirmed" : "transport_lost");
    } finally {
      if (control.timedOut() || signal?.aborted) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // A transport that ignores abort may still have a pending read. The
        // request has already settled; there is no safe work left to expose.
      }
    }
  } finally {
    control.dispose();
  }
}

/** The SSE transport treats [DONE] as an explicit end-of-stream marker. */
const providerSseDoneMarker = Symbol("provider_sse_done");

function parseSseEventForStream(event: ProviderSseEvent): unknown | typeof providerSseDoneMarker | undefined {
  if (event.data.trim() === "[DONE]") return providerSseDoneMarker;
  return parseServerSentEventData(event);
}

function validateProviderOutput(value: unknown): ProviderOutput {
  if (!isRecord(value)) {
    throw invalidResponse("Provider output was not an object.");
  }
  if (typeof value.agentMessage === "string") {
    const output = normalizeLegacyProviderOutput(value);
    return { ...output, toolCalls: ensureProviderToolCallIds(output.toolCalls) };
  }
  const content = stringValue(value.content).trim();
  if (!content) {
    throw invalidResponse("Provider output was missing content.");
  }
  return {
    content,
    toolCalls: ensureProviderToolCallIds(normalizeToolCalls(value.toolCalls)),
    ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {}),
    ...(isRecord(value.usage) ? { usage: value.usage } : {}),
    ...(Array.isArray(value.diagnostics) ? { diagnostics: value.diagnostics.filter(isProviderDiagnostics) } : {})
  };
}

function validateProviderStreamChunk(value: unknown): ProviderStreamChunk {
  if (!isRecord(value)) {
    throw invalidResponse("Provider stream chunk was not an object.");
  }
  const content = typeof value.content === "string" ? value.content : undefined;
  const toolCalls = normalizeToolCalls(value.toolCalls);
  const finishReason = typeof value.finishReason === "string" ? value.finishReason : undefined;
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const ignored = value.ignored === true;
  const terminal = value.terminal === true;
  if (content === undefined && toolCalls.length === 0 && finishReason === undefined && usage === undefined && !ignored && !terminal) {
    throw invalidResponse("Provider stream chunk was empty.");
  }
  return {
    ...(content !== undefined ? { content } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
    ...(ignored ? { ignored: true } : {}),
    ...(terminal ? { terminal: true } : {})
  };
}

function hasProviderStreamValue(chunk: ProviderStreamChunk): boolean {
  return (chunk.content?.length ?? 0) > 0
  || (chunk.toolCalls?.length ?? 0) > 0
  || chunk.finishReason !== undefined
  || chunk.usage !== undefined
  || chunk.ignored === true
  || chunk.terminal === true;
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

/**
 * Provider APIs do not share a tool-call ID contract. In particular Gemini
 * function calls may omit one. Host execution needs an ID even for a replay,
 * so derive it from the call shape and occurrence rather than randomness.
 */
export function ensureProviderToolCallIds(toolCalls: ProviderToolCall[]): ProviderToolCall[] {
  const occurrences = new Map<string, number>();
  return toolCalls.map((toolCall) => {
    const base = toolCall.id?.trim() || `tool_${stableToolCallHash(toolCall)}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      ...toolCall,
      id: occurrence === 1 ? base : `${base}_${occurrence}`
    };
  });
}

function stableToolCallHash(toolCall: ProviderToolCall): string {
  const value = stableJson({ name: toolCall.name, arguments: toolCall.arguments });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
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

function providerFailureForCandidate(candidate: ProviderAdapter, error: unknown, disposition: ProviderFailureDisposition): ProviderRequestError {
  if (error instanceof ProviderRequestError) {
    return new ProviderRequestError(error.code, error.message, {
      ...error.diagnostics,
      provider: error.diagnostics.provider ?? candidate.id,
      model: error.diagnostics.model ?? candidate.model
    }, disposition);
  }
  return new ProviderRequestError(
    "provider_failed",
    error instanceof Error ? error.message : "Provider request failed.",
    providerFailureDiagnostic(candidate, error),
    disposition
  );
}

function providerFailureDisposition(error: unknown): ProviderFailureDisposition {
  return error instanceof ProviderRequestError ? error.disposition : "transport_lost";
}

function defaultFailureDisposition(code: ProviderRequestError["code"], diagnostics: ProviderDiagnostics): ProviderFailureDisposition {
  if (code === "provider_not_configured") return "not_started";
  if (diagnostics.reason === "network") return "transport_lost";
  return "provider_terminal_response";
}

function combineFailureDispositions(dispositions: ProviderFailureDisposition[]): ProviderFailureDisposition {
  if (dispositions.includes("cancel_unconfirmed")) return "cancel_unconfirmed";
  if (dispositions.includes("transport_lost")) return "transport_lost";
  if (dispositions.includes("provider_terminal_response")) return "provider_terminal_response";
  return "not_started";
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

function safeDiagnosticMessage(value: string, secretValues: string[] = []): string {
  let sanitized = value;
  for (const secret of secretValues) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/key=([A-Za-z0-9._~+/=-]+)/gi, "key=[redacted]")
    .replace(/api[_-]?key["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "api_key=[redacted]")
    .replace(/(?:access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "credential=[redacted]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(?<![A-Za-z0-9:/.])\/[^\s"'<>]+/g, "[path]")
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function headerSecrets(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => /(authorization|api[-_]?key|token|secret)/i.test(name))
    .map(([, value]) => value.replace(/^Bearer\s+/i, ""))
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
