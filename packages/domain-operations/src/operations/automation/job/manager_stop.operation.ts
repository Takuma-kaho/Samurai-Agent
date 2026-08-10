import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  job_id: z.string().trim().min(1),
  note: z.string().trim().min(1).max(500).optional()
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobManagerStopPorts {
  managerStopSessionlessAutomationJob(input: { context: TrustedDomainContext; jobId: string; note?: string }): Promise<z.infer<typeof Output>>;
}

const automationJobManagerStop = defineCommand<AutomationJobManagerStopPorts>()({
  ...{
    kind: "command", id: "automation.job.manager_stop", version: "1.0", availability: "active",
    title: "Stop automation by Room manager", description: "Stop future Automation executions without cancelling an in-flight executor.",
    sources: ["runtime_api", "provider_tool_call", "surface_operation", "external_app"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
    render: ["status_timeline"], resourceKinds: ["automation_job"], proposedEffects: ["Stop future executions of an Automation job."], outputResourceKind: "automation_job", uiDisplayCategory: "automation",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Room managers control scheduling without becoming the stored execution authority." }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return { execute: async function handleAutomationJobManagerStop(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: await ports.managerStopSessionlessAutomationJob({ context, jobId: input.job_id, ...(input.note ? { note: input.note } : {}) }) };
    } };
  }
});

export default automationJobManagerStop;
