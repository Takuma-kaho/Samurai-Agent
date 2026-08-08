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

/**
 * Read-only material for a future learning decision.  It is reconstructed
 * from the Workspace and SQLite histories; no resource body is copied here.
 */
export interface LearningEvidenceBundle {
  backend_run: BackendRunRecord;
  activity_context: ActivityContextRef;
  room: RoomRecord;
  session: SessionRecord;
  agent: AgentRecord;
  input_message: MessageRecord;
  output_message?: MessageRecord;
  backend_events: BackendEventRecord[];
  tool_runs: ToolRunRecord[];
  workspace_changes: WorkspaceChangeRecord[];
  related_artifacts: ArtifactRecord[];
  used_learning_resources: LearningResourceUseRecord[];
}

export interface LearningEvidenceReadPort {
  getBackendRun(id: string): Promise<BackendRunRecord | undefined>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  getRoom(id: string): Promise<RoomRecord | undefined>;
  getAgent(id: string): Promise<AgentRecord | undefined>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;
  listBackendEvents(input: { runId: string }): Promise<BackendEventRecord[]>;
  listToolRuns(input: { runId: string }): Promise<ToolRunRecord[]>;
  listWorkspaceChanges(sessionId: string): Promise<WorkspaceChangeRecord[]>;
  listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]>;
  listLearningResourceUses(input: { runId: string; activityContext: ActivityContextRef }): Promise<LearningResourceUseRecord[]>;
}

/** A narrow reader: it neither calls an LLM nor changes Workspace resources. */
export class LearningEvidenceAssembler {
  constructor(private readonly store: LearningEvidenceReadPort) {}

  async assemble(runId: string): Promise<LearningEvidenceBundle | undefined> {
    const run = await this.store.getBackendRun(runId);
    if (!run?.agent_id || !run.session_id) return undefined;
    const session = await this.store.getSession(run.session_id);
    if (!session?.room_id || session.id !== run.session_id) return undefined;
    const [room, agent, messages] = await Promise.all([
      this.store.getRoom(session.room_id),
      this.store.getAgent(run.agent_id),
      this.store.listMessages(session.id)
    ]);
    if (!room || !agent) return undefined;
    const inputMessage = messages.find((message) => message.id === run.input_message_id);
    if (!inputMessage) return undefined;
    const activityContext: ActivityContextRef = {
      room_id: room.id,
      session_id: session.id,
      agent_id: agent.id
    };
    const [backendEvents, toolRuns, allChanges, artifacts, learningUses] = await Promise.all([
      this.store.listBackendEvents({ runId: run.id }),
      this.store.listToolRuns({ runId: run.id }),
      this.store.listWorkspaceChanges(session.id),
      this.store.listArtifactsForSession(session.id),
      this.store.listLearningResourceUses({ runId: run.id, activityContext })
    ]);
    const workspaceChanges = allChanges.filter((change) => change.run_id === run.id && change.session_id === session.id);
    const artifactIds = new Set(workspaceChanges
      .filter((change) => change.resource_ref.kind === "artifact" && typeof change.resource_ref.id === "string")
      .map((change) => change.resource_ref.id));
    const usedLearningResources = learningUses.filter((use) =>
      (use.resource_kind === "memory" || use.resource_kind === "wiki" || use.resource_kind === "skill" || use.resource_kind === "skill_support")
      && (use.stage === "body_loaded" || use.stage === "support_loaded" || use.stage === "applied")
    );
    return {
      backend_run: run,
      activity_context: activityContext,
      room,
      session,
      agent,
      input_message: inputMessage,
      ...(run.output_message_id ? { output_message: messages.find((message) => message.id === run.output_message_id) } : {}),
      backend_events: backendEvents.filter((event) => event.run_id === run.id && event.session_id === session.id),
      tool_runs: toolRuns.filter((toolRun) => toolRun.run_id === run.id && toolRun.session_id === session.id),
      workspace_changes: workspaceChanges,
      related_artifacts: artifacts.filter((artifact) => artifactIds.has(artifact.id)),
      used_learning_resources: usedLearningResources
    };
  }
}
