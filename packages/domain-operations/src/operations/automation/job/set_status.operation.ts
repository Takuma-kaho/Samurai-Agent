// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { nowIso } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";
import { automationJobJson, type AutomationJobMutationPorts } from "./job-mutation.js";

const Input = z.object({
  "job_id": z.string().trim().min(1), "status": z.enum(["enabled", "disabled"])
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobSetStatusPorts extends AutomationJobMutationPorts {}

const automationJobSetStatus = defineCommand<AutomationJobSetStatusPorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.set_status",
  "version": "3.0",
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
        const current = await ports.getAutomationJob(input.job_id);
        if (!current) throw ports.automationJobError("not_found", "automation_job_not_found");
        const contract = ports.automationJobContract("automation.job.set_status");
        const session = await ports.ensureAutomationSession();
        const envelope = ports.createAutomationEnvelope(`${input.status === "enabled" ? "Resume" : "Pause"} automation: ${current.title}`);
        const value = await ports.runAutomationJobMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
          targetResourceRefs: [ports.automationJobRef(current)], execute: async (operation) => {
            const saved = await ports.saveAutomationJobRecord({ ...current, status: input.status, locked_until: input.status === "disabled" ? undefined : current.locked_until, updated_at: nowIso() });
            const ref = ports.automationJobRef(saved);
            const rollbackPoint = await ports.createAutomationRollback(operation, [ref], { automation_job: automationJobJson(current) }, { automation_job: automationJobJson(saved) });
            return { resource: saved, ref, rollbackPoint, summary: `${input.status === "enabled" ? "Resumed" : "Paused"} automation ${saved.title}.` };
          }});
        return { ok: true, value };
      }
    };
  }
});

export default automationJobSetStatus;
