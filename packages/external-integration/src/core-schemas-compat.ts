import { z } from "zod";

/** The two Core09 boundary schemas are intentionally mirrored here so this
 * contract package can be typechecked before workspace links are installed.
 * Runtime callers still pass the same Core09-shaped values. */
export const SessionRefSchema = z.object({
  app_id: z.string().trim().min(1).max(200),
  session_id: z.string().trim().min(1).max(512),
  turn_id: z.string().trim().min(1).max(512).optional(),
  message_id: z.string().trim().min(1).max(512).optional(),
  resume_url: z.string().trim().min(1).max(4_000).optional(),
  external_ref: z.string().trim().min(1).max(2_000).optional()
}).strict();
export type SessionRef = z.infer<typeof SessionRefSchema>;

export const ConnectorEvidenceSchema = z.object({
  connector_id: z.string().trim().min(1).max(200),
  app_id: z.string().trim().min(1).max(200)
}).strict();
export type ConnectorEvidence = z.infer<typeof ConnectorEvidenceSchema>;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
