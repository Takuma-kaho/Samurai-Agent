import {
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

export interface FollowUpWorkItemInput {
  workItemId: string;
  instruction?: string;
}

export interface SteerWorkItemInput {
  workItemId: string;
  instruction?: string;
}

export interface RestoreWorkspaceBackupInput {
  backupId: string;
}

export interface RepairWorkspaceInput {
  dryRun: boolean;
}

export class ExecutionDomainService {
  constructor(private readonly dependencies: ExecutionDomainServiceDependencies) {}

  getObjective(id: string) { return this.dependencies.store.getObjective(id); }
  saveWorkItemRecord(record: WorkItemRecord) { return this.dependencies.store.saveWorkItem(record); }
  objectiveNotFoundError() { return this.dependencies.requestError("not_found", "objective_not_found"); }

  followUpWorkItem(input: FollowUpWorkItemInput) {
    return this.dependencies.coordinator.followUp(input.workItemId, input.instruction ?? "");
  }

  steerWorkItem(input: SteerWorkItemInput) {
    return this.dependencies.coordinator.steer(input.workItemId, input.instruction ?? "");
  }

  createWorkspaceBackup() {
    return this.dependencies.store.createWorkspaceBackup();
  }

  restoreWorkspaceBackup(input: RestoreWorkspaceBackupInput) {
    return this.dependencies.store.restoreWorkspaceBackup(input.backupId);
  }

  repairWorkspace(input: RepairWorkspaceInput) {
    return this.dependencies.store.repairWorkspace({ dryRun: input.dryRun });
  }
}
