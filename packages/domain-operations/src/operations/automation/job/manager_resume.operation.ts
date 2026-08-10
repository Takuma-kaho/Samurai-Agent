import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({ job_id: z.string().trim().min(1) }).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobManagerResumePorts {
  managerResumeSessionlessAutomationJob(input: { context: TrustedDomainContext; jobId: string }): Promise<z.infer<typeof Output>>;
}

const automationJobManagerResume = defineCommand<AutomationJobManagerResumePorts>()({
  ...{
    kind: "command", id: "automation.job.manager_resume", version: "1.0", availability: "active",
    title: "Resume automation management", description: "Allow a Room manager-stopped Automation job to be enabled separately.",
    sources: ["runtime_api", "provider_tool_call", "surface_operation", "external_app"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
    render: ["status_timeline"], resourceKinds: ["automation_job"], proposedEffects: ["Allow a separately enabled Automation job to run again."], outputResourceKind: "automation_job", uiDisplayCategory: "automation",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Resuming management never auto-enables a Job." }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return { execute: async function handleAutomationJobManagerResume(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: await ports.managerResumeSessionlessAutomationJob({ context, jobId: input.job_id }) };
    } };
  }
});

export default automationJobManagerResume;
