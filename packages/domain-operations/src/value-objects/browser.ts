import { z } from "zod";

export const browserPageSchema = z.object({
  url: z.string().min(1),
  title: z.string().optional(),
  html: z.string(),
  text: z.string(),
  adapter: z.enum(["playwright", "fetch"])
}).strict();

export const browserExtractValueSchema = z.object({ resource: browserPageSchema }).strict();

export const browserInteractionSchema = z.object({
  adapterId: z.string().min(1),
  url: z.string().min(1),
  title: z.string().optional(),
  text: z.string().optional()
}).strict();

export const browserScreenshotSchema = z.object({
  url: z.string().min(1),
  file_path: z.string().min(1),
  screenshot_ref: z.string().min(1),
  adapter_id: z.string().min(1),
  mime_type: z.enum(["image/png", "image/jpeg"]),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}).strict();

export const browserDownloadSchema = browserPageSchema.extend({
  file_path: z.string().min(1),
  snapshot_kind: z.literal("html_snapshot")
}).strict();
