import { ClientEventRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const clientEventValueSchema = ClientEventRecordSchema.strict();
export const expiredClientEventsValueSchema = z.object({
  expired_count: z.number().int().nonnegative(),
  events: z.array(ClientEventRecordSchema)
}).strict();
