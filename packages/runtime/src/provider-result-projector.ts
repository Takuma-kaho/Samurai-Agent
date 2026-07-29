import type { BackendOutputEvent } from "@samurai-agent/agent-backends";
import {
  AuditRecordSchema,
  type ArtifactRecord,
  type AuditRecord,
  type CollectionSchema,
  type JsonValue,
  type MemoryFrontmatter,
  OperationRecordSchema,
  type OperationRecord,
  type ResourceRef,
  type ToolRunRecord,
  type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

type CollectionSchemaWithFilePath = CollectionSchema & { file_path: string };

export interface RuntimeToolCallResult {
  operation: OperationRecord;
  toolRun: ToolRunRecord;
  outputPayload?: Record<string, JsonValue>;
  resourceRefs?: ResourceRef[];
  artifacts?: ArtifactRecord[];
  memories?: MemoryFrontmatter[];
  collectionSchemas?: CollectionSchemaWithFilePath[];
  workspaceChanges?: WorkspaceChangeRecord[];
  events?: BackendOutputEvent[];
}

/** Provider Query result. Queries do not create Operation/ToolRun records. */
export interface RuntimeToolQueryResult {
  readonly queryOnly: true;
  outputPayload?: Record<string, JsonValue>;
  resourceRefs?: ResourceRef[];
}

export function operationAuditRuntimeResult(value: unknown): {
  operation: OperationRecord;
  auditRecord?: AuditRecord;
  resourceRefs: ResourceRef[];
} | undefined {
  const record = unknownRecord(value);
  if (record.result && record.result !== value) {
    const nested = operationAuditRuntimeResult(record.result);
    if (nested) return nested;
  }
  const parsedOperation = OperationRecordSchema.safeParse(record.operation);
  if (!parsedOperation.success) return undefined;
  const parsedAuditRecord = AuditRecordSchema.safeParse(record.auditRecord);
  const resourceRefs = parsedOperation.data.target_resource_refs;
  const resultRef = parsedOperation.data.result_ref;
  return {
    operation: parsedOperation.data,
    ...(parsedAuditRecord.success ? { auditRecord: parsedAuditRecord.data } : {}),
    resourceRefs: resultRef ? [resultRef, ...resourceRefs] : resourceRefs
  };
}

export function runtimeWriteResource(value: unknown): unknown {
  const record = unknownRecord(value);
  if ("resource" in record) return record.resource;
  if (record.result && record.result !== value) return runtimeWriteResource(record.result);
  return undefined;
}

export function isArtifactRecordResource(value: unknown): value is ArtifactRecord {
  const record = unknownRecord(value);
  return typeof record.id === "string"
    && typeof record.title === "string"
    && isResourceRef(record.file_ref);
}

export function isMemoryFrontmatterResource(value: unknown): value is MemoryFrontmatter {
  const record = unknownRecord(value);
  return typeof record.id === "string"
    && typeof record.topic === "string"
    && typeof record.state === "string";
}

export function runtimeToolCallResult(value: unknown): RuntimeToolCallResult | undefined {
  const record = unknownRecord(value);
  const operation = unknownRecord(record.operation);
  const toolRun = unknownRecord(record.toolRun);
  if (typeof operation.id !== "string" || typeof toolRun.id !== "string" || !Array.isArray(record.resourceRefs)) return undefined;
  return value as RuntimeToolCallResult;
}

export function runtimeToolWorkspaceEvents(
  resource: unknown,
  resourceRefs: ResourceRef[],
  toolCallId?: string
): BackendOutputEvent[] {
  const artifact = isArtifactRecordResource(resource) ? resource : undefined;
  if (artifact) {
    return [{
      event_type: "artifact_created",
      payload: {
        artifact_id: artifact.id ?? resourceRefs[0]?.id ?? "unknown",
        title: artifact.title ?? resourceRefs[0]?.label ?? "Artifact"
      },
      resource_refs: resourceRefs,
      tool_call_id: toolCallId
    }];
  }
  const memory = isMemoryFrontmatterResource(resource) ? resource : undefined;
  if (!memory) return [];
  return [{
    event_type: "memory_suggested",
    payload: {
      memory_id: memory.id ?? resourceRefs[0]?.id ?? "unknown",
      topic: memory.topic ?? resourceRefs[0]?.label ?? "memory"
    },
    resource_refs: resourceRefs,
    tool_call_id: toolCallId
  }];
}

function isResourceRef(value: unknown): value is ResourceRef {
  const record = unknownRecord(value);
  return typeof record.kind === "string" && typeof record.id === "string" && typeof record.uri === "string";
}

function unknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
