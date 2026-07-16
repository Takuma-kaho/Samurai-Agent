// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { createId, nowIso, type ObjectiveRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { objectiveValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "completion_criteria": z.array(z.string().trim().min(1)).min(1),
  "max_attempts": z.number().int().positive().optional(),
  "objective": z.string().trim().min(1),
  "objective_id": z.string().trim().min(1).optional(),
  "session_id": z.string().trim().min(1).optional(),
  "time_budget_ms": z.number().int().positive().optional(),
  "title": z.string().trim().min(1).optional(),
  "token_budget": z.number().int().positive().optional()
}).strict();
const Output = objectiveValueSchema;

export interface ObjectiveCreatePorts {
  saveObjective(record: ObjectiveRecord): Promise<ObjectiveRecord>;
}

const objectiveCreate = defineCommand<ObjectiveCreatePorts>()({
  ...{
  "kind": "command",
  "id": "objective.create",
  "version": "2.0",
  "availability": "active",
  "title": "Create objective",
  "description": "Create a durable objective with explicit completion criteria.",
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
    "objective"
  ],
  "proposedEffects": [
    "Create a durable objective and explicit completion criteria."
  ],
  "outputResourceKind": "objective",
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
      execute: async function handleObjectiveCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const now = nowIso();
        const objective: ObjectiveRecord = {
          id: input.objective_id ?? createId("objective"),
          session_id: input.session_id,
          title: input.title ?? summarize(input.objective, 80),
          objective: input.objective,
          completion_criteria: input.completion_criteria,
          status: "active",
          token_budget: input.token_budget,
          time_budget_ms: input.time_budget_ms,
          max_attempts: input.max_attempts,
          created_at: now,
          updated_at: now
        };
        return { ok: true, value: await ports.saveObjective(objective) };
      }
    };
  }
});

export default objectiveCreate;

function summarize(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").slice(0, maxLength);
}
