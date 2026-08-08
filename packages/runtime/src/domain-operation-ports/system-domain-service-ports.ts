import { mcpCallValueSchema, sandboxExecValueSchema, type DomainOperationPorts, type ReflectionWorkflowInput } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";
import type { SystemMcpCallRequest, SystemSandboxExecRequest } from "../commands/services/system-domain-service.js";

type Ports = Pick<DomainOperationPorts, "mcp.call" | "reflection.run" | "reflection.suggestion.apply" | "rollback.restore" | "sandbox.exec">;

export function createSystemDomainServicePorts(services: Pick<RuntimeDomainServices, "systemDomainService">): Ports {
  return {
    "mcp.call": {
      executeMcpCall: async (context, request) => {
        const serviceRequest: SystemMcpCallRequest = {
          serverName: request.serverName,
          toolName: request.toolName,
          input: request.input,
          toolCallId: request.toolCallId
        };
        return mcpCallValueSchema.parse(await services.systemDomainService.callMcp(context, serviceRequest));
      }
    },
    "reflection.run": {
      getReflectionSession: (id) => services.systemDomainService.getReflectionSession(id),
      reflectionSessionNotFoundError: (id) => services.systemDomainService.reflectionSessionNotFoundError(id),
      getReflectionBackendRun: (id) => services.systemDomainService.getReflectionBackendRun(id),
      reflectionSourceRunNotFoundError: (id) => services.systemDomainService.reflectionSourceRunNotFoundError(id),
      reflectionSourceRunSessionMismatchError: (input) => services.systemDomainService.reflectionSourceRunSessionMismatchError(input),
      listReflectionMessages: (id) => services.systemDomainService.listReflectionMessages(id),
      listReflectionToolRuns: (runId) => services.systemDomainService.listReflectionToolRuns(runId),
      listReflectionWorkspaceChanges: (sessionId) => services.systemDomainService.listReflectionWorkspaceChanges(sessionId),
      listReflectionBackendEvents: (input) => services.systemDomainService.listReflectionBackendEvents(input),
      loadReflectionArtifacts: (input) => services.systemDomainService.loadReflectionArtifacts(input),
      executeReflectionWorkflow: (input: ReflectionWorkflowInput) => services.systemDomainService.executeReflectionWorkflow(input)
    },
    "reflection.suggestion.apply": {
      getReflectionSuggestion: (sessionId, suggestionId) => services.systemDomainService.getReflectionSuggestion(sessionId, suggestionId),
      reflectionSuggestionError: (code, message) => services.systemDomainService.reflectionSuggestionError(code, message),
      ensureReflectionMutationSession: () => services.systemDomainService.ensureReflectionMutationSession(),
      createReflectionMutationEnvelope: (content) => services.systemDomainService.createReflectionMutationEnvelope(content),
      runReflectionSuggestionMutation: (input) => services.systemDomainService.runReflectionSuggestionMutation(input),
      createReflectionMemoryTarget: (input) => services.systemDomainService.createReflectionMemoryTarget(input),
      createReflectionWikiTarget: (input) => services.systemDomainService.createReflectionWikiTarget(input),
      createReflectionSkillTarget: (input) => services.systemDomainService.createReflectionSkillTarget(input),
      createReflectionTargetRollback: (operation, refs, after) => services.systemDomainService.createReflectionTargetRollback(operation, refs, after),
      updateReflectionSuggestion: (suggestion) => services.systemDomainService.updateReflectionSuggestion(suggestion),
      reflectionNow: () => services.systemDomainService.reflectionNow()
    },
    "rollback.restore": {
      getRollbackPoint: (id) => services.systemDomainService.getRollbackPoint(id),
      rollbackRestoreError: (code, message) => services.systemDomainService.rollbackError(code, message),
      resolveRollbackPath: (path) => services.systemDomainService.resolveRollbackPath(path),
      rollbackFileRef: (path) => services.systemDomainService.rollbackFileRef(path),
      readRollbackFile: (path) => services.systemDomainService.readRollbackFile(path),
      removeRollbackFile: (path) => services.systemDomainService.removeRollbackFile(path),
      ensureRollbackParent: (path) => services.systemDomainService.ensureRollbackParent(path),
      writeRollbackFile: (path, content) => services.systemDomainService.writeRollbackFile(path, content),
      createRestoreRollback: (operation, refs, before, after) => services.systemDomainService.createRestoreRollback(operation, refs, before, after),
      runRollbackMutation: (input) => services.systemDomainService.runRollbackMutation(input),
      currentTimeMillis: () => services.systemDomainService.currentTimeMillis()
    },
    "sandbox.exec": {
      executeSandboxExec: async (context, request) => {
        const serviceRequest: SystemSandboxExecRequest = {
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          environment: request.environment,
          stdin: request.stdin,
          secretEnvironment: request.secretEnvironment,
          secretFiles: request.secretFiles.map((file) => ({
            secretRefId: file.secretRefId,
            filename: file.filename,
            environmentName: file.environmentName,
            mode: file.mode
          })),
          timeoutMs: request.timeoutMs,
          toolCallId: request.toolCallId
        };
        return sandboxExecValueSchema.parse(await services.systemDomainService.executeSandbox(context, serviceRequest));
      }
    }
  };
}
