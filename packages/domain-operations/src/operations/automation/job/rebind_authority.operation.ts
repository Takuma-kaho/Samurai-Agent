import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({ job_id: z.string().trim().min(1) }).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobRebindAuthorityPorts {
  rebindSessionlessAutomationJobAuthority(input: { context: TrustedDomainContext; jobId: string }): Promise<z.infer<typeof Output>>;
}

const automationJobRebindAuthority = defineCommand<AutomationJobRebindAuthorityPorts>()({
  ...{
    kind: "command", id: "automation.job.rebind_authority", version: "1.0", availability: "active",
    title: "Rebind automation authority", description: "Bind a legacy job to the current Room authority without enabling it.",
    sources: ["runtime_api", "external_app"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
    render: ["status_timeline"], resourceKinds: ["automation_job"],
    proposedEffects: ["Rebind Automation authority without automatically enabling the job."], outputResourceKind: "automation_job", uiDisplayCategory: "automation",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Legacy jobs never infer Room or authority from Session or delivery metadata." }]
  },
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleAutomationJobRebindAuthority(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return {
        ok: true,
        value: await ports.rebindSessionlessAutomationJobAuthority({ context, jobId: input.job_id })
      };
    } };
  }
});

export default automationJobRebindAuthority;
