// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { AutomationJobRecordSchema, createId, nowIso } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationJobWriteValueSchema } from "../../../value-objects/automation.js";
import { automationJobJson, type AutomationJobMutationPorts } from "./job-mutation.js";

const Input = z.object({
  "delivery_target": z.record(domainJsonValueSchema).default({ channel: "activity" }), "enabled": z.boolean().optional(),
  "kind": z.enum(["memory_review", "learning_evaluation", "skill_curator", "wiki_reindex", "daily_digest", "resource_translation", "custom_instruction"]), "max_attempts": z.number().int().positive().default(3),
  "next_run_at": z.string().datetime().optional(), "schedule": z.string().trim().min(1),
  "target_instruction": z.string().trim().min(1), "title": z.string().trim().min(1)
}).strict();
const Output = automationJobWriteValueSchema;

export interface AutomationJobSavePorts extends AutomationJobMutationPorts {}

const automationJobSave = defineCommand<AutomationJobSavePorts>()({
  ...{
  "kind": "command",
  "id": "automation.job.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save automation job",
  "description": "Save an automation job definition.",
  "sources": [
    "runtime_api"
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
        const contract = ports.automationJobContract("automation.job.save");
        const session = await ports.ensureAutomationSession();
        const envelope = ports.createAutomationEnvelope(`Save automation job: ${input.title}`);
        const now = nowIso();
        const job = AutomationJobRecordSchema.parse({ id: createId("automation"), title: input.title, kind: input.kind,
          status: input.enabled === false ? "disabled" : "enabled", schedule: input.schedule, target_instruction: input.target_instruction,
          delivery_target: input.delivery_target, next_run_at: input.next_run_at ?? now, failure_count: 0, max_attempts: input.max_attempts, created_at: now, updated_at: now });
        const value = await ports.runAutomationJobMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
          const saved = await ports.saveAutomationJobRecord(job); const ref = ports.automationJobRef(saved);
          const rollbackPoint = await ports.createAutomationRollback(operation, [ref], {}, { automation_job: automationJobJson(saved) });
          return { resource: saved, ref, rollbackPoint, summary: `Saved automation job ${saved.title}.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default automationJobSave;
