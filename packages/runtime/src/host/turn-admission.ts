import { createId, stableHash } from "@samurai-agent/core-schemas";
import type { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { AdmittedTurn, BackendBoundTurn, BackendBinding, HostAdmissionStore, TurnRequest } from "./host-types";

export class TurnAdmission {
  constructor(private readonly registry: AgentBackendRegistry, private readonly store: HostAdmissionStore, private readonly clock: () => string, private readonly resolveDefaultBackendId?: () => Promise<string> | string) {}

  async admit(request: TurnRequest): Promise<AdmittedTurn> {
    if (!request.sessionId.trim()) throw new Error("session_id_required");
    if (!request.content.trim()) throw new Error("content_required");
    if (!request.idempotencyKey.trim()) throw new Error("idempotency_key_required");
    const session = await this.store.getSession(request.sessionId);
    if (!session) throw new Error(`session_not_found:${request.sessionId}`);
    const backendId = request.backendId?.trim() || await this.resolveDefaultBackendId?.() || "samurai-native";
    const backend = this.registry.get(backendId);
    if (!backend) throw new Error(`backend_not_registered:${backendId}`);
    const status = backend.getStatus?.();
    if (status && (!status.configured || status.enabled === false || status.connection_state !== "ready")) throw new Error(status.reason ? `backend_not_ready:${status.reason}` : `backend_not_ready:${backend.id}`);
    const binding: BackendBinding = { id: backend.id, kind: backend.kind, backend };
    const requestHash = stableHash({
      session_id: request.sessionId,
      content: request.content,
      backend: { id: binding.id, kind: binding.kind },
      attachments: request.envelope.attachments.map((attachment) => ({ kind: attachment.kind, id: attachment.id, uri: attachment.uri, version: attachment.version ?? null })),
      locale: { input: request.envelope.input_locale, output: request.envelope.output_locale },
      envelope: {
        source: request.envelope.source,
        actor_identity: request.envelope.actor_identity,
        user_intent: request.envelope.user_intent,
        session_key: request.envelope.session_key,
        metadata: { ...request.envelope.metadata, ...(request.metadata ?? {}) }
      }
    });
    const bound: BackendBoundTurn = { request, session, binding, requestHash };
    const admission = await this.store.admitTurn({ session, binding, request, requestHash, runId: createId("run"), now: this.clock() });
    return { ...bound, ...admission };
  }
}
