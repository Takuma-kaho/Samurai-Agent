import type {
  ActivityInboxItem,
  ApprovalRequest,
  ArtifactRecord,
  AuditRecord,
  BackendEventRecord,
  BackendRunRecord,
  MemoryFrontmatter,
  MessageRecord,
  OperationRecord,
  PolicyDecisionRecord,
  SessionRecord,
  SettingsRecord,
  WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";

export const socketEvents = [
  "session.created",
  "message.created",
  "operation.created",
  "policy.decided",
  "artifact.created",
  "memory.candidate.created",
  "approval.requested",
  "audit.recorded",
  "activity.updated",
  "backend.run.created",
  "backend.run.updated",
  "backend.event.created",
  "workspace.change.created",
  "settings.updated"
] as const;

export type SocketEventName = (typeof socketEvents)[number];

export interface SocketEventPayloads {
  "session.created": SessionRecord;
  "message.created": MessageRecord;
  "operation.created": OperationRecord;
  "policy.decided": PolicyDecisionRecord;
  "artifact.created": ArtifactRecord;
  "memory.candidate.created": MemoryFrontmatter;
  "approval.requested": ApprovalRequest;
  "audit.recorded": AuditRecord;
  "activity.updated": ActivityInboxItem[];
  "backend.run.created": BackendRunRecord;
  "backend.run.updated": BackendRunRecord;
  "backend.event.created": BackendEventRecord;
  "workspace.change.created": WorkspaceChangeRecord;
  "settings.updated": SettingsRecord;
}

export interface RuntimeEvent<TName extends SocketEventName = SocketEventName> {
  name: TName;
  payload: SocketEventPayloads[TName];
}

export type RuntimeEventSink = <TName extends SocketEventName>(
  name: TName,
  payload: SocketEventPayloads[TName]
) => void | Promise<void>;
