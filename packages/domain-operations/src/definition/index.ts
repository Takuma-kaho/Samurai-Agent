import { toStrictJsonSchema, type JsonValue } from "@samurai-agent/core-schemas";
import { principalParticipantId, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { z } from "zod";
import { domainOperationAccess, type DomainAccessClassification } from "./access-classification.js";

export const domainInputSources = [
  "surface_operation",
  "provider_tool_call",
  "runtime_api",
  "external_app",
  "gateway_inbound",
  "automation",
  "generated_surface",
  "scheduled_context"
] as const;
export type DomainInputSource = (typeof domainInputSources)[number];

/**
 * Closed compatibility boundary for operations that still belong to the
 * Native App/legacy Session surface.  A Session-less ingress must not invent
 * a Session just to make one of these operations appear available.
 */
export const sessionCompatibleOperationIds = new Set<string>([
  "chat.turn.run",
  "session.create",
  "session.search",
  "search.session",
  "memory.archive",
  "memory.session.create",
  "learning.background_review.apply",
  "learning.resource.usage.record",
  "learning.resource.version.restore",
  "learning.resource.version.update",
  "learning.snapshot.prune",
  "curator.pause",
  "curator.restore",
  "curator.resume",
  "curator.run",
  "curator.snapshot.create",
  "curator.snapshot.list",
  "reflection.run",
  "reflection.suggestion.apply",
  "evaluation.run",
  "automation.job.release_lock",
  "automation.job.requeue",
  "browser.download_to_workspace",
  "browser.extract",
  "browser.interact",
  "browser.navigate",
  "browser.screenshot",
  "external.send",
  "external.send.dispatch",
  "external.send.prepare",
  "mcp.call",
  "sandbox.exec",
  "skill.lifecycle.apply",
  "skill.optimization.cancel",
  "skill.optimization.promote",
  "skill.optimization.reject",
  "skill.optimization.rollback",
  "skill.optimization.start",
  "message.presentation.update",
  "collection.manage",
  "generated_surface.state",
]);

export function isSessionCompatibleOperation(operationId: string): boolean {
  return sessionCompatibleOperationIds.has(operationId);
}

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
  /** Core 06 actor, selected only by a trusted ingress or a persisted Run. */
  participant?: ParticipantPrincipal;
  /** Server-resolved Room target. Public payloads never supply this field. */
  roomId?: string;
  sessionId?: string;
  /** Optional app-owned reference; never an authorization input. */
  sessionRef?: import("@samurai-agent/core-schemas").SessionRef;
  source?: import("@samurai-agent/core-schemas").TrustedWorkspaceSource;
  runId?: string;
  /** Server-selected input envelope; never populated from a command payload. */
  envelopeId?: string;
  /** Server-validated Surface operation identity; never populated from a command payload. */
  surfaceOperation?: {
    id: string;
    kind: string;
  };
  correlationId: string;
  /** Server-supplied stable identity for retry-safe admission. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

/** Artifact ownership is selected from trusted ingress identity, never payload. */
export function trustedCreatorId(context: TrustedDomainContext): string {
  return context.participant ? principalParticipantId(context.participant) : context.actorId;
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

/**
 * An executable definition keeps the concrete input/output types captured at
 * binding time.  The registry deliberately stores this opaque boundary rather
 * than widening every handler to `OperationHandler<unknown, unknown>`.
 */
export interface BoundOperationDefinition {
  readonly definition: OperationDefinition;
  readonly handlerName: string;
  execute(context: TrustedDomainContext, rawInput: unknown): Promise<DomainResult<unknown>>;
}

export class DomainContractError extends Error {
  constructor(
    readonly stage: "input" | "result" | "output",
    readonly operationId: string,
    readonly issue: { path: (string | number)[]; message: string } | undefined
  ) {
    super(`domain_operation_${stage}_invalid:${operationId}`);
    this.name = "DomainContractError";
  }
}

/**
 * A handler may require identity selected by the Runtime, rather than a value
 * supplied in its public input DTO. Keeping this distinct from input-schema
 * failures prevents a payload field from ever becoming an authority channel.
 */
export class TrustedDomainContextError extends Error {
  constructor(
    readonly operationId: string,
    readonly field: "runId" | "roomId"
  ) {
    super(`domain_operation_trusted_context_missing:${operationId}:${field}`);
    this.name = "TrustedDomainContextError";
  }
}

/** Room operations receive the selected Room from the trusted transport. */
export function requireRoomContext(context: TrustedDomainContext, operationId: string): string {
  const roomId = context.roomId?.trim();
  if (!roomId) throw new TrustedDomainContextError(operationId, "roomId");
  return roomId;
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
  /** Explicit Core 06 ownership boundary; assigned from the closed registry. */
  access: DomainAccessClassification;
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
export const domainQueryReadCapability: unique symbol = Symbol("samurai.domain.query.read");
export const domainWriteCapability: unique symbol = Symbol("samurai.domain.write");

export interface DomainQueryPorts {
  readonly [domainQueryReadCapability]: true;
  readonly [domainWriteCapability]?: never;
}

export interface DomainWritePorts {
  readonly [domainWriteCapability]: true;
  readonly [domainQueryReadCapability]?: never;
}

export type ReadCapability<Fn extends (...args: any[]) => any> = Fn & {
  readonly [domainQueryReadCapability]: true;
};

export type QueryPortContract<P extends DomainQueryPorts> = {
  [K in keyof P]: P[K] extends (...args: any[]) => any
    ? P[K] extends { readonly [domainQueryReadCapability]: true } ? P[K] : never
    : P[K];
};

export function defineCommand<P>() {
  return <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: Omit<CommandDefinition<I, O, P>, "kind" | "access">): CommandDefinition<I, O, P> =>
    Object.freeze({ ...definition, access: domainOperationAccess(definition.id), kind: "command" as const });
}

export function defineQuery<P extends DomainQueryPorts>() {
  return <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(definition: Omit<QueryDefinition<I, O, QueryPortContract<P>>, "kind" | "effect" | "idempotency" | "concurrency" | "access">): QueryDefinition<I, O, QueryPortContract<P>> =>
    Object.freeze({ ...definition, access: domainOperationAccess(definition.id), kind: "query" as const, effect: "read_only" as const, idempotency: "none" as const, concurrency: "none" as const });
}

/**
 * Bind a definition and its handler while their Zod-inferred types are still
 * known.  Only this closure may accept raw transport input; handlers always
 * receive the validated operation DTO.
 */
export function bindOperationDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny, P>(
  definition: CommandDefinition<I, O, P> | QueryDefinition<I, O, P>,
  handler: OperationHandler<z.infer<I>, z.infer<O>>
): BoundOperationDefinition {
  const handlerName = handler.execute.name;
  if (!handlerName) throw new Error(`domain_operation_handler_name_missing:${definition.id}`);
  return Object.freeze({
    definition,
    handlerName,
    async execute(context: TrustedDomainContext, rawInput: unknown): Promise<DomainResult<unknown>> {
      const input = definition.input.safeParse(rawInput);
      if (!input.success) {
        throw new DomainContractError("input", definition.id, input.error.issues[0]);
      }
      const result = await handler.execute(context, input.data);
      const envelope = domainResultEnvelopeSchema.safeParse(result);
      if (!envelope.success) {
        throw new DomainContractError("result", definition.id, envelope.error.issues[0]);
      }
      const output = definition.output.safeParse(envelope.data.value);
      if (!output.success) {
        throw new DomainContractError("output", definition.id, output.error.issues[0]);
      }
      return { ok: true, value: output.data };
    }
  });
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
