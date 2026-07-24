import type { AgentBackendRegistry } from "@samurai-agent/agent-backends";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentHost } from "../host/agent-host";
import { TurnCompletionCoordinator } from "../host/turn-completion-coordinator";
import type {
  AdmissionObserverPort,
  CommittedEventPublisherPort,
  HostCompletionPort,
  HostContextPort,
  HostDiagnosticsPort,
  HostPorts,
  PostTurnOperations,
  TurnCleanupPort,
  TurnPreflightPort,
  TurnToolExecutionPort
} from "../host/host-types";

export interface AgentHostCompositionOptions {
  store: WorkspaceStore;
  backendRegistry: AgentBackendRegistry;
  context: HostContextPort;
  completion?: HostCompletionPort;
  preflight: TurnPreflightPort;
  committedEventPublisher: CommittedEventPublisherPort;
  admissionObserver: AdmissionObserverPort;
  toolExecution: TurnToolExecutionPort;
  cleanup: TurnCleanupPort;
  diagnostics: HostDiagnosticsPort;
  maxConcurrency?: number;
  postTurn?: PostTurnOperations;
  resolveDefaultBackendId?: () => Promise<string> | string;
}

/** Composition root for the production Host. Concrete adapters are injected here. */
export function createAgentHost(options: AgentHostCompositionOptions): AgentHost {
  const completion: HostCompletionPort = options.completion ?? new TurnCompletionCoordinator(options.store, options.postTurn ?? {}, options.diagnostics);
  const ports: HostPorts = {
    store: options.store,
    context: options.context,
    completion,
    preflight: options.preflight,
    committedEventPublisher: options.committedEventPublisher,
    admissionObserver: options.admissionObserver,
    toolExecution: options.toolExecution,
    cleanup: options.cleanup,
    diagnostics: options.diagnostics,
    maxConcurrency: options.maxConcurrency,
    resolveDefaultBackendId: options.resolveDefaultBackendId,
    postTurn: options.postTurn
  };
  return new AgentHost(options.backendRegistry, ports);
}
