import { mcpCallValueSchema, sandboxExecValueSchema, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "mcp.call" | "reflection.run" | "reflection.suggestion.apply" | "rollback.restore" | "sandbox.exec">;

export function createSystemDomainServicePorts(services: Pick<RuntimeDomainServices, "systemDomainService">): Ports {
  return {
    "mcp.call": {
      executeMcpCall: async (context, input) => ({
        ok: true as const,
        value: mcpCallValueSchema.parse(await services.systemDomainService.callMcp(context, input))
      })
    },
    "reflection.run": {
      executeReflectionRun: async (context, input) => ({
        ok: true as const,
        value: await services.systemDomainService.runReflection(input)
      })
    },
    "reflection.suggestion.apply": {
      executeReflectionSuggestionApply: async (context, input) => ({
        ok: true as const,
        value: await services.systemDomainService.applyReflection(input)
      })
    },
    "rollback.restore": {
      executeRollbackRestore: async (context, input) => ({
        ok: true as const,
        value: await services.systemDomainService.restoreRollback(input)
      })
    },
    "sandbox.exec": {
      executeSandboxExec: async (context, input) => ({
        ok: true as const,
        value: sandboxExecValueSchema.parse(await services.systemDomainService.executeSandbox(context, input))
      })
    }
  };
}
