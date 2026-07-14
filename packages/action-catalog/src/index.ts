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
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const domainCommandInputSources = [
  "surface_operation",
  "provider_tool_call",
  "runtime_api",
  "gateway_inbound",
  "automation",
  "generated_surface",
  "scheduled_context"
] as const;

export type DomainCommandInputSource = (typeof domainCommandInputSources)[number];

export const domainCommandOutputRenderKinds = [
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
  input_schema: Record<string, JsonValue>;
}

function command(input: Omit<DomainCommandEntry, "handler_id" | "implementation_target" | "output_render_kinds" | "input_schema"> & {
  handler_id?: string;
  implementation_target?: string;
  output_render_kinds?: DomainCommandOutputRenderKind[];
  input_schema?: Record<string, JsonValue>;
}): DomainCommandEntry {
  return {
    ...input,
    handler_id: input.handler_id ?? `runtime.${input.id}`,
    implementation_target: input.implementation_target ?? (input.id === "chat.turn.run" ? "host" : "runtime"),
    output_render_kinds: input.output_render_kinds ?? defaultOutputRenderKinds(input),
    input_schema: input.input_schema ?? defaultDomainCommandInputSchema(input.id)
  };
}

function defaultDomainCommandInputSchema(commandId: string): Record<string, JsonValue> {
  const object = (properties: Record<string, JsonValue>, required: string[] = []): Record<string, JsonValue> => ({
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {})
  });
  switch (commandId) {
    case "chat.turn.run":
      return object({ session_id: { type: "string" }, content: { type: "string" }, backend_id: { type: "string" }, input_locale: { type: "string" }, output_locale: { type: "string" } }, ["content"]);
    case "artifact.create":
      return object({ title: { type: "string" }, content: { type: "string" }, instruction: { type: "string" }, kind: { type: "string" }, metadata: { type: "object" } }, ["title", "content"]);
    case "memory.topic.create":
      return object({ topic: { type: "string" }, topic_kind: { type: "string" }, content: { type: "string" }, metadata: { type: "object" } }, ["content"]);
    case "external.send.prepare":
      return object({ channel: { type: "string" }, target: { type: "object" }, title: { type: "string" }, body: { type: "string" }, content: { type: "string" }, summary: { type: "string" } });
    case "workspace.delete":
      return object({ target: { type: "string" }, reason: { type: "string" } });
    case "skill.view":
      return object({ skill_id: { type: "string" }, path: { type: "string" } }, ["skill_id"]);
    case "collection.schema.save":
      return object({ id: { type: "string" }, version: { type: "string" }, labels: { type: "object" }, descriptions: { type: "object" }, fields: { type: "array" }, refs: { type: "array" }, embeds: { type: "array" }, derived_fields: { type: "array" }, triggers: { type: "array" }, actions: { type: "array" }, views: { type: "array" }, permissions: { type: "object" } }, ["id", "version", "fields", "permissions"]);
    case "collection.record.create":
      return object({ collection_id: { type: "string" }, id: { type: "string" }, record_id: { type: "string" }, data: { type: "object" }, resource_refs: { type: "array" } }, ["collection_id", "data"]);
    case "collection.patch.apply":
      return object({ collection_id: { type: "string" }, record_id: { type: "string" }, patch_id: { type: "string" }, expected_version: { type: "integer", minimum: 1 }, changes: { type: "object" } }, ["collection_id", "record_id", "expected_version", "changes"]);
    case "collection.view.present":
      return object({ collection_id: { type: "string" }, query: { type: "string" }, view_id: { type: "string" }, record_id: { type: "string" } }, ["collection_id"]);
    case "collection.manage":
      return object({ action: { type: "string", enum: ["getItems", "putItems", "schemaDocs", "getSchema", "putSchema", "patchSchema"] }, collection_id: { type: "string" }, slug: { type: "string" }, ids: { type: "array", items: { type: "string" } }, fields: { type: "array", items: { type: "string" } }, items: { type: "array", items: { type: "object" } }, mode: { type: "string", enum: ["create", "upsert", "merge"] }, schema: { type: "object" }, patches: { type: "array" }, view_id: { type: "string" } }, ["action"]);
    case "generated_surface.create":
      return object({ session_id: { type: "string" }, title: { type: "string" }, html: { type: "string" }, css: { type: "string" }, script: { type: "string" }, actions: { type: "array" }, assets: { type: "array" }, input_data_schema: { type: "object" } }, ["title", "html"]);
    case "generated_surface.revise":
      return object({ session_id: { type: "string" }, surface_id: { type: "string" }, title: { type: "string" }, html: { type: "string" }, css: { type: "string" }, script: { type: "string" }, actions: { type: "array" }, assets: { type: "array" }, input_data_schema: { type: "object" } }, ["surface_id", "html"]);
    case "generated_surface.state":
      return object({ surface_id: { type: "string" }, action: { type: "string", enum: ["pin", "unpin", "archive"] } }, ["surface_id", "action"]);
    case "generated_surface.action.run":
      return object({ surface_id: { type: "string" }, revision_id: { type: "string" }, interaction_id: { type: "string" }, action_id: { type: "string" }, action_payload: { type: "object" } }, ["surface_id", "action_id"]);
    case "generated_surface.export":
      return object({ surface_id: { type: "string" }, revision_id: { type: "string" }, format: { type: "string", enum: ["html", "zip"] } }, ["surface_id"]);
    case "skill.optimization.start":
      return object({ session_id: { type: "string" }, skill_id: { type: "string" }, golden_examples: { type: "array" }, synthetic_examples: { type: "array" }, objective: { type: "string" } }, ["skill_id"]);
    case "skill.optimization.cancel":
      return object({ run_id: { type: "string" } }, ["run_id"]);
    case "skill.optimization.promote":
      return object({ run_id: { type: "string" }, candidate_id: { type: "string" } }, ["run_id", "candidate_id"]);
    case "skill.optimization.reject":
      return object({ run_id: { type: "string" }, candidate_id: { type: "string" } }, ["run_id", "candidate_id"]);
    case "skill.optimization.rollback":
      return object({ promotion_id: { type: "string" }, snapshot_id: { type: "string" } });
    default:
      return { type: "object", additionalProperties: true };
  }
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
  command({ id: "session.create", title: "Create session", description: "Create a persistent Chat session.", runtime_method: "createSession", ui_display_category: "chat", input_sources: ["runtime_api", "surface_operation", "gateway_inbound", "automation"], writes_workspace: true, output_resource_kind: "session", resource_kinds: ["session"], proposed_effects: ["Create a persistent Chat session."] }),
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
    provider_tool_names: ["create_artifact", "samurai.artifact.create", "mcp__samurai__artifact_create"],
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
  command({ id: "skill.patch", title: "Edit Skill", description: "Edit a Skill body and metadata through the Runtime boundary.", runtime_method: "patchSkill", ui_display_category: "skill", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], writes_workspace: true, output_resource_kind: "skill", output_render_kinds: ["skill"], resource_kinds: ["skill"], proposed_effects: ["Update a Skill body and metadata with history and rollback evidence."] }),
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
    description: "Save a Collection schema with validated fields and Workspace view definitions.",
    runtime_method: "saveCollectionSchema",
    ui_display_category: "collection",
    input_sources: ["runtime_api", "provider_tool_call"],
    provider_tool_names: ["samurai.collection.schema.save", "collection.schema.save", "save_collection_schema", "mcp__samurai__collection_schema_save"],
    writes_workspace: true,
    output_resource_kind: "collection_schema",
    resource_kinds: ["collection_schema"],
    proposed_effects: ["Create a Collection schema file, renderer view definitions, and SQLite index row."]
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
    input_sources: ["surface_operation", "runtime_api", "provider_tool_call", "scheduled_context", "generated_surface"],
    provider_tool_names: ["samurai.collection.record.create", "collection.record.create", "create_collection_record", "mcp__samurai__collection_record_create"],
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
    input_sources: ["surface_operation", "runtime_api", "provider_tool_call", "scheduled_context", "generated_surface"],
    provider_tool_names: ["collection.record.patch", "patch_collection_record", "mcp__samurai__collection_record_patch"],
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
    input_sources: ["surface_operation", "runtime_api", "generated_surface"],
    surface_operation_kinds: ["collection.record.delete"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    output_render_kinds: ["collection_record", "collection", "custom_view"],
    resource_kinds: ["collection_record"],
    proposed_effects: ["Delete a schema-validated Collection record when schema and view permissions allow it."]
  }),
  command({
    id: "collection.manage",
    title: "Manage collection",
    description: "Read or write Collection items and schemas through the shared Collection management surface.",
    runtime_method: "manageCollection",
    ui_display_category: "collection",
    input_sources: ["runtime_api", "provider_tool_call", "scheduled_context"],
    provider_tool_names: ["samurai.collection.manage", "collection.manage", "manage_collection", "collection_manage", "mcp__samurai__collection_manage"],
    writes_workspace: true,
    output_resource_kind: "collection",
    output_render_kinds: ["collection", "collection_record", "custom_view", "status_timeline"],
    resource_kinds: ["collection_schema", "collection_record", "collection_index"],
    proposed_effects: ["Run a Collection management action through the shared Collection surface."]
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
    input_sources: ["surface_operation", "runtime_api", "scheduled_context", "generated_surface"],
    surface_operation_kinds: ["collection.action.run"],
    writes_workspace: true,
    output_resource_kind: "collection_record",
    output_render_kinds: ["collection_record", "collection", "custom_view", "status_timeline"],
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
    id: "skill.view",
    title: "View Skill",
    description: "Read a selected Skill body or one declared support file on demand.",
    runtime_method: "viewSkill",
    ui_display_category: "memory",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["skill.view", "samurai.skill.view", "mcp__samurai__skill_view"],
    writes_workspace: false,
    output_resource_kind: "skill",
    resource_kinds: ["skill", "skill_support_file"],
    proposed_effects: ["Read a Skill only when the current run needs its procedure or support file."]
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
  command({ id: "file.inspect", title: "Inspect workspace file", description: "Inspect file metadata, content hash, and related Workspace provenance.", runtime_method: "runFileAction", ui_display_category: "workspace", input_sources: ["provider_tool_call", "runtime_api", "surface_operation"], provider_tool_names: ["file.inspect"], writes_workspace: false, output_resource_kind: "file", resource_kinds: ["file", "artifact", "workspace_change"], proposed_effects: ["Inspect file metadata and provenance without changing the Workspace."] }),
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
    title: "Capture browser screenshot",
    description: "Capture a real viewport image through a configured screenshot-capable adapter.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.screenshot"],
    writes_workspace: true,
    output_resource_kind: "file",
    resource_kinds: ["browser_page", "file"],
    proposed_effects: ["Capture a real browser viewport image into the workspace."]
  }),
  command({
    id: "browser.interact",
    title: "Interact with browser",
    description: "Navigate, click, or input through a configured real browser adapter.",
    runtime_method: "runBrowserAction",
    ui_display_category: "browser",
    input_sources: ["provider_tool_call", "runtime_api"],
    provider_tool_names: ["browser.interact"],
    writes_workspace: false,
    output_resource_kind: "browser_page",
    resource_kinds: ["browser_page"],
    proposed_effects: ["Interact with a real browser page through the configured adapter."]
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
  command({ id: "automation.job.set_status", title: "Pause or resume automation", description: "Enable or disable an Automation job through the Runtime boundary.", runtime_method: "setAutomationJobStatus", ui_display_category: "automation", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], writes_workspace: true, output_resource_kind: "automation_job", output_render_kinds: ["status_timeline"], resource_kinds: ["automation_job"], proposed_effects: ["Change an Automation job between enabled and disabled."] }),
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
    id: "curator.run",
    title: "Run Curator",
    description: "Run evaluation-aware Memory and Skill curation after creating a snapshot.",
    runtime_method: "runCuratorJob",
    ui_display_category: "memory",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "reflection_run",
    resource_kinds: ["reflection_run", "memory", "skill", "learning_snapshot"],
    proposed_effects: ["Curate learning resources after a restorable snapshot."]
  }),
  command({
    id: "curator.snapshot.create",
    title: "Create Curator Snapshot",
    description: "Create a restorable snapshot of Memory and Skill resources.",
    runtime_method: "createLearningSnapshot",
    ui_display_category: "memory",
    input_sources: ["runtime_api", "scheduled_context"],
    writes_workspace: true,
    output_resource_kind: "learning_snapshot",
    resource_kinds: ["learning_snapshot", "memory", "skill"],
    proposed_effects: ["Create a restorable learning-resource snapshot."]
  }),
  command({
    id: "curator.snapshot.list",
    title: "List Curator Snapshots",
    description: "List restorable learning-resource snapshots.",
    runtime_method: "listLearningSnapshots",
    ui_display_category: "memory",
    input_sources: ["runtime_api"],
    writes_workspace: false,
    output_resource_kind: "learning_snapshot",
    resource_kinds: ["learning_snapshot"],
    proposed_effects: ["List learning-resource snapshots."]
  }),
  command({
    id: "curator.restore",
    title: "Restore Curator Snapshot",
    description: "Restore Memory and Skill resources from a Curator snapshot.",
    runtime_method: "restoreLearningSnapshot",
    ui_display_category: "memory",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "learning_snapshot",
    resource_kinds: ["learning_snapshot", "memory", "skill"],
    proposed_effects: ["Restore learning resources from a snapshot."]
  }),
  command({
    id: "curator.pause",
    title: "Pause Curator",
    description: "Pause scheduled Curator runs.",
    runtime_method: "pauseCurator",
    ui_display_category: "memory",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "curator_state",
    resource_kinds: ["curator_state"],
    proposed_effects: ["Pause scheduled Curator runs."]
  }),
  command({
    id: "curator.resume",
    title: "Resume Curator",
    description: "Resume scheduled Curator runs.",
    runtime_method: "resumeCurator",
    ui_display_category: "memory",
    input_sources: ["runtime_api"],
    writes_workspace: true,
    output_resource_kind: "curator_state",
    resource_kinds: ["curator_state"],
    proposed_effects: ["Resume scheduled Curator runs."]
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
  command({ id: "workspace.repair", title: "Repair workspace", description: "Inspect and repair recoverable Workspace integrity issues.", runtime_method: "repairWorkspace", ui_display_category: "settings", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "workspace_health", resource_kinds: ["workspace"], proposed_effects: ["Repair recoverable Workspace integrity issues."] }),
  command({ id: "workspace.backup.create", title: "Create workspace backup", description: "Create an atomic Workspace backup.", runtime_method: "createWorkspaceBackup", ui_display_category: "settings", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "workspace_backup", resource_kinds: ["workspace_backup"], proposed_effects: ["Create an atomic Workspace backup."] }),
  command({ id: "workspace.backup.restore", title: "Restore workspace backup", description: "Restore a verified Workspace backup.", runtime_method: "restoreWorkspaceBackup", ui_display_category: "settings", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "workspace_backup", resource_kinds: ["workspace_backup", "workspace"], proposed_effects: ["Restore a verified Workspace backup."] }),
  command({ id: "gateway.mcp_config.save", title: "Save Gateway MCP config", description: "Save a validated Gateway MCP server configuration.", runtime_method: "saveGatewayMcpConfig", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_mcp_config", resource_kinds: ["gateway_mcp_config"], proposed_effects: ["Save a Gateway MCP server configuration."] }),
  command({ id: "gateway.concurrency_lock.expire", title: "Expire Gateway locks", description: "Expire stale Gateway concurrency locks.", runtime_method: "expireGatewayConcurrencyLocks", ui_display_category: "gateway", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "gateway_lock", resource_kinds: ["gateway_lock"], proposed_effects: ["Expire stale Gateway concurrency locks."] }),
  command({ id: "automation.job.requeue", title: "Requeue automation job", description: "Requeue an Automation job after an operational failure.", runtime_method: "requeueAutomationJob", ui_display_category: "automation", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "automation_job", resource_kinds: ["automation_job"], proposed_effects: ["Requeue an Automation job."] }),
  command({ id: "automation.job.release_lock", title: "Release automation lock", description: "Release a stale Automation job lock.", runtime_method: "releaseAutomationJobLock", ui_display_category: "automation", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "automation_job", resource_kinds: ["automation_job"], proposed_effects: ["Release an Automation job lock."] }),
  command({ id: "client.event.save", title: "Save client event", description: "Save a durable client delivery event.", runtime_method: "saveClientEvent", ui_display_category: "gateway", input_sources: ["runtime_api", "gateway_inbound", "automation"], writes_workspace: true, output_resource_kind: "client_event", resource_kinds: ["client_event"], proposed_effects: ["Save a durable client delivery event."] }),
  command({ id: "client.event.deliver", title: "Mark client event delivered", description: "Mark a client event as delivered.", runtime_method: "markClientEventDelivered", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "client_event", resource_kinds: ["client_event"], proposed_effects: ["Mark a client event as delivered."] }),
  command({ id: "client.event.ack", title: "Acknowledge client event", description: "Acknowledge a delivered client event.", runtime_method: "ackClientEvent", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "client_event", resource_kinds: ["client_event"], proposed_effects: ["Acknowledge a client event."] }),
  command({ id: "client.event.fail", title: "Fail client event", description: "Mark a client event delivery as failed.", runtime_method: "failClientEvent", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "client_event", resource_kinds: ["client_event"], proposed_effects: ["Mark a client event as failed."] }),
  command({ id: "settings.patch", title: "Update settings", description: "Update validated owner Workspace settings.", runtime_method: "patchSettings", ui_display_category: "settings", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "settings", resource_kinds: ["settings"], proposed_effects: ["Update owner Workspace settings."] }),
  command({ id: "resource.translation.save", title: "Save resource translation", description: "Save a derived translation with source provenance.", runtime_method: "saveResourceTranslation", ui_display_category: "artifact", input_sources: ["runtime_api", "automation"], writes_workspace: true, output_resource_kind: "resource_translation", resource_kinds: ["resource_translation"], proposed_effects: ["Save a derived resource translation."] }),
  command({ id: "resource.translation_job.save", title: "Save resource translation job", description: "Save a scheduled resource translation job.", runtime_method: "saveResourceTranslationJob", ui_display_category: "automation", input_sources: ["runtime_api", "automation"], writes_workspace: true, output_resource_kind: "automation_job", resource_kinds: ["automation_job", "resource_translation"], proposed_effects: ["Save a scheduled resource translation job."] }),
  command({ id: "approval.approve", title: "Approve request", description: "Approve a pending owner decision request.", runtime_method: "approveRequest", ui_display_category: "activity", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "approval", resource_kinds: ["approval", "operation"], proposed_effects: ["Approve a pending request and continue its authorized lifecycle."] }),
  command({ id: "approval.deny", title: "Deny request", description: "Deny a pending owner decision request.", runtime_method: "denyRequest", ui_display_category: "activity", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "approval", resource_kinds: ["approval", "operation"], proposed_effects: ["Deny a pending request and stop its lifecycle."] }),
  command({ id: "session.search.reindex", title: "Reindex session search", description: "Rebuild the Session search read model.", runtime_method: "reindexSessionSearch", ui_display_category: "chat", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "search_index", resource_kinds: ["search_index"], proposed_effects: ["Rebuild the Session search index."] }),
  command({ id: "learning.snapshot.prune", title: "Prune learning snapshots", description: "Apply the configured retention limit to Learning snapshots.", runtime_method: "pruneLearningSnapshots", ui_display_category: "memory", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "learning_snapshot", resource_kinds: ["learning_snapshot"], proposed_effects: ["Prune old Learning snapshots according to retention."] }),
  command({ id: "client.event.expire", title: "Expire client events", description: "Expire client events after their delivery deadline.", runtime_method: "expireClientEvents", ui_display_category: "gateway", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "client_event", resource_kinds: ["client_event"], proposed_effects: ["Expire client events after their deadline."] }),
  command({ id: "reflection.run", title: "Run background review", description: "Run scoped Background Review for a completed Session or Backend run.", runtime_method: "runReflection", ui_display_category: "memory", input_sources: ["runtime_api", "automation", "scheduled_context"], writes_workspace: true, output_resource_kind: "reflection_run", resource_kinds: ["reflection_run", "memory", "wiki", "skill"], proposed_effects: ["Review completed work and record scoped Learning changes."] }),
  command({ id: "evaluation.run", title: "Run learning evaluation", description: "Evaluate comparable Learning runs and guardrails.", runtime_method: "runEvaluationJob", ui_display_category: "memory", input_sources: ["runtime_api", "automation", "scheduled_context"], writes_workspace: true, output_resource_kind: "learning_evaluation", resource_kinds: ["learning_evaluation"], proposed_effects: ["Evaluate Learning outcomes and guardrails."] }),
  command({ id: "gateway.pairing_policy.save", title: "Save Gateway pairing policy", description: "Save an owner Gateway pairing policy.", runtime_method: "saveGatewayPairingPolicy", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_policy", resource_kinds: ["gateway_policy"], proposed_effects: ["Save a Gateway pairing policy."] }),
  command({ id: "gateway.routing_policy.save", title: "Save Gateway routing policy", description: "Save an owner Gateway routing policy.", runtime_method: "saveGatewayRoutingPolicy", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_policy", resource_kinds: ["gateway_policy"], proposed_effects: ["Save a Gateway routing policy."] }),
  command({ id: "gateway.pairing.expire", title: "Expire Gateway pairings", description: "Expire stale Gateway pairing requests.", runtime_method: "expireGatewayPairings", ui_display_category: "gateway", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "gateway_pairing", resource_kinds: ["gateway_pairing"], proposed_effects: ["Expire stale Gateway pairings."] }),
  command({ id: "gateway.state.repair", title: "Repair Gateway state", description: "Repair recoverable Gateway state inconsistencies.", runtime_method: "repairGatewayState", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_state", resource_kinds: ["gateway_state"], proposed_effects: ["Repair recoverable Gateway state."] }),
  command({ id: "gateway.pairing.approve", title: "Approve Gateway pairing", description: "Approve a pending Gateway pairing.", runtime_method: "approveGatewayPairing", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_pairing", resource_kinds: ["gateway_pairing"], proposed_effects: ["Approve a Gateway pairing."] }),
  command({ id: "gateway.pairing.reject", title: "Reject Gateway pairing", description: "Reject a pending Gateway pairing.", runtime_method: "rejectGatewayPairing", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_pairing", resource_kinds: ["gateway_pairing"], proposed_effects: ["Reject a Gateway pairing."] }),
  command({ id: "gateway.pairing.rotate", title: "Rotate Gateway pairing", description: "Rotate a Gateway pairing code.", runtime_method: "rotateGatewayPairing", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_pairing", resource_kinds: ["gateway_pairing"], proposed_effects: ["Rotate a Gateway pairing code."] }),
  command({ id: "gateway.pairing.revoke", title: "Revoke Gateway pairing", description: "Revoke an approved Gateway pairing.", runtime_method: "revokeGatewayPairing", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "gateway_pairing", resource_kinds: ["gateway_pairing"], proposed_effects: ["Revoke a Gateway pairing."] }),
  command({ id: "gateway.sandbox.recreate", title: "Recreate Gateway sandbox", description: "Recreate a Gateway sandbox instance.", runtime_method: "recreateGatewaySandboxInstance", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "sandbox_instance", resource_kinds: ["sandbox_instance"], proposed_effects: ["Recreate a Gateway sandbox instance."] }),
  command({ id: "gateway.sandbox.delete", title: "Delete Gateway sandbox", description: "Delete a Gateway sandbox instance.", runtime_method: "deleteGatewaySandboxInstance", ui_display_category: "gateway", input_sources: ["runtime_api"], writes_workspace: true, output_resource_kind: "sandbox_instance", resource_kinds: ["sandbox_instance"], proposed_effects: ["Delete a Gateway sandbox instance."] }),
  command({ id: "gateway.sandbox.sync", title: "Sync Gateway sandbox", description: "Synchronize Workspace data with a Gateway sandbox.", runtime_method: "syncGatewaySandboxWorkspace", ui_display_category: "gateway", input_sources: ["runtime_api", "automation"], writes_workspace: true, output_resource_kind: "sandbox_sync", resource_kinds: ["sandbox_instance", "sandbox_sync"], proposed_effects: ["Synchronize Workspace data with a Gateway sandbox."] }),
  command({ id: "objective.create", title: "Create objective", description: "Create a durable objective with explicit completion criteria.", runtime_method: "createObjective", ui_display_category: "activity", input_sources: ["runtime_api", "gateway_inbound", "automation"], writes_workspace: true, output_resource_kind: "objective", resource_kinds: ["objective"], proposed_effects: ["Create a durable objective and explicit completion criteria."] }),
  command({ id: "work_item.create", title: "Create work item", description: "Create a durable work item under an objective.", runtime_method: "createWorkItem", ui_display_category: "activity", input_sources: ["runtime_api", "gateway_inbound", "automation"], writes_workspace: true, output_resource_kind: "work_item", resource_kinds: ["objective", "work_item"], proposed_effects: ["Create a durable work item under an objective."] }),
  command({ id: "objective.transition", title: "Transition objective", description: "Pause, resume, or cancel an objective and propagate the transition.", runtime_method: "transitionObjective", ui_display_category: "activity", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "objective", resource_kinds: ["objective", "work_item", "backend_run"], proposed_effects: ["Transition an objective and propagate it to active work and Backend runs."] }),
  command({ id: "work_item.steer", title: "Steer work item", description: "Persist a steering instruction on the current work item.", runtime_method: "steerWorkItem", ui_display_category: "activity", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "work_item", resource_kinds: ["work_item"], proposed_effects: ["Add a steering instruction to the current work item."] }),
  command({ id: "work_item.follow_up", title: "Create follow-up work", description: "Create a dependent follow-up work item.", runtime_method: "createFollowUpWorkItem", ui_display_category: "activity", input_sources: ["runtime_api", "surface_operation"], writes_workspace: true, output_resource_kind: "work_item", resource_kinds: ["objective", "work_item"], proposed_effects: ["Create a dependent follow-up work item."] }),
  command({ id: "presentation.plan", title: "Plan presentation", description: "Choose the best built-in or Generated Surface presentation for a result.", runtime_method: "planPresentation", ui_display_category: "generated_surface", input_sources: ["runtime_api", "surface_operation", "generated_surface"], writes_workspace: false, output_resource_kind: "presentation_plan", output_render_kinds: ["chat", "custom_view"], resource_kinds: ["presentation_plan"], proposed_effects: ["Select a presentation without changing Workspace state."] }),
  command({ id: "generated_surface.create", title: "Create generated surface", description: "Validate and persist a versioned Generated Surface bundle.", runtime_method: "createGeneratedSurface", ui_display_category: "generated_surface", input_sources: ["runtime_api", "provider_tool_call", "generated_surface"], provider_tool_names: ["generated_surface.create", "samurai.generated_surface.create", "mcp__samurai__generated_surface_create", "create_generated_surface"], writes_workspace: true, output_resource_kind: "generated_surface", output_render_kinds: ["custom_view"], resource_kinds: ["generated_surface"], proposed_effects: ["Validate and persist a versioned Generated Surface bundle."] }),
  command({ id: "generated_surface.revise", title: "Revise generated surface", description: "Create a new immutable revision of a Generated Surface.", runtime_method: "reviseGeneratedSurface", ui_display_category: "generated_surface", input_sources: ["runtime_api", "provider_tool_call", "generated_surface"], provider_tool_names: ["generated_surface.revise", "samurai.generated_surface.revise", "mcp__samurai__generated_surface_revise"], writes_workspace: true, output_resource_kind: "generated_surface", output_render_kinds: ["custom_view"], resource_kinds: ["generated_surface"], proposed_effects: ["Create a new immutable Generated Surface revision."] }),
  command({ id: "generated_surface.state", title: "Change generated surface state", description: "Pin, unpin, or archive a Generated Surface.", runtime_method: "updateGeneratedSurfaceState", ui_display_category: "generated_surface", input_sources: ["runtime_api", "surface_operation", "generated_surface"], writes_workspace: true, output_resource_kind: "generated_surface", resource_kinds: ["generated_surface"], proposed_effects: ["Change Generated Surface lifecycle state."] }),
  command({ id: "generated_surface.interaction.record", title: "Record surface interaction", description: "Record a Generated Surface open, dismiss, correction, or regeneration signal.", runtime_method: "recordGeneratedSurfaceInteraction", ui_display_category: "generated_surface", input_sources: ["runtime_api", "surface_operation", "generated_surface"], writes_workspace: true, output_resource_kind: "surface_interaction", resource_kinds: ["generated_surface", "surface_interaction"], proposed_effects: ["Record a Generated Surface interaction for audit and learning."] }),
  command({ id: "generated_surface.action.run", title: "Run generated surface action", description: "Execute a declared Generated Surface action through its Domain Command.", runtime_method: "runGeneratedSurfaceAction", ui_display_category: "generated_surface", input_sources: ["runtime_api", "surface_operation", "generated_surface"], writes_workspace: true, output_resource_kind: "domain_command_result", resource_kinds: ["generated_surface", "operation"], proposed_effects: ["Execute a declared Generated Surface action through the Domain Command Bus."] }),
  command({ id: "generated_surface.export", title: "Export generated surface", description: "Export the selected Generated Surface as HTML or ZIP.", runtime_method: "exportGeneratedSurface", ui_display_category: "generated_surface", input_sources: ["runtime_api", "surface_operation", "generated_surface"], writes_workspace: false, output_resource_kind: "generated_surface_export", output_render_kinds: ["artifact"], resource_kinds: ["generated_surface", "generated_surface_export"], proposed_effects: ["Export a saved Generated Surface revision without changing its current revision."] }),
  command({ id: "skill.optimization.start", title: "Start Skill improvement", description: "Run the locked GEPA Skill improvement worker and save reviewable candidates.", runtime_method: "startSkillOptimization", ui_display_category: "skill", input_sources: ["runtime_api", "automation", "provider_tool_call"], provider_tool_names: ["samurai.skill.optimization.start", "skill.optimization.start", "start_skill_optimization", "mcp__samurai__skill_optimization_start"], writes_workspace: true, output_resource_kind: "skill_optimization_run", resource_kinds: ["skill", "skill_optimization_run", "optimization_candidate", "optimization_dataset", "work_item"], proposed_effects: ["Create an immutable Skill improvement run and candidate without changing the original Skill."] }),
  command({ id: "skill.optimization.cancel", title: "Cancel Skill improvement", description: "Cancel a running Skill improvement work item.", runtime_method: "cancelSkillOptimization", ui_display_category: "skill", input_sources: ["runtime_api", "provider_tool_call"], provider_tool_names: ["samurai.skill.optimization.cancel", "skill.optimization.cancel", "cancel_skill_optimization", "mcp__samurai__skill_optimization_cancel"], writes_workspace: true, output_resource_kind: "skill_optimization_run", resource_kinds: ["skill_optimization_run", "work_item"], proposed_effects: ["Stop a Skill improvement run and keep the original Skill unchanged."] }),
  command({ id: "skill.optimization.promote", title: "Promote Skill improvement", description: "Apply a user-confirmed GEPA candidate after conflict and safety checks.", runtime_method: "promoteSkillOptimization", ui_display_category: "skill", input_sources: ["runtime_api", "provider_tool_call"], provider_tool_names: ["samurai.skill.optimization.promote", "skill.optimization.promote", "promote_skill_optimization", "mcp__samurai__skill_optimization_promote"], writes_workspace: true, output_resource_kind: "skill", resource_kinds: ["skill", "skill_optimization_run", "optimization_candidate", "skill_optimization_snapshot", "optimization_promotion"], proposed_effects: ["Create a snapshot and promote one reviewed Skill candidate."] }),
  command({ id: "skill.optimization.reject", title: "Reject Skill improvement", description: "Reject a proposed Skill improvement candidate.", runtime_method: "rejectSkillOptimization", ui_display_category: "skill", input_sources: ["runtime_api", "provider_tool_call"], provider_tool_names: ["samurai.skill.optimization.reject", "skill.optimization.reject", "reject_skill_optimization", "mcp__samurai__skill_optimization_reject"], writes_workspace: true, output_resource_kind: "skill_optimization_run", resource_kinds: ["skill_optimization_run", "optimization_candidate"], proposed_effects: ["Reject a candidate and release its Skill lock without modifying the original Skill."] }),
  command({ id: "skill.optimization.rollback", title: "Rollback Skill improvement", description: "Restore a promoted Skill from its immutable pre-promotion snapshot.", runtime_method: "rollbackSkillOptimization", ui_display_category: "skill", input_sources: ["runtime_api", "provider_tool_call"], provider_tool_names: ["samurai.skill.optimization.rollback", "skill.optimization.rollback", "rollback_skill_optimization", "mcp__samurai__skill_optimization_rollback"], writes_workspace: true, output_resource_kind: "skill", resource_kinds: ["skill", "skill_optimization_snapshot", "optimization_promotion"], proposed_effects: ["Restore the Skill from a saved snapshot while preserving promotion provenance."] }),
  command({ id: "artifact.revise", title: "Revise artifact", description: "Create an immutable Artifact revision with content hash and lineage.", runtime_method: "reviseArtifact", ui_display_category: "artifact", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["artifact"], resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Create an immutable Artifact revision and update its current pointer."] }),
  command({ id: "artifact.restore_revision", title: "Restore artifact revision", description: "Restore an earlier immutable revision by creating a new revision from it.", runtime_method: "restoreArtifactRevision", ui_display_category: "artifact", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["artifact"], resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Create a new current Artifact revision from an earlier revision."] }),
  command({ id: "graph.create", title: "Create graph", description: "Create a validated node and edge graph as a revision-backed Artifact.", runtime_method: "createGraph", ui_display_category: "artifact", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], provider_tool_names: ["graph.create", "samurai.graph.create"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["graph_view", "artifact"], resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Create a validated graph Artifact in the Workspace."] }),
  command({ id: "graph.patch", title: "Edit graph", description: "Apply node and edge edits to a graph through a new immutable Artifact revision.", runtime_method: "patchGraph", ui_display_category: "artifact", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], provider_tool_names: ["graph.patch", "samurai.graph.patch"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["graph_view", "artifact"], resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Create a new graph Artifact revision from validated node and edge edits."] }),
  command({ id: "image.generate", title: "Save generated image", description: "Save an image provider result as a provenance-backed Artifact.", runtime_method: "saveGeneratedImage", ui_display_category: "artifact", input_sources: ["provider_tool_call", "runtime_api"], provider_tool_names: ["image.generate.result", "samurai.image.generate.result"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["artifact"], resource_kinds: ["artifact"], proposed_effects: ["Save a generated image provider result as an Artifact."] }),
  command({ id: "image.edit", title: "Save edited image", description: "Save an edited image provider result as a new immutable Artifact revision.", runtime_method: "saveEditedImage", ui_display_category: "artifact", input_sources: ["provider_tool_call", "runtime_api"], provider_tool_names: ["image.edit.result", "samurai.image.edit.result"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["artifact"], resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Save an edited image result as a new Artifact revision while preserving the original asset."] }),
  command({ id: "artifact.export_pdf", title: "Export PDF", description: "Export a text Artifact through a configured PDF adapter while preserving source revision provenance.", runtime_method: "exportArtifactPdf", ui_display_category: "artifact", input_sources: ["runtime_api", "provider_tool_call", "surface_operation"], provider_tool_names: ["artifact.export_pdf", "samurai.artifact.export_pdf"], writes_workspace: true, output_resource_kind: "artifact", output_render_kinds: ["artifact"], resource_kinds: ["artifact"], proposed_effects: ["Create a PDF Artifact from the selected source Artifact."] }),
  command({ id: "artifact.repair", title: "Repair artifact source", description: "Repair a missing current Artifact file from its verified content blob.", runtime_method: "repairArtifact", ui_display_category: "artifact", input_sources: ["runtime_api", "scheduled_context"], writes_workspace: true, output_resource_kind: "artifact", resource_kinds: ["artifact", "artifact_revision"], proposed_effects: ["Restore a missing Artifact revision file from its verified content blob."] }),
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
  input_schema: entry.input_schema,
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
    | "invalid_entrypoint_module"
    | "version_incompatible";
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
  enabled: boolean;
}

export interface PluginEntrypointLoadOptions {
  allowUnsigned?: boolean;
  importModule?: (specifier: string) => Promise<unknown>;
  timeoutMs?: number;
  memoryLimitMb?: number;
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
  private readonly disabledManifestIds = new Set<string>();

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
    const actions = [...this.actions.values()].filter((action) => {
      const manifest = this.manifestsByAction.get(action.id);
      return !manifest || !this.disabledManifestIds.has(manifest.id);
    });
    return category ? actions.filter((action) => action.ui_display_category === category) : actions;
  }

  listRenderers(): SurfaceRendererRegistryEntry[] {
    return [...this.renderers.values()].filter((renderer) => {
      const manifest = [...this.manifests.values()].find((item) => item.renderers?.some((entry) => entry.id === renderer.id));
      return !manifest || !this.disabledManifestIds.has(manifest.id);
    });
  }

  setPluginEnabled(manifestId: string, enabled: boolean): boolean {
    if (!this.manifests.has(manifestId)) return false;
    if (enabled) this.disabledManifestIds.delete(manifestId); else this.disabledManifestIds.add(manifestId);
    return true;
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
        missing_handler_ids: handlerIds.filter((handlerId) => !this.handlers.has(handlerId)),
        enabled: !this.disabledManifestIds.has(manifest.id)
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
    const manifest = this.manifestsByAction.get(action.id);
    if (manifest && this.disabledManifestIds.has(manifest.id)) {
      return { action_id: actionId, handler_id: action.handler_id, status: "failed", error: "plugin_disabled" };
    }
    const handler = this.handlers.get(action.handler_id);
    if (!handler) {
      return { action_id: actionId, handler_id: action.handler_id, status: "failed", error: "handler_not_registered" };
    }
    const result = await handler({
      action,
      manifest,
      input,
      context
    });
    return { action_id: actionId, handler_id: action.handler_id, ...result };
  }

  async loadEntrypoints(options: PluginEntrypointLoadOptions = {}): Promise<PluginEntrypointLoadResult> {
    const issues: PluginManifestLoadIssue[] = [];
    const loaded: PluginEntrypointLoadResult["loaded"] = [];
    const importModule = options.importModule;

    for (const binding of this.runtimeBindings.values()) {
      if (this.disabledManifestIds.has(binding.manifest_id)) {
        continue;
      }
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
      const apiVersion = typeof manifest.metadata.plugin_api_version === "string" ? manifest.metadata.plugin_api_version : "1";
      if (apiVersion !== "1") {
        issues.push({ file_path: binding.manifest_file_path, code: "version_incompatible", message: `plugin API version ${apiVersion} is incompatible with Host API version 1` });
        continue;
      }
      if (!importModule) {
        const listed = await runPluginWorker({ mode: "list", entrypoint: binding.entrypoint_path, timeoutMs: options.timeoutMs ?? 5_000, memoryLimitMb: options.memoryLimitMb ?? 64 }).catch((error) => {
          issues.push({ file_path: binding.manifest_file_path, code: "entrypoint_load_failed", message: error instanceof Error ? error.message : String(error) });
          return undefined;
        });
        if (!listed) continue;
        const handlerIds = Array.isArray((listed as { handlers?: unknown }).handlers) ? (listed as { handlers: unknown[] }).handlers.filter((id): id is string => typeof id === "string") : [];
        const registeredHandlerIds = binding.handler_ids.filter((handlerId) => handlerIds.includes(handlerId));
        for (const handlerId of registeredHandlerIds) {
          this.registerHandler(handlerId, async (handlerInput) => {
            try {
              return await runPluginWorker({ mode: "execute", entrypoint: binding.entrypoint_path!, handlerId, input: handlerInput, timeoutMs: options.timeoutMs ?? 5_000, memoryLimitMb: options.memoryLimitMb ?? 64 }) as PluginActionHandlerOutput;
            } catch (error) {
              return { status: "failed", error: error instanceof Error ? error.message : String(error) };
            }
          });
        }
        if (registeredHandlerIds.length === 0) {
          issues.push({ file_path: binding.manifest_file_path, code: "invalid_entrypoint_module", message: `plugin entrypoint did not export handlers for manifest ${binding.manifest_id}` });
          continue;
        }
        loaded.push({ manifest_id: binding.manifest_id, entrypoint_path: binding.entrypoint_path, registered_handler_ids: registeredHandlerIds });
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

async function runPluginWorker(input: {
  mode: "list" | "execute";
  entrypoint: string;
  handlerId?: string;
  input?: unknown;
  timeoutMs: number;
  memoryLimitMb: number;
}): Promise<unknown> {
  const workerPath = path.resolve(process.cwd(), "packages/action-catalog/src/plugin-worker.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${Math.max(16, input.memoryLimitMb)}`, workerPath, input.mode, pathToFileURL(input.entrypoint).href, input.handlerId ?? ""], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }
    });
    let stdout = "";
    let stderr = "";
    const maxOutput = 1_000_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`plugin_timeout:${input.timeoutMs}`));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxOutput) {
        child.kill("SIGKILL");
        reject(new Error("plugin_output_limit_exceeded"));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`plugin_process_failed:${code ?? signal ?? "unknown"}:${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "null"));
      } catch {
        reject(new Error("plugin_output_invalid_json"));
      }
    });
    child.stdin.end(JSON.stringify(input.input ?? {}));
  });
}

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
