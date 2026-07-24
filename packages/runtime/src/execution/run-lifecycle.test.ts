import { describe, expect, it } from "vitest";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import { RunLifecycle } from "./run-lifecycle";

describe("RunLifecycle", () => {
  it("owns a CAS transition and backend session binding", async () => {
    const store = new LifecycleStore(run());
    const lifecycle = new RunLifecycle(() => "2026-01-01T00:00:01.000Z");
    const preparing = await lifecycle.transition(store, store.current, { type: "preparing" });
    expect(preparing).toMatchObject({ status: "queued", phase: "preparing" });
    const starting = await lifecycle.transition(store, preparing, { type: "backend_starting" });
    const bound = await lifecycle.recordBackendSession(store, starting, "native-session-1");
    expect(bound).toMatchObject({ phase: "backend_starting", backend_session_id: "native-session-1" });
    expect(store.casCalls).toBe(3);
  });

  it("prepares terminal evidence without writing the Event", async () => {
    const lifecycle = new RunLifecycle(() => "2026-01-01T00:00:01.000Z");
    const current = { ...run(), status: "running" as const, phase: "external_running" as const };
    const decision = lifecycle.decide(current, { type: "completed", evidence: { kind: "completed", source: "canonical_event" } });
    const prepared = lifecycle.prepareTerminalSettlement(current, { ...current, status: "completed", phase: "settled", completed_at: "2026-01-01T00:00:01.000Z" }, decision, {
      id: "terminal-event-1", run_id: current.id, session_id: current.session_id, event_type: "run_completed", sequence: 1, attempt_no: 1,
      source_event_id: "provider-terminal-1", payload: { terminal_evidence: { kind: "completed", source: "canonical_event" } }, resource_refs: [], created_at: "2026-01-01T00:00:01.000Z"
    });
    expect(prepared.nextRun.status).toBe("completed");
    expect(prepared.terminalEvent.source_event_id).toBe("provider-terminal-1");
  });
});

class LifecycleStore {
  casCalls = 0;
  constructor(public current: BackendRunRecord) {}
  async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
    if (this.current.status !== input.expectedRun.status || this.current.phase !== input.expectedRun.phase) throw new Error("cas_conflict");
    this.casCalls += 1;
    this.current = input.nextRun;
    return this.current;
  }
  async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord> {
    return this.commitCore02RunTransition(input);
  }
}

function run(): BackendRunRecord {
  return { id: "run-1", session_id: "session-1", input_message_id: "message-1", backend_id: "backend", backend_kind: "mock", status: "queued", phase: "admitted", current_attempt: 1, request_idempotency_key: "key-1", request_hash: "hash-1", started_at: "2026-01-01T00:00:00.000Z", input_summary: "test", metadata: {} };
}
