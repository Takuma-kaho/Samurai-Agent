import type { AgentBackend, AgentBackendRegistry, BackendExecutionContext, BackendOutputEvent, BackendRunInput, BackendToolCallStartedEvent } from "@samurai-agent/agent-backends";
import {
  nowIso,
  stableHash,
  type BackendEventRecord,
  type BackendRunRecord,
  type ContextPreview,
  type ExternalAssistRecord,
  type GatewayBoundaryPolicy,
  type JsonValue,
  type AgentRecord,
  type SessionRecord
} from "@samurai-agent/core-schemas";
import type { RuntimeEventSink } from "@samurai-agent/ui-protocol";
import { buildContextPreview, type ContextPreviewPorts } from "../context/context-preview";
import { createBackendToolBridge } from "../host/backend-tool-bridge";
import { projectBackendEventForUi } from "../backend/event-bridge";
import { createAgentHost } from "./create-agent-host";
import {
  applyGatewayBoundaryAllowedTools,
  applyGatewayBoundaryToContextAssembly,
  buildContextHandoffForBackend,
  classifyBackendContextIntent,
  contextAssemblyRuntimeMetadata,
  contextHandoffRuntimeMetadata,
  expectedBackendOutputs,
  gatewayBoundaryRuntimeMetadata,
  gatewayBoundaryRuntimeSnapshot,
  shouldThinExternalBackendContext
} from "../host/turn-preparation-policy";
import type {
  AdmittedTurn,
  HostContextPort,
  HostDiagnosticsPort,
  TurnRequest
} from "../host/host-types";
import type { RuntimeWorkspacePort } from "./runtime-workspace-ports";

export interface HostExternalAssistSyncInput {
  sessionId: string;
  runId: string;
  inputMessageId: string;
  query: string;
  userContent: string;
  assistantContent: string;
  role: "assistive" | "disabled";
}

export interface HostToolInput {
  run: BackendRunRecord;
  runInput: BackendRunInput;
  event: BackendToolCallStartedEvent;
  gatewayBoundaryPolicy?: GatewayBoundaryPolicy;
  recordEvent: (event: BackendOutputEvent) => Promise<BackendEventRecord>;
}

export interface RuntimeHostCompositionDependencies {
  /** Infrastructure shared by the Host adapters. */
  core: {
    store: RuntimeWorkspacePort;
    backendRegistry: AgentBackendRegistry;
    emit: RuntimeEventSink;
  };
  /** Request and context preparation belongs outside the Host lifecycle. */
  preparation: {
    prepareRequest(request: TurnRequest): Promise<TurnRequest>;
    /** Re-check live Room membership before context or Backend handoff. */
    assertCurrentRunAccess(turn: AdmittedTurn): Promise<void>;
    /** Re-check live Room membership immediately before a Host-owned Tool. */
    assertRunAccess(run: BackendRunRecord): Promise<void>;
    contextPreviewPortsForTurn(turn: AdmittedTurn): ContextPreviewPorts;
    prepareResumeInput(input: { run: BackendRunRecord; resumeInput: Record<string, JsonValue> }): Promise<{ backendInput: BackendRunInput; gatewayBoundaryPolicy?: GatewayBoundaryPolicy }>;
    recordActivityResourceUses(turn: AdmittedTurn, preview: ContextPreview): Promise<void>;
    recordLearningResourceUses(turn: AdmittedTurn, preview: ContextPreview): Promise<void>;
    linkActivityToRun(input: { activityId: string; run: BackendRunRecord }): Promise<void>;
    linkWorkspaceActivityToRun(input: { context: import("@samurai-agent/core-schemas").TrustedWorkspaceContext; run: BackendRunRecord }): Promise<void>;
    observeRecoveredRun(run: BackendRunRecord): Promise<void>;
    workingDirectory(): string;
    workingDirectoryMode(): "workspace" | "repo";
    backendExecutionRoot(runId: string): Promise<string>;
    cleanupBackendExecutionRoot(runId: string): Promise<void>;
    resolveDefaultBackendId(): string;
  };
  /** Backend tool bridge state is an execution adapter, not Host business logic. */
  execution: {
    handleBackendToolStartedEvent(input: HostToolInput): Promise<unknown>;
    registerToolBridgeToken(runId: string, token: string): Promise<void>;
    clearRunState(runId: string): void | Promise<void>;
  };
  /** Only the post-commit domain operations that exist in production are listed. */
  postTurn: {
    saveGeneratedSurfacePresentations(input: { sessionId: string; messageId: string; runId: string }): Promise<void>;
    runExternalAssistSync(input: HostExternalAssistSyncInput): Promise<ExternalAssistRecord[]>;
    registerLearningCandidate(input: { runId: string }): Promise<void>;
  };
  diagnostics: {
    formatError(error: unknown): string;
    logError(message: string, metadata: Record<string, unknown>): void;
  };
}

/**
 * Production Host wiring. The Host itself receives only the named Ports; all
 * Workspace, Domain and presentation adapters remain at this boundary.
 */
export function createRuntimeAgentHost(deps: RuntimeHostCompositionDependencies) {
  const diagnostics: HostDiagnosticsPort = {
    record: async (input) => deps.core.store.appendHostDiagnostic(input),
    logPersistenceFailure: (input) => {
      deps.diagnostics.logError("host_diagnostic_persistence_failed", {
        run_id: input.runId,
        session_id: input.sessionId,
        attempt: input.attemptNo,
        operation_id: input.operationId,
        event_type: input.eventType,
        message: deps.diagnostics.formatError(input.error)
      });
    }
  };
  const committedEventPublisher = {
    publish: async (input: { event: BackendEventRecord; run: BackendRunRecord }) => {
      const uiEvent = projectBackendEventForUi(input.event);
      if (uiEvent) await deps.core.emit("backend.event.created", uiEvent);
      await deps.core.emit("backend.run.updated", input.run);
    }
  };
  const context: HostContextPort = {
    getCandidates: async ({ turn, signal }) => {
      await deps.preparation.assertCurrentRunAccess(turn);
      const contextIntent = classifyBackendContextIntent(turn.request.content);
      const thinExternalContext = shouldThinExternalBackendContext(turn.binding.kind, contextIntent);
      return buildContextPreview({
        sessionId: turn.session.id,
        agentId: turn.request.agentId ?? turn.run.agent_id,
        query: turn.request.content,
        ports: deps.preparation.contextPreviewPortsForTurn(turn),
        skipHeavyContext: thinExternalContext,
        onProgress: async (displayKind, text, activityKind) => {
          await context.reportProgress({ turn, displayKind, text, ...(activityKind ? { activityKind } : {}) });
        }
      });
    },
    assemble: async ({ turn, candidates }) => {
      const boundary = turn.request.gatewayBoundaryPolicy
        ? gatewayBoundaryRuntimeSnapshot(turn.request.gatewayBoundaryPolicy, nowIso())
        : undefined;
      const availableTools = applyGatewayBoundaryAllowedTools(candidates.available_tools, turn.request.gatewayBoundaryPolicy);
      return {
        context: applyGatewayBoundaryToContextAssembly(candidates.context_assembly, boundary, candidates.available_tools, availableTools),
        availableTools,
        ...(boundary ? { gatewayBoundary: boundary } : {})
      };
    },
    handoff: async ({ turn, candidates, assembly }) => {
      await deps.preparation.assertCurrentRunAccess(turn);
      const executionBinding = runtimeBindingFromRunMetadata(turn.run.metadata, {
        // Session handoff may use the persisted Workspace identity. A legacy
        // Session request has no trusted Workspace ID in this layer.
        roomId: turn.session.room_id ?? turn.run.room_id,
        sessionId: turn.session.id,
        agent: turn.request.agent,
        agentId: turn.run.agent_id ?? turn.request.agent?.id,
        backendId: turn.binding.id
      });
      const executionContext = executionBinding
        ? runtimeExecutionContextForBackend(executionBinding, turn.binding.backend)
        : undefined;
      const agentSnapshot = executionBinding
        ? { id: executionBinding.agentId, ...executionBinding.agent }
        : turn.request.agent;
      const contextIntent = classifyBackendContextIntent(turn.request.content);
      const expectedOutputs = expectedBackendOutputs(turn.request.content);
      const handoff = buildContextHandoffForBackend({
        backendKind: turn.binding.kind,
        contextIntent,
        contextPreview: candidates,
        contextAssembly: assembly.context,
        gatewayBoundaryPresent: Boolean(assembly.gatewayBoundary)
      });
      const activeToolBridge = createBackendToolBridge({
        backendKind: turn.binding.kind,
        runId: turn.run.id,
        expectedOutputs,
        contextIntent,
        gatewayBoundaryPresent: Boolean(assembly.gatewayBoundary)
      });
      if (activeToolBridge?.token) await deps.execution.registerToolBridgeToken(turn.run.id, activeToolBridge.token);
      const recentMessages = (await deps.core.store.listMessages(turn.session.id)).slice(-10);
      const backendExecutionRoot = await deps.preparation.backendExecutionRoot(turn.run.id);
      const workspaceRoot = backendExecutionRoot;
      const workingDirectory = deps.preparation.workingDirectoryMode() === "workspace"
        ? backendExecutionRoot
        : deps.preparation.workingDirectory();
      const boundaryMetadata = assembly.gatewayBoundary ? gatewayBoundaryRuntimeMetadata(assembly.gatewayBoundary) : {};
      const metadata: Record<string, JsonValue> = {
        ...runtimeMetadataForBackend(turn.request.metadata ?? {}),
        context_intent: contextIntent,
        ...(expectedOutputs.length > 0 ? { expected_outputs: expectedOutputs } : {}),
        workspace_root: workspaceRoot,
        working_directory: workingDirectory,
        backend_working_directory_mode: deps.preparation.workingDirectoryMode(),
        backend_workspace_root_role: "isolated_agent_worktree",
        ...(turn.request.temporaryContext && turn.request.temporaryContext.length > 0
          ? {
              temporary_context_count: turn.request.temporaryContext.length,
              temporary_context_ref_ids: turn.request.temporaryContext.map((item) => item.id)
            }
          : {}),
        ...(activeToolBridge ? { tool_bridge_status: "enabled", tool_bridge_server: activeToolBridge.server_name } : {}),
        context_handoff_status: "ready",
        ...boundaryMetadata,
        ...contextAssemblyRuntimeMetadata(assembly.context),
        ...contextHandoffRuntimeMetadata(handoff),
        ...(candidates.freeze_snapshot
          ? { freeze_snapshot_id: candidates.freeze_snapshot.id, freeze_snapshot_hash: candidates.freeze_snapshot.stable_hash }
          : {})
      };
      await deps.preparation.recordActivityResourceUses(turn, candidates);
      await deps.preparation.recordLearningResourceUses(turn, candidates);
      // A participant may have been removed while the context was assembled.
      // Do not let an already-created Backend input become a new execution.
      await deps.preparation.assertCurrentRunAccess(turn);
      const backendInput: BackendRunInput = {
        run_id: turn.run.id,
        session_id: turn.session.id,
        ...(turn.session.room_id ? { room_id: turn.session.room_id } : {}),
        ...(agentSnapshot ? {
          agent_context: {
            id: executionBinding?.agentId ?? agentSnapshot.id,
            name: agentSnapshot.name,
            role: agentSnapshot.role,
            instructions: agentSnapshot.instructions,
            authority: "supporting_context" as const
          }
        } : {}),
        input_message_id: turn.userMessage.id,
        workspace_root: workspaceRoot,
        working_directory: workingDirectory,
        envelope: {
          ...turn.request.envelope,
          metadata: runtimeMetadataForBackend(turn.request.envelope.metadata)
        },
        user_input: turn.request.content,
        input_locale: turn.request.envelope.input_locale,
        output_locale: turn.session.output_locale,
        active_memory: candidates.active_memory.map((memory) => ({
          id: memory.id,
          topic: memory.topic,
          content: memory.content,
          state: memory.state,
          sensitive_level: memory.sensitive_level,
          priority: memory.priority,
          selection_reason: memory.selection_reason,
          conflicts_with: memory.conflicts_with
        })),
        freeze_snapshot: candidates.freeze_snapshot,
        gateway_boundary: assembly.gatewayBoundary,
        knowledge_wiki: candidates.knowledge_wiki,
        collection_notes: candidates.collection_notes,
        selected_skills: candidates.selected_skills,
        session_search: candidates.session_search,
        session_summary: candidates.session_summary,
        external_assist: candidates.external_assist,
        context_assembly: assembly.context,
        context_handoff: handoff,
        ...(assembly.availableTools ? { available_tools: [...assembly.availableTools] } : {}),
        ...(activeToolBridge ? { tool_bridge: activeToolBridge } : {}),
        recent_messages: recentMessages,
        temporary_context: turn.request.temporaryContext,
        metadata,
        context_intent: contextIntent,
        expected_outputs: expectedOutputs,
        ...(executionContext ? { execution_context: executionContext } : {})
      };
      return { handoff, backendInput };
    },
    reportProgress: async ({ turn, displayKind, text, activityKind }) => {
      const attemptNo = turn.run.current_attempt ?? 1;
      const sourceEventId = `host-progress:${turn.run.id}:${attemptNo}:${displayKind}:${activityKind ?? ""}:${stableHash(text)}`;
      const result = await deps.core.store.appendCore02Event({
        id: sourceEventId,
        run_id: turn.run.id,
        session_id: turn.run.session_id,
        event_type: "host_progress",
        sequence: 1,
        attempt_no: attemptNo,
        source_event_id: sourceEventId,
        payload: { display_kind: displayKind, text, ...(activityKind ? { activity_kind: activityKind } : {}) },
        resource_refs: [],
        created_at: nowIso()
      });
      if (!result.duplicate) await committedEventPublisher.publish({ event: result.event, run: turn.run });
    }
  };
  return createAgentHost({
    store: deps.core.store,
    backendRegistry: deps.core.backendRegistry,
    context,
    preflight: { prepare: async ({ request }) => deps.preparation.prepareRequest(request) },
    committedEventPublisher,
    admissionObserver: { observe: async (turn) => deps.core.emit("backend.run.created", turn.run) },
    admissionGuard: {
      guard: async (turn) => {
        if (turn.request.activityId) await deps.preparation.linkActivityToRun({ activityId: turn.request.activityId, run: turn.run });
      }
    },
    prepareResumeInput: deps.preparation.prepareResumeInput,
    assertRunAccess: deps.preparation.assertRunAccess,
    recoveredRunObserver: deps.preparation.observeRecoveredRun,
    prepareWorkspaceExecution: async ({ run, binding, request, backendInput }) => {
      // Recheck immediately before the Backend cassette sees a Room-first
      // request. A SessionRef never replaces this current Room decision.
      await deps.preparation.assertRunAccess(run);
      await deps.preparation.linkWorkspaceActivityToRun({ context: request.context, run });
      const persistedAgent = run.agent_id ? await deps.core.store.getAgent(run.agent_id) : undefined;
      const executionBinding = runtimeBindingFromRunMetadata(run.metadata, {
        workspaceId: request.context.workspace_id,
        roomId: request.context.room_id,
        sessionId: run.session_id,
        agent: persistedAgent,
        agentId: run.agent_id ?? request.agent_id,
        backendId: binding.id
      });
      const executionContext = executionBinding
        ? runtimeExecutionContextForBackend(executionBinding, binding.backend)
        : undefined;
      const agentSnapshot = executionBinding?.agent;
      const userInput = request.input_summary?.trim() || run.input_summary || "Workspace execution";
      const contextIntent = classifyBackendContextIntent(userInput);
      const expectedOutputs = expectedBackendOutputs(userInput);
      const activeToolBridge = createBackendToolBridge({
        backendKind: binding.kind,
        runId: run.id,
        expectedOutputs,
        contextIntent,
        gatewayBoundaryPresent: false,
        sessionless: true
      });
      if (activeToolBridge?.token) await deps.execution.registerToolBridgeToken(run.id, activeToolBridge.token);
      const backendExecutionRoot = await deps.preparation.backendExecutionRoot(run.id);
      const workingDirectory = deps.preparation.workingDirectoryMode() === "workspace"
        ? backendExecutionRoot
        : deps.preparation.workingDirectory();
      const metadata: Record<string, JsonValue> = {
        ...runtimeMetadataForBackend(backendInput.metadata),
        context_intent: contextIntent,
        backend_workspace_root_role: "isolated_agent_worktree",
        ...(expectedOutputs.length > 0 ? { expected_outputs: expectedOutputs } : {}),
        ...(activeToolBridge ? { tool_bridge_status: "enabled", tool_bridge_server: activeToolBridge.server_name } : {})
      };
      // Membership can change while a bridge token is being registered.
      await deps.preparation.assertRunAccess(run);
      return {
        backendInput: {
          ...backendInput,
          workspace_root: backendExecutionRoot,
          working_directory: workingDirectory,
          ...(agentSnapshot ? {
            agent_context: {
              id: executionBinding.agentId,
              name: agentSnapshot.name,
              role: agentSnapshot.role,
              instructions: agentSnapshot.instructions,
              authority: "supporting_context" as const
            }
          } : {}),
          envelope: {
            ...backendInput.envelope,
            metadata: { ...runtimeMetadataForBackend(backendInput.envelope.metadata), ...metadata }
          },
          metadata,
          context_intent: contextIntent,
          expected_outputs: expectedOutputs,
          ...(executionContext ? { execution_context: executionContext } : {}),
          ...(activeToolBridge ? { tool_bridge: activeToolBridge } : {})
        }
      };
    },
    toolExecution: {
      execute: async ({ run, backendInput, event, gatewayBoundaryPolicy, recordEvent }) => {
        if (event.event_type !== "tool_call_started") return;
        // This is deliberately inside the Tool path, rather than relying on
        // admission-time state or the Backend's own cached Session state.
        await deps.preparation.assertRunAccess(run);
        await deps.execution.handleBackendToolStartedEvent({
          run,
          runInput: backendInput,
          event: { event_type: event.event_type, payload: event.payload, tool_call_id: event.tool_call_id },
          gatewayBoundaryPolicy,
          recordEvent: async (toolEvent) => recordEvent(toolEvent)
        });
      }
    },
    cleanup: {
      cleanup: async ({ runId }) => {
        await deps.execution.clearRunState(runId);
        const run = await deps.core.store.getBackendRun(runId);
        if (!run || isSettledRun(run)) {
          await deps.preparation.cleanupBackendExecutionRoot(runId);
        }
      }
    },
    diagnostics,
    postTurn: {
      presentation: {
        operationId: "presentation",
        run: async ({ admitted, run }) => {
          if (!run.output_message_id) return;
          await deps.postTurn.saveGeneratedSurfacePresentations({ sessionId: admitted.session.id, messageId: run.output_message_id, runId: run.id });
        }
      },
      externalAssistSync: {
        operationId: "external_assist_sync",
        run: async ({ admitted, run, output }) => {
          const settings = await deps.core.store.getSettings();
          const records = await deps.postTurn.runExternalAssistSync({
            sessionId: admitted.session.id,
            runId: run.id,
            inputMessageId: admitted.userMessage.id,
            query: admitted.request.content,
            userContent: admitted.userMessage.content,
            assistantContent: output.content,
            role: settings.external_provider_role
          });
          const status = records.some((record) => record.status === "completed")
            ? "completed"
            : records.some((record) => record.status === "failed")
              ? "failed"
              : "skipped";
          const providerIds = records.map((record) => record.provider_id);
          const updated = {
            ...run,
            metadata: {
              ...run.metadata,
              external_assist_sync_status: status,
              ...(providerIds.length === 1 ? { external_assist_sync_provider_id: providerIds[0] } : {}),
              external_assist_sync_provider_ids: providerIds,
              external_assist_sync_statuses: records.map((record) => record.status)
            }
          };
          await deps.core.store.updateRunMetadata({ runId: run.id, metadata: updated.metadata });
          run.metadata = updated.metadata;
        }
      },
      learningReview: {
        operationId: "learning_candidate_registration",
        run: async ({ run }) => {
          await deps.postTurn.registerLearningCandidate({ runId: run.id });
        }
      },
    },
    resolveDefaultBackendId: () => deps.preparation.resolveDefaultBackendId()
  });
}

function isSettledRun(run: BackendRunRecord): boolean {
  return run.status === "completed"
    || run.status === "failed"
    || run.status === "cancelled"
    || run.status === "outcome_unknown";
}

/**
 * Durable association used to construct the additive Backend execution
 * context.  `sessionId` is intentionally optional: Room work does not need a
 * Chat Session to identify its execution boundary.
 */
export interface RuntimeExecutionBindingSnapshot {
  workspaceId: string;
  roomId: string;
  sessionId?: string;
  workId?: string;
  assigneeId?: string;
  agentId: string;
  agentConfigurationVersion: number;
  backendId: string;
  generation: number;
  agent: {
    name: string;
    role: string;
    instructions: string;
    enabled: boolean;
  };
}

interface RuntimeExecutionBindingFallback {
  workspaceId?: string;
  roomId?: string;
  sessionId?: string;
  agent?: AgentRecord;
  agentId?: string;
  backendId: string;
  generation?: number;
}

/**
 * Rebuild a binding from persisted Run metadata.  The persisted record wins
 * over a live Agent lookup; a changed Agent therefore cannot silently alter a
 * continuation.  A legacy run without this metadata keeps the old input
 * shape and returns a binding only when its fallback snapshot is complete.
 */
export function runtimeBindingFromRunMetadata(
  metadata: Record<string, JsonValue>,
  fallback: RuntimeExecutionBindingFallback
): RuntimeExecutionBindingSnapshot | undefined {
  const raw = metadata.runtime_binding;
  if (raw === undefined) {
    const agent = fallback.agent;
    const agentId = fallback.agentId ?? agent?.id;
    const workspaceId = fallback.workspaceId?.trim();
    const roomId = fallback.roomId?.trim();
    if (!agent || !agentId || !workspaceId || !roomId) return undefined;
    return {
      workspaceId,
      roomId,
      ...(fallback.sessionId?.trim() ? { sessionId: fallback.sessionId.trim() } : {}),
      // A legacy/no-binding fallback keeps the previous safe default.  Zero
      // is meaningful only when an explicit Human Work association is
      // present; it must not become a legacy generation accidentally.
      ...(fallback.generation ? { generation: requirePositiveInteger(fallback.generation, "generation") } : { generation: 1 }),
      agentId: agentId.trim(),
      agentConfigurationVersion: requirePositiveInteger(agent.configuration_version, "agent_configuration_version"),
      backendId: fallback.backendId.trim(),
      agent: {
        name: agent.name,
        role: agent.role,
        instructions: agent.instructions,
        enabled: agent.enabled
      }
    };
  }
  if (!isRecord(raw)) throw new Error("runtime_execution_binding_invalid");

  const record = raw;
  const rawAgent = record.agent;
  const agentRecord = rawAgent === undefined
    ? undefined
    : isRecord(rawAgent) ? rawAgent : invalidBinding();
  const workId = readOptionalString(record, "workId", "work_id");
  const assigneeId = readOptionalString(record, "assigneeId", "assignee_id");
  const hasWorkBinding = workId !== undefined || assigneeId !== undefined;
  if ((workId === undefined) !== (assigneeId === undefined)) invalidBinding();

  const workspaceId = readOptionalString(record, "workspaceId", "workspace_id") ?? normalizedFallback(fallback.workspaceId);
  const roomId = readOptionalString(record, "roomId", "room_id") ?? normalizedFallback(fallback.roomId);
  const sessionId = readOptionalString(record, "sessionId", "session_id") ?? normalizedFallback(fallback.sessionId);
  const agentId = readOptionalString(record, "agentId", "agent_id") ?? normalizedFallback(fallback.agentId ?? fallback.agent?.id);
  const backendId = readOptionalString(record, "backendId", "backend_id")
    ?? readOptionalString(agentRecord, "backend_id")
    ?? normalizedFallback(fallback.backendId);
  const generation = readOptionalGeneration(record, hasWorkBinding)
    ?? (hasWorkBinding ? undefined : fallback.generation ?? 1);
  const agentConfigurationVersion = readOptionalPositiveInteger(record, "agentConfigurationVersion", "agent_configuration_version")
    ?? readOptionalPositiveInteger(agentRecord, "config_version", "configuration_version")
    ?? (fallback.agent ? requirePositiveInteger(fallback.agent.configuration_version, "agent_configuration_version") : undefined);
  const name = readOptionalString(agentRecord, "name") ?? fallback.agent?.name;
  const role = readOptionalString(agentRecord, "role") ?? fallback.agent?.role;
  const instructions = readOptionalString(agentRecord, "instructions") ?? fallback.agent?.instructions;
  const enabled = readOptionalBoolean(agentRecord, "enabled") ?? fallback.agent?.enabled;

  if (!workspaceId || !roomId || !agentId || !backendId || generation === undefined || !agentConfigurationVersion
    || !name?.trim() || !role?.trim() || !instructions?.trim() || enabled === undefined
    || (hasWorkBinding && (!workId || !assigneeId))) {
    invalidBinding();
  }
  if (fallback.workspaceId && workspaceId !== fallback.workspaceId.trim()) invalidBindingMismatch();
  if (fallback.roomId && roomId !== fallback.roomId.trim()) invalidBindingMismatch();
  if (fallback.sessionId && sessionId && sessionId !== fallback.sessionId.trim()) invalidBindingMismatch();
  if (fallback.agentId && agentId !== fallback.agentId.trim()) invalidBindingMismatch();
  if (backendId !== fallback.backendId.trim()) invalidBindingMismatch();

  return {
    workspaceId,
    roomId,
    ...(sessionId ? { sessionId } : {}),
    ...(workId ? { workId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    agentId,
    agentConfigurationVersion,
    backendId,
    generation,
    agent: { name: name.trim(), role: role.trim(), instructions: instructions.trim(), enabled }
  };
}

/** Convert a persisted binding into the typed Backend boundary. */
export function runtimeExecutionContextForBackend(
  binding: RuntimeExecutionBindingSnapshot,
  backend: Pick<AgentBackend, "id" | "kind">
): BackendExecutionContext | undefined {
  if (!binding.workId && !binding.assigneeId) return undefined;
  if (!binding.workId || !binding.assigneeId) throw new Error("runtime_execution_binding_incomplete");
  if (binding.backendId !== backend.id) throw new Error("runtime_execution_binding_backend_mismatch");
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 0) {
    throw new Error("runtime_execution_generation_invalid");
  }
  return {
    agent: {
      id: binding.agentId,
      name: binding.agent.name,
      role: binding.agent.role,
      instructions: binding.agent.instructions,
      enabled: binding.agent.enabled,
      backend_id: binding.backendId,
      config_version: String(binding.agentConfigurationVersion)
    },
    association: {
      workspace_id: binding.workspaceId,
      room_id: binding.roomId,
      work_id: binding.workId,
      assignee_id: binding.assigneeId,
      backend_id: binding.backendId,
      generation: binding.generation
    },
    credential_boundary: backend.kind === "samurai_native" ? "provider_api" : "external_cli",
    continuity: backend.kind === "samurai_native" ? "samurai_context" : "external_session"
  };
}

/** Keep the typed association out of generic provider/user metadata. */
export function runtimeMetadataForBackend(metadata: Record<string, JsonValue>): Record<string, JsonValue> {
  const { runtime_binding: _runtimeBinding, ...safeMetadata } = metadata;
  return safeMetadata;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBinding(): never {
  throw new Error("runtime_execution_binding_invalid");
}

function invalidBindingMismatch(): never {
  throw new Error("runtime_execution_binding_mismatch");
}

function normalizedFallback(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function readOptionalString(record: Record<string, JsonValue> | undefined, ...keys: string[]): string | undefined {
  if (!record) return undefined;
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined);
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalidBinding();
  return value.trim();
}

function readOptionalBoolean(record: Record<string, JsonValue> | undefined, key: string): boolean | undefined {
  if (!record || record[key] === undefined) return undefined;
  if (typeof record[key] !== "boolean") invalidBinding();
  return record[key] as boolean;
}

function readOptionalPositiveInteger(record: Record<string, JsonValue> | undefined, ...keys: string[]): number | undefined {
  if (!record) return undefined;
  const value = keys.map((key) => record[key]).find((candidate) => candidate !== undefined);
  if (value === undefined) return undefined;
  const field = keys[0] ?? "value";
  if (typeof value === "number") return requirePositiveInteger(value, field);
  if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) return requirePositiveInteger(Number(value), field);
  invalidBinding();
}

function readOptionalGeneration(record: Record<string, JsonValue>, allowZero: boolean): number | undefined {
  const value = record.generation;
  if (value === undefined) return undefined;
  if (typeof value === "number") return requireGeneration(value, allowZero);
  if (typeof value === "string" && (allowZero ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/).test(value)) {
    return requireGeneration(Number(value), allowZero);
  }
  invalidBinding();
}

function requireGeneration(value: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error("runtime_execution_generation_invalid");
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`runtime_execution_${field}_invalid`);
  return value;
}
