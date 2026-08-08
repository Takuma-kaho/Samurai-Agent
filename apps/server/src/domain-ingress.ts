import { SessionRefSchema, type JsonValue, type SessionRef, type TrustedWorkspaceSource } from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";

export interface DomainIngressSessionLookup {
  getSession(sessionId: string): Promise<unknown | undefined>;
}

export interface DomainIngressBackendRunLookup {
  getBackendRun(runId: string): Promise<{ id: string; session_id?: string; room_id?: string } | undefined>;
}

export type DomainIngressLookup = DomainIngressSessionLookup & DomainIngressBackendRunLookup;

export interface TrustedRuntimeApiContext {
  roomId?: string;
  sessionId?: string;
  runId?: string;
  sessionRef?: SessionRef;
  /** Selected by an authenticated Server/Gateway adapter, never by payload. */
  participant?: ParticipantPrincipal;
  source?: TrustedWorkspaceSource;
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
  roomId?: unknown;
  sessionId?: unknown;
  backendRunId?: unknown;
  sessionRef?: unknown;
  authenticatedAppId?: unknown;
  authenticatedParticipant?: ParticipantPrincipal;
  authenticatedSource?: TrustedWorkspaceSource;
}

/**
 * The HTTP adapter resolves requested resources before the Domain contract is
 * parsed. `room_id`, `session_id`, `run_id`, and `backend_run_id` are transport
 * references only and never become public Domain payload fields.
 */
export async function resolveTrustedRuntimeApiInput(
  lookup: DomainIngressLookup,
  payload: Record<string, JsonValue>,
  transport: RuntimeApiTransportReferences,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<TrustedRuntimeApiInput> {
  for (const key of ["workspace_id", "actor_id", "actor_identity", "participant_id", "participant_kind", "requested_by_participant_id", "trusted_participant_context", "trusted_requester_participant_id", "correlation_id", "source", "input_source", "session_id", "envelope_id", "run_id", "backend_run_id", "room_id", "source_room_id", "principal", "app_id", "delegated_by", "session_ref"]) {
    if (payload[key] !== undefined) throw requestError("bad_request", `untrusted_domain_context:${key}`);
  }
  if (transport.roomId !== undefined && (typeof transport.roomId !== "string" || !transport.roomId.trim())) {
    throw requestError("bad_request", "invalid_domain_transport:room_id");
  }
  const requestedRoomId = typeof transport.roomId === "string" ? transport.roomId.trim() : undefined;
  if (transport.sessionId !== undefined && (typeof transport.sessionId !== "string" || !transport.sessionId.trim())) {
    throw requestError("bad_request", "invalid_domain_transport:session_id");
  }
  const requestedSessionId = typeof transport.sessionId === "string" ? transport.sessionId.trim() : undefined;
  if (transport.backendRunId !== undefined && (typeof transport.backendRunId !== "string" || !transport.backendRunId.trim())) {
    throw requestError("bad_request", "invalid_domain_transport:backend_run_id");
  }
  const backendRunId = typeof transport.backendRunId === "string" ? transport.backendRunId.trim() : undefined;
  const rawSessionRef = transport.sessionRef;
  const parsedSessionRef = rawSessionRef === undefined ? undefined : SessionRefSchema.safeParse(rawSessionRef);
  if (rawSessionRef !== undefined && !parsedSessionRef?.success) {
    throw requestError("bad_request", "invalid_domain_transport:session_ref");
  }
  const sessionRef = parsedSessionRef?.success ? parsedSessionRef.data : undefined;
  const authenticatedAppId = typeof transport.authenticatedAppId === "string" ? transport.authenticatedAppId.trim() : undefined;
  const authenticatedParticipant = transport.authenticatedParticipant;
  const authenticatedSource = transport.authenticatedSource;
  if (sessionRef && authenticatedAppId && sessionRef.app_id !== authenticatedAppId) {
    throw requestError("bad_request", "domain_transport_session_ref_app_mismatch");
  }
  if (authenticatedSource?.app_id && sessionRef && authenticatedSource.app_id !== sessionRef.app_id) {
    throw requestError("bad_request", "domain_transport_session_ref_app_mismatch");
  }
  if (authenticatedSource?.kind === "external_app") {
    if (!authenticatedSource.app_id || authenticatedParticipant?.kind !== "external_app" || authenticatedParticipant.appId !== authenticatedSource.app_id) {
      throw requestError("bad_request", "domain_transport_external_app_context_mismatch");
    }
  } else if (authenticatedParticipant?.kind === "external_app") {
    throw requestError("bad_request", "domain_transport_external_app_context_mismatch");
  }
  const backendRun = backendRunId ? await lookup.getBackendRun(backendRunId) : undefined;
  if (backendRunId && !backendRun) throw requestError("not_found", `Backend run not found: ${backendRunId}`);
  if (backendRun && requestedSessionId && backendRun.session_id && backendRun.session_id !== requestedSessionId) {
    throw requestError("bad_request", "domain_transport_session_mismatch:backend_run_id");
  }
  const sessionId = backendRun?.session_id ?? requestedSessionId;
  if (sessionId && !await lookup.getSession(sessionId)) throw requestError("not_found", `Session not found: ${sessionId}`);
  if (backendRun?.room_id && requestedRoomId && backendRun.room_id !== requestedRoomId) {
    throw requestError("bad_request", "domain_transport_room_mismatch:backend_run_id");
  }
  const session = sessionId ? await lookup.getSession(sessionId) as { room_id?: string } | undefined : undefined;
  if (session?.room_id && requestedRoomId && session.room_id !== requestedRoomId) {
    throw requestError("bad_request", "domain_transport_room_mismatch:session_id");
  }
  const roomId = requestedRoomId ?? backendRun?.room_id ?? session?.room_id;
  return {
    payload: { ...payload },
    context: {
      ...(roomId ? { roomId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(backendRun ? { runId: backendRun.id } : {}),
      ...(sessionRef ? { sessionRef } : {}),
      ...(authenticatedParticipant ? { participant: authenticatedParticipant } : {}),
      ...(authenticatedSource ? { source: authenticatedSource } : {})
    }
  };
}

/**
 * Native App's legacy Session endpoints may still carry `room_id` in their
 * HTTP body.  Strip it before the public Session schema is parsed and retain
 * it only as a Server-owned transport selector.
 */
export async function resolveLegacySessionCreateIngress(
  lookup: DomainIngressLookup,
  payload: Record<string, JsonValue>,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<TrustedRuntimeApiInput> {
  const { room_id: roomId, ...operationPayload } = payload;
  return resolveTrustedRuntimeApiInput(lookup, operationPayload, { roomId }, requestError);
}

export async function assertTrustedRuntimePayload(
  lookup: DomainIngressLookup,
  payload: Record<string, JsonValue>,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<Record<string, JsonValue>> {
  return (await resolveTrustedRuntimeApiInput(lookup, payload, {}, requestError)).payload;
}
