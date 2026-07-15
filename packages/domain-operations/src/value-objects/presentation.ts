import { z } from "zod";
import { domainJsonValueSchema } from "../definition/index.js";
import { surfaceRenderSpecSchema } from "./surface-render.js";

export const messagePresentationRecordSchema = z.object({
  id: z.string().min(1),
  session_id: z.string().min(1),
  message_id: z.string().min(1),
  kind: z.enum(["collection_app", "generated_surface", "skill_optimization"]),
  title: z.string(),
  subtitle: z.string(),
  collection_id: z.string(),
  view_id: z.string(),
  renderer: z.string(),
  view_state: z.record(domainJsonValueSchema).optional(),
  surface_id: z.string().optional(),
  revision_id: z.string().optional(),
  preview_url: z.string().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime()
}).strict();

export const messagePresentationUpdateValueSchema = z.object({
  presentation: messagePresentationRecordSchema,
  render_spec: surfaceRenderSpecSchema,
  render_specs: z.array(surfaceRenderSpecSchema)
}).strict();
