import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const rollbackRestoreValueSchema = runtimeWriteValueSchema(z.object({
  rollback_point_id: z.string().min(1),
  path: z.string().min(1),
  action: z.enum(["written", "deleted"])
}).strict());
