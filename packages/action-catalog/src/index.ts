import {
  ActionCatalogEntrySchema,
  PluginManifestSchema,
  nowIso,
  type ActionCatalogEntry,
  type DomainCommandCatalogDiagnosticIssue,
  type DomainCommandCatalogDiagnosticsReport,
  type JsonValue,
  type PluginManifest,
  type SurfaceRendererRegistryEntry
} from "@samurai-agent/core-schemas";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const domainCommandInputSources = [
  "surface_operation",
  "provider_tool_call",
  "runtime_api",
  "gateway_inbound",
  "automation",
  "scheduled_context"
] as const;

export type DomainCommandInputSource = (typeof domainCommandInputSources)[number];

export const domainCommandOutputRenderKinds = [
  "chat",
  "status_timeline",
  "form",
  "table",
  "chart",
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

export type DomainCommandOutputRenderKind = (typeof domainCommandOutputRenderKinds)[number];

export interface DomainCommandEntry {
  id: string;
  title: string;
  description: string;
  runtime_method: string;
  handler_id: string;
  implementation_target: string;
  ui_display_category: string;
  input_sources: DomainCommandInputSource[];
  surface_operation_kinds?: string[];
  provider_tool_names?: string[];
  writes_workspace: boolean;
  output_resource_kind: string;
  output_render_kinds: DomainCommandOutputRenderKind[];
  resource_kinds: string[];
  proposed_effects: string[];
}

function command(input: Omit<DomainCommandEntry, "handler_id" | "implementation_target" | "output_render_kinds"> & {
  handler_id?: string;
  implementation_target?: string;
  output_render_kinds?: DomainCommandOutputRenderKind[];
}): DomainCommandEntry {
  return {
    ...input,
    handler_id: input.handler_id ?? `runtime.${input.id}`,
    implementation_target: input.implementation_target ?? (input.id === "chat.turn.run" ? "host" : "runtime"),
    output_render_kinds: input.output_render_kinds ?? defaultOutputRenderKinds(input)
  };
}

function defaultOutputRenderKinds(input: Pick<DomainCommandEntry, "id" | "ui_display_category" | "output_resource_kind">): DomainCommandOutputRenderKind[] {
  switch (input.output_resource_kind) {
    case "backend_run":
      return ["chat"];
    case "artifact":
      return ["artifact"];
    case "memory":
      return ["memory"];
    case "skill":
    case "skill_support_file":
      return ["skill"];
    case "wiki":
    case "wiki_index":
      return ["knowledge_wiki"];
    case "collection_schema":
    case "collection_index":
      return ["collection"];
    case "collection_record":
      return ["collection_record"];
    case "gateway_inbound":
      return ["gateway"];
    case "reflection_suggestion":
      return ["memory", "knowledge_wiki", "skill"];
    default:
      return ["status_timeline"];
  }
}

export const domainCommandEntries: DomainCommandEntry[] = [
  command({
    id: "chat.turn.run",
    title: "Run chat turn",
    description: "Route a user message through Host context assembly and the selected Backend cassette.",
    runtime_method: "runChatTurn",
    ui_display_category: "chat",
    input_sources: ["surface_operation", "runtime_api", "gateway_inbound", "automation"],
    surface_operation_kinds: ["message.submit"],
    writes_workspace: false,
    output_resource_kind: "backend_run",
    resource_kinds: ["backend_run", "message"],
    proposed_effects: ["Route the message through Host context assembly and a BackendRun."]
  }),
  command({
    id: "artifact.create",
    title: "Create artifact",
    description: "Create a local workspace artifact from backend, UI, or generated surface output.",
    runtime_method: "runStructuredSurfaceOperation",
    ui_display_category: "artifact",
    input_sources: ["surface_operation", "provider_tool_call", "runtime_api"],
    surface_operation_kinds: ["form.submit", "table.patch", "chart.request", "artifact.request", "custom_view.action"],
    provider_tool_names: ["create_artifact"],
    writes_workspace: true,
    output_resource_kind: "artifact",
    output_render_kinds: ["artifact", "form", "table", "chart", "custom_view"],
    resource_kinds: ["artifact"],
    proposed_effects: ["Create a local workspace artifact draft."]
  }),
  command({
    id: "memory.session.create",
    title: "Create session memory",
    description: "Keep the current turn as session-scoped memory.",
    runtime_method: "runChatTurn",
    ui_display_category: "memory",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "memory",
    resource_kinds: ["memory"],
    proposed_effects: ["Keep the current user intent in session memory."]
  }),
  command({
    id: "memory.topic.create",
    title: "Create topic memory",
    description: "Create a visible topic memory candidate.",
    runtime_method: "createTopicMemory",
    ui_display_category: "memory",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["remember_topic"],
    writes_workspace: true,
    output_resource_kind: "memory",
    resource_kinds: ["memory"],
    proposed_effects: ["Create a visible topic memory candidate."]
  }),
  command({
    id: "memory.archive",
    title: "Archive memory",
    description: "Archive a memory item without physically deleting it.",
    runtime_method: "archiveMemory",
    ui_display_category: "memory",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "memory",
    resource_kinds: ["memory"],
    proposed_effects: ["Archive a memory item so it leaves normal memory views."]
  }),
  command({
    id: "skill.candidate.create",
    title: "Create skill candidate",
    description: "Create a reusable Skill candidate from a reflection or backend pattern.",
    runtime_method: "saveSkillCandidate",
    ui_display_category: "skill",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "skill",
    resource_kinds: ["skill"],
    proposed_effects: ["Create a local Skill candidate markdown file."]
  }),
  command({
    id: "skill.project.save",
    title: "Save project skill",
    description: "Save a promoted project Skill markdown file.",
    runtime_method: "saveSkillProject",
    ui_display_category: "skill",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "skill",
    resource_kinds: ["skill"],
    proposed_effects: ["Save a promoted project Skill markdown file."]
  }),
  command({
    id: "skill.support_file.save",
    title: "Save skill support file",
    description: "Save a support file for a local Skill.",
    runtime_method: "saveSkillSupportFile",
    ui_display_category: "skill",
    input_sources: ["runtime_api", "provider_tool_call"],
    writes_workspace: true,
    output_resource_kind: "skill_support_file",
    resource_kinds: ["skill", "skill_support_file"],
    proposed_effects: ["Save a support file for a local Skill."]
  }),
  command({
    id: "skill.lifecycle.apply",
    title: "Apply skill lifecycle action",
    description: "Apply a curator lifecycle transition to a local Skill.",
    runtime_method: "applyCuratorSkillAction",
    ui_display_category: "skill",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "skill",
    resource_kinds: ["skill"],
    proposed_effects: ["Apply a curator lifecycle transition to a local Skill."]
  }),
  command({
    id: "wiki.proposal.create",
    title: "Create Knowledge Wiki proposal",
    description: "Create a proposed Knowledge Wiki page with provenance.",
    runtime_method: "createWikiProposal",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "wiki",
    resource_kinds: ["wiki"],
    proposed_effects: ["Create a proposed Knowledge Wiki markdown page."]
  }),
  command({
    id: "wiki.accept",
    title: "Accept Knowledge Wiki page",
    description: "Accept a proposed Knowledge Wiki page for active retrieval.",
    runtime_method: "acceptWikiPage",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "wiki",
    resource_kinds: ["wiki"],
    proposed_effects: ["Accept a Knowledge Wiki page for active retrieval."]
  }),
  command({
    id: "wiki.reject",
    title: "Reject Knowledge Wiki page",
    description: "Reject a proposed Knowledge Wiki page without deleting its markdown.",
    runtime_method: "rejectWikiPage",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "wiki",
    resource_kinds: ["wiki"],
    proposed_effects: ["Reject a Knowledge Wiki page without deleting its markdown."]
  }),
  command({
    id: "wiki.patch",
    title: "Patch Knowledge Wiki page",
    description: "Edit Knowledge Wiki frontmatter or markdown content.",
    runtime_method: "patchWikiPage",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "wiki",
    resource_kinds: ["wiki"],
    proposed_effects: ["Edit Knowledge Wiki frontmatter or markdown content."]
  }),
  command({
    id: "wiki.archive",
    title: "Archive Knowledge Wiki page",
    description: "Archive a Knowledge Wiki page without deleting its markdown.",
    runtime_method: "archiveWikiPage",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "wiki",
    resource_kinds: ["wiki"],
    proposed_effects: ["Archive a Knowledge Wiki page without deleting its markdown."]
  }),
  command({
    id: "wiki.reindex",
    title: "Reindex Knowledge Wiki",
    description: "Refresh the Knowledge Wiki SQLite index from markdown pages.",
    runtime_method: "reindexWiki",
    ui_display_category: "knowledge_wiki",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "wiki_index",
    resource_kinds: ["wiki", "wiki_index"],
    proposed_effects: ["Refresh the Knowledge Wiki SQLite index from markdown pages."]
  }),
  command({
    id: "collection.schema.save",
    title: "Save collection schema",
    description: "Save a Collection schema to the local workspace.",
    runtime_method: "saveCollectionSchema",
    ui_display_category: "collection",
    input_sources: ["runtime_api", "provider_tool_call"],
    provider_tool_names: ["samurai.collection.schema.save", "collection.schema.save", "save_collection_schema", "mcp__samurai__collection_schema_save"],
    writes_workspace: true,
    output_resource_kind: "collection_schema",
    resource_kinds: ["collection_schema"],
    proposed_effects: ["Create a Collection schema file and SQLite index row."]
  }),
  command({
    id: "collection.view.present",
    title: "Present collection view",
    description: "Regenerate a Collection view render spec from current schema, records, actions, and permissions.",
    runtime_method: "presentCollectionView",
    ui_display_category: "collection",
    input_sources: ["surface_operation", "runtime_api", "provider_tool_call"],
    provider_tool_names: ["samurai.collection.view.present", "present_collection", "mcp__samurai__collection_view_present"],
    surface_operation_kinds: ["collection.view.present"],
    writes_workspace: false,
    output_resource_kind: "collection_view",
    output_render_kinds: ["collection", "custom_view"],
    resource_kinds: ["collection_schema", "collection_record"],
    proposed_effects: ["Return a current Collection view render spec without rebuilding it in the frontend."]
  }),
  command({
    id: "collection.record.create",
    title: "Create collection record",
    description: "Create a schema-validated Collection record.",
    runtime_method: "createCollectionRecord",
    ui_display_category: "collection",
    input_sources: ["surface_operation", "runtime_api", "scheduled_context"],
    surface_operation_kinds: ["collection.record.create"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    resource_kinds: ["collection_record"],
    proposed_effects: ["Create a schema-validated Collection record and return a Collection record render spec."]
  }),
  command({
    id: "collection.patch.apply",
    title: "Apply collection patch",
    description: "Patch a schema-validated Collection record.",
    runtime_method: "applyCollectionPatch",
    ui_display_category: "collection",
    input_sources: ["surface_operation", "runtime_api", "scheduled_context"],
    surface_operation_kinds: ["collection.record.patch"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    resource_kinds: ["collection_record"],
    proposed_effects: ["Apply a schema-validated Collection patch and return the updated Collection record render spec."]
  }),
  command({
    id: "collection.record.delete",
    title: "Delete collection record",
    description: "Delete a Collection record through Runtime permission checks.",
    runtime_method: "deleteCollectionRecord",
    ui_display_category: "collection",
    input_sources: ["surface_operation", "runtime_api"],
    surface_operation_kinds: ["collection.record.delete"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    output_render_kinds: ["collection_record", "collection", "custom_view"],
    resource_kinds: ["collection_record"],
    proposed_effects: ["Delete a schema-validated Collection record when schema and view permissions allow it."]
  }),
  command({
    id: "message.presentation.update",
    title: "Update message presentation state",
    description: "Persist card-local UI state for a chat message presentation.",
    runtime_method: "updateMessagePresentationViewState",
    ui_display_category: "chat",
    input_sources: ["surface_operation", "runtime_api"],
    surface_operation_kinds: ["message.presentation.update"],
    writes_workspace: false,
    output_resource_kind: "message_presentation",
    output_render_kinds: ["chat", "custom_view"],
    resource_kinds: ["message_presentation", "collection_schema"],
    proposed_effects: ["Persist the current view state for a chat card."]
  }),
  command({
    id: "collection.action.run",
    title: "Run collection action",
    description: "Run a schema-defined Collection action such as patch, create, or reindex.",
    runtime_method: "runCollectionAction",
    ui_display_category: "collection",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    output_render_kinds: ["collection_record", "collection", "status_timeline"],
    resource_kinds: ["collection_record", "collection_index"],
    proposed_effects: ["Run a schema-defined Collection action through the runtime boundary."]
  }),
  command({
    id: "collection.reindex",
    title: "Reindex collections",
    description: "Refresh Collection SQLite indexes from schema and record files.",
    runtime_method: "reindexCollections",
    ui_display_category: "collection",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "collection_index",
    resource_kinds: ["collection_schema", "collection_record", "collection_index"],
    proposed_effects: ["Refresh Collection SQLite indexes from schema and record files."]
  }),
  command({
    id: "file.read",
    title: "Read workspace file",
    description: "Read a file inside the local workspace.",
    runtime_method: "runFileAction",
    ui_display_category: "workspace",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["file.read"],
    writes_workspace: false,
    output_resource_kind: "file",
    resource_kinds: ["file"],
    proposed_effects: ["Read a file inside the local workspace."]
  }),
  command({
    id: "file.list",
    title: "List workspace files",
    description: "List files inside the local workspace.",
    runtime_method: "runFileAction",
    ui_display_category: "workspace",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["file.list"],
    writes_workspace: false,
    output_resource_kind: "file",
    resource_kinds: ["file"],
    proposed_effects: ["List files inside the local workspace."]
  }),
  command({
    id: "file.write",
    title: "Write workspace file",
    description: "Write a file inside the local workspace.",
    runtime_method: "runFileAction",
    ui_display_category: "workspace",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["file.write"],
    writes_workspace: true,
    output_resource_kind: "file",
    resource_kinds: ["file"],
    proposed_effects: ["Write a file inside the local workspace."]
  }),
  command({
    id: "file.patch",
    title: "Patch workspace file",
    description: "Patch a file inside the local workspace.",
    runtime_method: "runFileAction",
    ui_display_category: "workspace",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["file.patch"],
    writes_workspace: true,
    output_resource_kind: "file",
    resource_kinds: ["file"],
    proposed_effects: ["Patch a file inside the local workspace."]
  }),
  command({
    id: "rollback.restore",
    title: "Restore rollback point",
    description: "Restore a reversible local workspace snapshot.",
    runtime_method: "restoreRollbackPoint",
    ui_display_category: "run_history",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "rollback_point",
    resource_kinds: ["rollback_point", "file"],
    proposed_effects: ["Restore a reversible local workspace snapshot from a rollback point."]
  }),
  command({
    id: "browser.navigate",
    title: "Navigate browser page",
    description: "Navigate or fetch a browser-readable page for workspace use.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.navigate"],
    writes_workspace: false,
    output_resource_kind: "browser_page",
    resource_kinds: ["browser_page"],
    proposed_effects: ["Read a browser page without mutating external state."]
  }),
  command({
    id: "browser.extract",
    title: "Extract browser page",
    description: "Extract text from a browser-readable page.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.extract"],
    writes_workspace: false,
    output_resource_kind: "browser_page",
    resource_kinds: ["browser_page"],
    proposed_effects: ["Extract text from a browser-readable page."]
  }),
  command({
    id: "browser.screenshot",
    title: "Capture browser snapshot",
    description: "Capture browser-readable content into the workspace fallback adapter.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.screenshot"],
    writes_workspace: true,
    output_resource_kind: "file",
    resource_kinds: ["browser_page", "file"],
    proposed_effects: ["Capture browser-readable content into the workspace."]
  }),
  command({
    id: "browser.download_to_workspace",
    title: "Download browser page",
    description: "Download browser-readable content into the local workspace.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.download_to_workspace"],
    writes_workspace: true,
    output_resource_kind: "file",
    resource_kinds: ["browser_page", "file"],
    proposed_effects: ["Download browser-readable content into the local workspace."]
  }),
  command({
    id: "external.send",
    title: "Prepare outbound send",
    description: "Plan an outbound send request without dispatching it.",
    runtime_method: "createOperationPlan",
    ui_display_category: "external",
    input_sources: ["provider_tool_call", "runtime_api"],
    writes_workspace: true,
    output_resource_kind: "external_send",
    resource_kinds: ["external_send"],
    proposed_effects: ["Prepare an outbound action. No external effect is executed in v1."]
  }),
  command({
    id: "external.send.prepare",
    title: "Prepare external send draft",
    description: "Prepare an outbound send draft without dispatching it.",
    runtime_method: "prepareExternalSend",
    ui_display_category: "external",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["request_external_send", "external.send.prepare"],
    writes_workspace: true,
    output_resource_kind: "external_send",
    resource_kinds: ["external_send"],
    proposed_effects: ["Create an outbound send draft without dispatching."]
  }),
  command({
    id: "external.send.dispatch",
    title: "Dispatch external send",
    description: "Dispatch a prepared outbound send after approval.",
    runtime_method: "dispatchExternalSend",
    ui_display_category: "external",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["external.send.dispatch"],
    writes_workspace: true,
    output_resource_kind: "external_send",
    resource_kinds: ["external_send"],
    proposed_effects: ["Dispatch a prepared outbound send after approval."]
  }),
  command({
    id: "workspace.delete",
    title: "Request workspace delete",
    description: "Prepare a delete operation for a workspace resource.",
    runtime_method: "createOperationPlan",
    ui_display_category: "workspace",
    input_sources: ["provider_tool_call"],
    provider_tool_names: ["request_delete"],
    writes_workspace: true,
    output_resource_kind: "workspace_resource",
    resource_kinds: ["workspace_resource"],
    proposed_effects: ["Prepare a delete operation. No deletion is executed in v1."]
  }),
  command({
    id: "gateway.inbound.route",
    title: "Route gateway inbound",
    description: "Route an approved external inbound message into a Host session.",
    runtime_method: "runGatewayInbound",
    ui_display_category: "gateway",
    input_sources: ["gateway_inbound"],
    writes_workspace: true,
    output_resource_kind: "gateway_inbound",
    output_render_kinds: ["chat", "gateway"],
    resource_kinds: ["gateway_inbound", "backend_run"],
    proposed_effects: ["Route an approved external inbound message into a Host session."]
  }),
  command({
    id: "sandbox.exec",
    title: "Execute sandbox command",
    description: "Execute a sandbox command inside the Gateway boundary.",
    runtime_method: "handleSandboxExecToolCall",
    ui_display_category: "gateway",
    input_sources: ["provider_tool_call"],
    provider_tool_names: ["sandbox.exec"],
    writes_workspace: true,
    output_resource_kind: "sandbox_execution",
    resource_kinds: ["sandbox_execution", "gateway_sandbox_instance", "file"],
    proposed_effects: ["Execute a sandbox command inside the Gateway boundary."]
  }),
  command({
    id: "mcp.call",
    title: "Call MCP tool",
    description: "Call an MCP tool through stored Gateway MCP configuration.",
    runtime_method: "handleMcpToolCall",
    ui_display_category: "gateway",
    input_sources: ["provider_tool_call"],
    provider_tool_names: ["mcp.call"],
    writes_workspace: true,
    output_resource_kind: "mcp_tool",
    resource_kinds: ["mcp_server", "mcp_tool"],
    proposed_effects: ["Call an MCP tool through the Gateway boundary."]
  }),
  command({
    id: "automation.job.save",
    title: "Save automation job",
    description: "Save an automation job definition.",
    runtime_method: "saveAutomationJob",
    ui_display_category: "automation",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "automation_job",
    resource_kinds: ["automation_job"],
    proposed_effects: ["Save an automation job definition."]
  }),
  command({
    id: "automation.job.run",
    title: "Run automation job",
    description: "Run an enabled automation job through scheduled context.",
    runtime_method: "runAutomationJob",
    ui_display_category: "automation",
    input_sources: ["automation", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "automation_run",
    resource_kinds: ["automation_job", "automation_run"],
    proposed_effects: ["Run an enabled automation job through scheduled context."]
  }),
  command({
    id: "automation.memory_review.run",
    title: "Run memory review",
    description: "Run the scheduled memory review automation.",
    runtime_method: "runMemoryReviewAutomation",
    ui_display_category: "automation",
    input_sources: ["automation", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "reflection_run",
    resource_kinds: ["automation_run", "reflection_run", "memory"],
    proposed_effects: ["Run the scheduled memory review automation."]
  }),
  command({
    id: "reflection.suggestion.apply",
    title: "Apply reflection suggestion",
    description: "Apply a visible reflection suggestion to Memory, Knowledge Wiki, or Skill.",
    runtime_method: "applyReflectionSuggestion",
    ui_display_category: "memory",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["reflection.suggestion.apply"],
    writes_workspace: true,
    output_resource_kind: "reflection_suggestion",
    resource_kinds: ["reflection_suggestion", "memory", "wiki", "skill"],
    proposed_effects: ["Apply a visible reflection suggestion to a reusable workspace resource."]
  }),
  command({
    id: "grant.create",
    title: "Create grant",
    description: "Create an owner-scoped grant for a capability operation.",
    runtime_method: "createGrant",
    ui_display_category: "settings",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "grant",
    resource_kinds: ["grant"],
    proposed_effects: ["Create an owner-scoped grant for a capability operation."]
  }),
  command({
    id: "grant.revoke",
    title: "Revoke grant",
    description: "Revoke an existing capability grant.",
    runtime_method: "revokeGrant",
    ui_display_category: "settings",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "grant",
    resource_kinds: ["grant"],
    proposed_effects: ["Revoke an existing capability grant."]
  })
];

export const actionCatalogEntries: ActionCatalogEntry[] = domainCommandEntries.map((entry) => ({
  id: entry.id,
  title: entry.title,
  display_name: entry.title,
  description: entry.description,
  input_schema: { type: "object" },
  output_schema: {
    type: "object",
    properties: {
      render_spec: { type: "object" },
      render_specs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { enum: entry.output_render_kinds }
          }
        }
      }
    },
    "x-samurai-render-kinds": entry.output_render_kinds
  },
  resource_kinds: entry.resource_kinds,
  handler_id: entry.handler_id,
  implementation_target: entry.implementation_target,
  ui_display_category: entry.ui_display_category
}));

export function getDomainCommandEntry(id: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.id === id);
}

export function requireDomainCommandEntry(id: string): DomainCommandEntry {
  const entry = getDomainCommandEntry(id);
  if (!entry) {
    throw new Error(`Unknown domain command: ${id}`);
  }
  return entry;
}

export function listDomainCommandEntries(source?: DomainCommandInputSource): DomainCommandEntry[] {
  return source
    ? domainCommandEntries.filter((entry) => entry.input_sources.includes(source))
    : [...domainCommandEntries];
}

export function getDomainCommandForSurfaceOperationKind(kind: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.surface_operation_kinds?.includes(kind));
}

export function getDomainCommandForProviderToolName(name: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.provider_tool_names?.includes(name));
}

export function getDomainCommandCatalogDiagnostics(): DomainCommandCatalogDiagnosticsReport {
  const issues: DomainCommandCatalogDiagnosticIssue[] = [];
  const commandIds = new Map<string, string>();
  const providerToolNames = new Map<string, string>();
  const surfaceOperationKinds = new Map<string, string>();
  const actionEntries = new Map(actionCatalogEntries.map((entry) => [entry.id, entry]));
  const standardRenderKinds = new Set(domainCommandOutputRenderKinds);

  for (const entry of domainCommandEntries) {
    addDuplicateIssue(issues, commandIds, entry.id, entry.id, "duplicate_command_id", "Domain Command id is declared more than once.");

    if (entry.input_sources.length === 0) {
      issues.push({
        code: "empty_input_sources",
        command_id: entry.id,
        message: "Domain Command must declare at least one input source."
      });
    }
    if (entry.resource_kinds.length === 0) {
      issues.push({
        code: "empty_resource_kinds",
        command_id: entry.id,
        message: "Domain Command must declare at least one resource kind."
      });
    }
    if (entry.proposed_effects.length === 0) {
      issues.push({
        code: "empty_proposed_effects",
        command_id: entry.id,
        message: "Domain Command must describe proposed effects for UI and diagnostics."
      });
    }
    for (const renderKind of entry.output_render_kinds) {
      if (!standardRenderKinds.has(renderKind)) {
        issues.push({
          code: "invalid_output_render_kind",
          command_id: entry.id,
          reference: renderKind,
          message: "Domain Command output render kind is not part of the standard render kind set."
        });
      }
    }
    for (const providerToolName of entry.provider_tool_names ?? []) {
      addDuplicateIssue(issues, providerToolNames, providerToolName, entry.id, "duplicate_provider_tool_name", "Provider tool name maps to more than one Domain Command.");
    }
    for (const surfaceOperationKind of entry.surface_operation_kinds ?? []) {
      addDuplicateIssue(issues, surfaceOperationKinds, surfaceOperationKind, entry.id, "duplicate_surface_operation_kind", "Surface operation kind maps to more than one Domain Command.");
    }

    const actionEntry = actionEntries.get(entry.id);
    if (!actionEntry) {
      issues.push({
        code: "missing_action_catalog_entry",
        command_id: entry.id,
        message: "Domain Command is missing from the ActionCatalog mirror."
      });
      continue;
    }
    const actionRenderKinds = actionRenderKindContract(actionEntry);
    if (
      actionEntry.handler_id !== entry.handler_id
      || actionEntry.implementation_target !== entry.implementation_target
      || actionEntry.ui_display_category !== entry.ui_display_category
      || !sameStringSet(actionEntry.resource_kinds, entry.resource_kinds)
      || !sameStringSet(actionRenderKinds, entry.output_render_kinds)
    ) {
      issues.push({
        code: "action_catalog_mismatch",
        command_id: entry.id,
        message: "ActionCatalog entry no longer mirrors the Domain Command contract."
      });
    }
  }

  return {
    ok: issues.length === 0,
    generated_at: nowIso(),
    coverage: {
      commands: domainCommandEntries.length,
      action_catalog_entries: actionCatalogEntries.length,
      provider_tool_mappings: providerToolNames.size,
      surface_operation_mappings: surfaceOperationKinds.size,
      render_kinds: [...standardRenderKinds],
      input_sources: [...domainCommandInputSources]
    },
    issues,
    recommendation: issues.length
      ? "Fix Domain Command catalog diagnostics before wiring new runtime, provider, Gateway, or frontend entrypoints."
      : "Domain Command catalog, ActionCatalog mirror, provider tool aliases, surface operation aliases, and render kind declarations are internally consistent."
  };
}

function addDuplicateIssue(
  issues: DomainCommandCatalogDiagnosticIssue[],
  seen: Map<string, string>,
  reference: string,
  commandId: string,
  code: DomainCommandCatalogDiagnosticIssue["code"],
  message: string
): void {
  const existing = seen.get(reference);
  if (!existing) {
    seen.set(reference, commandId);
    return;
  }
  issues.push({
    code,
    command_id: commandId,
    reference,
    message: `${message} Existing command: ${existing}.`
  });
}

function actionRenderKindContract(entry: ActionCatalogEntry): string[] {
  const value = entry.output_schema["x-samurai-render-kinds"];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const values = new Set(a);
  return b.every((item) => values.has(item));
}

export const pluginManifests: PluginManifest[] = [
  {
    id: "samurai-workspace-core",
    name: "Samurai Workspace Core",
    version: "1.0.0",
    kind: "tool",
    actions: actionCatalogEntries,
    resource_kinds: [...new Set(actionCatalogEntries.flatMap((entry) => entry.resource_kinds))],
    metadata: {
      built_in: true
    }
  }
];

for (const entry of actionCatalogEntries) {
  ActionCatalogEntrySchema.parse(entry);
}

for (const manifest of pluginManifests) {
  PluginManifestSchema.parse(manifest);
}

export function getActionCatalogEntry(id: string): ActionCatalogEntry | undefined {
  return actionCatalogEntries.find((entry) => entry.id === id);
}

export function listActionCatalogEntries(category?: string): ActionCatalogEntry[] {
  return category
    ? actionCatalogEntries.filter((entry) => entry.ui_display_category === category)
    : [...actionCatalogEntries];
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return pluginManifests.find((manifest) => manifest.id === id);
}

export interface PluginManifestLoadIssue {
  file_path: string;
  code:
    | "invalid_manifest"
    | "duplicate_manifest"
    | "duplicate_action"
    | "duplicate_renderer"
    | "read_failed"
    | "entrypoint_missing"
    | "entrypoint_outside_plugin"
    | "entrypoint_integrity_mismatch"
    | "entrypoint_unsigned"
    | "signature_invalid"
    | "signature_untrusted"
    | "entrypoint_load_failed"
    | "invalid_entrypoint_module";
  message: string;
}

export interface PluginTrustedSigningKey {
  key_id: string;
  public_key: string;
}

export interface PluginManifestLoadOptions {
  trustedSigningKeys?: PluginTrustedSigningKey[];
  requireSignature?: boolean;
}

export type PluginEntrypointStatus =
  | "not_declared"
  | "ready"
  | "missing"
  | "outside_plugin"
  | "integrity_mismatch";

export type PluginSignatureStatus =
  | "not_declared"
  | "trusted"
  | "untrusted_key"
  | "invalid";

export interface PluginRuntimeBinding {
  manifest_id: string;
  manifest_file_path: string;
  plugin_dir: string;
  entrypoint?: string;
  entrypoint_path?: string;
  entrypoint_sha256?: string;
  expected_entrypoint_sha256?: string;
  entrypoint_status: PluginEntrypointStatus;
  signature_status: PluginSignatureStatus;
  signature_key_id?: string;
  action_ids: string[];
  handler_ids: string[];
  renderer_ids: string[];
}

export interface PluginManifestLoadResult {
  manifests: PluginManifest[];
  actions: ActionCatalogEntry[];
  renderers: SurfaceRendererRegistryEntry[];
  bindings: PluginRuntimeBinding[];
  issues: PluginManifestLoadIssue[];
}

export interface PluginActionHandlerInput {
  action: ActionCatalogEntry;
  manifest?: PluginManifest;
  input: Record<string, JsonValue>;
  context?: Record<string, JsonValue>;
}

export interface PluginActionHandlerOutput {
  status: "completed" | "failed";
  output?: JsonValue;
  error?: string;
}

export type PluginActionHandler = (input: PluginActionHandlerInput) => Promise<PluginActionHandlerOutput> | PluginActionHandlerOutput;

export interface PluginRuntimeStatus {
  manifest_id: string;
  name: string;
  version: string;
  kind: PluginManifest["kind"];
  source: "built_in" | "filesystem";
  manifest_file_path?: string;
  plugin_dir?: string;
  entrypoint?: string;
  entrypoint_path?: string;
  entrypoint_status: PluginEntrypointStatus;
  signature_status: PluginSignatureStatus;
  action_ids: string[];
  renderer_ids: string[];
  handler_ids: string[];
  registered_handler_ids: string[];
  missing_handler_ids: string[];
}

export interface PluginEntrypointLoadOptions {
  allowUnsigned?: boolean;
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface PluginEntrypointLoadResult {
  loaded: Array<{
    manifest_id: string;
    entrypoint_path: string;
    registered_handler_ids: string[];
  }>;
  issues: PluginManifestLoadIssue[];
}

export class PluginRuntimeRegistry {
  private readonly actions = new Map<string, ActionCatalogEntry>();
  private readonly renderers = new Map<string, SurfaceRendererRegistryEntry>();
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly manifestsByAction = new Map<string, PluginManifest>();
  private readonly runtimeBindings = new Map<string, PluginRuntimeBinding>();
  private readonly handlers = new Map<string, PluginActionHandler>();

  constructor(catalog: PluginManifestLoadResult | { manifests: PluginManifest[]; actions: ActionCatalogEntry[]; renderers?: SurfaceRendererRegistryEntry[]; bindings?: PluginRuntimeBinding[] } = { manifests: pluginManifests, actions: actionCatalogEntries }) {
    for (const action of catalog.actions) {
      this.actions.set(action.id, action);
    }
    for (const renderer of catalog.renderers ?? catalog.manifests.flatMap((manifest) => manifest.renderers ?? [])) {
      this.renderers.set(renderer.id, renderer);
    }
    for (const manifest of catalog.manifests) {
      this.manifests.set(manifest.id, manifest);
      for (const action of manifest.actions) {
        this.manifestsByAction.set(action.id, manifest);
      }
    }
    for (const binding of catalog.bindings ?? []) {
      this.runtimeBindings.set(binding.manifest_id, binding);
    }
  }

  registerHandler(handlerId: string, handler: PluginActionHandler): void {
    this.handlers.set(handlerId, handler);
  }

  getAction(actionId: string): ActionCatalogEntry | undefined {
    return this.actions.get(actionId);
  }

  listActions(category?: string): ActionCatalogEntry[] {
    const actions = [...this.actions.values()];
    return category ? actions.filter((action) => action.ui_display_category === category) : actions;
  }

  listRenderers(): SurfaceRendererRegistryEntry[] {
    return [...this.renderers.values()];
  }

  listPluginStatuses(): PluginRuntimeStatus[] {
    return [...this.manifests.values()].map((manifest) => {
      const binding = this.runtimeBindings.get(manifest.id);
      const handlerIds = uniqueStrings(manifest.actions.map((action) => action.handler_id));
      const registeredHandlerIds = handlerIds.filter((handlerId) => this.handlers.has(handlerId));
      return {
        manifest_id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        source: manifest.metadata.built_in === true ? "built_in" : "filesystem",
        manifest_file_path: binding?.manifest_file_path,
        plugin_dir: binding?.plugin_dir,
        entrypoint: binding?.entrypoint,
        entrypoint_path: binding?.entrypoint_path,
        entrypoint_status: binding?.entrypoint_status ?? "not_declared",
        signature_status: binding?.signature_status ?? "not_declared",
        action_ids: manifest.actions.map((action) => action.id),
        renderer_ids: manifest.renderers?.map((renderer) => renderer.id) ?? [],
        handler_ids: handlerIds,
        registered_handler_ids: registeredHandlerIds,
        missing_handler_ids: handlerIds.filter((handlerId) => !this.handlers.has(handlerId))
      };
    });
  }

  hasRegisteredHandler(actionId: string): boolean {
    const action = this.actions.get(actionId);
    return action ? this.handlers.has(action.handler_id) : false;
  }

  async executeAction(actionId: string, input: Record<string, JsonValue>, context?: Record<string, JsonValue>): Promise<PluginActionHandlerOutput & { action_id: string; handler_id?: string }> {
    const action = this.actions.get(actionId);
    if (!action) {
      return { action_id: actionId, status: "failed", error: "action_not_found" };
    }
    const handler = this.handlers.get(action.handler_id);
    if (!handler) {
      return { action_id: actionId, handler_id: action.handler_id, status: "failed", error: "handler_not_registered" };
    }
    const result = await handler({
      action,
      manifest: this.manifestsByAction.get(action.id),
      input,
      context
    });
    return { action_id: actionId, handler_id: action.handler_id, ...result };
  }

  async loadEntrypoints(options: PluginEntrypointLoadOptions = {}): Promise<PluginEntrypointLoadResult> {
    const issues: PluginManifestLoadIssue[] = [];
    const loaded: PluginEntrypointLoadResult["loaded"] = [];
    const importModule = options.importModule ?? nativeDynamicImport;

    for (const binding of this.runtimeBindings.values()) {
      if (!binding.entrypoint || !binding.entrypoint_path || binding.entrypoint_status !== "ready") {
        continue;
      }
      if (binding.signature_status !== "trusted" && options.allowUnsigned !== true) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "entrypoint_unsigned",
          message: `plugin entrypoint ${binding.entrypoint} is not signed by a trusted key`
        });
        continue;
      }
      const manifest = this.manifests.get(binding.manifest_id);
      if (!manifest) {
        continue;
      }
      let moduleExports: unknown;
      try {
        moduleExports = await importModule(pathToFileURL(binding.entrypoint_path).href);
      } catch (error) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "entrypoint_load_failed",
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const registeredHandlerIds = await this.registerEntrypointModuleHandlers(moduleExports, manifest, binding).catch((error) => {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "invalid_entrypoint_module",
          message: error instanceof Error ? error.message : String(error)
        });
        return [];
      });
      if (registeredHandlerIds.length === 0) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "invalid_entrypoint_module",
          message: `plugin entrypoint did not register handlers for manifest ${binding.manifest_id}`
        });
        continue;
      }
      loaded.push({
        manifest_id: binding.manifest_id,
        entrypoint_path: binding.entrypoint_path,
        registered_handler_ids: registeredHandlerIds
      });
    }

    return { loaded, issues };
  }

  private async registerEntrypointModuleHandlers(moduleExports: unknown, manifest: PluginManifest, binding: PluginRuntimeBinding): Promise<string[]> {
    const moduleRecord = asRecord(moduleExports);
    const defaultRecord = asRecord(moduleRecord?.default);
    const register = firstFunction(moduleRecord?.register, moduleRecord?.registerPlugin, defaultRecord?.register, defaultRecord?.registerPlugin);
    const before = new Set(this.handlers.keys());
    if (register) {
      await register(this, { manifest, binding });
    }
    const handlers = asRecord(moduleRecord?.handlers) ?? asRecord(defaultRecord?.handlers) ?? {};
    for (const [handlerId, handler] of Object.entries(handlers)) {
      if (binding.handler_ids.includes(handlerId) && typeof handler === "function") {
        this.registerHandler(handlerId, handler as PluginActionHandler);
      }
    }
    return uniqueStrings(binding.handler_ids.filter((handlerId) => this.handlers.has(handlerId) && !before.has(handlerId)));
  }
}

const nativeDynamicImport = (specifier: string): Promise<unknown> => {
  return import(/* @vite-ignore */ specifier);
};

export async function loadPluginManifests(rootDir: string, options: PluginManifestLoadOptions = {}): Promise<PluginManifestLoadResult> {
  const manifestPaths = await findPluginManifestFiles(rootDir);
  const issues: PluginManifestLoadIssue[] = [];
  const manifests: PluginManifest[] = [...pluginManifests];
  const actions: ActionCatalogEntry[] = [...actionCatalogEntries];
  const renderers: SurfaceRendererRegistryEntry[] = manifests.flatMap((manifest) => manifest.renderers ?? []);
  const bindings: PluginRuntimeBinding[] = [];
  const manifestIds = new Set(manifests.map((manifest) => manifest.id));
  const actionIds = new Set(actions.map((action) => action.id));
  const rendererIds = new Set(renderers.map((renderer) => renderer.id));

  for (const manifestPath of manifestPaths) {
    const relativePath = path.relative(rootDir, manifestPath) || manifestPath;
    const raw = await readFile(manifestPath, "utf8").catch((error) => {
      issues.push({
        file_path: relativePath,
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    });
    if (raw === undefined) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      issues.push({
        file_path: relativePath,
        code: "invalid_manifest",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const parsed = PluginManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      issues.push({
        file_path: relativePath,
        code: "invalid_manifest",
        message: parsed.error.message
      });
      continue;
    }
    const manifest = parsed.data;
    if (manifestIds.has(manifest.id)) {
      issues.push({
        file_path: relativePath,
        code: "duplicate_manifest",
        message: `duplicate plugin manifest id: ${manifest.id}`
      });
      continue;
    }
    const uniqueActions: ActionCatalogEntry[] = [];
    for (const action of manifest.actions) {
      if (actionIds.has(action.id)) {
        issues.push({
          file_path: relativePath,
          code: "duplicate_action",
          message: `duplicate action id: ${action.id}`
        });
        continue;
      }
      actionIds.add(action.id);
      uniqueActions.push(action);
    }
    manifestIds.add(manifest.id);
    const uniqueRenderers: SurfaceRendererRegistryEntry[] = [];
    for (const renderer of manifest.renderers ?? []) {
      if (rendererIds.has(renderer.id)) {
        issues.push({
          file_path: relativePath,
          code: "duplicate_renderer",
          message: `duplicate renderer id: ${renderer.id}`
        });
        continue;
      }
      rendererIds.add(renderer.id);
      uniqueRenderers.push(renderer);
    }
    const filteredManifest = { ...manifest, actions: uniqueActions, ...(manifest.renderers ? { renderers: uniqueRenderers } : {}) };
    const binding = await buildPluginRuntimeBinding(rootDir, manifestPath, relativePath, filteredManifest, issues, options);
    manifests.push(filteredManifest);
    actions.push(...uniqueActions);
    renderers.push(...uniqueRenderers);
    bindings.push(binding);
  }

  return { manifests, actions, renderers, bindings, issues };
}

async function findPluginManifestFiles(rootDir: string): Promise<string[]> {
  const direct = path.join(rootDir, ".codex-plugin", "plugin.json");
  const pluginsDir = path.join(rootDir, "plugins");
  const candidates = [direct];
  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    candidates.push(path.join(pluginsDir, entry.name, "plugin.json"));
    candidates.push(path.join(pluginsDir, entry.name, ".codex-plugin", "plugin.json"));
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing.sort((left, right) => left.localeCompare(right));
}

async function fileExists(filePath: string): Promise<boolean> {
  return readFile(filePath).then(() => true, () => false);
}

async function buildPluginRuntimeBinding(
  rootDir: string,
  manifestPath: string,
  relativePath: string,
  manifest: PluginManifest,
  issues: PluginManifestLoadIssue[],
  options: PluginManifestLoadOptions
): Promise<PluginRuntimeBinding> {
  const pluginDir = pluginRootForManifestPath(manifestPath);
  const binding: PluginRuntimeBinding = {
    manifest_id: manifest.id,
    manifest_file_path: relativePath,
    plugin_dir: path.relative(rootDir, pluginDir) || ".",
    entrypoint: manifest.entrypoint,
    entrypoint_status: manifest.entrypoint ? "missing" : "not_declared",
    signature_status: "not_declared",
    signature_key_id: pluginSignatureMetadata(manifest)?.key_id,
    action_ids: manifest.actions.map((action) => action.id),
    handler_ids: uniqueStrings(manifest.actions.map((action) => action.handler_id)),
    renderer_ids: manifest.renderers?.map((renderer) => renderer.id) ?? []
  };

  const signature = verifyPluginManifestSignature(manifest, options.trustedSigningKeys ?? []);
  binding.signature_status = signature.status;
  if (signature.key_id) {
    binding.signature_key_id = signature.key_id;
  }
  if (options.requireSignature && signature.status !== "trusted") {
    issues.push({
      file_path: relativePath,
      code: signature.status === "invalid" ? "signature_invalid" : "signature_untrusted",
      message: `plugin manifest ${manifest.id} is not signed by a trusted key`
    });
  }

  if (!manifest.entrypoint) {
    return binding;
  }

  const resolved = resolvePluginEntrypointPath(pluginDir, manifest.entrypoint);
  if (!resolved) {
    binding.entrypoint_status = "outside_plugin";
    issues.push({
      file_path: relativePath,
      code: "entrypoint_outside_plugin",
      message: `plugin entrypoint must be a relative path inside ${binding.plugin_dir}`
    });
    return binding;
  }
  binding.entrypoint_path = resolved;
  const entrypointContent = await readFile(resolved).catch(() => undefined);
  if (!entrypointContent) {
    binding.entrypoint_status = "missing";
    issues.push({
      file_path: relativePath,
      code: "entrypoint_missing",
      message: `plugin entrypoint not found: ${manifest.entrypoint}`
    });
    return binding;
  }
  const actualHash = createHash("sha256").update(entrypointContent).digest("hex");
  binding.entrypoint_sha256 = actualHash;
  const expectedHash = entrypointExpectedHash(manifest);
  if (expectedHash) {
    binding.expected_entrypoint_sha256 = expectedHash;
    if (expectedHash !== actualHash) {
      binding.entrypoint_status = "integrity_mismatch";
      issues.push({
        file_path: relativePath,
        code: "entrypoint_integrity_mismatch",
        message: `plugin entrypoint sha256 mismatch for ${manifest.entrypoint}`
      });
      return binding;
    }
  }
  binding.entrypoint_status = "ready";
  return binding;
}

function pluginRootForManifestPath(manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath);
  return path.basename(manifestDir) === ".codex-plugin" ? path.dirname(manifestDir) : manifestDir;
}

function resolvePluginEntrypointPath(pluginDir: string, entrypoint: string): string | undefined {
  if (path.isAbsolute(entrypoint) || entrypoint.includes("://")) {
    return undefined;
  }
  const resolved = path.resolve(pluginDir, entrypoint);
  const relative = path.relative(pluginDir, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}

function entrypointExpectedHash(manifest: PluginManifest): string | undefined {
  const metadata = asRecord(manifest.metadata);
  const value = typeof metadata?.entrypoint_sha256 === "string"
    ? metadata.entrypoint_sha256
    : typeof metadata?.entrypoint_integrity === "string"
      ? metadata.entrypoint_integrity
      : undefined;
  if (!value) {
    return undefined;
  }
  return value.startsWith("sha256-") ? value.slice("sha256-".length) : value;
}

interface PluginSignatureMetadata {
  algorithm: "ed25519";
  key_id: string;
  signature: string;
}

function pluginSignatureMetadata(manifest: PluginManifest): PluginSignatureMetadata | undefined {
  const metadata = asRecord(manifest.metadata);
  const raw = asRecord(metadata?.plugin_signature);
  if (!raw) {
    return undefined;
  }
  if (raw.algorithm !== "ed25519" || typeof raw.key_id !== "string" || typeof raw.signature !== "string") {
    return undefined;
  }
  return {
    algorithm: "ed25519",
    key_id: raw.key_id,
    signature: raw.signature
  };
}

function verifyPluginManifestSignature(manifest: PluginManifest, trustedKeys: PluginTrustedSigningKey[]): { status: PluginSignatureStatus; key_id?: string } {
  const signature = pluginSignatureMetadata(manifest);
  if (!signature) {
    return { status: "not_declared" };
  }
  const trustedKey = trustedKeys.find((key) => key.key_id === signature.key_id);
  if (!trustedKey) {
    return { status: "untrusted_key", key_id: signature.key_id };
  }
  try {
    const publicKey = createPublicKey(trustedKey.public_key);
    const payload = Buffer.from(createPluginManifestSignaturePayload(manifest), "utf8");
    const ok = verifySignature(null, payload, publicKey, Buffer.from(signature.signature, "base64"));
    return { status: ok ? "trusted" : "invalid", key_id: signature.key_id };
  } catch {
    return { status: "invalid", key_id: signature.key_id };
  }
}

export function createPluginManifestSignaturePayload(manifest: PluginManifest): string {
  const metadata = { ...asRecord(manifest.metadata) };
  delete metadata.plugin_signature;
  return stableJsonStringify({ ...manifest, metadata });
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstFunction(...values: unknown[]): ((...args: unknown[]) => unknown) | undefined {
  return values.find((value): value is (...args: unknown[]) => unknown => typeof value === "function");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
