import { jsonSchemaFor, type DomainAvailability, type DomainConcurrency, type DomainEffect, type DomainIdempotency, type DomainInputSource, type DomainProvenance, type DomainRenderKind, type DomainRuntimeCapability } from "./definition/index.js";
import { operationDefinitions } from "./generated/operation-index.generated.js";
import type { z } from "zod";
import type { JsonValue } from "@samurai-agent/core-schemas";
import { createHash } from "node:crypto";

export interface DomainCommandCatalogEntry {
  kind: "command";
  id: string;
  contract_version: string;
  contract_fingerprint: string;
  availability: DomainAvailability;
  runtime_requirements: DomainRuntimeCapability[];
  title: string;
  description: string;
  implementation_target: "domain_operation";
  ui_display_category: string;
  input_sources: DomainInputSource[];
  allowed_sources: DomainInputSource[];
  provider_tool_names?: string[];
  surface_operation_kinds?: string[];
  writes_workspace: boolean;
  output_resource_kind: string;
  output_render_kinds: DomainRenderKind[];
  render_kinds: DomainRenderKind[];
  input_schema: Record<string, JsonValue>;
  output_schema: Record<string, JsonValue>;
  effect_kind: DomainEffect;
  idempotency_policy: DomainIdempotency;
  concurrency_policy: DomainConcurrency;
  provenance: DomainProvenance[];
  resource_kinds: string[];
  proposed_effects: string[];
}

export interface DomainQueryCatalogEntry extends Omit<DomainCommandCatalogEntry, "kind" | "effect_kind" | "idempotency_policy" | "concurrency_policy" | "writes_workspace"> {
  kind: "query";
  effect_kind: "read_only";
  idempotency_policy: "none";
  concurrency_policy: "none";
  writes_workspace: false;
}

export const domainCommandEntries = Object.freeze(operationDefinitions.reduce<DomainCommandCatalogEntry[]>((entries, definition) => {
  if (definition.kind === "command") entries.push(projectCommand(definition));
  return entries;
}, []));
export const domainQueryEntries = Object.freeze(operationDefinitions.reduce<DomainQueryCatalogEntry[]>((entries, definition) => {
  if (definition.kind === "query") entries.push(projectQuery(definition));
  return entries;
}, []));

export function getDomainCommandEntry(id: string): DomainCommandCatalogEntry | undefined {
  return domainCommandEntries.find((entry) => entry.id === id);
}

export function getDomainQueryEntry(id: string): DomainQueryCatalogEntry | undefined {
  return domainQueryEntries.find((entry) => entry.id === id);
}

export function listDomainCommandEntries(source?: DomainInputSource): DomainCommandCatalogEntry[] {
  return source ? domainCommandEntries.filter((entry) => entry.allowed_sources.includes(source)) : [...domainCommandEntries];
}

export function listDomainQueryEntries(source?: DomainInputSource): DomainQueryCatalogEntry[] {
  return source ? domainQueryEntries.filter((entry) => entry.allowed_sources.includes(source)) : [...domainQueryEntries];
}

interface CatalogDefinition {
  id: string;
  version: string;
  availability: DomainAvailability;
  runtimeRequirements?: readonly DomainRuntimeCapability[];
  title: string;
  description: string;
  sources: readonly DomainInputSource[];
  effect: DomainEffect;
  idempotency: DomainIdempotency;
  concurrency: DomainConcurrency;
  render: readonly DomainRenderKind[];
  resourceKinds: readonly string[];
  proposedEffects: readonly string[];
  outputResourceKind: string;
  uiDisplayCategory: string;
  providerToolNames?: readonly string[];
  surfaceOperationKinds?: readonly string[];
  provenance: readonly DomainProvenance[];
  input: z.ZodTypeAny;
  output: z.ZodTypeAny;
}

function projectCommand(definition: CatalogDefinition): DomainCommandCatalogEntry {
  const inputSchema = jsonSchemaFor(definition.input, definition.id);
  const outputSchema = jsonSchemaFor(definition.output, `${definition.id}.output`);
  return {
    kind: "command",
    id: definition.id,
    contract_version: definition.version,
    contract_fingerprint: fingerprintDefinition(definition, inputSchema, outputSchema),
    availability: definition.availability,
    runtime_requirements: [...(definition.runtimeRequirements ?? [])],
    title: definition.title,
    description: definition.description,
    implementation_target: "domain_operation",
    ui_display_category: definition.uiDisplayCategory,
    input_sources: [...definition.sources],
    allowed_sources: [...definition.sources],
    ...(definition.providerToolNames ? { provider_tool_names: [...definition.providerToolNames] } : {}),
    ...(definition.surfaceOperationKinds ? { surface_operation_kinds: [...definition.surfaceOperationKinds] } : {}),
    writes_workspace: definition.effect === "workspace_mutation",
    output_resource_kind: definition.outputResourceKind,
    output_render_kinds: [...definition.render],
    render_kinds: [...definition.render],
    input_schema: inputSchema,
    output_schema: outputSchema,
    effect_kind: definition.effect,
    idempotency_policy: definition.idempotency,
    concurrency_policy: definition.concurrency,
    provenance: [...definition.provenance],
    resource_kinds: [...definition.resourceKinds],
    proposed_effects: [...definition.proposedEffects]
  };
}

export function fingerprintDefinition(
  definition: CatalogDefinition,
  inputSchema = jsonSchemaFor(definition.input, definition.id),
  outputSchema = jsonSchemaFor(definition.output, `${definition.id}.output`)
): string {
  const contract = {
    id: definition.id,
    version: definition.version,
    availability: definition.availability,
    runtimeRequirements: definition.runtimeRequirements,
    title: definition.title,
    description: definition.description,
    sources: definition.sources,
    effect: definition.effect,
    idempotency: definition.idempotency,
    concurrency: definition.concurrency,
    render: definition.render,
    resourceKinds: definition.resourceKinds,
    proposedEffects: definition.proposedEffects,
    outputResourceKind: definition.outputResourceKind,
    uiDisplayCategory: definition.uiDisplayCategory,
    providerToolNames: definition.providerToolNames,
    surfaceOperationKinds: definition.surfaceOperationKinds,
    provenance: definition.provenance,
    inputSchema,
    outputSchema
  };
  return createHash("sha256").update(stableJson(contract)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item);
}

function projectQuery(definition: CatalogDefinition): DomainQueryCatalogEntry {
  const entry = projectCommand(definition);
  return {
    ...entry,
    kind: "query",
    effect_kind: "read_only",
    idempotency_policy: "none",
    concurrency_policy: "none",
    writes_workspace: false
  };
}
