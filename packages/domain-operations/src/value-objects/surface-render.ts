import { jsonValueSchema, ResourceRefSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";

const renderKinds = ["chat", "status_timeline", "form", "table", "chart", "graph_view", "artifact", "collection", "collection_record", "memory", "skill", "knowledge_wiki", "gateway", "run_history", "custom_view"] as const;

export const surfaceRenderSpecSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(renderKinds),
  priority: z.enum(["primary", "secondary", "background"]),
  state: z.enum(["ready", "loading", "empty", "error"]).optional(),
  title: z.string().optional(),
  resource_refs: z.array(ResourceRefSchema),
  props: z.record(jsonValueSchema),
  fallback: z.object({
    kind: z.enum(renderKinds),
    title: z.string().optional(),
    message: z.string(),
    props: z.record(jsonValueSchema).optional()
  }).strict().optional(),
  errors: z.array(z.object({ code: z.string().min(1), message: z.string(), retryable: z.boolean() }).strict()).optional(),
  negotiation: z.object({
    requested_kind: z.enum(renderKinds),
    requested_renderer: z.string().optional(),
    reason: z.enum(["unsupported_kind", "unsupported_custom_renderer", "invalid_fallback"]),
    applied_fallback: z.boolean()
  }).strict().optional()
}).strict();
