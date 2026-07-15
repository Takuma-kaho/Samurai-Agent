import { CuratorStateRecordSchema, LearningSnapshotRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const curatorStateValueSchema = CuratorStateRecordSchema.strict();
export const learningSnapshotValueSchema = LearningSnapshotRecordSchema.strict();
export const learningSnapshotPruneValueSchema = z.object({
  retained: z.number().int().nonnegative(),
  removed: z.array(z.string().min(1))
}).strict();
