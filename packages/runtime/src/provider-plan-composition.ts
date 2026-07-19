import {
  getDomainCommandEntry,
  getDomainCommandForProviderToolName
} from "@samurai-agent/action-catalog";
import type { ProviderOutput, ProviderToolCall } from "./backend/provider";

export interface OperationPlan {
  operation: string;
  proposedEffects: string[];
  toolCall?: ProviderToolCall;
  artifact?: {
    title: string;
    content: string;
    preview?: string;
  };
}

const memorySessionCreateOperationId = (() => {
  const command = getDomainCommandEntry("memory.session.create");
  if (!command) throw new Error("provider_plan_memory_session_command_missing");
  return command.id;
})();

export function createOperationPlans(providerOutput: ProviderOutput): OperationPlan[] {
  const operations: OperationPlan[] = [{
    operation: memorySessionCreateOperationId,
    proposedEffects: ["Keep the current user intent in session memory."]
  }];
  for (const toolCall of providerOutput.toolCalls) {
    const plan = operationPlanFromToolCall(toolCall);
    if (!plan) continue;
    if (plan.artifact) operations.unshift(plan);
    else operations.push(plan);
  }
  return operations;
}

function operationPlanFromToolCall(toolCall: ProviderToolCall): OperationPlan | undefined {
  const command = getDomainCommandForProviderToolName(toolCall.name);
  if (!command) return undefined;
  if (toolCall.name === "create_artifact") {
    const title = stringArg(toolCall.arguments.title).trim();
    const content = stringArg(toolCall.arguments.content).trim();
    if (!title || !content) return undefined;
    const preview = stringArg(toolCall.arguments.preview).trim();
    return {
      operation: command.id,
      proposedEffects: command.proposed_effects,
      toolCall,
      artifact: { title, content, ...(preview ? { preview } : {}) }
    };
  }
  if (toolCall.name === "remember_topic" || toolCall.name === "request_external_send") {
    return { operation: command.id, proposedEffects: command.proposed_effects, toolCall };
  }
  return undefined;
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}
