import { nowIso, type BackendRunRecord, type ObjectiveRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import { createFollowUpWorkItem, steerWorkItem, transitionObjectiveState } from "./work-state-machine";

export interface BackendRunCancellationPort {
  cancelRun(runId: string): Promise<BackendRunRecord>;
}

export class DurableWorkCoordinator {
  constructor(private readonly store: WorkspaceStore, private readonly runControl: BackendRunCancellationPort) {}

  async transitionObjective(objectiveId: string, action: "pause" | "resume" | "cancel", now = nowIso()) {
    const objective = await this.requireObjective(objectiveId);
    const workItems = await this.store.listWorkItems({ objectiveId });
    const transition = transitionObjectiveState({ objective, workItems, action, now });
    await this.store.saveObjective(transition.objective);
    for (const workItem of transition.workItems) await this.store.saveWorkItem(workItem);
    if (action === "cancel") {
      for (const runId of transition.cancelBackendRunIds) {
        const run = await this.store.getBackendRun(runId);
        if (!run) continue;
        await this.runControl.cancelRun(run.id);
      }
    }
    return transition;
  }

  async steer(workItemId: string, instruction: string, now = nowIso()): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(workItemId);
    return this.store.saveWorkItem(steerWorkItem({ workItem, instruction, now }));
  }

  async followUp(workItemId: string, instruction: string, now = nowIso()) {
    const current = await this.requireWorkItem(workItemId);
    const objective = await this.requireObjective(current.objective_id);
    const created = createFollowUpWorkItem({ objective, current, instruction, now });
    await this.store.saveWorkItem(created.workItem);
    await this.store.saveWorkDependency(created.dependency);
    return created;
  }

  private async requireObjective(id: string): Promise<ObjectiveRecord> {
    const objective = await this.store.getObjective(id);
    if (!objective) throw new Error(`objective_not_found:${id}`);
    return objective;
  }

  private async requireWorkItem(id: string): Promise<WorkItemRecord> {
    const workItem = await this.store.getWorkItem(id);
    if (!workItem) throw new Error(`work_item_not_found:${id}`);
    return workItem;
  }
}
