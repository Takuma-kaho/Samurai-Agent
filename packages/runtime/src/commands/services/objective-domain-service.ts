import type { ObjectiveRecord, WorkItemRecord } from "@samurai-agent/core-schemas";

export interface ObjectiveWritePort {
  save(record: ObjectiveRecord): Promise<ObjectiveRecord>;
  transition(objectiveId: string, action: "pause" | "resume" | "cancel"): Promise<{
    objective: ObjectiveRecord; workItems: WorkItemRecord[]; cancelBackendRunIds: string[];
  }>;
}

export interface ObjectiveDomainServiceDependencies { objectives: ObjectiveWritePort; }

export class ObjectiveDomainService {
  constructor(private readonly dependencies: ObjectiveDomainServiceDependencies) {}

  save(record: ObjectiveRecord) {
    return this.dependencies.objectives.save(record);
  }

  transition(id: string, action: "pause" | "resume" | "cancel") {
    return this.dependencies.objectives.transition(id, action);
  }
}
