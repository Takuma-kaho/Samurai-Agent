import { toStrictJsonSchema, type JsonValue } from "@samurai-agent/core-schemas";
import { z } from "zod";

export const domainInputSources = [
  "surface_operation",
  "provider_tool_call",
  "runtime_api",
  "gateway_inbound",
  "automation",
  "generated_surface",
  "scheduled_context"
] as const;
export type DomainInputSource = (typeof domainInputSources)[number];

export const domainRenderKinds = [
  "chat", "status_timeline", "form", "table", "chart", "graph_view", "artifact",
  "collection", "collection_record", "memory", "skill", "knowledge_wiki", "gateway",
  "run_history", "custom_view"
] as const;
export type DomainRenderKind = (typeof domainRenderKinds)[number];

export type DomainEffect = "workspace_mutation" | "external_effect" | "runtime_control" | "read_only";
export type DomainIdempotency = "required" | "optional" | "none" | "external";
export type DomainConcurrency = "optimistic_version" | "state_transition" | "append_or_unique" | "external_idempotency" | "none";
export type DomainAvailability = "active" | "deprecated_command";
export type DomainRuntimeCapability = "agent_backend" | "pdf_export" | "browser_adapter" | "plugin_runtime";

export interface DomainProvenance {
  source: "mulmoclaude" | "hermes" | "openclaw" | "samurai";
  commit_sha: string;
  reference_file: string;
  decision: "adopted" | "adapted" | "not_adopted";
  reason: string;
}

export interface TrustedDomainContext {
  inputSource: DomainInputSource;
  workspaceId: string;
  actorId: string;
  sessionId?: string;
  runId?: string;
  correlationId: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface CommandOperationPort<I, O> {
  execute(context: TrustedDomainContext, input: I): Promise<O> | O;
}

export interface QueryOperationPort<I, O> {
  execute(context: TrustedDomainContext, input: I): Promise<O> | O;
}

export interface OperationHandler<I, O> {
  execute(context: TrustedDomainContext, input: I): Promise<DomainResult<O>> | DomainResult<O>;
}

interface BaseDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny, P> {
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
  input: I;
  output: O;
  createHandler(ports: P): OperationHandler<z.infer<I>, z.infer<O>>;
}

export interface CommandDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny, P = unknown> extends BaseDefinition<I, O, P> {
  readonly kind: "command";
}

export interface QueryDefinition<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny, P = unknown> extends BaseDefinition<I, O, P> {
  readonly kind: "query";
  readonly effect: "read_only";
  readonly idempotency: "none";
  readonly concurrency: "none";
}

export type OperationDefinition = CommandDefinition | QueryDefinition;

/** Nominal boundary for capabilities that cannot mutate domain state. */
export interface DomainQueryPorts {
  readonly domainPortKind?: "query";
}

export function defineCommand<P>() {
  return <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: Omit<CommandDefinition<I, O, P>, "kind">): CommandDefinition<I, O, P> =>
    Object.freeze({ ...definition, kind: "command" as const });
}

export function defineQuery<P extends DomainQueryPorts>() {
  return <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: Omit<QueryDefinition<I, O, P>, "kind" | "effect" | "idempotency" | "concurrency">): QueryDefinition<I, O, P> =>
    Object.freeze({ ...definition, kind: "query" as const, effect: "read_only" as const, idempotency: "none" as const, concurrency: "none" as const });
}

export const domainResultEnvelopeSchema = z.object({
  ok: z.literal(true),
  value: z.unknown()
}).strict();

export type DomainResult<T> = { ok: true; value: T };

const domainJsonScalarSchema = z.union([
  z.string().max(1_000_000),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

function finiteJsonValueSchema(depth: number): z.ZodType<JsonValue> {
  if (depth === 0) return domainJsonScalarSchema;
  const child = finiteJsonValueSchema(depth - 1);
  return z.union([
    domainJsonScalarSchema,
    z.array(child).max(1_000),
    z.record(child)
  ]);
}

/** Public Domain payloads are deliberately finite so Zod and generated JSON Schema stay equivalent. */
export const domainJsonValueSchema = finiteJsonValueSchema(6);

export function jsonSchemaFor(schema: z.ZodTypeAny, name: string): Record<string, JsonValue> {
  return toStrictJsonSchema(schema, name);
}
