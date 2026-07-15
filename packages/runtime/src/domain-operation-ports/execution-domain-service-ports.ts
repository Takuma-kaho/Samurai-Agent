import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "work_item.create" | "work_item.follow_up" | "work_item.steer" | "workspace.backup.create" | "workspace.backup.restore" | "workspace.repair">;

export function createExecutionDomainServicePorts(services: Pick<RuntimeDomainServices, "executionDomainService">): Ports {
  return {
    "work_item.create": {
      executeWorkItemCreate: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.createWorkItem(input)
      })
    },
    "work_item.follow_up": {
      executeWorkItemFollowUp: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.followUpWorkItem(input)
      })
    },
    "work_item.steer": {
      executeWorkItemSteer: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.steerWorkItem(input)
      })
    },
    "workspace.backup.create": {
      executeWorkspaceBackupCreate: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.createWorkspaceBackup()
      })
    },
    "workspace.backup.restore": {
      executeWorkspaceBackupRestore: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.restoreWorkspaceBackup(input)
      })
    },
    "workspace.repair": {
      executeWorkspaceRepair: async (context, input) => ({
        ok: true as const,
        value: await services.executionDomainService.repairWorkspace(input)
      })
    }
  };
}

