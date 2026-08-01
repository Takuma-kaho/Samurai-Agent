// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ArtifactRecord, BackendEventRecord, BackendRunRecord, MessageRecord, SessionRecord, ToolRunRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { reflectionRunValueSchema } from "../../value-objects/reflection.js";

const Input = z.object({
  "source_run_id": z.string().trim().min(1).optional()
}).strict();
const Output = reflectionRunValueSchema;

export interface ReflectionArtifactSnapshot {
  artifact: ArtifactRecord;
  content?: string;
  content_truncated: boolean;
}

export interface ReflectionWorkflowInput {
  kind: "manual" | "scheduled";
  session: SessionRecord;
  sourceRunId?: string;
  backendRun?: BackendRunRecord;
  userMessage?: MessageRecord;
  agentMessage?: MessageRecord;
  backendEvents: BackendEventRecord[];
  workspaceChanges: WorkspaceChangeRecord[];
  toolRuns: ToolRunRecord[];
  transcriptMessages: MessageRecord[];
  artifacts: ReflectionArtifactSnapshot[];
}

export interface ReflectionRunPorts {
  getReflectionSession(id: string): Promise<SessionRecord | undefined>;
  reflectionSessionNotFoundError(id: string): Error;
  getReflectionBackendRun(id: string): Promise<BackendRunRecord | undefined>;
  reflectionSourceRunNotFoundError(id: string): Error;
  reflectionSourceRunSessionMismatchError(input: { sourceRunId: string; sessionId: string }): Error;
  listReflectionMessages(sessionId: string): Promise<MessageRecord[]>;
  listReflectionToolRuns(runId?: string): Promise<ToolRunRecord[]>;
  listReflectionWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]>;
  listReflectionBackendEvents(input: { runId?: string; sessionId?: string }): Promise<BackendEventRecord[]>;
  loadReflectionArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: WorkspaceChangeRecord[] }): Promise<ReflectionArtifactSnapshot[]>;
  executeReflectionWorkflow(input: ReflectionWorkflowInput): Promise<z.infer<typeof Output>>;
}

const reflectionRun = defineCommand<ReflectionRunPorts>()({
  ...{
  "kind": "command",
  "id": "reflection.run",
  "version": "3.2",
  "availability": "active",
  "title": "Run background review",
  "description": "Run scoped Background Review for a completed Session or Backend run.",
  "sources": [
    "runtime_api",
    "automation",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "reflection_run",
    "memory",
    "wiki",
    "skill"
  ],
  "proposedEffects": [
    "Review completed work and record scoped Learning changes."
  ],
  "outputResourceKind": "reflection_run",
  "uiDisplayCategory": "memory",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleReflectionRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const sessionId = context.sessionId;
        if (!sessionId) throw ports.reflectionSessionNotFoundError("trusted_context_session_required");
        const session = await ports.getReflectionSession(sessionId);
        if (!session) throw ports.reflectionSessionNotFoundError(sessionId);
        const backendRun = input.source_run_id ? await ports.getReflectionBackendRun(input.source_run_id) : undefined;
        if (input.source_run_id && !backendRun) throw ports.reflectionSourceRunNotFoundError(input.source_run_id);
        if (backendRun && backendRun.session_id !== session.id) {
          throw ports.reflectionSourceRunSessionMismatchError({ sourceRunId: backendRun.id, sessionId: session.id });
        }
        const messages = await ports.listReflectionMessages(sessionId);
        const userMessage = [...messages].reverse().find((message) => message.role === "user");
        const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
        const [toolRuns, workspaceChanges, backendEvents] = await Promise.all([
          ports.listReflectionToolRuns(input.source_run_id), ports.listReflectionWorkspaceChanges(sessionId),
          ports.listReflectionBackendEvents(input.source_run_id ? { runId: input.source_run_id } : { sessionId })
        ]);
        const artifacts = await ports.loadReflectionArtifacts({ sessionId, sourceRunId: input.source_run_id, workspaceChanges });
        const value = await ports.executeReflectionWorkflow({
          kind: "manual", session,
          ...(input.source_run_id === undefined ? {} : { sourceRunId: input.source_run_id }),
          ...(backendRun ? { backendRun } : {}),
          userMessage, agentMessage, backendEvents, workspaceChanges, toolRuns, transcriptMessages: messages, artifacts
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});

export default reflectionRun;
