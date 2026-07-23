import { describe, expect, it } from "vitest";
import type { BackendRunInput } from "@samurai-agent/agent-backends";
import type { BackendRunRecord, MessageEnvelope, SessionRecord } from "@samurai-agent/core-schemas";
import { buildHostContextAssembly } from "../context/context-assembly";
import { TurnPreparer } from "./turn-preparer";
import type { AdmittedTurn } from "./host-types";

describe("TurnPreparer", () => {
  it("uses the admitted Backend binding and does not execute the Backend", async () => {
    const calls: string[] = [];
    const binding = {
      id: "fixed-backend",
      kind: "mock" as const,
      backend: {
        id: "fixed-backend",
        kind: "mock" as const,
        label: "Fixed Backend",
        runTurn: () => {
          calls.push("runTurn");
          return (async function* () { yield { event_type: "run_completed", payload: {} }; })();
        }
      }
    };
    const admitted = admittedTurn(binding);
    const input = backendInput(admitted);
    const preparer = new TurnPreparer({
      getCandidates: async ({ turn }) => {
        calls.push(`candidates:${turn.binding.id}`);
        return {} as never;
      },
      assemble: async ({ turn }) => {
        calls.push(`assembly:${turn.binding.id}`);
        return { context: contextAssembly(turn) };
      },
      handoff: async ({ turn }) => {
        calls.push(`handoff:${turn.binding.id}`);
        return { handoff: { version: 1, strategy: "inline_context", sources: [] }, backendInput: input };
      }
    });

    const prepared = await preparer.prepare(admitted);

    expect(prepared.binding).toBe(binding);
    expect(prepared.backendInput.run_id).toBe(admitted.run.id);
    expect(prepared.context.session_id).toBe(admitted.session.id);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.backendInput.context_intent).toBe("light_chat");
    expect(calls).toEqual(["candidates:fixed-backend", "assembly:fixed-backend", "handoff:fixed-backend"]);
  });
});

function contextAssembly(turn: AdmittedTurn) {
  return buildHostContextAssembly({
    sessionId: turn.session.id,
    query: turn.request.content,
    sessionFound: true,
    messageCount: 0,
    recentMessageCount: 0,
    freezeSnapshotPresent: false,
    activeMemoryCandidateCount: 0,
    activeMemoryCount: 0,
    knowledgeWikiCandidateCount: 0,
    knowledgeWikiIncludedCount: 0,
    collectionNoteCandidateCount: 0,
    collectionNoteIncludedCount: 0,
    selectedSkillCount: 0,
    sessionSearchCandidateCount: 0,
    sessionSearchIncludedCount: 0,
    externalAssistRole: "disabled",
    externalAssistHintCount: 0,
    externalAssistFailureCount: 0,
    availableToolCount: 0
  });
}

function admittedTurn(binding: AdmittedTurn["binding"]): AdmittedTurn {
  const now = "2026-01-01T00:00:00.000Z";
  const session: SessionRecord = { id: "session-1", session_key: "web:owner:session-1", title: "Session", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now };
  const envelope: MessageEnvelope = { id: "envelope-1", source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
  const userMessage = { id: "message-1", session_id: session.id, role: "user" as const, content: "hello", input_locale: "ja" as const, output_locale: "ja" as const, envelope, created_at: now };
  const run: BackendRunRecord = { id: "run-1", session_id: session.id, input_message_id: userMessage.id, backend_id: binding.id, backend_kind: binding.kind, status: "queued", phase: "admitted", current_attempt: 1, request_idempotency_key: "key-1", request_hash: "hash-1", started_at: now, input_summary: "hello", metadata: {} };
  return {
    request: { sessionId: session.id, content: "hello", envelope, idempotencyKey: "key-1" },
    session,
    binding,
    requestHash: "hash-1",
    reservation: { sessionId: session.id, runId: run.id, version: 1, status: "held" },
    userMessage,
    run
  };
}

function backendInput(turn: AdmittedTurn): BackendRunInput {
  return {
    run_id: turn.run.id,
    session_id: turn.session.id,
    input_message_id: turn.userMessage.id,
    envelope: turn.request.envelope,
    user_input: turn.request.content,
    input_locale: "ja",
    output_locale: "ja",
    active_memory: [],
    recent_messages: [],
    metadata: {}
  };
}
