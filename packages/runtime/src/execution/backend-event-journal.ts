import type { BackendEventRecord, BackendRunRecord, JsonValue, ResourceRef } from "@samurai-agent/core-schemas";
import type { BackendTerminalEvidence } from "@samurai-agent/agent-backends";
import { createId, nowIso } from "@samurai-agent/core-schemas";
import { RunLifecycle, type LifecycleTransitionDecision, type PreparedTerminalSettlement } from "./run-lifecycle";
import type { CanonicalLifecycleEvent } from "./run-state-machine";

export interface JournalEventInput {
  runId: string;
  sessionId: string;
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
  getBackendRun?(runId: string): Promise<BackendRunRecord | undefined>;
  saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord>;
  updateBackendRun?(run: BackendRunRecord): Promise<BackendRunRecord>;
  atomic?<T>(operation: () => Promise<T>): Promise<T>;
  commitCore02RunTransition?(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord }): Promise<BackendRunRecord>;
  commitCore02LifecycleEvent?(input: { expectedRun: BackendRunRecord; nextRun: BackendRunRecord; event: BackendEventRecord }): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }>;
  appendCore02Event?(event: BackendEventRecord): Promise<{ event: BackendEventRecord; duplicate: boolean }>;
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
    const event: BackendEventRecord = { id: createId("backend_event"), run_id: input.runId, session_id: input.sessionId, event_type: input.eventType, sequence: 0, attempt_no: input.attemptNo, ...(input.sourceEventId ? { source_event_id: input.sourceEventId } : {}), ...(input.sourceSequence !== undefined ? { source_sequence: input.sourceSequence } : {}), payload: journalPayload(input), resource_refs: input.resourceRefs ?? [], created_at: this.clock() };
    if (this.store.appendCore02Event) return this.store.appendCore02Event(event);
    return { event: await this.store.saveBackendEvent({ ...event, sequence: existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1 }), duplicate: false };
  }

  async commitLifecycleTransitionEvent(run: BackendRunRecord, input: JournalEventInput, decision: LifecycleTransitionDecision): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    if (isTerminalEventType(input.eventType) || input.terminalEvidence) throw new Error("terminal_event_requires_settlement");
    validateJournalInput(input);
    const existing = await this.store.listBackendEvents({ runId: input.runId });
    const duplicate = findDuplicate(existing, input);
    if (duplicate) {
      const current = this.store.getBackendRun ? await this.store.getBackendRun(run.id) : undefined;
      return { run: current ?? run, event: duplicate, duplicate: true };
    }
    const event = createEvent(input, this.clock(), existing.reduce((max, item) => Math.max(max, item.sequence), 0) + 1);
    const nextRun = this.lifecycle.apply(run, decision);
    if (this.store.commitCore02LifecycleEvent) return this.store.commitCore02LifecycleEvent({ expectedRun: run, nextRun, event });
    const persist = async () => {
      await this.store.saveBackendEvent(event);
      const persistedRun = await this.lifecycle.persist(this.store, run, nextRun);
      return { run: persistedRun, event, duplicate: false };
    };
    return this.store.atomic ? this.store.atomic(persist) : persist();
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

  async commitLifecycleEvent(run: BackendRunRecord, input: JournalEventInput, decision: LifecycleTransitionDecision): Promise<{ run: BackendRunRecord; event: BackendEventRecord; duplicate: boolean }> {
    if (isTerminalEventType(input.eventType) || input.terminalEvidence) {
      const prepared = await this.prepareTerminalSettlement(run, input, decision);
      return { run: prepared.nextRun, event: prepared.terminalEvent, duplicate: Boolean(await this.findExistingTerminal(prepared)) };
    }
    return this.commitLifecycleTransitionEvent(run, input, decision);
  }

  private async findExistingTerminal(prepared: PreparedTerminalSettlement): Promise<BackendEventRecord | undefined> {
    const existing = await this.store.listBackendEvents({ runId: prepared.expectedRun.id });
    return existing.find((event) => event.id === prepared.terminalEvent.id || (prepared.sourceIdentity.sourceEventId && event.source_event_id === prepared.sourceIdentity.sourceEventId) || (prepared.sourceIdentity.sourceEventId === undefined && prepared.sourceIdentity.sourceSequence !== undefined && event.source_event_id === undefined && event.source_sequence === prepared.sourceIdentity.sourceSequence));
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
  const waitingExecution = input.eventType === "backend_waiting_for_native_input"
    ? input.payload.waiting_execution === "suspended" ? "suspended" : "live"
    : undefined;
  return {
    ...input.payload,
    ...(waitingExecution ? { waiting_execution: waitingExecution } : {}),
    ...(input.terminalEvidence ? { terminal_evidence: input.terminalEvidence as unknown as JsonValue } : {})
  };
}

function createEvent(input: JournalEventInput, createdAt: string, sequence: number, eventId?: string): BackendEventRecord {
  return {
    id: eventId ?? createId("backend_event"),
    run_id: input.runId,
    session_id: input.sessionId,
    event_type: input.eventType,
    sequence: Math.max(1, sequence),
    attempt_no: input.attemptNo,
    ...(input.sourceEventId ? { source_event_id: input.sourceEventId } : {}),
    ...(input.sourceSequence !== undefined ? { source_sequence: input.sourceSequence } : {}),
    payload: journalPayload(input),
    resource_refs: input.resourceRefs ?? [],
    created_at: createdAt
  };
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
  async listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]> {
    return this.events.filter((event) => event.run_id === input.runId);
  }
  async saveBackendEvent(event: BackendEventRecord): Promise<BackendEventRecord> {
    this.events.push(event);
    return event;
  }
  async atomic<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}
