// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { WorkItemRecordSchema, createId, nowIso, stableHash, type ObjectiveRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workItemValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "instruction": z.string().trim().min(1),
  "max_attempts": z.number().int().positive().default(3),
  "objective_id": z.string().trim().min(1),
  "parent_work_item_id": z.string().trim().min(1).optional(),
  "priority": z.number().int().default(0),
  "work_idempotency_key": z.string().trim().min(1).optional(),
  "work_item_id": z.string().trim().min(1).optional()
}).strict();
const Output = workItemValueSchema;

export interface WorkItemCreatePorts {
  getWorkItemObjective(id: string): Promise<ObjectiveRecord | undefined>;
  saveWorkItem(record: WorkItemRecord): Promise<WorkItemRecord>;
  workItemObjectiveNotFoundError(): Error;
}

const workItemCreate = defineCommand<WorkItemCreatePorts>()({
  ...{
  "kind": "command",
  "id": "work_item.create",
  "version": "1.0",
  "availability": "active",
  "title": "Create work item",
  "description": "Create a durable work item under an objective.",
  "sources": [
    "runtime_api",
    "gateway_inbound",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "objective",
    "work_item"
  ],
  "proposedEffects": [
    "Create a durable work item under an objective."
  ],
  "outputResourceKind": "work_item",
  "uiDisplayCategory": "activity",
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
      execute: async function handleWorkItemCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!await ports.getWorkItemObjective(input.objective_id)) throw ports.workItemObjectiveNotFoundError();
        const now = nowIso();
        const record = WorkItemRecordSchema.parse({
          id: input.work_item_id ?? createId("work"), objective_id: input.objective_id,
          parent_work_item_id: input.parent_work_item_id, instruction: input.instruction,
          status: "ready", priority: input.priority, attempt: 0, max_attempts: input.max_attempts,
          idempotency_key: input.work_idempotency_key ?? `${input.objective_id}:${stableHash(input)}`,
          created_at: now, updated_at: now
        });
        return { ok: true, value: await ports.saveWorkItem(record) };
      }
    };
  }
});

export default workItemCreate;
