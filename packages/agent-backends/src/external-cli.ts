import {
  type AgentBackendKind,
  type BackendCapabilityStatus,
  type BackendExecutionOwner,
  type JsonValue,
  type BackendSessionPolicy,
} from "@samurai-agent/core-schemas";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess, type ProcessRunnerEvent } from "./process-runner.js";
import { createCliOutputDecoder } from "./cli-parser.js";
import type { ExternalCliProvider } from "./provider-decoder-helpers.js";
import { jsonSafe, protocolDiagnosticEvent, safeFailureMessage, stringValue } from "./provider-decoder-helpers.js";
import { backendCapabilityIds } from "./contract.js";
import {
  buildExternalBackendPrompt,
  buildExternalBackendResumePrompt,
  externalBackendEnv,
  interpolateBackendArgs
} from "./external-backend-context.js";
import type {
  AgentBackend,
  AgentBackendStatus,
  BackendCancelResult,
  BackendLiveVerification,
  BackendOutputEvent,
  BackendRunInput,
  ExternalCommandProbe
} from "./contract.js";
import { backendSupports } from "./contract.js";

function cancelledBeforeStartEvent(label: string): BackendOutputEvent {
  return {
    event_type: "run_failed",
    terminal_evidence: { kind: "cancelled", source: "owned_loop_return" },
    payload: {
      error_code: "backend_cancelled_before_start",
      message: `${label} was cancelled before starting.`,
      reason: "already_aborted",
      retryable: false,
      cause_category: "cancellation"
    }
  };
}

export interface ExternalCliBackendOptions {
  id: string;
  kind: Extract<AgentBackendKind, "claude_code" | "codex" | "external">;
  label: string;
  command?: string;
  args?: string[];
  artifactMcpScript?: string;
  resumeArgs?: string[];
  capabilityProbeResults?: Array<Omit<BackendCapabilityStatus, "backend_id" | "checked_at"> & { checked_at?: string }>;
}

export class ExternalCliBackend implements AgentBackend {
  readonly id: string;
  readonly kind: ExternalCliBackendOptions["kind"];
  readonly label: string;
  readonly sessionPolicy: BackendSessionPolicy;
  readonly execution_owner: BackendExecutionOwner = "tool_bridge";
  readonly resumeRun?: (runId: string, input: Record<string, JsonValue>) => AsyncIterable<BackendOutputEvent>;
  private readonly command?: string;
  private readonly args: string[];
  private readonly artifactMcpScript?: string;
  private readonly resumeArgs?: string[];
  private readonly capabilityProbeResults: ExternalCliBackendOptions["capabilityProbeResults"];
  private readonly activeRuns = new Map<string, { child: ChildProcessWithoutNullStreams; cancelled: boolean }>();
  private liveVerification?: BackendLiveVerification;
  private readonly provider: ExternalCliProvider;

  constructor(options: ExternalCliBackendOptions, provider?: ExternalCliProvider) {
    this.id = options.id;
    this.kind = options.kind;
    this.label = options.label;
    this.command = options.command?.trim() || undefined;
    this.args = options.args ?? [];
    this.artifactMcpScript = options.artifactMcpScript?.trim() || process.env.SAMURAI_ARTIFACT_MCP_SCRIPT?.trim() || undefined;
    this.resumeArgs = options.resumeArgs && options.resumeArgs.length > 0 ? options.resumeArgs : undefined;
    this.sessionPolicy = { acquisition: "provider_event", resume: this.resumeArgs ? "native" : "unsupported" };
    this.resumeRun = this.resumeArgs ? (runId, input = {}) => this.runResumeCommand(runId, input) : undefined;
    this.capabilityProbeResults = options.capabilityProbeResults;
    this.provider = provider ?? {};
  }

  getStatus(): AgentBackendStatus {
    const commandProbe = resolveExternalCommandProbe(this.command);
    const configured = commandProbe.configured;
    const available = configured && commandProbe.resolved;
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      configured,
      enabled: available,
      connection_state: available ? (this.liveVerification ? "ready" : "unverified") : configured ? "degraded" : "unconfigured",
      session_policy: this.sessionPolicy,
      execution_owner: this.execution_owner,
      supports: {
        ...backendSupports(this),
        resume_run: !!this.resumeArgs
      },
      capabilities: this.capabilityStatuses(commandProbe),
      active_run_count: this.activeRuns.size,
      metadata: {
        args_count: this.args.length,
        command_probe: jsonSafe(commandProbe),
        ...(this.liveVerification ? { live_verification: jsonSafe(this.liveVerification) } : {})
      },
      ...(!available ? { reason: commandProbe.reason ?? (configured ? "command_not_found" : "command_not_configured") } : {})
    };
  }

  recordLiveVerification(input: BackendLiveVerification): void {
    this.liveVerification = {
      version: input.version,
      verified_at: input.verified_at,
      ...(input.effective_args ? { effective_args: input.effective_args.map((arg) => redactCliArgument(arg)) } : {})
    };
  }

  private capabilityStatuses(commandProbe: ExternalCommandProbe): BackendCapabilityStatus[] {
    const checkedAt = new Date().toISOString();
    const supplied = new Map((this.capabilityProbeResults ?? []).map((item) => [item.capability_id, item]));
    return backendCapabilityIds.map((capabilityId) => {
      const result = supplied.get(capabilityId);
      if (result) {
        if (!commandProbe.resolved) {
          return {
            backend_id: this.id,
            capability_id: capabilityId,
            state: "unavailable",
            source: result.source,
            reason: commandProbe.reason ?? "backend_command_unavailable",
            checked_at: result.checked_at ?? checkedAt,
            probe_version: result.probe_version,
            evidence_summary: "The backend command is unavailable, so supplied capability evidence cannot make it available."
          };
        }
        return {
          ...result,
          backend_id: this.id,
          checked_at: result.checked_at ?? checkedAt
        };
      }
      const reason = !commandProbe.configured
        ? "backend_not_configured"
        : !commandProbe.resolved
          ? commandProbe.reason ?? "backend_command_unavailable"
          : "capability_not_probed";
      return {
        backend_id: this.id,
        capability_id: capabilityId,
        state: commandProbe.resolved ? "unverified" : "unavailable",
        source: "backend_native",
        reason,
        checked_at: checkedAt,
        probe_version: "static-v1",
        evidence_summary: commandProbe.resolved
          ? "Backend command is available, but this capability has not been executed by diagnostics."
          : "Backend command is unavailable, so this capability cannot be used."
      };
    });
  }

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    if (input.abort_signal?.aborted) {
      yield cancelledBeforeStartEvent(this.label);
      return;
    }

    if (!this.command) {
      const failedEvent: BackendOutputEvent = {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_not_configured",
          message: `${this.label} command is not configured.`,
          reason: "not_configured",
          retryable: false
        }
      };
      yield failedEvent;
      return;
    }
    const commandProbe = resolveExternalCommandProbe(this.command);
    if (!commandProbe.resolved) {
      const failedEvent: BackendOutputEvent = {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_command_not_found",
          message: `${this.label} command could not be resolved.`,
          reason: commandProbe.reason ?? "command_not_found",
          retryable: false,
          command_name: commandProbe.command_name ?? "unknown"
        }
      };
      yield failedEvent;
      return;
    }
    if (input.abort_signal?.aborted) {
      yield cancelledBeforeStartEvent(this.label);
      return;
    }

    try {
      for await (const event of runCommandEvents({
        runId: input.run_id,
        backendKind: this.kind,
        provider: this.provider,
        command: this.command,
        args: this.provider.prepareArgs?.({
          args: this.args,
          workingDirectory: input.working_directory,
          toolBridge: input.tool_bridge,
          artifactMcpScript: this.artifactMcpScript
        }) ?? this.args,
        input: buildExternalBackendPrompt(input),
        env: externalBackendEnv(input),
        cwd: input.working_directory,
        label: this.label,
        abortSignal: input.abort_signal,
        registerChild: (child) => this.activeRuns.set(input.run_id, { child, cancelled: false }),
        markChildCancelled: (child) => {
          const active = this.activeRuns.get(input.run_id);
          if (active?.child === child) active.cancelled = true;
        },
        isCancelled: () => this.activeRuns.get(input.run_id)?.cancelled === true,
        unregisterChild: (child) => {
          if (this.activeRuns.get(input.run_id)?.child === child) {
            this.activeRuns.delete(input.run_id);
          }
        },
        expectedBackendSessionId: input.backend_session_id
      })) {
        yield event;
      }
    } finally {
      // The command runner owns child-process cleanup; no Event cache is kept here.
    }
  }

  async cancelRun(runId: string): Promise<BackendCancelResult> {
    const state = this.activeRuns.get(runId);
    if (!state) {
      return { kind: "unsupported" };
    }
    state.cancelled = true;
    state.child.kill("SIGTERM");
    return { kind: "requested" };
  }

  private async *runResumeCommand(runId: string, input: Record<string, JsonValue>): AsyncIterable<BackendOutputEvent> {
    if (!this.command) {
      const failedEvent: BackendOutputEvent = {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_not_configured",
          message: `${this.label} command is not configured.`,
          reason: "not_configured",
          retryable: false
        }
      };
      yield failedEvent;
      return;
    }
    const commandProbe = resolveExternalCommandProbe(this.command);
    if (!commandProbe.resolved) {
      const failedEvent: BackendOutputEvent = {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_command_not_found",
          message: `${this.label} command could not be resolved.`,
          reason: commandProbe.reason ?? "command_not_found",
          retryable: false,
          command_name: commandProbe.command_name ?? "unknown"
        }
      };
      yield failedEvent;
      return;
    }
    const backendSessionId = stringValue(input.backend_session_id) || "";
    const resumeRequiresSession = this.resumeArgs?.some((arg) => arg.includes("{backend_session_id}")) === true;
    if (resumeRequiresSession && !backendSessionId) {
      const failedEvent: BackendOutputEvent = {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_native_session_missing",
          message: `${this.label} cannot resume because no backend native session id is known.`,
          reason: "native_session_missing",
          retryable: false
        }
      };
      yield failedEvent;
      return;
    }
    const args = interpolateBackendArgs(this.resumeArgs ?? [], { runId, backendSessionId });
    const resumeAbortSignal = (input as Record<string, unknown>).abort_signal as AbortSignal | undefined;
    const promptInput = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "abort_signal")) as Record<string, JsonValue>;
    try {
      for await (const event of runCommandEvents({
        runId,
        backendKind: this.kind,
        provider: this.provider,
        command: this.command,
        args: this.provider.prepareArgs?.({
          args,
          workingDirectory: stringValue(input.working_directory),
          toolBridge: undefined,
          artifactMcpScript: this.artifactMcpScript
        }) ?? args,
        input: buildExternalBackendResumePrompt(promptInput),
        env: {
          SAMURAI_BACKEND_RESUME_RUN_ID: runId,
          ...(stringValue(input.workspace_root) ? { SAMURAI_WORKSPACE_ROOT: stringValue(input.workspace_root) } : {}),
          ...(stringValue(input.working_directory) ? { SAMURAI_BACKEND_WORKING_DIRECTORY: stringValue(input.working_directory) } : {}),
          ...(backendSessionId ? { SAMURAI_BACKEND_SESSION_ID: backendSessionId } : {})
        },
        cwd: stringValue(input.working_directory),
        label: this.label,
        abortSignal: resumeAbortSignal,
        registerChild: (child) => this.activeRuns.set(runId, { child, cancelled: false }),
        isCancelled: () => this.activeRuns.get(runId)?.cancelled === true,
        unregisterChild: (child) => {
          if (this.activeRuns.get(runId)?.child === child) {
            this.activeRuns.delete(runId);
          }
        },
        expectedBackendSessionId: backendSessionId
      })) {
        yield event;
      }
    } finally {
      // The command runner owns child-process cleanup; no Event cache is kept here.
    }
  }
}

interface CommandRunInput {
  runId: string;
  backendKind: AgentBackendKind;
  provider: ExternalCliProvider;
  command: string;
  args: string[];
  input: string;
  env?: Record<string, string>;
  cwd?: string;
  label: string;
  abortSignal?: AbortSignal;
  registerChild?: (child: ChildProcessWithoutNullStreams) => void;
  markChildCancelled?: (child: ChildProcessWithoutNullStreams) => void;
  isCancelled?: () => boolean;
  unregisterChild?: (child: ChildProcessWithoutNullStreams) => void;
  expectedBackendSessionId?: string;
}

async function* runCommandEvents(input: CommandRunInput): AsyncIterable<BackendOutputEvent> {
  const outputLastMessageDirectory = input.provider.outputLastMessage ? await mkdtemp(path.join(tmpdir(), "samurai-codex-")) : undefined;
  const outputLastMessagePath = outputLastMessageDirectory ? path.join(outputLastMessageDirectory, "last-message.txt") : undefined;
  const args = input.args.map((arg) => arg === "{output_last_message_path}" ? outputLastMessagePath ?? arg : arg);
  let stdoutLineBuffer = "";
  let protocolDiagnosticSeen = false;
  let providerStarted = false;
  let providerTerminal: BackendOutputEvent | undefined;
  let providerTerminalBeforeCancellation = false;
  let providerSessionId = input.expectedBackendSessionId;
  let sessionConflictSeen = false;
  let textEventSeen = false;
  let spawnError: string | undefined;
  let processErrorSummary: string | undefined;
  let closeEvent: Extract<ProcessRunnerEvent, { kind: "close" }> | undefined;
  const emittedSourceIds = new Set<string>();
  const events: BackendOutputEvent[] = [];
  let emittedEventCount = 0;
  const decodeLine = createCliOutputDecoder(input.backendKind, input.provider.createDecoder, input.provider.sessionId);

  const queueEvent = (event: BackendOutputEvent): void => {
    if (event.source_event_id) {
      if (emittedSourceIds.has(event.source_event_id)) return;
      emittedSourceIds.add(event.source_event_id);
    }
    const eventSessionId = event.backend_session_id;
    if (eventSessionId) {
      if (providerSessionId && providerSessionId !== eventSessionId) {
        protocolDiagnosticSeen = true;
        sessionConflictSeen = true;
        const providerEventType = "provider_event_type" in event.payload && typeof event.payload.provider_event_type === "string"
          ? event.payload.provider_event_type
          : undefined;
        events.push(protocolDiagnosticEvent(input.backendKind, "session_conflict", "Backend emitted a different Session ID.", providerEventType));
        return;
      }
      providerSessionId = eventSessionId;
    }
    if (event.event_type === "run_started") {
      if (providerStarted) return;
      providerStarted = true;
    }
    if (event.terminal_evidence) {
      if (!providerTerminal) {
        providerTerminal = event;
        providerTerminalBeforeCancellation = input.isCancelled?.() !== true && input.abortSignal?.aborted !== true;
      }
      return;
    }
    if (event.event_type === "backend_protocol_diagnostic") {
      protocolDiagnosticSeen = true;
    }
    if (event.event_type === "text_delta" && typeof event.payload.text === "string" && event.payload.text.trim()) {
      textEventSeen = true;
    }
    events.push(event);
  };
  const parseLine = (line: string) => {
    for (const event of decodeLine(line, "stdout")) queueEvent(event);
  };
  const consumeStdout = (chunk: string) => {
    stdoutLineBuffer += chunk;
    const lines = stdoutLineBuffer.split(/\r?\n/);
    stdoutLineBuffer = lines.pop() ?? "";
    for (const line of lines) parseLine(line);
  };
  const pendingEvents = (): BackendOutputEvent[] => {
    const pending = events.slice(emittedEventCount);
    emittedEventCount = events.length;
    return pending;
  };

  try {
    for await (const processEvent of runProcess({
      command: input.command,
      args,
      input: input.input,
      env: input.env,
      cwd: input.cwd,
      abortSignal: input.abortSignal,
      registerChild: input.registerChild,
      markChildCancelled: input.markChildCancelled,
      isCancelled: input.isCancelled,
      unregisterChild: input.unregisterChild
    })) {
      if (processEvent.kind === "aborted_before_start") {
        yield cancelledBeforeStartEvent(input.label);
        return;
      }
      if (processEvent.kind === "stdout") {
        consumeStdout(processEvent.chunk);
        for (const event of pendingEvents()) yield event;
      } else if (processEvent.kind === "spawn_error") {
        spawnError = safeFailureMessage(processEvent.message, "Backend process failed to start.");
      } else if (processEvent.kind === "process_error") {
        processErrorSummary = safeFailureMessage(processEvent.message, "Backend process reported an execution error.");
      } else if (processEvent.kind === "close") {
        closeEvent = processEvent;
      }
    }

    if (stdoutLineBuffer.trim()) parseLine(stdoutLineBuffer);

    const close = closeEvent ?? { kind: "close" as const, exitCode: null, signal: null, stdout: "", stderr: "", cancelled: false };
    const cancellationRequested = close.cancelled || input.isCancelled?.() === true || input.abortSignal?.aborted === true;
    const cancellationConfirmed = cancellationRequested && (close.signal === "SIGTERM" || close.exitCode === 143 || close.exitCode === 0);
    const providerFailure = input.provider.processFailure?.(close.stderr);
    const failureCode = providerFailure?.code ?? "backend_failed";
    const failureMessage = providerFailure?.message ?? `${input.label} failed.`;
    const processFailure = (code = failureCode, message = failureMessage): BackendOutputEvent => ({
      event_type: "run_failed",
      terminal_evidence: { kind: "failed", source: "process_exit", error: { code, message, retryable: false, causeCategory: "process" } },
      payload: {
        error_code: code,
        message,
        reason: "process_exit",
        retryable: false,
        ...(close.exitCode !== null ? { exit_code: close.exitCode } : {}),
        ...(close.signal ? { signal: close.signal } : {}),
        ...(spawnError ? { process_error_summary: spawnError } : {}),
        ...(processErrorSummary ? { process_error_summary: processErrorSummary } : {}),
        stderr_summary: safeFailureMessage(close.stderr, "")
      }
    });

    if (spawnError) {
      for (const event of pendingEvents()) yield event;
      yield {
        event_type: "run_failed",
        terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
        payload: {
          error_code: "backend_spawn_failed",
          message: `${input.label} failed to start.`,
          reason: "spawn_failed",
          retryable: false,
          process_error_summary: spawnError,
          stderr_summary: safeFailureMessage(close.stderr, "")
        }
      };
      return;
    }

    const naturalProviderTerminal = providerTerminal;
    const terminalIsCompleted = naturalProviderTerminal?.terminal_evidence?.kind === "completed";
    if (outputLastMessagePath && providerStarted && terminalIsCompleted && close.exitCode === 0 && !protocolDiagnosticSeen && !textEventSeen) {
      try {
        const finalMessage = await input.provider.outputLastMessage?.(outputLastMessagePath);
        if (finalMessage) {
          events.push({ event_type: "text_delta", payload: { text: finalMessage, provider_event_type: "output-last-message" } });
          textEventSeen = true;
        }
      } catch {
        // The official file is optional when the provider already emitted text.
      }
    }

    for (const event of pendingEvents()) yield event;
    if (protocolDiagnosticSeen) {
      yield processFailure(sessionConflictSeen ? "backend_session_conflict" : "backend_protocol_error", sessionConflictSeen ? "Backend emitted a different native Session ID." : "Backend output did not satisfy the provider protocol.");
      return;
    }
    if (naturalProviderTerminal) {
      if (!providerStarted) {
        yield processFailure("backend_protocol_error", "Backend emitted a terminal event before its start event.");
        return;
      }
      if (cancellationRequested && !providerTerminalBeforeCancellation) {
        if (cancellationConfirmed) {
          yield { event_type: "run_failed", terminal_evidence: { kind: "cancelled", source: "process_exit" }, payload: { error_code: "backend_cancelled", message: `${input.label} was cancelled.`, reason: "cancelled", retryable: false, ...(close.exitCode !== null ? { exit_code: close.exitCode } : {}), ...(close.signal ? { signal: close.signal } : {}) } } satisfies BackendOutputEvent;
        } else if (closeEvent) {
          yield processFailure("backend_cancelled_process_exit", `${input.label} exited after cancellation was requested.`);
        } else {
          yield { event_type: "run_failed", terminal_evidence: { kind: "indeterminate", reason: "cancel_unconfirmed", providerStarted: true, mayHaveSideEffects: true }, payload: { error_code: "backend_cancel_unconfirmed", message: `${input.label} stop could not be confirmed.`, reason: "cancel_unconfirmed", retryable: false } } satisfies BackendOutputEvent;
        }
        return;
      }
      if (terminalIsCompleted && close.exitCode !== 0 && !(cancellationRequested && providerTerminalBeforeCancellation)) {
        yield processFailure();
      } else {
        yield(processErrorSummary
          ? { ...naturalProviderTerminal, payload: { ...naturalProviderTerminal.payload, process_error_summary: processErrorSummary } } as BackendOutputEvent
          : naturalProviderTerminal);
      }
      return;
    }
    if (cancellationRequested) {
      if (cancellationConfirmed) {
        yield { event_type: "run_failed", terminal_evidence: { kind: "cancelled", source: "process_exit" }, payload: { error_code: "backend_cancelled", message: `${input.label} was cancelled.`, reason: "cancelled", retryable: false, ...(close.exitCode !== null ? { exit_code: close.exitCode } : {}), ...(close.signal ? { signal: close.signal } : {}) } } satisfies BackendOutputEvent;
      } else if (closeEvent) {
        yield processFailure("backend_cancelled_process_exit", `${input.label} exited after cancellation was requested.`);
      } else {
        yield { event_type: "run_failed", terminal_evidence: { kind: "indeterminate", reason: "cancel_unconfirmed", providerStarted, mayHaveSideEffects: providerStarted }, payload: { error_code: "backend_cancel_unconfirmed", message: `${input.label} stop could not be confirmed.`, reason: "cancel_unconfirmed", retryable: false } } satisfies BackendOutputEvent;
      }
      return;
    }
    if (close.exitCode === 0 && !protocolDiagnosticSeen) {
      yield processFailure("backend_terminal_missing", "Backend exited without a terminal event.");
      return;
    }
    yield processFailure();
  } finally {
    if (outputLastMessageDirectory) {
      await rm(outputLastMessageDirectory, { recursive: true, force: true });
    }
  }
}

export function resolveExternalCommandProbe(command: string | undefined, env: NodeJS.ProcessEnv = process.env): ExternalCommandProbe {
  const trimmed = command?.trim();
  if (!trimmed) {
    return {
      configured: false,
      resolved: false,
      reason: "command_not_configured"
    };
  }
  const pathKind = isDirectCommandPath(trimmed) ? "direct_path" : "path_lookup";
  const candidates = pathKind === "direct_path" ? [trimmed] : commandPathCandidates(trimmed, env);
  for (const candidate of candidates) {
    if (isExecutableFileCandidate(candidate)) {
      return {
        configured: true,
        command_name: path.basename(trimmed),
        path_kind: pathKind,
        resolved: true
      };
    }
  }
  return {
    configured: true,
    command_name: path.basename(trimmed),
    path_kind: pathKind,
    resolved: false,
    reason: candidates.some((candidate) => existsSync(candidate)) ? "command_not_executable" : "command_not_found"
  };
}

function commandPathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? "";
  return pathValue.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
}

function isDirectCommandPath(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function isExecutableFileCandidate(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function redactCliArgument(value: string): string {
  if (/token|secret|password|api[_-]?key|authorization/i.test(value)) return "[redacted-arg]";
  return value.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]").slice(0, 240);
}
