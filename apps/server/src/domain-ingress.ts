import type { JsonValue } from "@samurai-agent/core-schemas";

export interface DomainIngressSessionLookup {
  getSession(sessionId: string): Promise<unknown | undefined>;
}

export interface DomainIngressBackendRunLookup {
  getBackendRun(runId: string): Promise<{ id: string; session_id: string } | undefined>;
}

export type DomainIngressLookup = DomainIngressSessionLookup & DomainIngressBackendRunLookup;

export interface TrustedRuntimeApiContext {
  sessionId?: string;
  runId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface TrustedRuntimeApiInput {
  payload: Record<string, JsonValue>;
  context: TrustedRuntimeApiContext;
}

/**
 * Transport references are intentionally outside the public operation DTO.
 * They identify a persisted resource which the HTTP ingress resolves before it
 * creates TrustedDomainContext; they are never copied into payload.
 */
export interface RuntimeApiTransportReferences {
  sessionId?: unknown;
  backendRunId?: unknown;
}

/**
 * The HTTP adapter resolves requested resources before the Domain contract is
 * parsed. `session_id`, `run_id`, and `backend_run_id` are transport
 * references only and never become public Domain payload fields.
 */
export async function resolveTrustedRuntimeApiInput(
  lookup: DomainIngressLookup,
  payload: Record<string, JsonValue>,
  transport: RuntimeApiTransportReferences,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<TrustedRuntimeApiInput> {
  for (const key of ["workspace_id", "actor_id", "actor_identity", "correlation_id", "source", "input_source", "session_id", "envelope_id", "run_id", "backend_run_id"]) {
    if (payload[key] !== undefined) throw requestError("bad_request", `untrusted_domain_context:${key}`);
  }
  if (transport.sessionId !== undefined && (typeof transport.sessionId !== "string" || !transport.sessionId.trim())) {
    throw requestError("bad_request", "invalid_domain_transport:session_id");
  }
  const requestedSessionId = typeof transport.sessionId === "string" ? transport.sessionId.trim() : undefined;
  if (transport.backendRunId !== undefined && (typeof transport.backendRunId !== "string" || !transport.backendRunId.trim())) {
    throw requestError("bad_request", "invalid_domain_transport:backend_run_id");
  }
  const backendRunId = typeof transport.backendRunId === "string" ? transport.backendRunId.trim() : undefined;
  const backendRun = backendRunId ? await lookup.getBackendRun(backendRunId) : undefined;
  if (backendRunId && !backendRun) throw requestError("not_found", `Backend run not found: ${backendRunId}`);
  if (backendRun && requestedSessionId && backendRun.session_id !== requestedSessionId) {
    throw requestError("bad_request", "domain_transport_session_mismatch:backend_run_id");
  }
  const sessionId = backendRun?.session_id ?? requestedSessionId;
  if (sessionId && !await lookup.getSession(sessionId)) throw requestError("not_found", `Session not found: ${sessionId}`);
  return {
    payload: { ...payload },
    context: {
      ...(sessionId ? { sessionId } : {}),
      ...(backendRun ? { runId: backendRun.id } : {})
    }
  };
}

export async function assertTrustedRuntimePayload(
  lookup: DomainIngressLookup,
  payload: Record<string, JsonValue>,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<Record<string, JsonValue>> {
  return (await resolveTrustedRuntimeApiInput(lookup, payload, {}, requestError)).payload;
}
