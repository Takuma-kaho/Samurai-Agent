import { ActivityInboxItemSchema, AutomationRunRecordSchema, OperationRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { reflectionRunValueSchema } from "./reflection.js";

export const automationRunRecordSchema = AutomationRunRecordSchema;

export const automationJobRunValueSchema = z.object({
  resource: automationRunRecordSchema,
  automationRun: automationRunRecordSchema,
  operation: OperationRecordSchema.optional(),
  activity: z.array(ActivityInboxItemSchema),
  blocked: z.literal(true).optional()
}).strict();

export const automationMemoryReviewRunValueSchema = runtimeWriteValueSchema(automationRunRecordSchema, {
  automationRun: automationRunRecordSchema,
  memoryReviewTrace: reflectionRunValueSchema
});
