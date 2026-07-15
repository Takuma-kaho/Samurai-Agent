import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { reflectionRunValueSchema } from "./reflection.js";

export const automationRunRecordSchema = z.object({
  id: z.string().min(1), kind: z.string().min(1), source: z.string().min(1),
  session_id: z.string().min(1).optional(), backend_run_id: z.string().min(1).optional(),
  status: z.enum(["started", "completed", "failed"]), operation_id: z.string().min(1).optional(),
  started_at: z.string().datetime(), completed_at: z.string().datetime().optional(), error: z.string().optional()
}).strict();

export const automationJobRunValueSchema = runtimeWriteValueSchema(automationRunRecordSchema, {
  automationRun: automationRunRecordSchema
});

export const automationMemoryReviewRunValueSchema = runtimeWriteValueSchema(automationRunRecordSchema, {
  automationRun: automationRunRecordSchema,
  memoryReviewTrace: reflectionRunValueSchema
});
