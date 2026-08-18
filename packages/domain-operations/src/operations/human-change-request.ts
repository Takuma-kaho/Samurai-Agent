import { ActivityRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import type { TrustedDomainContext } from "../definition/index.js";

/**
 * External Clients may record a bounded, non-secret request for a human-owned
 * change. They never receive a command that writes the Policy, Profile, or
 * Soul itself.
 */
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

export type HumanChangeRequestInput = z.infer<typeof humanChangeRequestInputSchema>;
export type HumanChangeRequestOutput = z.infer<typeof humanChangeRequestOutputSchema>;

export interface HumanChangeRequestPorts {
  requestHumanChange(
    context: TrustedDomainContext,
    input: HumanChangeRequestInput & { request_kind: HumanChangeRequestOutput["request_kind"] }
  ): Promise<HumanChangeRequestOutput>;
}
