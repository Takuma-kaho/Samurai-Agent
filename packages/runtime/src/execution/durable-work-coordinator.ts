import { nowIso, type BackendRunRecord, type ObjectiveRecord, type WorkDependencyRecord, type WorkItemRecord } from "@samurai-agent/core-schemas";
import { createFollowUpWorkItem, steerWorkItem, transitionObjectiveState } from "./work-state-machine";

export interface BackendRunCancellationPort {
  cancelRun(runId: string): Promise<BackendRunRecord>;
}

export interface DurableWorkStorePort {
  getObjective(id: string, roomId: string): Promise<ObjectiveRecord | undefined>;
  listWorkItems(input: { objectiveId?: string; status?: WorkItemRecord["status"]; roomId: string }): Promise<WorkItemRecord[]>;
  saveObjective(record: ObjectiveRecord, roomId: string): Promise<ObjectiveRecord>;
  saveWorkItem(record: WorkItemRecord, roomId: string): Promise<WorkItemRecord>;
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  getWorkItem(id: string, roomId: string): Promise<WorkItemRecord | undefined>;
  saveWorkDependency(record: WorkDependencyRecord, roomId: string): Promise<WorkDependencyRecord>;
}

export class DurableWorkCoordinator {
  constructor(private readonly store: DurableWorkStorePort, private readonly runControl: BackendRunCancellationPort) {}

  async transitionObjective(objectiveId: string, action: "pause" | "resume" | "cancel", roomId: string, now = nowIso()) {
    const objective = await this.requireObjective(objectiveId, roomId);
    assertRoomBinding(objective.room_id, roomId, "objective");
    const workItems = await this.store.listWorkItems({ objectiveId, roomId });
    for (const workItem of workItems) assertRoomBinding(workItem.room_id, roomId, "work_item");
    const transition = transitionObjectiveState({ objective, workItems, action, now });
    await this.store.saveObjective(transition.objective, roomId);
    for (const workItem of transition.workItems) await this.store.saveWorkItem(workItem, roomId);
    if (action === "cancel") {
      for (const runId of transition.cancelBackendRunIds) {
        const run = await this.store.getBackendRun(runId);
        if (!run) continue;
        await this.runControl.cancelRun(run.id);
      }
    }
    return transition;
  }

  async steer(workItemId: string, instruction: string, roomId: string, now = nowIso()): Promise<WorkItemRecord> {
    const workItem = await this.requireWorkItem(workItemId, roomId);
    assertRoomBinding(workItem.room_id, roomId, "work_item");
    return this.store.saveWorkItem(steerWorkItem({ workItem, instruction, now }), roomId);
  }

  async followUp(workItemId: string, instruction: string, roomId: string, now = nowIso()) {
    const current = await this.requireWorkItem(workItemId, roomId);
    assertRoomBinding(current.room_id, roomId, "work_item");
    const objective = await this.requireObjective(current.objective_id, roomId);
    assertRoomBinding(objective.room_id, roomId, "objective");
    const created = createFollowUpWorkItem({ objective, current, instruction, now });
    await this.store.saveWorkItem(created.workItem, roomId);
    await this.store.saveWorkDependency(created.dependency, roomId);
    return created;
  }

  private async requireObjective(id: string, roomId: string): Promise<ObjectiveRecord> {
    const objective = await this.store.getObjective(id, roomId);
    if (!objective) throw new Error(`objective_not_found:${id}`);
    return objective;
  }

  private async requireWorkItem(id: string, roomId: string): Promise<WorkItemRecord> {
    const workItem = await this.store.getWorkItem(id, roomId);
    if (!workItem) throw new Error(`work_item_not_found:${id}`);
    return workItem;
  }
}

function assertRoomBinding(recordRoomId: string | undefined, requestedRoomId: string, resourceKind: "objective" | "work_item"): void {
  if (!requestedRoomId.trim() || recordRoomId !== requestedRoomId) {
    throw new Error(`${resourceKind}_room_access_denied`);
  }
}
