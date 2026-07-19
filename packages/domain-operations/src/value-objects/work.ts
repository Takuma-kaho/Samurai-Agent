import { ObjectiveRecordSchema, WorkDependencyRecordSchema, WorkItemRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const objectiveValueSchema = ObjectiveRecordSchema.strict();
export const objectiveTransitionValueSchema = z.object({
  objective: ObjectiveRecordSchema,
  workItems: z.array(WorkItemRecordSchema),
  cancelBackendRunIds: z.array(z.string().min(1))
}).strict();
export const workItemValueSchema = WorkItemRecordSchema.strict();
export const workItemFollowUpValueSchema = z.object({
  workItem: WorkItemRecordSchema,
  dependency: WorkDependencyRecordSchema
}).strict();
