import {
  getDomainCommandForProviderToolName,
  getDomainCommandEntry,
  getDomainQueryForProviderToolName,
  requireDomainCommandEntry
} from "@samurai-agent/action-catalog";

const artifactCommandIdValue = "artifact.create" as const;
const memoryCommandIdValue = "memory.topic.create" as const;
const generatedSurfaceCreateCommandIdValue = "generated_surface.create" as const;
const generatedSurfaceReviseCommandIdValue = "generated_surface.revise" as const;
const collectionPatchCommandIdValue = "collection.patch.apply" as const;
const mcpCallCommandIdValue = "mcp.call" as const;
const sandboxExecCommandIdValue = "sandbox.exec" as const;
const artifactCommand = requireDomainCommandEntry(artifactCommandIdValue);
const memoryCommand = requireDomainCommandEntry(memoryCommandIdValue);
const generatedSurfaceCreateCommand = requireDomainCommandEntry(generatedSurfaceCreateCommandIdValue);
const generatedSurfaceReviseCommand = requireDomainCommandEntry(generatedSurfaceReviseCommandIdValue);
const collectionPatchCommand = requireDomainCommandEntry(collectionPatchCommandIdValue);
const mcpCallCommand = requireDomainCommandEntry(mcpCallCommandIdValue);

export type ProviderCapturedWriteCommandId = typeof artifactCommandIdValue | typeof memoryCommandIdValue;
export type GeneratedSurfaceWriteCommandId = typeof generatedSurfaceCreateCommandIdValue | typeof generatedSurfaceReviseCommandIdValue;

export function providerCapturedWriteCommandId(toolName: string): ProviderCapturedWriteCommandId | undefined {
  const id = getDomainCommandEntry(toolName)?.id ?? getDomainCommandForProviderToolName(toolName)?.id;
  if (id === artifactCommand.id) return artifactCommandIdValue;
  if (id === memoryCommand.id) return memoryCommandIdValue;
  return undefined;
}

export function isProviderSkillView(toolName: string): boolean {
  return getDomainQueryForProviderToolName(toolName)?.id === getDomainQueryForProviderToolName("samurai.skill.view")?.id;
}

export function effectiveProviderCommandId(commandId: string, activeSurfaceId: string | undefined, shouldRevise: boolean): string {
  return commandId === generatedSurfaceCreateCommand.id && activeSurfaceId && shouldRevise
    ? generatedSurfaceReviseCommand.id
    : commandId;
}

export function isGeneratedSurfaceWrite(commandId: string): boolean {
  return commandId === generatedSurfaceCreateCommand.id || commandId === generatedSurfaceReviseCommand.id;
}

export function isGeneratedSurfaceRevision(commandId: string): boolean {
  return commandId === generatedSurfaceReviseCommand.id;
}

export function generatedSurfaceWriteCommandId(commandId: string): GeneratedSurfaceWriteCommandId | undefined {
  if (commandId === generatedSurfaceCreateCommand.id) return generatedSurfaceCreateCommandIdValue;
  if (commandId === generatedSurfaceReviseCommand.id) return generatedSurfaceReviseCommandIdValue;
  return undefined;
}

export function artifactCommandId(): typeof artifactCommandIdValue { return artifactCommandIdValue; }
export function memoryCommandId(): typeof memoryCommandIdValue { return memoryCommandIdValue; }
export function collectionPatchCommandId(): typeof collectionPatchCommandIdValue { return collectionPatchCommandIdValue; }
export function mcpCallCommandId(): typeof mcpCallCommandIdValue { return mcpCallCommandIdValue; }
export function sandboxExecCommandId(): typeof sandboxExecCommandIdValue { return sandboxExecCommandIdValue; }
export function isArtifactCommand(commandId: string): boolean { return commandId === artifactCommand.id; }
export function isMemoryCommand(commandId: string): boolean { return commandId === memoryCommand.id; }
export function isMcpCallCommand(commandId: string): boolean { return commandId === mcpCallCommand.id; }
