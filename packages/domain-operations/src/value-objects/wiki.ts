import { WikiFrontmatterSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";

export const storedWikiSchema = WikiFrontmatterSchema.extend({ file_path: z.string().min(1) }).strict();
export const wikiWriteValueSchema = runtimeWriteValueSchema(storedWikiSchema);
const wikiReindexResourceSchema = z.object({
  active: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(z.object({ file_path: z.string(), message: z.string() }).strict())
}).strict();
export const wikiReindexValueSchema = runtimeWriteValueSchema(wikiReindexResourceSchema);
