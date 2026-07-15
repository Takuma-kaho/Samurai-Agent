import { ActivityInboxItemSchema, MemoryFrontmatterSchema, OperationRecordSchema, RollbackPointSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const memoryWriteValueSchema = runtimeWriteValueSchema(MemoryFrontmatterSchema);
export const memoryArchiveValueSchema = z.object({
  memory: MemoryFrontmatterSchema.extend({ file_path: z.string().min(1) }).strict(),
  content: z.string(),
  operation: OperationRecordSchema,
  rollbackPoint: RollbackPointSchema.optional(),
  activity: z.array(ActivityInboxItemSchema),
  changed: z.boolean(),
  warning: z.string().optional()
}).strict();
