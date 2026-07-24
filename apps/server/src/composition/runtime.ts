import { AgentRuntime, createAgentHost, createRuntimeAgentHost, type AgentHostCompositionOptions, type AgentHost, type AgentRuntimeWorkspaceOptions, type RuntimeHostCompositionDependencies } from "@samurai-agent/runtime";

type AgentRuntimeConstructor = ConstructorParameters<typeof AgentRuntime>;

export interface AgentRuntimeCompositionOptions {
  store: AgentRuntimeConstructor[0];
  emit?: AgentRuntimeConstructor[1];
  provider?: AgentRuntimeConstructor[2];
  backendRegistry?: AgentRuntimeConstructor[3];
  pluginRegistry?: AgentRuntimeConstructor[4];
  externalAssistProviders?: AgentRuntimeConstructor[5];
  evaluationJudgeProvider?: AgentRuntimeConstructor[6];
  workspaceOptions?: AgentRuntimeWorkspaceOptions;
}

/** Single production composition point for Host dependencies. */
export function composeAgentHost(options: AgentHostCompositionOptions): AgentHost {
  return createAgentHost(options);
}

export function composeRuntimeHost(dependencies: RuntimeHostCompositionDependencies): AgentHost {
  return createRuntimeAgentHost(dependencies);
}

/** Server composition root: construct the Runtime and its single AgentHost once. */
export function composeAgentRuntime(options: AgentRuntimeCompositionOptions): AgentRuntime {
  if (!options.workspaceOptions?.productionLogger) {
    throw new Error("production_logger_required");
  }
  const runtime = new AgentRuntime(
    options.store,
    options.emit,
    options.provider,
    options.backendRegistry,
    options.pluginRegistry,
    options.externalAssistProviders,
    options.evaluationJudgeProvider,
    {
      ...(options.workspaceOptions ?? {}),
      deferHost: true
    }
  );
  runtime.attachAgentHost(composeRuntimeHost(runtime.getHostCompositionDependencies()));
  return runtime;
}
