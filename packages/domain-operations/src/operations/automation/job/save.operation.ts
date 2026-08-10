// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";

const Input = z.object({
  "delivery_target": z.record(domainJsonValueSchema).default({ channel: "activity" }), "enabled": z.boolean().optional(),
  "kind": z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "resource_translation", "custom_instruction"]), "max_attempts": z.number().int().positive().default(3),
  "next_run_at": z.string().datetime().optional(), "schedule": z.string().trim().min(1),
  "target_instruction": z.string().trim().min(1), "title": z.string().trim().min(1)
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobSavePorts {
  saveSessionlessAutomationJob(input: { context: TrustedDomainContext; request: z.infer<typeof Input> }): Promise<z.infer<typeof Output>>;
}

const automationJobSave = defineCommand<AutomationJobSavePorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.save",
  "version": "4.0",
  "availability": "active",
  "title": "Save automation job",
  "description": "Save an automation job definition.",
  "sources": [
    "runtime_api",
    "external_app"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_job"
  ],
  "proposedEffects": [
    "Save an automation job definition."
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
      execute: async function handleAutomationJobSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: await ports.saveSessionlessAutomationJob({ context, request: input }) };
      }
    };
  }
});

export default automationJobSave;
