import type { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentHost } from "../host/agent-host";
import { TurnCompletionCoordinator } from "../host/turn-completion-coordinator";
import type { HostCompletionPort, HostContextPort, HostPorts, PostTurnPort, TurnCleanupPort } from "../host/host-types";

export interface AgentHostCompositionOptions {
  store: WorkspaceStore;
  backendRegistry: AgentBackendRegistry;
  context: HostContextPort;
  completion?: HostCompletionPort;
  maxConcurrency?: number;
  postTurns?: readonly PostTurnPort[];
  cleanup?: TurnCleanupPort;
  onPostTurnFailure?: (input: { runId: string; operation: string; error: unknown }) => void | Promise<void>;
}

/** Composition root for the production Host. Concrete adapters are injected here. */
export function createAgentHost(options: AgentHostCompositionOptions): AgentHost {
  const completion: HostCompletionPort = options.completion ?? new TurnCompletionCoordinator(options.store, options.postTurns, undefined, options.onPostTurnFailure);
  const ports: HostPorts = {
    store: options.store,
    context: options.context,
    completion,
    maxConcurrency: options.maxConcurrency,
    resolveDefaultBackendId: undefined,
    cleanup: options.cleanup
  };
  return new AgentHost(options.backendRegistry, ports);
}
