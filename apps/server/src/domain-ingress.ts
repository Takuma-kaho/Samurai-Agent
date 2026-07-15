import type { JsonValue } from "@samurai-agent/core-schemas";

export interface DomainIngressSessionLookup {
  getSession(sessionId: string): Promise<unknown | undefined>;
}

export async function assertTrustedRuntimePayload(
  sessions: DomainIngressSessionLookup,
  payload: Record<string, JsonValue>,
  requestError: (code: "bad_request" | "not_found", message: string) => Error
): Promise<Record<string, JsonValue>> {
  for (const key of ["workspace_id", "actor_id", "actor_identity", "correlation_id", "source", "input_source"]) {
    if (payload[key] !== undefined) throw requestError("bad_request", `untrusted_domain_context:${key}`);
  }
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  if (sessionId && !await sessions.getSession(sessionId)) throw requestError("not_found", `Session not found: ${sessionId}`);
  return payload;
}
