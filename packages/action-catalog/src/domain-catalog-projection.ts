import {
  collectionManageCompatibility,
  deprecatedOperations,
  domainCommandEntries as projectedCommandEntries,
  domainInputSources,
  domainQueryEntries as projectedQueryEntries,
  domainRenderKinds,
  operationDefinitions,
  type DomainCommandCatalogEntry,
  type DomainInputSource,
  type DomainQueryCatalogEntry,
  type DomainRenderKind,
  type OperationDefinition
} from "@samurai-agent/domain-operations";
import {
  nowIso,
  type ActionCatalogEntry,
  type DomainCommandCatalogDiagnosticsReport,
  type JsonValue
} from "@samurai-agent/core-schemas";

export const domainCommandInputSources = domainInputSources;
export type DomainCommandInputSource = DomainInputSource;
export const domainCommandOutputRenderKinds = domainRenderKinds;
export type DomainCommandOutputRenderKind = DomainRenderKind;
export type DomainCommandEntry = DomainCommandCatalogEntry;
export type DomainQueryEntry = DomainQueryCatalogEntry;

export interface DeprecatedDomainCommandEntry {
  id: string;
  title: string;
  description: string;
  contract_version: string;
  availability: "deprecated_command";
  replacement: { kind: "effective_inventory"; target: "/api/domain/commands/effective" };
}

export const domainCommandEntries = [...projectedCommandEntries];
export const domainQueryEntries = [...projectedQueryEntries];
export const domainLegacyCommandEntries: DeprecatedDomainCommandEntry[] = deprecatedOperations.map((entry) => ({
  id: entry.id,
  title: entry.title,
  description: entry.description,
  contract_version: entry.contractVersion,
  availability: "deprecated_command",
  replacement: entry.replacement
}));

export const collectionManageCompatibilityEntry = {
  id: collectionManageCompatibility.id,
  input_schema: collectionManageCompatibility.inputSchema as unknown as Record<string, JsonValue>
};

export const actionCatalogEntries: ActionCatalogEntry[] = domainCommandEntries.map((entry) => ({
  id: entry.id,
  kind: entry.kind,
  contract_version: entry.contract_version,
  contract_fingerprint: entry.contract_fingerprint,
  availability: entry.availability,
  runtime_requirements: entry.runtime_requirements,
  title: entry.title,
  display_name: entry.title,
  description: entry.description,
  input_schema: entry.input_schema,
  output_schema: {
    ...entry.output_schema,
    "x-samurai-render-kinds": [...entry.render_kinds]
  },
  allowed_sources: [...entry.allowed_sources],
  effect_kind: entry.effect_kind,
  idempotency_policy: entry.idempotency_policy,
  concurrency_policy: entry.concurrency_policy,
  render_kinds: [...entry.render_kinds],
  provenance: [...entry.provenance],
  resource_kinds: [...entry.resource_kinds],
  implementation_target: entry.implementation_target,
  ui_display_category: entry.ui_display_category
}));

export function getDomainCommandEntry(id: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.id === id);
}

export function requireDomainCommandEntry(id: string): DomainCommandEntry {
  const entry = getDomainCommandEntry(id);
  if (!entry) throw new Error(`Unknown domain command: ${id}`);
  return entry;
}

export function getDeprecatedDomainCommandEntry(id: string): DeprecatedDomainCommandEntry | undefined {
  return domainLegacyCommandEntries.find((entry) => entry.id === id);
}

export function listDomainCommandEntries(source?: DomainCommandInputSource): DomainCommandEntry[] {
  return source
    ? domainCommandEntries.filter((entry) => entry.allowed_sources.includes(source))
    : [...domainCommandEntries];
}

export function getDomainQueryEntry(id: string): DomainQueryEntry | undefined {
  return domainQueryEntries.find((entry) => entry.id === id);
}

export function requireDomainQueryEntry(id: string): DomainQueryEntry {
  const entry = getDomainQueryEntry(id);
  if (!entry) throw new Error(`Unknown domain query: ${id}`);
  return entry;
}

export function listDomainQueryEntries(source?: DomainCommandInputSource): DomainQueryEntry[] {
  return source
    ? domainQueryEntries.filter((entry) => entry.allowed_sources.includes(source))
    : [...domainQueryEntries];
}

export function getDomainCommandForSurfaceOperationKind(kind: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.surface_operation_kinds?.includes(kind));
}

export function getDomainCommandForProviderToolName(name: string): DomainCommandEntry | undefined {
  return domainCommandEntries.find((entry) => entry.provider_tool_names?.includes(name));
}

export function getDomainQueryForSurfaceOperationKind(kind: string): DomainQueryEntry | undefined {
  return domainQueryEntries.find((entry) => entry.surface_operation_kinds?.includes(kind));
}

export function getDomainQueryForProviderToolName(name: string): DomainQueryEntry | undefined {
  return domainQueryEntries.find((entry) => entry.provider_tool_names?.includes(name));
}

export function validateDomainCommandInput(entry: DomainCommandEntry, payload: Record<string, unknown>): ValidationIssue | undefined {
  return validateOperationInput(entry.id, payload);
}

export function validateDomainQueryInput(entry: DomainQueryEntry, payload: Record<string, unknown>): ValidationIssue | undefined {
  return validateOperationInput(entry.id, payload);
}

export function validateDomainOutput(_entry: DomainCommandEntry | DomainQueryEntry, output: unknown): ValidationIssue | undefined {
  if (isRecord(output) && output.ok === true) return undefined;
  return { path: "$.ok", message: "Expected successful runtime result envelope." };
}

export function getDomainCommandCatalogDiagnostics(): DomainCommandCatalogDiagnosticsReport {
  const allEntries = [...domainCommandEntries, ...domainQueryEntries];
  const actionIds = new Set(actionCatalogEntries.map((entry) => entry.id));
  const issues = allEntries.flatMap((entry) => {
    const entryIssues: Array<{ code: "missing_action_catalog_entry" | "empty_input_sources" | "empty_resource_kinds" | "empty_proposed_effects"; command_id: string; message: string }> = [];
    if (!entry.allowed_sources.length) entryIssues.push({ code: "empty_input_sources", command_id: entry.id, message: "Domain operation must declare input sources." });
    if (!entry.resource_kinds.length) entryIssues.push({ code: "empty_resource_kinds", command_id: entry.id, message: "Domain operation must declare resource kinds." });
    if (!entry.proposed_effects.length) entryIssues.push({ code: "empty_proposed_effects", command_id: entry.id, message: "Domain operation must describe proposed effects." });
    if (entry.kind === "command" && !actionIds.has(entry.id)) entryIssues.push({ code: "missing_action_catalog_entry", command_id: entry.id, message: "Domain command is missing from the Action Catalog projection." });
    return entryIssues;
  });
  const providerToolMappings = new Set(allEntries.flatMap((entry) => entry.provider_tool_names ?? []));
  const surfaceOperationMappings = new Set(allEntries.flatMap((entry) => entry.surface_operation_kinds ?? []));
  return {
    ok: issues.length === 0,
    generated_at: nowIso(),
    coverage: {
      commands: domainCommandEntries.length,
      queries: domainQueryEntries.length,
      legacy_commands: domainLegacyCommandEntries.length,
      action_catalog_entries: actionCatalogEntries.length,
      provider_tool_mappings: providerToolMappings.size,
      surface_operation_mappings: surfaceOperationMappings.size,
      render_kinds: [...domainCommandOutputRenderKinds],
      input_sources: [...domainCommandInputSources],
      strict_schema_rate: 1,
      generic_schema_count: 0
    },
    issues,
    recommendation: issues.length ? "Fix the Domain Operation definition before exposing it through the Action Catalog." : "Domain Operations and the Action Catalog projection are internally consistent."
  };
}

interface ValidationIssue {
  path: string;
  message: string;
}

function validateOperationInput(id: string, payload: Record<string, unknown>): ValidationIssue | undefined {
  const definition = operationDefinitions.find((candidate) => candidate.id === id);
  if (!definition) return { path: "$", message: `Unknown domain operation: ${id}` };
  const result = definition.input.safeParse(payload);
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  return { path: issue?.path.length ? `$.${issue.path.join(".")}` : "$", message: issue?.message ?? "Invalid input." };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
