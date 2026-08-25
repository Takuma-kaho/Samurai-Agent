import { z } from "zod";
import {
  createId,
  jsonValueSchema,
  supportedLocales,
  type ActivityInboxItem,
  type ApprovalRequest,
  type ArtifactRecord,
  type AuditRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type GatewayBoundaryPolicy,
  type GatewayInboundMessageRecord,
  type GatewayPairingRecord,
  type GatewayPairingPolicyRecord,
  type GatewayRoutingPolicyRecord,
  type JsonValue,
  type MemoryFrontmatter,
  type MessageRecord,
  type OperationRecord,
  type PolicyDecisionRecord,
  ResourceRefSchema,
  type ResourceRef,
  type SupportedLocale,
  SurfaceRendererRegistryEntrySchema,
  type SurfaceRendererRegistryEntry,
  type SessionRecord,
  type SettingsRecord,
  type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

export const socketEvents = [
  "session.created",
  "message.created",
  "operation.created",
  "policy.decided",
  "artifact.created",
  "memory.candidate.created",
  "approval.requested",
  "audit.recorded",
  "activity.updated",
  "backend.run.created",
  "backend.run.updated",
  "backend.event.created",
  "workspace.change.created",
  "gateway.pairing.requested",
  "gateway.pairing.updated",
  "gateway.inbound.blocked",
  "gateway.inbound.routed",
  "gateway.inbound.processed",
  "gateway.inbound.failed",
  "gateway.pairing_policy.saved",
  "gateway.routing_policy.saved",
  "gateway.boundary_policy.saved",
  "settings.updated"
] as const;

export type SocketEventName = (typeof socketEvents)[number];

export interface SocketEventPayloads {
  "session.created": SessionRecord;
  "message.created": MessageRecord;
  "operation.created": OperationRecord;
  "policy.decided": PolicyDecisionRecord;
  "artifact.created": ArtifactRecord;
  "memory.candidate.created": MemoryFrontmatter;
  "approval.requested": ApprovalRequest;
  "audit.recorded": AuditRecord;
  "activity.updated": ActivityInboxItem[];
  "backend.run.created": BackendRunRecord;
  "backend.run.updated": BackendRunRecord;
  "backend.event.created": BackendEventRecord;
  "workspace.change.created": WorkspaceChangeRecord;
  "gateway.pairing.requested": GatewayPairingRecord;
  "gateway.pairing.updated": GatewayPairingRecord;
  "gateway.inbound.blocked": GatewayInboundMessageRecord;
  "gateway.inbound.routed": GatewayInboundMessageRecord;
  "gateway.inbound.processed": GatewayInboundMessageRecord;
  "gateway.inbound.failed": GatewayInboundMessageRecord;
  "gateway.pairing_policy.saved": GatewayPairingPolicyRecord;
  "gateway.routing_policy.saved": GatewayRoutingPolicyRecord;
  "gateway.boundary_policy.saved": GatewayBoundaryPolicy;
  "settings.updated": SettingsRecord;
}

export interface RuntimeEvent<TName extends SocketEventName = SocketEventName> {
  name: TName;
  payload: SocketEventPayloads[TName];
}

export type RuntimeEventSink = <TName extends SocketEventName>(
  name: TName,
  payload: SocketEventPayloads[TName]
) => void | Promise<void>;

export const surfaceOperationKinds = [
  "message.submit",
  "form.submit",
  "table.patch",
  "chart.request",
  "artifact.request",
  "collection.view.present",
  "collection.record.create",
  "collection.record.patch",
  "collection.record.delete",
  "collection.action.run",
  "message.presentation.update",
  "custom_view.action"
] as const;

export type SurfaceOperationKind = (typeof surfaceOperationKinds)[number];

export interface SurfaceOperationBase {
  id: string;
  kind: SurfaceOperationKind;
  session_id?: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
  renderer_capabilities?: SurfaceRendererCapabilities;
  metadata?: Record<string, JsonValue>;
}

export interface MessageSubmitOperation extends SurfaceOperationBase {
  kind: "message.submit";
  content: string;
  backend_id?: string;
  attachments?: ResourceRef[];
}

export interface FormSubmitOperation extends SurfaceOperationBase {
  kind: "form.submit";
  form_id: string;
  values: Record<string, JsonValue>;
  submit_label?: string;
}

export interface TablePatchOperation extends SurfaceOperationBase {
  kind: "table.patch";
  table_id: string;
  row_id?: string;
  changes: Record<string, JsonValue>;
}

export interface ChartRequestOperation extends SurfaceOperationBase {
  kind: "chart.request";
  chart_id?: string;
  title: string;
  query: string;
  data_refs: string[];
}

export interface ArtifactRequestOperation extends SurfaceOperationBase {
  kind: "artifact.request";
  artifact_id?: string;
  action: "create" | "revise" | "export" | "preview";
  title?: string;
  instruction: string;
}

export interface CollectionViewPresentOperation extends SurfaceOperationBase {
  kind: "collection.view.present";
  collection_id: string;
  view_id?: string;
}

export interface CollectionRecordCreateOperation extends SurfaceOperationBase {
  kind: "collection.record.create";
  collection_id: string;
  record_id: string;
  data: Record<string, JsonValue>;
}

export interface CollectionRecordPatchOperation extends SurfaceOperationBase {
  kind: "collection.record.patch";
  collection_id: string;
  record_id: string;
  patch_id: string;
  expected_version?: number;
  changes: Record<string, JsonValue>;
}

export interface CollectionRecordDeleteOperation extends SurfaceOperationBase {
  kind: "collection.record.delete";
  collection_id: string;
  record_id: string;
  expected_version: number;
  view_id?: string;
}

export interface CollectionActionRunOperation extends SurfaceOperationBase {
  kind: "collection.action.run";
  collection_id: string;
  action_id: string;
  backend_id?: string;
  record_id?: string;
  view_id?: string;
  payload: Record<string, JsonValue>;
}

export interface MessagePresentationUpdateOperation extends SurfaceOperationBase {
  kind: "message.presentation.update";
  presentation_id: string;
  view_state: Record<string, JsonValue>;
}

export interface CustomViewActionOperation extends SurfaceOperationBase {
  kind: "custom_view.action";
  view_id: string;
  action_id: string;
  payload: Record<string, JsonValue>;
}

export type SurfaceOperation =
  | MessageSubmitOperation
  | FormSubmitOperation
  | TablePatchOperation
  | ChartRequestOperation
  | ArtifactRequestOperation
  | CollectionViewPresentOperation
  | CollectionRecordCreateOperation
  | CollectionRecordPatchOperation
  | CollectionRecordDeleteOperation
  | CollectionActionRunOperation
  | MessagePresentationUpdateOperation
  | CustomViewActionOperation;

export const surfaceRenderKinds = [
  "chat",
  "status_timeline",
  "form",
  "table",
  "chart",
  "graph_view",
  "artifact",
  "collection",
  "collection_record",
  "memory",
  "skill",
  "knowledge_wiki",
  "gateway",
  "run_history",
  "custom_view"
] as const;

export type SurfaceRenderKind = (typeof surfaceRenderKinds)[number];

export const builtinSurfaceRendererRegistryEntries: SurfaceRendererRegistryEntry[] = [
  {
    id: "surface.chat",
    kind: "chat",
    version: "1",
    title: "Chat",
    description: "Render a chat turn, backend run status, and related workspace feedback.",
    props_schema: { type: "object" },
    fallback_kind: "status_timeline",
    category: "chat"
  },
  {
    id: "surface.status_timeline",
    kind: "status_timeline",
    version: "1",
    title: "Status timeline",
    description: "Render ordered status and event items.",
    props_schema: { type: "object" },
    category: "run_history"
  },
  {
    id: "surface.graph_view",
    kind: "graph_view",
    version: "1",
    title: "Graph",
    description: "Render and edit a node and edge graph backed by an Artifact revision.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "artifact",
    category: "artifact"
  },
  {
    id: "surface.form",
    kind: "form",
    version: "1",
    title: "Form",
    description: "Render a structured form surface.",
    props_schema: { type: "object" },
    fallback_kind: "artifact",
    category: "input"
  },
  {
    id: "surface.table",
    kind: "table",
    version: "1",
    title: "Table",
    description: "Render rows and patchable table data.",
    props_schema: { type: "object" },
    fallback_kind: "artifact",
    category: "workspace"
  },
  {
    id: "surface.chart",
    kind: "chart",
    version: "1",
    title: "Chart",
    description: "Render chart or table-backed structured data.",
    props_schema: { type: "object" },
    fallback_kind: "artifact",
    category: "workspace"
  },
  {
    id: "surface.artifact",
    kind: "artifact",
    version: "1",
    title: "Artifact",
    description: "Render a workspace artifact by id or file path.",
    props_schema: { type: "object" },
    category: "workspace"
  },
  {
    id: "surface.collection",
    kind: "collection",
    version: "1",
    title: "Collection",
    description: "Render a Collection summary or list of record ids.",
    props_schema: { type: "object" },
    category: "collection"
  },
  {
    id: "surface.collection_record",
    kind: "collection_record",
    version: "1",
    title: "Collection record",
    description: "Render a schema-validated Collection record with resolved refs and embeds.",
    props_schema: { type: "object" },
    fallback_kind: "collection",
    category: "collection"
  },
  {
    id: "surface.memory",
    kind: "memory",
    version: "1",
    title: "Memory",
    description: "Render Memory resources or suggestions.",
    props_schema: { type: "object" },
    category: "memory"
  },
  {
    id: "surface.skill",
    kind: "skill",
    version: "1",
    title: "Skill",
    description: "Render Skill candidates or saved Skill resources.",
    props_schema: { type: "object" },
    category: "skill"
  },
  {
    id: "surface.knowledge_wiki",
    kind: "knowledge_wiki",
    version: "1",
    title: "Knowledge Wiki",
    description: "Render Knowledge Wiki pages or proposals.",
    props_schema: { type: "object" },
    category: "knowledge_wiki"
  },
  {
    id: "surface.gateway",
    kind: "gateway",
    version: "1",
    title: "Gateway",
    description: "Render Gateway status, pairing, routing, or boundary diagnostics.",
    props_schema: { type: "object" },
    category: "gateway"
  },
  {
    id: "surface.run_history",
    kind: "run_history",
    version: "1",
    title: "Run History",
    description: "Render backend run, event, tool, and workspace change history.",
    props_schema: { type: "object" },
    category: "run_history"
  },
  {
    id: "surface.custom_view.generic",
    kind: "custom_view",
    renderer: "generic",
    version: "1",
    title: "Generic custom view",
    description: "Render plugin or backend-defined custom view data with declared actions.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "artifact",
    category: "custom_view"
  },
  {
    id: "surface.custom_view.collection_table",
    kind: "custom_view",
    renderer: "collection_table",
    version: "1",
    title: "Collection table",
    description: "Render a user-created personal data app backed by a Collection.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "collection",
    category: "custom_view"
  },
  {
    id: "surface.custom_view.collection_gallery",
    kind: "custom_view",
    renderer: "collection_gallery",
    version: "1",
    title: "Collection gallery",
    description: "Render a Collection as card-like records backed by the same Collection data.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "collection",
    category: "custom_view"
  },
  {
    id: "surface.custom_view.calendar_view",
    kind: "custom_view",
    renderer: "calendar_view",
    version: "1",
    title: "Collection calendar",
    description: "Render a date-oriented Collection view backed by the same Collection data.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "collection",
    category: "custom_view"
  },
  {
    id: "surface.custom_view.collection_kanban",
    kind: "custom_view",
    renderer: "collection_kanban",
    version: "1",
    title: "Collection kanban",
    description: "Render an enum-grouped Collection view backed by the same Collection data.",
    props_schema: { type: "object" },
    actions_schema: { type: "array" },
    fallback_kind: "collection",
    category: "custom_view"
  }
];

for (const entry of builtinSurfaceRendererRegistryEntries) {
  SurfaceRendererRegistryEntrySchema.parse(entry);
}

export const surfaceRenderPriorities = ["primary", "secondary", "background"] as const;
export type SurfaceRenderPriority = (typeof surfaceRenderPriorities)[number];

export const surfaceRenderStates = ["ready", "loading", "empty", "error"] as const;
export type SurfaceRenderState = (typeof surfaceRenderStates)[number];

export interface SurfaceRenderError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface SurfaceRenderFallback {
  kind: SurfaceRenderKind;
  title?: string;
  message: string;
  props?: Record<string, JsonValue>;
}

export interface SurfaceRenderNegotiation {
  requested_kind: SurfaceRenderKind;
  requested_renderer?: string;
  reason: "unsupported_kind" | "unsupported_custom_renderer" | "invalid_fallback";
  applied_fallback: boolean;
}

export interface SurfaceRenderSpec {
  id: string;
  kind: SurfaceRenderKind;
  priority: SurfaceRenderPriority;
  state?: SurfaceRenderState;
  title?: string;
  resource_refs: ResourceRef[];
  props: Record<string, JsonValue>;
  fallback?: SurfaceRenderFallback;
  errors?: SurfaceRenderError[];
  negotiation?: SurfaceRenderNegotiation;
}

export interface SurfaceCustomRendererCapability {
  renderer: string;
  versions?: string[];
  schema_refs?: string[];
}

export interface SurfaceRendererCapabilities {
  protocol_version?: string;
  supported_kinds: SurfaceRenderKind[];
  custom_view_renderers?: SurfaceCustomRendererCapability[];
}

const SurfaceRenderErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean()
});

const SurfaceRenderFallbackSchema = z.object({
  kind: z.enum(surfaceRenderKinds),
  title: z.string().optional(),
  message: z.string(),
  props: z.record(jsonValueSchema).optional()
});

const SurfaceRenderNegotiationSchema = z.object({
  requested_kind: z.enum(surfaceRenderKinds),
  requested_renderer: z.string().optional(),
  reason: z.enum(["unsupported_kind", "unsupported_custom_renderer", "invalid_fallback"]),
  applied_fallback: z.boolean()
});

const SurfaceCustomRendererCapabilitySchema = z.object({
  renderer: z.string().min(1),
  versions: z.array(z.string().min(1)).optional(),
  schema_refs: z.array(z.string().min(1)).optional()
});

export const SurfaceRendererCapabilitiesSchema = z.object({
  protocol_version: z.string().optional(),
  supported_kinds: z.array(z.enum(surfaceRenderKinds)).min(1),
  custom_view_renderers: z.array(SurfaceCustomRendererCapabilitySchema).optional()
}) satisfies z.ZodType<SurfaceRendererCapabilities>;

const SurfaceRenderBaseShape = {
  id: z.string().min(1),
  priority: z.enum(surfaceRenderPriorities),
  state: z.enum(surfaceRenderStates).optional().default("ready"),
  title: z.string().optional(),
  resource_refs: z.array(ResourceRefSchema),
  fallback: SurfaceRenderFallbackSchema.optional(),
  errors: z.array(SurfaceRenderErrorSchema).optional(),
  negotiation: SurfaceRenderNegotiationSchema.optional()
};

const jsonProps = <TShape extends z.ZodRawShape>(shape: TShape) =>
  z.object(shape).catchall(jsonValueSchema);

const ChatRenderPropsSchema = jsonProps({
  session_id: z.string().min(1),
  backend_run_id: z.string().min(1),
  backend_status: z.string().min(1),
  message_ids: z.array(z.string()),
  primary_message_id: z.string().nullable(),
  artifact_ids: z.array(z.string()),
  memory_ids: z.array(z.string()),
  reflection_suggestion_ids: z.array(z.string())
});

const StatusTimelineRenderPropsSchema = jsonProps({
  run_id: z.string().optional(),
  status: z.string().min(1),
  event_ids: z.array(z.string())
});

const FormRenderPropsSchema = jsonProps({
  form_id: z.string().min(1),
  fields: z.array(z.object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["text", "textarea", "number", "select", "checkbox", "date", "datetime", "file", "hidden"]),
    required: z.boolean().optional(),
    options: z.array(z.object({
      label: z.string(),
      value: jsonValueSchema
    })).optional(),
    default_value: jsonValueSchema.optional()
  })),
  submit_label: z.string().optional(),
  operation_kind: z.enum(surfaceOperationKinds).optional()
});

const TableRenderPropsSchema = jsonProps({
  table_id: z.string().min(1),
  columns: z.array(z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(["text", "number", "boolean", "date", "datetime", "json"]).optional()
  })),
  rows: z.array(z.record(jsonValueSchema)),
  patchable: z.boolean().optional(),
  collection_id: z.string().optional()
});

const ChartRenderPropsSchema = jsonProps({
  chart_id: z.string().min(1),
  chart_type: z.enum(["bar", "line", "area", "pie", "scatter", "table"]),
  data_refs: z.array(z.string()),
  data: z.array(z.record(jsonValueSchema)).optional()
});

const ArtifactRenderPropsSchema = jsonProps({
  artifact_id: z.string().min(1),
  file_path: z.string().optional(),
  title: z.string().optional(),
  mime_type: z.string().optional()
});

const CollectionRenderPropsSchema = jsonProps({
  collection_id: z.string().min(1),
  schema_id: z.string().optional(),
  record_ids: z.array(z.string())
});

const CollectionRecordRenderPropsSchema = jsonProps({
  collection_id: z.string().min(1),
  record_id: z.string().min(1),
  file_path: z.string().optional(),
  data: z.record(jsonValueSchema).optional(),
  record_resource_refs: z.array(ResourceRefSchema).optional(),
  resolved_refs: z.array(z.object({
    ref_id: z.string().min(1),
    field: z.string().min(1),
    target_collection_id: z.string().min(1),
    target_record_id: z.string().min(1),
    record: z.object({
      id: z.string().min(1),
      collection_id: z.string().min(1),
      data: z.record(jsonValueSchema),
      resource_refs: z.array(ResourceRefSchema),
      created_at: z.string().datetime(),
      updated_at: z.string().datetime(),
      file_path: z.string().optional()
    }).catchall(jsonValueSchema),
    resource_ref: ResourceRefSchema
  })).optional(),
  missing_refs: z.array(z.object({
    ref_id: z.string().min(1),
    field: z.string().min(1),
    target_collection_id: z.string().min(1),
    target_record_id: z.string().optional(),
    reason: z.enum(["empty", "invalid", "not_found"])
  })).optional(),
  embed_fields: z.array(z.object({
    embed_id: z.string().min(1),
    field: z.string().min(1),
    value: jsonValueSchema
  })).optional()
});

const MemoryRenderPropsSchema = jsonProps({
  memory_ids: z.array(z.string())
});

const SkillRenderPropsSchema = jsonProps({
  skill_ids: z.array(z.string()),
  disclosure_level: z.enum(["catalog", "body", "support"]).optional()
});

const KnowledgeWikiRenderPropsSchema = jsonProps({
  wiki_ids: z.array(z.string()),
  active_only: z.boolean().optional()
});

const GatewayRenderPropsSchema = jsonProps({
  status: z.string().optional(),
  pairing_id: z.string().optional(),
  inbound_id: z.string().optional(),
  boundary_policy_id: z.string().optional()
});

const RunHistoryRenderPropsSchema = jsonProps({
  run_ids: z.array(z.string()),
  selected_run_id: z.string().optional()
});

const CustomViewSandboxSchema = z.object({
  mode: z.enum(["iframe"]),
  allow_scripts: z.boolean(),
  allow_forms: z.boolean(),
  allow_same_origin: z.boolean(),
  network_access: z.enum(["none", "read"]),
  workspace_access: z.enum(["none", "read", "write"])
});

const CustomViewCapabilitySchema = z.object({
  token_id: z.string().min(1),
  allowed_actions: z.array(z.string().min(1)),
  read_resource_refs: z.array(ResourceRefSchema),
  write_operations: z.array(z.enum(surfaceOperationKinds)),
  /** External network is a separate capability from rendering HTML. */
  network_access: z.enum(["none", "read"]).optional(),
  data_url: z.string().optional(),
  data_capabilities: z.array(z.enum(["read", "write"])).optional()
});

const CustomViewRenderPropsSchema = jsonProps({
  view_id: z.string().min(1),
  renderer: z.string().min(1),
  renderer_version: z.string().optional(),
  schema_ref: z.string().optional(),
  sandbox: CustomViewSandboxSchema.optional(),
  capability: CustomViewCapabilitySchema.optional(),
  actions: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    operation_kind: z.enum(surfaceOperationKinds).optional(),
    action_kind: z.string().optional(),
    description: z.string().optional(),
    scope: z.enum(["collection", "record"]).optional()
  })).optional(),
  data: jsonValueSchema.optional()
});

export const SurfaceRenderSpecSchema = z.discriminatedUnion("kind", [
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("chat"), props: ChatRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("status_timeline"), props: StatusTimelineRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("form"), props: FormRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("table"), props: TableRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("chart"), props: ChartRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("artifact"), props: ArtifactRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("collection"), props: CollectionRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("collection_record"), props: CollectionRecordRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("memory"), props: MemoryRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("skill"), props: SkillRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("knowledge_wiki"), props: KnowledgeWikiRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("gateway"), props: GatewayRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("run_history"), props: RunHistoryRenderPropsSchema }),
  z.object({ ...SurfaceRenderBaseShape, kind: z.literal("custom_view"), props: CustomViewRenderPropsSchema })
]) satisfies z.ZodType<SurfaceRenderSpec>;

export function createSurfaceRenderSpec(input: Omit<SurfaceRenderSpec, "id"> & { id?: string }): SurfaceRenderSpec {
  return SurfaceRenderSpecSchema.parse({
    ...input,
    id: input.id ?? createId("render")
  });
}

export function parseSurfaceRendererCapabilities(value: unknown): SurfaceRendererCapabilities | undefined {
  const parsed = SurfaceRendererCapabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function negotiateSurfaceRenderSpec(
  spec: SurfaceRenderSpec,
  capabilities?: SurfaceRendererCapabilities
): SurfaceRenderSpec {
  if (!capabilities) {
    return spec;
  }

  const reason = unsupportedRenderReason(spec, capabilities);
  if (!reason) {
    return spec;
  }

  const negotiatedFallback = renderFallbackAsSpec(spec, reason);
  if (
    negotiatedFallback &&
    capabilities.supported_kinds.includes(negotiatedFallback.kind) &&
    !unsupportedRenderReason(negotiatedFallback, capabilities)
  ) {
    return negotiatedFallback;
  }

  return createSurfaceRenderSpec({
    id: spec.id,
    kind: "status_timeline",
    priority: spec.priority,
    state: "error",
    title: spec.title ?? "Unsupported surface",
    resource_refs: spec.resource_refs,
    props: {
      status: "renderer_unsupported",
      event_ids: [],
      requested_kind: spec.kind,
      requested_renderer: customRendererName(spec) ?? null
    },
    errors: [{
      code: "renderer_unsupported",
      message: `Renderer is not supported by this frontend: ${spec.kind}`,
      retryable: false
    }],
    negotiation: {
      requested_kind: spec.kind,
      requested_renderer: customRendererName(spec),
      reason: negotiatedFallback ? "invalid_fallback" : reason,
      applied_fallback: false
    }
  });
}

function renderFallbackAsSpec(
  spec: SurfaceRenderSpec,
  reason: SurfaceRenderNegotiation["reason"]
): SurfaceRenderSpec | undefined {
  if (!spec.fallback) {
    return undefined;
  }
  const candidate = SurfaceRenderSpecSchema.safeParse({
    id: spec.id,
    kind: spec.fallback.kind,
    priority: spec.priority,
    state: spec.state,
    title: spec.fallback.title ?? spec.title,
    resource_refs: spec.resource_refs,
    props: spec.fallback.props ?? {},
    errors: spec.errors,
    negotiation: {
      requested_kind: spec.kind,
      requested_renderer: customRendererName(spec),
      reason,
      applied_fallback: true
    }
  });
  return candidate.success ? candidate.data : undefined;
}

function unsupportedRenderReason(
  spec: SurfaceRenderSpec,
  capabilities: SurfaceRendererCapabilities
): SurfaceRenderNegotiation["reason"] | undefined {
  if (!capabilities.supported_kinds.includes(spec.kind)) {
    return "unsupported_kind";
  }
  if (spec.kind !== "custom_view") {
    return undefined;
  }
  const renderer = customRendererName(spec);
  if (!renderer || renderer === "generic") {
    return undefined;
  }
  const rendererVersion = typeof spec.props.renderer_version === "string" ? spec.props.renderer_version : undefined;
  const supported = capabilities.custom_view_renderers?.some((entry) => {
    if (entry.renderer !== renderer) {
      return false;
    }
    return !rendererVersion || !entry.versions || entry.versions.includes(rendererVersion);
  });
  return supported ? undefined : "unsupported_custom_renderer";
}

function customRendererName(spec: SurfaceRenderSpec): string | undefined {
  if (spec.kind !== "custom_view") {
    return undefined;
  }
  return typeof spec.props.renderer === "string" ? spec.props.renderer : undefined;
}

export const surfaceOperationResultKinds = [
  "chat_turn",
  "collection_view",
  "collection_record",
  "collection_patch",
  "collection_delete",
  "collection_action",
  "message_presentation",
  "artifact",
  "form_submission",
  "table_patch",
  "chart_request",
  "custom_view_action"
] as const;

export type SurfaceOperationResultKind = (typeof surfaceOperationResultKinds)[number];

export const surfaceOperationDispatchTargets = [
  "host_chat",
  "collection_engine",
  "artifact_pipeline"
] as const;

export type SurfaceOperationDispatchTarget = (typeof surfaceOperationDispatchTargets)[number];

export interface SurfaceOperationDispatchPlan {
  operation_id: string;
  operation_kind: SurfaceOperationKind;
  dispatch_target: SurfaceOperationDispatchTarget;
  runtime_method: string;
  operation_name: string;
  result_kind: SurfaceOperationResultKind;
  render_kind: SurfaceRenderKind;
  requires_session: boolean;
  writes_workspace: boolean;
  output_resource_kind: string;
  proposed_effects: string[];
}

export interface SurfaceOperationResultEnvelope<TResult = unknown> {
  operation: SurfaceOperation;
  result_kind: SurfaceOperationResultKind;
  render_spec: SurfaceRenderSpec;
  render_specs?: SurfaceRenderSpec[];
  result: TResult;
}

export const SurfaceOperationDispatchPlanSchema = z.object({
  operation_id: z.string().min(1),
  operation_kind: z.enum(surfaceOperationKinds),
  dispatch_target: z.enum(surfaceOperationDispatchTargets),
  runtime_method: z.string().min(1),
  operation_name: z.string().min(1),
  result_kind: z.enum(surfaceOperationResultKinds),
  render_kind: z.enum(surfaceRenderKinds),
  requires_session: z.boolean(),
  writes_workspace: z.boolean(),
  output_resource_kind: z.string().min(1),
  proposed_effects: z.array(z.string())
});

const SupportedLocaleSurfaceSchema = z.enum(supportedLocales);
const SurfaceOperationBaseShape = {
  id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  input_locale: SupportedLocaleSurfaceSchema.optional(),
  output_locale: SupportedLocaleSurfaceSchema.optional(),
  renderer_capabilities: SurfaceRendererCapabilitiesSchema.optional(),
  metadata: z.record(jsonValueSchema).optional()
};

const RawSurfaceOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("message.submit"),
    content: z.string().trim().min(1),
    backend_id: z.string().min(1).optional(),
    attachments: z.array(ResourceRefSchema).optional().default([])
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("form.submit"),
    form_id: z.string().min(1),
    values: z.record(jsonValueSchema),
    submit_label: z.string().optional()
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("table.patch"),
    table_id: z.string().min(1),
    row_id: z.string().min(1).optional(),
    changes: z.record(jsonValueSchema)
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("chart.request"),
    chart_id: z.string().min(1).optional(),
    title: z.string().min(1),
    query: z.string().min(1),
    data_refs: z.array(z.string()).optional().default([])
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("artifact.request"),
    artifact_id: z.string().min(1).optional(),
    action: z.enum(["create", "revise", "export", "preview"]),
    title: z.string().optional(),
    instruction: z.string().min(1)
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("collection.view.present"),
    collection_id: z.string().min(1),
    view_id: z.string().min(1).optional()
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("collection.record.create"),
    collection_id: z.string().min(1),
    record_id: z.string().min(1),
    data: z.record(jsonValueSchema)
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("collection.record.patch"),
    collection_id: z.string().min(1),
    record_id: z.string().min(1),
    patch_id: z.string().min(1).optional(),
    expected_version: z.number().int().positive().optional(),
    changes: z.record(jsonValueSchema)
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("collection.record.delete"),
    collection_id: z.string().min(1),
    record_id: z.string().min(1),
    expected_version: z.number().int().positive(),
    view_id: z.string().min(1).optional()
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("collection.action.run"),
    collection_id: z.string().min(1),
    action_id: z.string().min(1),
    backend_id: z.string().min(1).optional(),
    record_id: z.string().min(1).optional(),
    view_id: z.string().min(1).optional(),
    payload: z.record(jsonValueSchema).optional().default({})
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("message.presentation.update"),
    presentation_id: z.string().min(1),
    view_state: z.record(jsonValueSchema)
  }),
  z.object({
    ...SurfaceOperationBaseShape,
    kind: z.literal("custom_view.action"),
    view_id: z.string().min(1),
    action_id: z.string().min(1),
    payload: z.record(jsonValueSchema).optional().default({})
  })
]);

export const SurfaceOperationSchema: z.ZodType<SurfaceOperation> = RawSurfaceOperationSchema.transform((operation) => {
  if (operation.kind === "collection.record.patch") {
    return {
      ...operation,
      id: operation.id ?? createId("surface"),
      patch_id: operation.patch_id ?? createId("collection_patch")
    };
  }
  return {
    ...operation,
    id: operation.id ?? createId("surface")
  };
}) as z.ZodType<SurfaceOperation>;

export function parseSurfaceOperation(value: unknown): SurfaceOperation | undefined {
  const parsed = SurfaceOperationSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
