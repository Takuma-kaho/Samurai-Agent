// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { nowIso } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobRunValueSchema } from "../../../value-objects/automation-run.js";
import { executeAutomationJob, type AutomationJobExecutionPorts } from "./execute-automation-job.js";

const Input = z.object({
  "job_id": z.string().trim().min(1), "now": z.string().datetime().optional()
}).strict();
const Output = automationJobRunValueSchema;

export interface AutomationJobRunPorts extends AutomationJobExecutionPorts {}

const automationJobRun = defineCommand<AutomationJobRunPorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.run",
  "version": "3.0",
  "availability": "active",
  "title": "Run automation job",
  "description": "Run an enabled automation job through scheduled context.",
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
    "automation_job",
    "automation_run"
  ],
  "proposedEffects": [
    "Run an enabled automation job through scheduled context."
  ],
  "outputResourceKind": "automation_run",
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
      execute: async function handleAutomationJobRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const job = await ports.getAutomationJob(input.job_id);
        if (!job) throw ports.automationExecutionError("not_found", `Automation job not found: ${input.job_id}`);
        const now = input.now ?? nowIso();
        const locked = await ports.acquireAutomationJobLock(job.id, { lockedUntil: new Date(Date.parse(now) + 15 * 60_000).toISOString(), now });
        if (!locked) throw ports.automationExecutionError("conflict", "automation_job_locked");
        return { ok: true, value: Output.parse(await executeAutomationJob(ports, locked, now)) };
      }
    };
  }
});

export default automationJobRun;
