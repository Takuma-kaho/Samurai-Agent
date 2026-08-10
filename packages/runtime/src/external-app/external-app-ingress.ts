import type {
  ActivityRecord,
  ConnectorEvidence,
  ExternalAppIngressClass,
  JsonValue,
  ResourceRef,
  ResourceUsageStage
} from "@samurai-agent/core-schemas";
import {
  ActivityFailureSchema,
  ActivityRecordStatusSchema,
  ActivityVerificationRecordSchema,
  ResourceRefSchema,
  ResourceUsageStageSchema,
  createId
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import type { ActivityIngestPort } from "../activity/activity-ingest-port.js";
import type { DomainCommandRuntimeResult, DomainQueryRuntimeResult, TrustedDomainRuntimeContext } from "../agent-runtime.js";
import { ExternalAppContextError, ExternalAppContextResolver, type RequestedWorkspaceTarget } from "./external-app-context-resolver.js";

export interface ExternalAppIngressRuntime {
  runDomainQuery(input: { query_id: string; payload?: unknown; input_source: "external_app" }, trusted: TrustedDomainRuntimeContext): Promise<DomainQueryRuntimeResult>;
  runDomainCommand(input: { command_id: string; payload?: unknown; input_source: "external_app"; idempotency_key: string }, trusted: TrustedDomainRuntimeContext): Promise<DomainCommandRuntimeResult>;
}

/** Public evidence shape. Authority, usage scope, and job references are server-owned. */
export interface ExternalActivityResourceUsage {
  resource_ref: ResourceRef;
  stage: ResourceUsageStage;
  resource_version?: string;
  content_hash?: string;
}

const ExternalActivityResourceUsageSchema = z.object({
  resource_ref: ResourceRefSchema,
  stage: ResourceUsageStageSchema,
  resource_version: z.string().trim().min(1).max(512).optional(),
  content_hash: z.string().trim().min(1).max(512).optional()
}).strict();

const ExternalActivityIngestSchema = z.object({
  evidence: z.unknown(),
  target: z.unknown(),
  idempotency_key: z.string().trim().min(1).max(512),
  instruction_summary: z.string().trim().min(1).max(20_000),
  status: ActivityRecordStatusSchema.refine((status) => status !== "recording", "external_activity_must_be_finalized"),
  result_summary: z.string().trim().min(1).max(20_000).optional(),
  verification: z.array(ActivityVerificationRecordSchema).max(200).optional(),
  failure: ActivityFailureSchema.optional(),
  domain_operation_ids: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
  correction_of_activity_id: z.string().trim().min(1).max(512).optional(),
  resource_usage: z.array(ExternalActivityResourceUsageSchema).max(200).optional()
}).strict();

/**
 * The sole formal Core09 ingress. Transport adapters can only provide
 * ConnectorEvidence plus a requested target; they never receive Store access.
 */
export class ExternalAppIngress {
  constructor(private readonly dependencies: {
    resolver: ExternalAppContextResolver;
    runtime: ExternalAppIngressRuntime;
    activityIngest: ActivityIngestPort;
  }) {}

  async query(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    query_id: string;
    payload?: unknown;
  }): Promise<DomainQueryRuntimeResult> {
    const resolved = await this.dependencies.resolver.resolve({ evidence: input.evidence, target: input.target, ingressClass: "query" });
    return this.dependencies.runtime.runDomainQuery({
      query_id: input.query_id,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      input_source: "external_app"
    }, resolved.trustedContext);
  }

  async domainOperation(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    command_id: string;
    payload?: unknown;
  }): Promise<DomainCommandRuntimeResult> {
    const resolved = await this.dependencies.resolver.resolve({ evidence: input.evidence, target: input.target, ingressClass: "domain_operation" });
    const key = resolved.trustedContext.idempotencyKey;
    if (!key) throw new ExternalAppContextError("external_app_requested_room_invalid", "external_app_idempotency_key_required");
    return this.dependencies.runtime.runDomainCommand({
      command_id: input.command_id,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
      input_source: "external_app",
      idempotency_key: key
    }, resolved.trustedContext);
  }

  async activityIngest(input: {
    evidence: ConnectorEvidence;
    target: RequestedWorkspaceTarget;
    idempotency_key: string;
    instruction_summary: string;
    status: Exclude<ActivityRecord["status"], "recording">;
    result_summary?: string;
    verification?: ActivityRecord["verification"];
    failure?: ActivityRecord["failure"];
    domain_operation_ids?: string[];
    correction_of_activity_id?: string;
    resource_usage?: ExternalActivityResourceUsage[];
  }): Promise<ActivityRecord> {
    const publicInput = ExternalActivityIngestSchema.parse(input);
    const resolved = await this.dependencies.resolver.resolve({
      evidence: publicInput.evidence as ConnectorEvidence,
      target: publicInput.target as RequestedWorkspaceTarget,
      ingressClass: "activity_ingest"
    });
    return this.dependencies.activityIngest.ingestFinalizedActivity({
      context: resolved.workspaceContext,
      idempotencyKey: publicInput.idempotency_key,
      instructionSummary: publicInput.instruction_summary,
      status: publicInput.status,
      ...(publicInput.result_summary ? { resultSummary: publicInput.result_summary } : {}),
      ...(publicInput.verification ? { verification: publicInput.verification } : {}),
      ...(publicInput.failure ? { failure: publicInput.failure } : {}),
      ...(publicInput.domain_operation_ids ? { domainOperationIds: publicInput.domain_operation_ids } : {}),
      ...(publicInput.correction_of_activity_id ? { correctionOfActivityId: publicInput.correction_of_activity_id } : {}),
      ...(publicInput.resource_usage ? {
        resourceUsage: publicInput.resource_usage.map((usage) => ({
          id: createId("resource_usage"),
          resource_ref: usage.resource_ref,
          stage: usage.stage,
          ...(usage.resource_version ? { resource_version: usage.resource_version } : {}),
          ...(usage.content_hash ? { content_hash: usage.content_hash } : {}),
          usage_scope: { kind: "room" as const, room_id: resolved.workspaceContext.room_id! }
        }))
      } : {})
    });
  }
}

export const externalAppIngressClasses: readonly ExternalAppIngressClass[] = ["query", "domain_operation", "activity_ingest"];
export type ExternalAppIngressPayload = Record<string, JsonValue>;
