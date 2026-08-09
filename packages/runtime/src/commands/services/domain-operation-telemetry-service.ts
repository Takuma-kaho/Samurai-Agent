import { createId, nowIso, type BackendRunRecord, type NewWorkspaceChangeRecord, type OperationRecord, type ResourceRef, type WorkspaceChangeRecord } from "@samurai-agent/core-schemas";

export interface DomainOperationTelemetryPort {
  getBackendRun(id: string): Promise<BackendRunRecord | undefined>;
  listWorkspaceChanges(sessionId?: string): Promise<WorkspaceChangeRecord[]>;
  saveWorkspaceChange(change: NewWorkspaceChangeRecord): Promise<WorkspaceChangeRecord>;
  emitWorkspaceChange(change: WorkspaceChangeRecord): Promise<void>;
}

export interface DomainOperationTelemetryInput {
  runId: string;
  sessionId?: string;
  correlationId: string;
  operation: OperationRecord;
  resourceRef: ResourceRef;
}

/**
 * Records the BackendRun telemetry that is produced by a completed Domain
 * operation. It is deliberately separate from operation handlers: a
 * WorkspaceChange belongs to an existing BackendRun, while the operation can
 * also be called by ingress paths that do not create one.
 */
export class DomainOperationTelemetryService {
  constructor(private readonly port: DomainOperationTelemetryPort) {}

  async record(input: DomainOperationTelemetryInput): Promise<WorkspaceChangeRecord> {
    const run = await this.port.getBackendRun(input.runId);
    if (!run || (input.sessionId !== undefined && run.session_id !== input.sessionId)) {
      throw new Error(`domain_operation_telemetry_backend_run_invalid:${input.runId}`);
    }
    if (!run.room_id) throw new Error(`domain_operation_telemetry_backend_run_room_missing:${input.runId}`);
    const existing = (await this.port.listWorkspaceChanges(input.sessionId)).find((change) =>
      change.run_id === input.runId
      && (change.domain_operation_id === input.operation.id || change.legacy_operation_id === input.operation.id)
    );
    if (existing) return existing;

    const change: NewWorkspaceChangeRecord = {
      id: createId("change"),
      run_id: input.runId,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      room_id: run.room_id,
      domain_operation_id: input.operation.id,
      ...(input.operation.session_ref ? { session_ref: input.operation.session_ref } : {}),
      resource_ref: input.resourceRef,
      change_type: changeTypeForResource(input.resourceRef),
      summary: `Changed ${input.resourceRef.label ?? input.resourceRef.kind}/${input.resourceRef.id}.`,
      correlation_id: input.correlationId,
      created_at: nowIso()
    };
    const saved = await this.port.saveWorkspaceChange(change);
    await this.port.emitWorkspaceChange(saved);
    return saved;
  }
}

function changeTypeForResource(ref: ResourceRef): WorkspaceChangeRecord["change_type"] {
  switch (ref.kind) {
    case "artifact":
    case "artifact_revision":
      return "artifact_created";
    case "memory":
      return "memory_suggested";
    case "skill":
    case "skill_candidate":
      return "skill_candidate_created";
    case "collection":
    case "collection_schema":
    case "collection_record":
      return "collection_changed";
    case "settings":
      return "settings_changed";
    default:
      return "other";
  }
}
