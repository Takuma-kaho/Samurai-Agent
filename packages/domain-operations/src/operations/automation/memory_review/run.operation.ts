// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { createId, nowIso, type ActivityInboxItem, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationMemoryReviewRunValueSchema } from "../../../value-objects/automation-run.js";

const Input = z.object({}).strict();
const Output = automationMemoryReviewRunValueSchema;

export interface AutomationMemoryReviewRunPorts {
  createAutomationRun(input: { id: string; kind: string; source: string; status: "started"; started_at: string }): Promise<AutomationRunRecord>;
  updateAutomationRun(record: AutomationRunRecord): Promise<AutomationRunRecord>;
  ensureScheduledAutomationSession(context: ScheduledContext, title: string): Promise<SessionRecord>;
  createScheduledAutomationEnvelope(context: ScheduledContext, content: string): MessageEnvelope;
  runScheduledAutomationMutation(input: { session: SessionRecord; envelope: MessageEnvelope; context: ScheduledContext; operationName: string; inputRef?: ResourceRef; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: AutomationRunRecord; ref: ResourceRef; summary: string; rollbackPoint?: RollbackPoint }> }): Promise<{ resource: AutomationRunRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  runScheduledMemoryReview(session: SessionRecord): Promise<z.infer<typeof Output>["memoryReviewTrace"]>;
  automationErrorMessage(error: unknown): string;
}
type ScheduledContext = { source: "cron"; actor_identity: "owner_scheduled"; instruction_source: "scheduled_context"; channel: "cron"; session_key: string };
interface AutomationRunRecord { id: string; kind: string; source: string; session_id?: string; backend_run_id?: string; status: "started" | "completed" | "failed"; operation_id?: string; started_at: string; completed_at?: string; error?: string }

const automationMemoryReviewRun = defineCommand<AutomationMemoryReviewRunPorts>()({
  ...{
  "kind": "command",
  "id": "automation.memory_review.run",
  "version": "3.0",
  "availability": "active",
  "title": "Run memory review",
  "description": "Run the scheduled memory review automation.",
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
    "automation_run",
    "reflection_run",
    "memory"
  ],
  "proposedEffects": [
    "Run the scheduled memory review automation."
  ],
  "outputResourceKind": "reflection_run",
  "uiDisplayCategory": "automation",
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
      execute: async function handleAutomationMemoryReviewRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const startedAt = nowIso();
        let automationRun = await ports.createAutomationRun({ id: createId("automation_run"), kind: "memory_review", source: "cron", status: "started", started_at: startedAt });
        const scheduledContext: ScheduledContext = { source: "cron", actor_identity: "owner_scheduled", instruction_source: "scheduled_context", channel: "cron", session_key: "cron:memory-review" };
        const session = await ports.ensureScheduledAutomationSession(scheduledContext, "Scheduled memory review");
        automationRun = await ports.updateAutomationRun({ ...automationRun, session_id: session.id });
        const envelope = ports.createScheduledAutomationEnvelope(scheduledContext, "Run scheduled memory review.");
        try {
          let trace: z.infer<typeof Output>["memoryReviewTrace"] | undefined;
          const result = await ports.runScheduledAutomationMutation({ session, envelope, context: scheduledContext, operationName: "automation.memory_review.run",
            inputRef: { kind: "automation_run", id: String(automationRun.id), uri: `automation-runs/${String(automationRun.id)}`, label: "Automation run" },
            proposedEffects: ["Run scheduled memory review and deterministic curator without external effects."], execute: async () => {
              trace = await ports.runScheduledMemoryReview(session);
              return { resource: automationRun, ref: { kind: "automation_run", id: String(automationRun.id), uri: `automation-runs/${String(automationRun.id)}`, label: "Memory review automation" }, summary: `Memory review automation ran Background Review and applied ${trace.suggestions.length} learning change(s).` };
            }});
          automationRun = await ports.updateAutomationRun({ ...automationRun, status: "completed", operation_id: result.operation.id, completed_at: nowIso() });
          if (!trace) throw new Error("memory_review_trace_missing");
          return { ok: true, value: Output.parse({ ...result, automationRun, memoryReviewTrace: trace }) };
        } catch (error) {
          automationRun = await ports.updateAutomationRun({ ...automationRun, status: "failed", completed_at: nowIso(), error: ports.automationErrorMessage(error) });
          throw error;
        }
      }
    };
  }
});

export default automationMemoryReviewRun;
