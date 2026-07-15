import { z } from "zod";
import { domainJsonValueSchema } from "../definition/index.js";

export const fileDirectoryEntrySchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional()
}).strict();

export const fileResourceSchema = z.object({
  path: z.string(),
  content: z.string().optional(),
  entries: z.array(fileDirectoryEntrySchema).optional(),
  metadata: z.record(domainJsonValueSchema).optional(),
  provenance: z.record(domainJsonValueSchema).optional()
}).strict();

export const fileReadValueSchema = z.object({ resource: fileResourceSchema }).strict();
