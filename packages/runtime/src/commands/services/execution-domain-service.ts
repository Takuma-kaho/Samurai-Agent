import {
  type JsonValue,
  type ObjectiveRecord,
  type WorkDependencyRecord,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";
import type { WorkspaceBackupRecord, WorkspaceRepairResult, WorkspaceRestoreResult } from "@samurai-agent/workspace-store";

export interface ExecutionStorePort {
  getObjective(id: string): Promise<ObjectiveRecord | undefined>;
  saveWorkItem(record: WorkItemRecord): Promise<WorkItemRecord>;
  createWorkspaceBackup(): Promise<WorkspaceBackupRecord>;
  restoreWorkspaceBackup(backupId: string): Promise<WorkspaceRestoreResult>;
  repairWorkspace(options?: { dryRun?: boolean }): Promise<WorkspaceRepairResult>;
}

export interface WorkCoordinatorPort {
  followUp(workItemId: string, instruction: string): Promise<{ workItem: WorkItemRecord; dependency: WorkDependencyRecord }>;
  steer(workItemId: string, instruction: string): Promise<WorkItemRecord>;
}

export interface ExecutionDomainServiceDependencies {
  store: ExecutionStorePort;
  coordinator: WorkCoordinatorPort;
  requestError: (code: "not_found", message: string) => Error;
}

export class ExecutionDomainService {
  constructor(private readonly dependencies: ExecutionDomainServiceDependencies) {}

  getObjective(id: string) { return this.dependencies.store.getObjective(id); }
  saveWorkItemRecord(record: WorkItemRecord) { return this.dependencies.store.saveWorkItem(record); }
  objectiveNotFoundError() { return this.dependencies.requestError("not_found", "objective_not_found"); }

  followUpWorkItem(payload: Record<string, JsonValue>) {
    return this.dependencies.coordinator.followUp(requiredString(payload, "work_item_id"), optionalString(payload.instruction));
  }

  steerWorkItem(payload: Record<string, JsonValue>) {
    return this.dependencies.coordinator.steer(requiredString(payload, "work_item_id"), optionalString(payload.instruction));
  }

  createWorkspaceBackup() {
    return this.dependencies.store.createWorkspaceBackup();
  }

  restoreWorkspaceBackup(payload: Record<string, JsonValue>) {
    return this.dependencies.store.restoreWorkspaceBackup(requiredString(payload, "backup_id"));
  }

  repairWorkspace(payload: Record<string, JsonValue>) {
    return this.dependencies.store.repairWorkspace({ dryRun: payload.dry_run !== false });
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
