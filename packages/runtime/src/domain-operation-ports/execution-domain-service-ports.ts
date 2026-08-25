import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "work_item.create" | "work_item.follow_up" | "work_item.steer" | "workspace.backup.create" | "workspace.backup.restore" | "workspace.repair">;

export function createExecutionDomainServicePorts(services: Pick<RuntimeDomainServices, "executionDomainService">): Ports {
  return {
    "work_item.create": {
      getWorkItemObjective: (id, roomId) => services.executionDomainService.getObjective(id, roomId),
      saveWorkItem: (record) => services.executionDomainService.saveWorkItemRecord(record),
      workItemObjectiveNotFoundError: () => services.executionDomainService.objectiveNotFoundError()
    },
    "work_item.follow_up": {
      createFollowUpWorkItem: (input) => services.executionDomainService.followUpWorkItem(input)
    },
    "work_item.steer": {
      steerWorkItem: (input) => services.executionDomainService.steerWorkItem(input)
    },
    "workspace.backup.create": {
      createWorkspaceBackup: () => services.executionDomainService.createWorkspaceBackup()
    },
    "workspace.backup.restore": {
      restoreWorkspaceBackup: (input) => services.executionDomainService.restoreWorkspaceBackup(input)
    },
    "workspace.repair": {
      repairWorkspace: (input) => services.executionDomainService.repairWorkspace(input)
    }
  };
}
