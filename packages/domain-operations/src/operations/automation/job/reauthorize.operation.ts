import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({ job_id: z.string().trim().min(1) }).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobReauthorizePorts {
  reauthorizeSessionlessAutomationJob(input: { context: TrustedDomainContext; jobId: string }): Promise<z.infer<typeof Output>>;
}

const automationJobReauthorize = defineCommand<AutomationJobReauthorizePorts>()({
  ...{
    kind: "command", id: "automation.job.reauthorize", version: "1.0", availability: "active",
    title: "Reauthorize automation job", description: "Recheck the stored Automation authority after an authorization block without replacing it.",
    sources: ["runtime_api", "provider_tool_call", "surface_operation", "external_app"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
    render: ["status_timeline"], resourceKinds: ["automation_job"], proposedEffects: ["Recheck stored Automation authority and leave the Job disabled."], outputResourceKind: "automation_job", uiDisplayCategory: "automation",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Authorization recovery is explicit and never changes the persisted authority." }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return { execute: async function handleAutomationJobReauthorize(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: await ports.reauthorizeSessionlessAutomationJob({ context, jobId: input.job_id }) };
    } };
  }
});

export default automationJobReauthorize;
