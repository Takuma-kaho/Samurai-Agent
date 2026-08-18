// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  "job_id": z.string().trim().min(1), "status": z.enum(["enabled", "disabled"])
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobSetStatusPorts {
  setSessionlessAutomationJobStatus(input: { context: TrustedDomainContext; jobId: string; status: "enabled" | "disabled" }): Promise<z.infer<typeof Output>>;
}

const automationJobSetStatus = defineCommand<AutomationJobSetStatusPorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.set_status",
  "version": "4.0",
  "availability": "active",
  "title": "Pause or resume automation",
  "description": "Enable or disable an Automation job through the Runtime boundary.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_job"
  ],
  "proposedEffects": [
    "Change an Automation job between enabled and disabled."
  ],
  "outputResourceKind": "automation_job",
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
      execute: async function handleAutomationJobSetStatus(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: await ports.setSessionlessAutomationJobStatus({ context, jobId: input.job_id, status: input.status }) };
      }
    };
  }
});

export default automationJobSetStatus;
