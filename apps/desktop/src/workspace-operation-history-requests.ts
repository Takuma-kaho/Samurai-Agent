import { workspaceTargetRequest, type WorkspaceTargetRequest } from "./workspace-room-requests.js";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const workspaceOperationHistoryRecordTypes = [
  "interaction_request",
  "domain_operation",
  "generated_surface_action_result",
  "generated_surface_operation_result",
  "surface_interaction",
  "collection_record",
  "collection_patch"
] as const;

export type WorkspaceOperationHistoryRecordType = (typeof workspaceOperationHistoryRecordTypes)[number];

export interface WorkspaceOperationHistoryRequest {
  roomId: string;
  recordType: WorkspaceOperationHistoryRecordType;
  target?: WorkspaceTargetRequest;
}

/**
 * Validate the narrow read-only history request before it crosses IPC. The
 * record type is an allowlist rather than a free-form database selector so a
 * renderer cannot use this bridge to probe unrelated records.
 */
export function workspaceOperationHistoryRequest(input: unknown): WorkspaceOperationHistoryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("workspace_operation_history_request_invalid");
  }
  const value = input as Record<string, unknown>;
  const roomId = requiredOpaque(value.roomId, "roomId");
  const recordType = value.recordType;
  if (typeof recordType !== "string" || !workspaceOperationHistoryRecordTypes.includes(recordType as WorkspaceOperationHistoryRecordType)) {
    throw new Error("workspace_operation_history_record_type_invalid");
  }
  const target = workspaceTargetRequest(value.target);
  return { roomId, recordType: recordType as WorkspaceOperationHistoryRecordType, ...(target ? { target } : {}) };
}

function requiredOpaque(value: unknown, field: string): string {
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error(`${field}_invalid`);
  return value;
}
