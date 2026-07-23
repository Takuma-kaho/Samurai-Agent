import { describe, expect, it } from "vitest";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import { BackendEventJournal, InMemoryBackendEventJournalStore } from "./backend-event-journal";
import { lifecycleEventForTerminalEvidence } from "./run-state-machine";
import { RunLifecycle } from "./run-lifecycle";

describe("BackendEventJournal", () => {
  it("persists typed evidence with an already-decided transition", async () => {
    const store = new InMemoryBackendEventJournalStore();
    const journal = new BackendEventJournal(store, () => "2026-01-01T00:00:01.000Z");
    const run = runningRun();
    const evidence = { kind: "failed", source: "provider_terminal_response", error: { code: "provider_denied", message: "Provider denied the request.", retryable: false, causeCategory: "provider" } } as const;
    const decision = new RunLifecycle().decide(run, lifecycleEventForTerminalEvidence(evidence));

    const committed = await journal.commitLifecycleEvent(run, {
      runId: run.id,
      sessionId: run.session_id,
      attemptNo: 1,
      eventType: "run_failed",
      payload: { error_code: "provider_denied" },
      sourceEventId: "provider-terminal-1",
      terminalEvidence: evidence
    }, decision);

    expect(committed.run).toMatchObject({ status: "failed", error_code: "provider_denied" });
    expect(committed.event.payload.terminal_evidence).toEqual(evidence);
  });

  it("deduplicates source identity only within the same attempt", async () => {
    const store = new InMemoryBackendEventJournalStore();
    const journal = new BackendEventJournal(store);
    const base = { runId: "run-1", sessionId: "session-1", eventType: "text_delta" as const, payload: { text: "same" }, sourceEventId: "provider-event-1" };

    const first = await journal.appendCanonicalEvent({ ...base, attemptNo: 1 });
    const duplicate = await journal.appendCanonicalEvent({ ...base, attemptNo: 1 });
    const nextAttempt = await journal.appendCanonicalEvent({ ...base, attemptNo: 2 });
    const idAndSequence = await journal.appendCanonicalEvent({ ...base, sourceEventId: "provider-event-with-sequence", sourceSequence: 7, attemptNo: 1 });
    const sequenceOnly = { runId: "run-1", sessionId: "session-1", eventType: "text_delta" as const, payload: { text: "provider replay" }, sourceSequence: 7 };
    const firstSequence = await journal.appendCanonicalEvent({ ...sequenceOnly, attemptNo: 1 });
    const duplicateSequence = await journal.appendCanonicalEvent({ ...sequenceOnly, attemptNo: 1 });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(nextAttempt.duplicate).toBe(false);
    expect(idAndSequence.duplicate).toBe(false);
    expect(firstSequence.duplicate).toBe(false);
    expect(duplicateSequence.duplicate).toBe(true);
    expect(store.events).toHaveLength(4);
  });

  it("validates attempt and provider source identity at runtime", async () => {
    const journal = new BackendEventJournal(new InMemoryBackendEventJournalStore());
    const base = { runId: "run-1", sessionId: "session-1", attemptNo: 1, eventType: "text_delta" as const, payload: { text: "test" } };

    await expect(journal.appendCanonicalEvent({ ...base, attemptNo: 0 })).rejects.toThrow("invalid_journal_attempt_no");
    await expect(journal.appendCanonicalEvent({ ...base, sourceEventId: "" })).rejects.toThrow("invalid_journal_source_event_id");
    await expect(journal.appendCanonicalEvent({ ...base, sourceSequence: 0 })).rejects.toThrow("invalid_journal_source_sequence");
    await expect(journal.appendCanonicalEvent({ ...base, terminalEvidence: { kind: "completed", source: "canonical_event" } })).rejects.toThrow("terminal_event_requires_settlement");
  });

  it("lets the atomic store return the current settled run for terminal replay", async () => {
    const staleRun = runningRun();
    const settledRun = { ...staleRun, status: "completed", phase: "settled", completed_at: "2026-01-01T00:00:01.000Z" } as BackendRunRecord;
    const existing: BackendEventRecord = {
      id: "event-existing",
      run_id: staleRun.id,
      session_id: staleRun.session_id,
      event_type: "run_completed",
      sequence: 1,
      attempt_no: 1,
      source_event_id: "terminal-1",
      payload: {},
      resource_refs: [],
      created_at: "2026-01-01T00:00:01.000Z"
    };
    let atomicCommits = 0;
    const journal = new BackendEventJournal({
      async listBackendEvents() { return [existing]; },
      async saveBackendEvent(event) { return event; },
      async commitCore02LifecycleEvent() {
        atomicCommits += 1;
        return { run: settledRun, event: existing, duplicate: true };
      }
    });
    const evidence = { kind: "completed", source: "provider_terminal_response" } as const;

    const replay = await journal.commitLifecycleEvent(staleRun, {
      runId: staleRun.id,
      sessionId: staleRun.session_id,
      attemptNo: 1,
      eventType: "run_completed",
      payload: {},
      sourceEventId: "terminal-1",
      terminalEvidence: evidence
    }, new RunLifecycle().decide(staleRun, lifecycleEventForTerminalEvidence(evidence)));

    expect(atomicCommits).toBe(0);
    expect(replay).toMatchObject({ duplicate: true, run: { status: "completed" } });
  });
});

function runningRun(): BackendRunRecord {
  return {
    id: "run-1",
    session_id: "session-1",
    input_message_id: "message-1",
    backend_id: "backend",
    backend_kind: "external",
    status: "running",
    phase: "external_running",
    current_attempt: 1,
    started_at: "2026-01-01T00:00:00.000Z",
    input_summary: "test",
    metadata: {}
  };
}
