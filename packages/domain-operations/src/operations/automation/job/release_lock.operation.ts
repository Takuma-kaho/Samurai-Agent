// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  "job_id": z.string().trim().min(1),
  "lock_owner_token": z.string().trim().min(1),
  "now": z.string().datetime().optional()
}).strict();
const Output = automationJobValueSchema;

export interface AutomationJobReleaseLockPorts {
  releaseAutomationJobLock(jobId: string, lockOwnerToken: string, now?: string): Promise<z.infer<typeof Output> | undefined>;
  automationJobNotFoundError(): Error;
}

const automationJobReleaseLock = defineCommand<AutomationJobReleaseLockPorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.release_lock",
  "version": "2.0",
  "availability": "active",
  "title": "Release automation lock",
  "description": "Release a stale Automation job lock.",
  "sources": [
    "runtime_api",
    "scheduled_context"
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
    "Release an Automation job lock."
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
      execute: async function handleAutomationJobReleaseLock(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const job = await ports.releaseAutomationJobLock(input.job_id, input.lock_owner_token, input.now);
        if (!job) throw ports.automationJobNotFoundError();
        return { ok: true, value: job };
      }
    };
  }
});

export default automationJobReleaseLock;
