import { ActivityRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const humanChangeRequestInputSchema = z.object({
  proposed_change_summary: z.string().trim().min(1).max(4_000),
  affected_fields: z.array(z.string().trim().min(1).max(256)).max(100).default([])
}).strict();

export const humanChangeRequestOutputSchema = z.object({
  request_kind: z.enum(["policy", "profile", "soul"]),
  status: z.literal("requested"),
  proposed_change_summary: z.string().trim().min(1).max(4_000),
  affected_fields: z.array(z.string().trim().min(1).max(256)),
  activity: ActivityRecordSchema
}).strict();
