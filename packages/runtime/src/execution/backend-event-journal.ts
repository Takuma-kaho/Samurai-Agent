import { BackendEventRecordSchema, type BackendEventRecord, type BackendRunRecord, type JsonValue, type ResourceRef } from "@samurai-agent/core-schemas";
import type { BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import { createId, nowIso } from "@samurai-agent/core-schemas";
import { RunLifecycle, type LifecycleTransitionDecision, type PreparedTerminalSettlement } from "./run-lifecycle";
import type { CanonicalLifecycleEvent } from "./run-state-machine";

export interface JournalEventInput {
  runId: string;
  sessionId: string;
  backendSessionId?: string;
  attemptNo: number;
  eventType: BackendEventRecord["event_type"];
  payload: Record<string, JsonValue>;
  resourceRefs?: ResourceRef[];
  sourceEventId?: string;
  sourceSequence?: number;
  eventId?: string;
  terminalEvidence?: BackendTerminalEvidence;
}

export interface JournalStore {
  listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }>;
  appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }>;
}

/**
 * Persists an already-decided lifecycle transition and its canonical event.
 * This class deliberately does not inspect event names to infer run status.
 */
export class BackendEventJournal {
  private readonly lifecycle: RunLifecycle;

  constructor(private readonly store: JournalStore, private readonly clock: () => string = nowIso) {
    this.lifecycle = new RunLifecycle(clock);
  }

  async appendCanonicalEvent(input: JournalEventInput): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    if (isTerminalEventType(input.eventType) || input.terminalEvidence) throw new Error("terminal_event_requires_settlement");
    validateJournalInput(input);
    const existing = await this.store.listBackendEvents({ runId: input.runId });
    const duplicate = existing.find((event) => event.attempt_no === input.attemptNo && ((input.sourceEventId !== undefined && event.source_event_id === input.sourceEventId) || (input.sourceEventId === undefined && input.sourceSequence !== undefined && event.source_event_id === undefined && event.source_sequence === input.sourceSequence)));
    if (duplicate) return { event: duplicate, duplicate: true };
    const event: BackendEventRecord = {
      id: createId("backend_event"),
      run_id: input.runId,
      session_id: input.sessionId,
      ...(journalBackendSessionId(input) ? { backend_session_id: journalBackendSessionId(input) } : {}),
      event_type: input.eventType,
      sequence: Math.max(1, existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1),
      attempt_no: input.attemptNo,
      ...(input.sourceEventId ? { source_event_id: input.sourceEventId } : {}),
      ...(input.sourceSequence !== undefined ? { source_sequence: input.sourceSequence } : {}),
      payload: journalPayload(input),
      resource_refs: input.resourceRefs ?? [],
      created_at: this.clock()
    };
    BackendEventRecordSchema.parse(event);
    return this.store.appendCore02Event(event);
  }

  async commitLifecycleTransitionEvent(run: BackendRunRecord, input: JournalEventInput, decision: LifecycleTransitionDecision): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    if (isTerminalEventType(input.eventType) || input.terminalEvidence) throw new Error("terminal_event_requires_settlement");
    validateJournalInput(input);
    const existing = await this.store.listBackendEvents({ runId: input.runId });
    const duplicate = findDuplicate(existing, input);
    if (duplicate) {
      const current = await this.store.getBackendRun(run.id);
      return { run: current ?? run, event: duplicate, duplicate: true };
    }
    const event = createEvent(input, this.clock(), existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1);
    const nextRun = this.lifecycle.apply(run, decision);
    return this.store.commitCore02LifecycleEvent({ expectedRun: run, nextRun, event });
  }

  /**
   * Builds the terminal record and lifecycle result without writing either one.
   * The completion port owns the SQLite transaction that makes them durable.
   */
  async prepareTerminalSettlement(run: BackendRunRecord, input: JournalEventInput, decision: LifecycleTransitionDecision): Promise<PreparedTerminalSettlement> {
    validateJournalInput(input);
    if (!input.terminalEvidence || !isTerminalEventType(input.eventType)) throw new Error("terminal_evidence_required");
    const existing = await this.store.listBackendEvents({ runId: input.runId });
    const sourceEventId = input.sourceEventId ?? syntheticTerminalSource(run, input.eventType);
    const eventId = input.eventId ?? `terminal-event:${run.id}:${input.attemptNo}:${sourceEventId}`;
    const duplicate = findDuplicate(existing, input) ?? existing.find((event) => event.id === eventId);
    const event = duplicate
      ? {
          ...duplicate,
          // Older terminal rows may predate the typed evidence column. Keep
          // the row untouched, but carry the caller's evidence through the
          // prepared settlement so replay can be settled idempotently.
          payload: duplicate.payload.terminal_evidence
            ? duplicate.payload
            : { ...duplicate.payload, terminal_evidence: input.terminalEvidence as unknown as JsonValue }
        }
      : createEvent(
          { ...input, sourceEventId },
          this.clock(),
          existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
          eventId
        );
    const nextRun = this.lifecycle.apply(run, decision);
    return this.lifecycle.prepareTerminalSettlement(run, nextRun, decision, event);
  }

}

function validateJournalInput(input: JournalEventInput): void {
  if (!input.runId.trim()) throw new Error("invalid_journal_run_id");
  if (!input.sessionId.trim()) throw new Error("invalid_journal_session_id");
  if (!Number.isSafeInteger(input.attemptNo) || input.attemptNo <= 0) throw new Error("invalid_journal_attempt_no");
  if (input.sourceEventId !== undefined && !input.sourceEventId.trim()) throw new Error("invalid_journal_source_event_id");
  if (input.sourceSequence !== undefined && (!Number.isSafeInteger(input.sourceSequence) || input.sourceSequence <= 0)) throw new Error("invalid_journal_source_sequence");
  if (input.sourceEventId === undefined && input.sourceSequence === undefined && !isTerminalEventType(input.eventType)) throw new Error("journal_source_identity_required");
}

function journalPayload(input: JournalEventInput): Record<string, JsonValue> {
  const { backend_session_id: _legacyBackendSessionId, ...payload } = input.payload;
  const waitingExecution = input.eventType === "backend_waiting_for_native_input"
    ? payload.waiting_execution === "suspended" ? "suspended" : "live"
    : undefined;
  return {
    ...payload,
    ...(waitingExecution ? { waiting_execution: waitingExecution } : {}),
    ...(input.terminalEvidence ? { terminal_evidence: input.terminalEvidence as unknown as JsonValue } : {})
  };
}

function journalBackendSessionId(input: JournalEventInput): string | undefined {
  if (input.backendSessionId?.trim()) return input.backendSessionId;
  const value = input.payload.backend_session_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function createEvent(input: JournalEventInput, createdAt: string, sequence: number, eventId?: string): BackendEventRecord {
  const event = {
    id: eventId ?? createId("backend_event"),
    run_id: input.runId,
    session_id: input.sessionId,
    ...(journalBackendSessionId(input) ? { backend_session_id: journalBackendSessionId(input) } : {}),
    event_type: input.eventType,
    sequence: Math.max(1, sequence),
    attempt_no: input.attemptNo,
    ...(input.sourceEventId ? { source_event_id: input.sourceEventId } : {}),
    ...(input.sourceSequence !== undefined ? { source_sequence: input.sourceSequence } : {}),
    payload: journalPayload(input),
    resource_refs: input.resourceRefs ?? [],
    created_at: createdAt
  } satisfies BackendEventRecord;
  return BackendEventRecordSchema.parse(event);
}

function findDuplicate(events: BackendEventRecord[], input: JournalEventInput): BackendEventRecord | undefined {
  return events.find((event) => event.attempt_no === input.attemptNo && (
    (input.sourceEventId !== undefined && event.source_event_id === input.sourceEventId)
    || (input.sourceEventId === undefined && input.sourceSequence !== undefined && event.source_event_id === undefined && event.source_sequence === input.sourceSequence)
  ));
}

function isTerminalEventType(eventType: BackendEventRecord["event_type"]): boolean {
  return eventType === "run_completed" || eventType === "run_failed";
}

function syntheticTerminalSource(run: BackendRunRecord, eventType: BackendEventRecord["event_type"]): string {
  return `terminal:${run.id}:${run.current_attempt ?? 1}:${eventType}`;
}

export class InMemoryBackendEventJournalStore implements JournalStore {
  readonly events: BackendEventRecord[] = [];
  readonly runs = new Map<string, BackendRunRecord>();
  async listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]> {
    return this.events.filter((event) => event.run_id === input.runId);
  }
  async getBackendRun(runId: string): Promise<BackendRunRecord | undefined> {
    return this.runs.get(runId);
  }

  async appendCore02Event(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((candidate) => candidate.run_id === event.run_id && candidate.attempt_no === event.attempt_no && candidate.source_event_id === event.source_event_id);
    if (duplicate) return { event: duplicate, duplicate: true };
    const next = { ...event, sequence: this.events.filter((candidate) => candidate.run_id === event.run_id).length + 1 };
    this.events.push(next);
    return { event: next, duplicate: false };
  }

  async commitCore02LifecycleEvent(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    const duplicate = this.events.find((candidate) => candidate.run_id === input.event.run_id && candidate.attempt_no === input.event.attempt_no && candidate.source_event_id === input.event.source_event_id);
    if (duplicate) return { run: this.runs.get(input.expectedRun.id) ?? input.expectedRun, event: duplicate, duplicate: true };
    const appended = await this.appendCore02Event(input.event);
    this.runs.set(input.nextRun.id, input.nextRun);
    return { run: input.nextRun, event: appended.event, duplicate: false };
  }
}
