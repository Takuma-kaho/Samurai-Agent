// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { reflectionRunValueSchema } from "../../value-objects/reflection.js";

const Input = z.object({
  "session_id": z.string().trim().min(1),
  "source_run_id": z.string().trim().min(1).optional()
}).strict();
const Output = reflectionRunValueSchema;

export interface ReflectionRunPorts {
  getReflectionSession(id: string): Promise<unknown | undefined>;
  reflectionSessionNotFoundError(id: string): Error;
  listReflectionMessages(sessionId: string): Promise<Array<{ role: string; session_id: string; created_at: string }>>;
  listReflectionToolRuns(runId?: string): Promise<unknown[]>;
  listReflectionWorkspaceChanges(sessionId?: string): Promise<unknown[]>;
  listReflectionBackendEvents(input: { runId?: string; sessionId?: string }): Promise<unknown[]>;
  loadReflectionArtifacts(input: { sessionId: string; sourceRunId?: string; workspaceChanges: unknown[] }): Promise<unknown[]>;
  executeReflectionWorkflow(input: Record<string, unknown>): Promise<z.infer<typeof Output>>;
}

const reflectionRun = defineCommand<ReflectionRunPorts>()({
  ...{
  "kind": "command",
  "id": "reflection.run",
  "version": "2.0",
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
        const session = await ports.getReflectionSession(input.session_id);
        if (!session) throw ports.reflectionSessionNotFoundError(input.session_id);
        const messages = await ports.listReflectionMessages(input.session_id);
        const userMessage = [...messages].reverse().find((message) => message.role === "user");
        const agentMessage = [...messages].reverse().find((message) => message.role === "agent");
        const [toolRuns, workspaceChanges, backendEvents] = await Promise.all([
          ports.listReflectionToolRuns(input.source_run_id), ports.listReflectionWorkspaceChanges(input.session_id),
          ports.listReflectionBackendEvents(input.source_run_id ? { runId: input.source_run_id } : { sessionId: input.session_id })
        ]);
        const artifacts = await ports.loadReflectionArtifacts({ sessionId: input.session_id, sourceRunId: input.source_run_id, workspaceChanges });
        const value = await ports.executeReflectionWorkflow({ kind: "manual", session, sourceRunId: input.source_run_id, userMessage, agentMessage, backendEvents, workspaceChanges, toolRuns, transcriptMessages: messages, artifacts });
        return { ok: true, value };
      }
    };
  }
});

export default reflectionRun;
