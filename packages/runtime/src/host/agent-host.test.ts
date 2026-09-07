import { describe, expect, it } from "vitest";
import { AgentBackendRegistry, type AgentBackend, type BackendOutputEvent } from "@samurai-agent/agent-backends";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import { AgentHost } from "./agent-host";

describe("AgentHost Workspace reconciliation", () => {
  it("reconciles late terminal evidence for outcome_unknown without calling runTurn", async () => {
    let streamCalls = 0;
    let runTurnCalls = 0;
    const backend: AgentBackend = {
      id: "external-backend",
      kind: "external",
      label: "External backend",
      sessionPolicy: { acquisition: "none", resume: "unsupported" },
      execution_owner: "backend",
      runTurn: async function* (): AsyncIterable<BackendOutputEvent> {
        runTurnCalls += 1;
      },
      streamEvents: async function* (): AsyncIterable<BackendOutputEvent> {
        streamCalls += 1;
        yield {
          event_type: "run_completed",
          terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
          payload: { output_summary: "late completion" },
          source_event_id: "late-terminal-1"
        };
      }
    };
    const store = new WorkspaceSyncStore(outcomeUnknownRun());
    const host = new AgentHost(new AgentBackendRegistry([backend]), {
      store: store as never,
      context: {} as never,
      completion: {} as never,
      preflight: {} as never,
      committedEventPublisher: { publish: async () => undefined },
      admissionObserver: { observe: async () => undefined },
      toolExecution: {} as never,
      cleanup: { cleanup: async () => undefined },
      diagnostics: { record: async () => undefined, logPersistenceFailure: () => undefined },
      assertRunAccess: async () => undefined
    });

    const reconciled = await host.syncRun("run-unknown");

    expect(reconciled.status).toBe("completed");
    expect(streamCalls).toBe(1);
    expect(runTurnCalls).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]?.event_type).toBe("run_completed");
  });
});

class WorkspaceSyncStore {
  readonly events: BackendEventRecord[] = [];
  private current: BackendRunRecord;

  constructor(run: BackendRunRecord) {
    this.current = run;
  }

  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
    return this.current.id === runId ? this.current : undefined;
  }

  async listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]> {
    return this.events.filter((event) => event.run_id === input.runId);
  }

  async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((candidate) => candidate.source_event_id === event.source_event_id);
    if (duplicate) return { event: duplicate, duplicate: true };
    this.events.push(event);
    return { event, duplicate: false };
  }

  async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }) {
    this.current = input.nextRun;
    return { run: this.current, event: input.event, duplicate: false };
  }

  async commitCore02BackendSession(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }) {
    this.current = input.nextRun;
    return this.current;
  }

  async commitCore02RunTransition(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }) {
    this.current = input.nextRun;
    return this.current;
  }

  async commitWorkspaceRunSettlement(input: { nextRun: BackendRunRecord; terminalEvent: BackendEventRecord; outputSummary?: string }) {
    this.current = { ...input.nextRun, ...(input.outputSummary ? { output_summary: input.outputSummary } : {}) };
    this.events.push(input.terminalEvent);
    return this.current;
  }
}

function outcomeUnknownRun(): BackendRunRecord {
  return {
    id: "run-unknown",
    room_id: "room-1",
    backend_id: "external-backend",
    backend_kind: "external",
    status: "outcome_unknown",
    phase: "settled",
    current_attempt: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    input_summary: "workspace task",
    metadata: {}
  };
}
