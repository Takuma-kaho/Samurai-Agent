import type { BackendToolBridge } from "@samurai-agent/agent-backends";
import {
  collectionManageCompatibilityEntry,
  getDomainOperationForProviderToolName,
  type DomainOperationCatalogEntry
} from "@samurai-agent/action-catalog";

interface ProviderToolBridgeDeclaration {
  name: string;
  provider_tool_name: string;
  title: string;
  description: string;
  presentation_aliases?: readonly string[];
  compatibility?: "collection_manage";
}

const providerToolBridgeDeclarations: readonly ProviderToolBridgeDeclaration[] = [
  { name: "samurai.artifact.create", provider_tool_name: "mcp__samurai__artifact_create", title: "Create Samurai Artifact", description: "Create a Samurai workspace Artifact from generated user-facing content.", presentation_aliases: ["artifact_create"] },
  { name: "samurai.generated_surface.create", provider_tool_name: "mcp__samurai__generated_surface_create", title: "Create Samurai Generated Surface", description: "Generate a saved HTML Surface for the Workspace Canvas. Use only when the user asks for an independent or custom UI." },
  { name: "samurai.generated_surface.revise", provider_tool_name: "mcp__samurai__generated_surface_revise", title: "Revise Samurai Generated Surface", description: "Create a new immutable HTML revision for the selected Generated Surface after a chat correction." },
  { name: "samurai.skill.optimization.start", provider_tool_name: "mcp__samurai__skill_optimization_start", title: "Start Samurai Skill improvement", description: "Start an independent GEPA improvement run for a selected Skill. The original Skill is not changed." },
  { name: "samurai.skill.optimization.cancel", provider_tool_name: "mcp__samurai__skill_optimization_cancel", title: "Cancel Samurai Skill improvement", description: "Cancel a running Skill improvement and keep the original Skill unchanged." },
  { name: "samurai.skill.optimization.promote", provider_tool_name: "mcp__samurai__skill_optimization_promote", title: "Promote Samurai Skill improvement", description: "Apply a reviewed Skill improvement candidate after the user confirms it." },
  { name: "samurai.skill.optimization.reject", provider_tool_name: "mcp__samurai__skill_optimization_reject", title: "Reject Samurai Skill improvement", description: "Reject a Skill improvement candidate without changing the original Skill." },
  { name: "samurai.skill.optimization.rollback", provider_tool_name: "mcp__samurai__skill_optimization_rollback", title: "Rollback Samurai Skill improvement", description: "Restore a promoted Skill from its saved pre-promotion snapshot." },
  { name: "samurai.session.search", provider_tool_name: "mcp__samurai__session_search", title: "Search Samurai Sessions", description: "Search previous Samurai sessions without injecting them into the prompt." },
  { name: "samurai.memory.search", provider_tool_name: "mcp__samurai__memory_search", title: "Search Samurai Memory", description: "Search accepted Samurai Memory entries by topic." },
  { name: "samurai.wiki.search", provider_tool_name: "mcp__samurai__wiki_search", title: "Search Samurai Knowledge Wiki", description: "Search active Knowledge Wiki pages and return refs." },
  { name: "samurai.skill.view", provider_tool_name: "mcp__samurai__skill_view", title: "View Samurai Skill", description: "Read the body of a selected Skill or an allowed support file only when needed for the current run." },
  { name: "samurai.skill.search", provider_tool_name: "mcp__samurai__skill_search", title: "Search Samurai Skills", description: "Search reusable Samurai Skills and return catalog refs." },
  { name: "samurai.collection.search", provider_tool_name: "mcp__samurai__collection_search", title: "Search Samurai Collections", description: "Search local Collection records and return read-only summaries." },
  { name: "samurai.collection.manage", provider_tool_name: "mcp__samurai__collection_manage", title: "Manage Samurai Collection", description: "Read and write Collection data through the host. Prefer this over raw file I/O for Collection records and schema edits; raw file I/O remains an escape hatch.", compatibility: "collection_manage" },
  { name: "samurai.collection.schema.save", provider_tool_name: "mcp__samurai__collection_schema_save", title: "Save Samurai Collection Schema", description: "Save a validated CollectionSchema for a personal Workspace data app." },
  { name: "samurai.collection.record.create", provider_tool_name: "mcp__samurai__collection_record_create", title: "Create Samurai Collection Record", description: "Create a schema-validated Collection record through Runtime." },
  { name: "samurai.collection.view.present", provider_tool_name: "mcp__samurai__collection_view_present", title: "Present Samurai Collection", description: "Present an existing Collection as an interactive Workspace card." }
];

interface ProviderToolBridgeMapping {
  declaration: ProviderToolBridgeDeclaration;
  entry?: DomainOperationCatalogEntry;
  compatibility?: "collection_manage";
}

export function buildProviderToolBridgeMaps(declarations: readonly ProviderToolBridgeDeclaration[] = providerToolBridgeDeclarations): {
  byName: Map<string, ProviderToolBridgeMapping>;
  byAlias: Map<string, ProviderToolBridgeMapping>;
} {
  const byName = new Map<string, ProviderToolBridgeMapping>();
  const byAlias = new Map<string, ProviderToolBridgeMapping>();
  for (const declaration of declarations) {
    if (byName.has(declaration.name)) throw new Error(`duplicate_provider_tool_bridge_name:${declaration.name}`);
    if (byAlias.has(declaration.provider_tool_name)) throw new Error(`duplicate_provider_tool_bridge_alias:${declaration.provider_tool_name}`);
    let mapping: ProviderToolBridgeMapping;
    if (declaration.compatibility === "collection_manage") {
      mapping = { declaration, compatibility: declaration.compatibility };
    } else {
      const entry = getDomainOperationForProviderToolName(declaration.provider_tool_name);
      const canonicalEntry = getDomainOperationForProviderToolName(declaration.name);
      if (!entry || !canonicalEntry) {
        throw new Error(`provider_tool_bridge_definition_missing:${declaration.name}:${declaration.provider_tool_name}`);
      }
      if (entry.id !== canonicalEntry.id) {
        throw new Error(`provider_tool_bridge_alias_mismatch:${declaration.name}:${declaration.provider_tool_name}`);
      }
      mapping = { declaration, entry };
    }
    byName.set(declaration.name, mapping);
    byAlias.set(declaration.provider_tool_name, mapping);
    if (mapping.entry) {
      for (const alias of mapping.entry.provider_tool_names ?? []) {
        const existing = byAlias.get(alias);
        if (existing && existing !== mapping) throw new Error(`duplicate_provider_tool_bridge_definition_alias:${alias}`);
        byAlias.set(alias, mapping);
      }
    }
    for (const alias of declaration.presentation_aliases ?? []) {
      const existing = byAlias.get(alias);
      if (existing && existing !== mapping) throw new Error(`duplicate_provider_tool_bridge_allowlist_alias:${alias}`);
      byAlias.set(alias, mapping);
    }
    if (!mapping.entry) byAlias.set(declaration.name, mapping);
  }
  return { byName, byAlias };
}

const providerToolBridgeMaps = buildProviderToolBridgeMaps();

function mappingForToolName(toolName: string): ProviderToolBridgeMapping | undefined {
  return providerToolBridgeMaps.byName.get(toolName) ?? providerToolBridgeMaps.byAlias.get(toolName);
}

export const samuraiToolBridgeDescriptors: BackendToolBridge["tools"] = providerToolBridgeDeclarations.map((declaration) => {
  const mapping = providerToolBridgeMaps.byName.get(declaration.name);
  if (!mapping) throw new Error(`provider_tool_bridge_mapping_missing:${declaration.name}`);
  return {
    name: declaration.name,
    provider_tool_name: declaration.provider_tool_name,
    title: declaration.title,
    description: declaration.description,
    input_schema: mapping.compatibility === "collection_manage"
      ? collectionManageCompatibilityEntry.input_schema
      : mapping.entry!.input_schema
  };
});

export const samuraiToolBridgeTools = new Set(samuraiToolBridgeDescriptors.map((tool) => tool.name));
export const samuraiToolBridgeWriteTools = new Set(providerToolBridgeDeclarations
  .filter((declaration) => {
    const mapping = providerToolBridgeMaps.byName.get(declaration.name)!;
    return mapping.compatibility === "collection_manage" || mapping.entry?.kind === "command";
  })
  .map((declaration) => declaration.name));

export function samuraiToolBridgeActionId(toolName: string): string {
  const mapping = mappingForToolName(toolName);
  if (!mapping) throw new Error(`unknown_samurai_tool_bridge:${toolName}`);
  return mapping.compatibility === "collection_manage" ? collectionManageCompatibilityEntry.id : mapping.entry!.id;
}

export function normalizeSamuraiToolBridgeName(name: string): string {
  const normalized = name.trim();
  return mappingForToolName(normalized)?.declaration.name ?? normalized;
}

export function isSamuraiToolBridgeObservedProviderTool(providerToolName: string, payload: Record<string, unknown>): boolean {
  if (payload.already_executed !== true || payload.tool_origin !== "samurai_tool_bridge") return false;
  return mappingForToolName(providerToolName) !== undefined;
}
