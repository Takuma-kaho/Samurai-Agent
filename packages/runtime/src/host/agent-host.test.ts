import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBackendRegistry, MockBackend, type BackendRunInput } from "@samurai-agent/agent-backends";
import { nowIso, type MessageEnvelope } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { buildHostContextAssembly } from "../context/context-assembly";
import { AgentHost } from "./agent-host";
import { TurnCompletionCoordinator } from "./turn-completion-coordinator";
import type { AdmittedTurn, HostDiagnosticsPort } from "./host-types";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentHost production path", () => {
  it("settles terminal data atomically and keeps a post-turn failure outside the completed Run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-host-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    try {
      const now = nowIso();
      const session = { id: "session-host", session_key: "web:owner:host", room_id: "room_default", title: "Host", ui_locale: "ja" as const, output_locale: "ja" as const, created_at: now, updated_at: now };
      await store.createSession(session);
      const envelope: MessageEnvelope = { id: "envelope-host", source: "web", actor_identity: "owner", session_key: session.session_key, user_intent: "chat", attachments: [], input_locale: "ja", output_locale: "ja", metadata: {}, received_at: now };
      const context = {
        getCandidates: async () => ({} as never),
        assemble: async ({ turn }: { turn: AdmittedTurn }) => ({
          context: buildHostContextAssembly({
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
          })
        }),
        handoff: async ({ turn }: { turn: AdmittedTurn }) => ({
          handoff: { version: 1 as const, strategy: "inline_context" as const, sources: [] },
          backendInput: backendInput(turn)
        }),
        reportProgress: async () => undefined
      };
      const diagnostics: HostDiagnosticsPort = {
        record: async (input) => store.appendHostDiagnostic(input),
        logPersistenceFailure: () => undefined
      };
      const host = new AgentHost(new AgentBackendRegistry([new MockBackend()]), {
        store,
        context,
        completion: new TurnCompletionCoordinator(store, {
          presentation: {
            operationId: "presentation",
            run: async () => { throw new Error("presentation failed"); }
          }
        }, diagnostics),
        preflight: { prepare: async ({ request }) => ({ ...request, roomId: "room_default", requestedByParticipantId: localOwnerParticipantId }) },
        committedEventPublisher: { publish: async () => undefined },
        admissionObserver: { observe: async () => undefined },
        toolExecution: { execute: async () => undefined },
        cleanup: { cleanup: async () => undefined },
        diagnostics,
        resolveDefaultBackendId: () => "mock"
      });

      const result = await host.runTurn({ sessionId: session.id, content: "hello", envelope, idempotencyKey: "host-key-1" });

      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") return;
      expect(result.output.content).toContain("Mock response: hello");
      const events = await store.listBackendEvents({ runId: result.run.id });
      expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_completed", "host_post_turn_failed"]);
      expect(events.at(-1)?.payload.command_name).toBe("presentation");
      expect((await store.getBackendRun(result.run.id))?.status).toBe("completed");
      expect(await store.getBackendRun(result.run.id)).toMatchObject({
        room_id: "room_default",
        principal: { kind: "human", participant_id: localOwnerParticipantId },
        source: { kind: "native_app", app_id: "samurai-native" },
        session_ref: { app_id: "samurai-native", session_id: session.id }
      });
      expect((await store.listMessages(session.id)).filter((message) => message.role === "agent")).toHaveLength(1);
      expect((await store.getSessionRunReservation({ runId: result.run.id }))?.status).toBe("released");
    } finally {
      await store.close();
    }
  });
});

function backendInput(turn: { run: { id: string }; session: { id: string; output_locale: "ja" }; userMessage: { id: string }; request: { envelope: MessageEnvelope; content: string } }): BackendRunInput {
  return {
    run_id: turn.run.id,
    session_id: turn.session.id,
    input_message_id: turn.userMessage.id,
    envelope: turn.request.envelope,
    user_input: turn.request.content,
    input_locale: "ja",
    output_locale: turn.session.output_locale,
    active_memory: [],
    recent_messages: [],
    metadata: {}
  };
}
