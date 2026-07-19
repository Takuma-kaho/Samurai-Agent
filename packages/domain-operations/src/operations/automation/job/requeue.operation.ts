// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  "job_id": z.string().trim().min(1),
  "next_run_at": z.string().datetime().optional()
}).strict();
const Output = automationJobValueSchema;

export interface AutomationJobRequeuePorts {
  requeueAutomationJob(jobId: string, nextRunAt?: string): Promise<z.infer<typeof Output> | undefined>;
  automationJobNotFoundError(): Error;
}

const automationJobRequeue = defineCommand<AutomationJobRequeuePorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.requeue",
  "version": "2.0",
  "availability": "active",
  "title": "Requeue automation job",
  "description": "Requeue an Automation job after an operational failure.",
  "sources": [
    "runtime_api"
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
    "Requeue an Automation job."
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
      execute: async function handleAutomationJobRequeue(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const job = await ports.requeueAutomationJob(input.job_id, input.next_run_at);
        if (!job) throw ports.automationJobNotFoundError();
        return { ok: true, value: job };
      }
    };
  }
});

export default automationJobRequeue;
