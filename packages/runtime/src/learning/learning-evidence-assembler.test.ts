import { describe, expect, it } from "vitest";
import type {
  ActivityContextRef,
  AgentRecord,
  ArtifactRecord,
  BackendEventRecord,
  BackendRunRecord,
  LearningResourceUseRecord,
  MessageRecord,
  RoomRecord,
  SessionRecord,
  ToolRunRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import { LearningEvidenceAssembler, type LearningEvidenceReadPort } from "./learning-evidence-assembler.js";

const now = "2026-08-02T00:00:00.000Z";

describe("LearningEvidenceAssembler", () => {
  it("reconstructs only one scoped Run without copying resource bodies", async () => {
    const port = fixturePort();
    const bundle = await new LearningEvidenceAssembler(port).assemble("run-a");

    expect(bundle).toMatchObject({
      backend_run: { id: "run-a" },
      activity_context: { room_id: "room-a", session_id: "session-a", agent_id: "agent-a" },
      input_message: { id: "message-input-a" },
      output_message: { id: "message-output-a" }
    });
    expect(bundle?.backend_events.map((event) => event.id)).toEqual(["event-a"]);
    expect(bundle?.tool_runs.map((toolRun) => toolRun.id)).toEqual(["tool-a"]);
    expect(bundle?.workspace_changes.map((change) => change.id)).toEqual(["change-a"]);
    expect(bundle?.related_artifacts.map((artifact) => artifact.id)).toEqual(["artifact-a"]);
    expect(bundle?.used_learning_resources.map((use) => use.resource_id)).toEqual(["memory-a", "skill-a", "skill-a:references/a.md"]);
    expect(JSON.stringify(bundle)).not.toContain("resource body must stay in the Workspace");
  });

  it("does not materialize a Run without a resolvable Activity Context", async () => {
    const port = fixturePort();
    await expect(new LearningEvidenceAssembler(port).assemble("run-unscoped")).resolves.toBeUndefined();
  });
});

function fixturePort(): LearningEvidenceReadPort {
  const activityContext: ActivityContextRef = { room_id: "room-a", session_id: "session-a", agent_id: "agent-a" };
  const runA = { id: "run-a", session_id: "session-a", agent_id: "agent-a", input_message_id: "message-input-a", output_message_id: "message-output-a", backend_id: "backend-a", backend_kind: "external", status: "completed", started_at: now, completed_at: now, input_summary: "input", metadata: {} } as BackendRunRecord;
  const runUnscoped = { ...runA, id: "run-unscoped", agent_id: undefined } as BackendRunRecord;
  const sessionA = { id: "session-a", session_key: "a", room_id: "room-a", title: "A", ui_locale: "ja", output_locale: "ja", created_at: now, updated_at: now } as SessionRecord;
  const sessionB = { ...sessionA, id: "session-b", session_key: "b", room_id: "room-b" } as SessionRecord;
  const messages: MessageRecord[] = [
    { id: "message-input-a", session_id: "session-a", role: "user", content: "input", input_locale: "ja", output_locale: "ja", created_at: now },
    { id: "message-output-a", session_id: "session-a", role: "agent", content: "output", input_locale: "ja", output_locale: "ja", created_at: now },
    { id: "message-b", session_id: "session-b", role: "user", content: "other", input_locale: "ja", output_locale: "ja", created_at: now }
  ];
  const artifactA = { id: "artifact-a", title: "A", kind: "note", locale: "ja", source_locales: ["ja"], file_ref: { kind: "artifact", id: "artifact-a", uri: "artifacts/a.md" }, metadata: { content_hash: "artifact-hash-a" }, source_operation_id: "operation-a", created_by: "agent-a", created_at: now, updated_at: now } as ArtifactRecord;
  const artifactB = { ...artifactA, id: "artifact-b", source_operation_id: "operation-b" } as ArtifactRecord;
  const uses: LearningResourceUseRecord[] = [
    learningUse("use-memory", "memory", "memory-a", "body_loaded", activityContext),
    learningUse("use-selected", "skill", "skill-a", "selected", activityContext),
    learningUse("use-skill", "skill", "skill-a", "body_loaded", activityContext),
    learningUse("use-support", "skill_support", "skill-a:references/a.md", "support_loaded", activityContext),
    learningUse("use-foreign", "wiki", "wiki-b", "body_loaded", { room_id: "room-b", session_id: "session-b", agent_id: "agent-b" })
  ];
  return {
    getBackendRun: async (id) => id === runA.id ? runA : id === runUnscoped.id ? runUnscoped : undefined,
    getSession: async (id) => id === sessionA.id ? sessionA : id === sessionB.id ? sessionB : undefined,
    getRoom: async (id) => id === "room-a" ? { id, name: "A", created_at: now, updated_at: now } as RoomRecord : id === "room-b" ? { id, name: "B", created_at: now, updated_at: now } as RoomRecord : undefined,
    getAgent: async (id) => id === "agent-a" ? { id, name: "A", role: "Research", instructions: "", backend_id: "backend-a", enabled: true, created_at: now, updated_at: now } as AgentRecord : undefined,
    listMessages: async (sessionId) => messages.filter((message) => message.session_id === sessionId),
    listBackendEvents: async () => [event("event-a", "run-a", "session-a"), event("event-b", "run-b", "session-b")],
    listToolRuns: async () => [tool("tool-a", "run-a", "session-a"), tool("tool-b", "run-b", "session-b")],
    listWorkspaceChanges: async () => [change("change-a", "run-a", "session-a", "artifact-a"), change("change-b", "run-b", "session-b", "artifact-b")],
    listArtifactsForSession: async (sessionId) => sessionId === "session-a" ? [artifactA, artifactB] : [],
    listLearningResourceUses: async (input) => uses.filter((use) => use.run_id === input.runId && use.activity_context?.room_id === input.activityContext.room_id)
  };
}

function learningUse(id: string, kind: LearningResourceUseRecord["resource_kind"], resourceId: string, stage: LearningResourceUseRecord["stage"], activityContext: ActivityContextRef): LearningResourceUseRecord {
  return { id, run_id: "run-a", session_id: activityContext.session_id, resource_kind: kind, resource_id: resourceId, resource_version: "version-a", content_hash: "hash-a", stage, activity_context: activityContext, metadata: {}, created_at: now };
}

function event(id: string, runId: string, sessionId: string): BackendEventRecord {
  return { id, run_id: runId, session_id: sessionId, event_type: "run_completed", sequence: 1, payload: {}, resource_refs: [], created_at: now };
}

function tool(id: string, runId: string, sessionId: string): ToolRunRecord {
  return { id, run_id: runId, session_id: sessionId, tool_call_id: id, provider_tool_name: "file.read", action_id: "file.read", status: "completed", input_summary: "", output_summary: "", resource_refs: [], created_at: now };
}

function change(id: string, runId: string, sessionId: string, artifactId: string): WorkspaceChangeRecord {
  return { id, run_id: runId, session_id: sessionId, resource_ref: { kind: "artifact", id: artifactId, uri: `artifacts/${artifactId}.md` }, change_type: "artifact_created", summary: "", created_at: now };
}
