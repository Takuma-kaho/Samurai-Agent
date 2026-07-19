import { ActivityInboxItemSchema, OperationRecordSchema, RollbackPointSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

type RuntimeWriteShape<Resource extends z.ZodTypeAny> = {
  resource: Resource;
  operation: typeof OperationRecordSchema;
  rollbackPoint: z.ZodOptional<typeof RollbackPointSchema>;
  activity: z.ZodArray<typeof ActivityInboxItemSchema>;
};

export function runtimeWriteValueSchema<Resource extends z.ZodTypeAny>(resource: Resource): z.ZodObject<RuntimeWriteShape<Resource>, "strict">;
export function runtimeWriteValueSchema<Resource extends z.ZodTypeAny, Extra extends z.ZodRawShape>(resource: Resource, extra: Extra): z.ZodObject<RuntimeWriteShape<Resource> & Extra, "strict">;
export function runtimeWriteValueSchema(resource: z.ZodTypeAny, extra: z.ZodRawShape = {}) {
  return z.object({
    resource,
    operation: OperationRecordSchema,
    rollbackPoint: RollbackPointSchema.optional(),
    activity: z.array(ActivityInboxItemSchema),
    ...extra
  }).strict();
}
