import { ResourceRefSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

export const transferableResourceKindSchema = z.enum(["wiki", "skill"]);
export type TransferableResourceKind = z.infer<typeof transferableResourceKindSchema>;

export const resourceTransferValueSchema = runtimeWriteValueSchema(z.object({
  resource_kind: transferableResourceKindSchema,
  source: ResourceRefSchema,
  target: ResourceRefSchema,
  resource_version: z.number().int().positive()
}).strict());

export type ResourceTransferValue = z.infer<typeof resourceTransferValueSchema>;

/** Redaction is deliberately limited to built-in secret patterns. The public
 * DTO never carries the secret text that must be removed. */
export const resourceRedactionValueSchema = runtimeWriteValueSchema(z.object({
  resource_kind: transferableResourceKindSchema,
  redacted_resource: ResourceRefSchema,
  resource_version: z.number().int().positive(),
  redaction_mode: z.literal("known_secret_patterns")
}).strict());

export type ResourceRedactionValue = z.infer<typeof resourceRedactionValueSchema>;

/** Reasons become durable Operation input. Reject secret-shaped strings at
 * the public contract rather than relying on a later display redaction. */
export const resourceTransferReasonSchema = z.string().trim().min(1).max(2_000).refine(
  (value) => !/(?:api[_-]?key|(?:access|refresh)?[_-]?token|secret|password|cookie|authorization)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}/i.test(value),
  "resource_transfer_reason_secret_not_allowed"
);
