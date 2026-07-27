import { timingSafeEqual } from "node:crypto";
import { getDomainQueryForProviderToolName } from "@samurai-agent/action-catalog";
import type { BackendOutputEvent, BackendRunInput, BackendToolCallStartedEvent } from "@samurai-agent/agent-backends";
import {
  type ArtifactRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type JsonValue,
  type OperationRecord,
  type ResourceRef,
  type ToolRunRecord,
  stableHash
} from "@samurai-agent/core-schemas";
import {
  normalizeSamuraiToolBridgeName,
  samuraiToolBridgeActionId,
  samuraiToolBridgeTools,
  samuraiToolBridgeWriteTools
} from "../provider-tool-bridge-composition";
import { normalizeBackendOutputEvent } from "../backend/event-bridge";
import type { RuntimeToolCallResult, RuntimeToolQueryResult } from "../provider-result-projector";

export type BackendToolBridgeErrorCode = "bad_request" | "conflict" | "forbidden" | "not_found";

export interface BackendToolBridgeCallInput {
  runId: string;
  token: string;
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, JsonValue>;
}

export interface BackendToolBridgeCallResult {
  status: "completed";
  artifact_id?: string;
  title?: string;
  resource_ref?: ResourceRef;
  output?: JsonValue;
  tool_run_ids: string[];
}

export interface BackendToolStartedResult {
  operations: OperationRecord[];
  artifacts: ArtifactRecord[];
  toolRuns: ToolRunRecord[];
}

export interface BackendToolBridgeServiceDependencies {
  getRun(runId: string): Promise<BackendRunRecord | undefined>;
  listEvents(runId: string): Promise<BackendEventRecord[]>;
  buildRunInput(run: BackendRunRecord): Promise<BackendRunInput>;
  recordEvent(run: BackendRunRecord, event: BackendOutputEvent): Promise<BackendEventRecord>;
  executeRuntimeTool(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendToolCallStartedEvent;
  }): Promise<RuntimeToolCallResult | RuntimeToolQueryResult | undefined>;
  executeProviderQuery(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendToolCallStartedEvent;
    queryId: string;
    args: Record<string, JsonValue>;
  }): Promise<RuntimeToolQueryResult | undefined>;
  runReadOnlyTool(input: { toolName: string; toolInput: Record<string, JsonValue>; runId: string }): Promise<JsonValue>;
  executeBackendToolStarted(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendToolCallStartedEvent;
    recordEvent: (event: BackendOutputEvent) => Promise<BackendEventRecord>;
  }): Promise<BackendToolStartedResult>;
  createError(code: BackendToolBridgeErrorCode, message: string): Error;
}

/** Process-local HTTP Tool Bridge state and execution path. */
export class BackendToolBridgeService {
  private readonly tokens = new Map<string, string>();
  private readonly inFlight = new Map<string, { inputHash: string; promise: Promise<BackendToolBridgeCallResult> }>();

  constructor(private readonly deps: BackendToolBridgeServiceDependencies) {}

  registerToken(runId: string, token: string): void {
    this.tokens.set(runId, token);
  }

  clearToken(runId: string): void {
    this.tokens.delete(runId);
  }

  async run(input: BackendToolBridgeCallInput): Promise<BackendToolBridgeCallResult> {
    const run = await this.deps.getRun(input.runId);
    if (!run) throw this.deps.createError("not_found", "backend_run_not_found");
    if (run.status !== "running") throw this.deps.createError("conflict", "backend_run_not_running");

    const expectedToken = this.tokens.get(run.id);
    if (!expectedToken || !timingSafeTokenEqual(expectedToken, input.token)) {
      throw this.deps.createError("forbidden", "tool_bridge_token_invalid");
    }
    const providerToolName = normalizeSamuraiToolBridgeName(input.toolName);
    if (!samuraiToolBridgeTools.has(providerToolName)) {
      throw this.deps.createError("conflict", "tool_bridge_tool_not_allowed");
    }
    const toolCallId = input.toolCallId.trim();
    if (!toolCallId) throw this.deps.createError("bad_request", "tool_call_id_required");

    const attemptNo = run.current_attempt ?? 1;
    const actionId = samuraiToolBridgeActionId(providerToolName);
    const toolIdentity = `${run.id}:${attemptNo}:${toolCallId}`;
    const toolInputHash = stableHash({ action_id: actionId, input: input.toolInput });
    const existing = await this.findExistingResult(run.id, attemptNo, toolCallId, toolIdentity, toolInputHash);
    if (existing) return existing;
    const inFlight = this.inFlight.get(toolIdentity);
    if (inFlight) {
      if (inFlight.inputHash !== toolInputHash) throw this.deps.createError("conflict", "tool_call_identity_conflict");
      return inFlight.promise;
    }

    const promise = this.runWithIdentity({ run, input, providerToolName, toolCallId, toolIdentity, toolInputHash, actionId });
    this.inFlight.set(toolIdentity, { inputHash: toolInputHash, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(toolIdentity)?.promise === promise) this.inFlight.delete(toolIdentity);
    }
  }

  private async runWithIdentity(input: {
    run: BackendRunRecord;
    input: BackendToolBridgeCallInput;
    providerToolName: string;
    toolCallId: string;
    toolIdentity: string;
    toolInputHash: string;
    actionId: string;
  }): Promise<BackendToolBridgeCallResult> {
    const runInput = await this.deps.buildRunInput(input.run);
    const recordEvent = (event: BackendOutputEvent) => this.deps.recordEvent(input.run, {
      ...event,
      ...(event.event_type === "tool_call_started" || event.event_type === "tool_call_output" ? {
        tool_call_id: input.toolCallId,
        payload: {
          ...event.payload,
          tool_call_id: input.toolCallId,
          tool_identity: input.toolIdentity,
          tool_input_hash: input.toolInputHash
        }
      } : {}),
      source_event_id: event.source_event_id
        ?? `tool-bridge:${input.toolIdentity}:${event.event_type}:${stableHash(event.payload)}`
    } as BackendOutputEvent);
    const startedEvent = normalizeBackendOutputEvent({
      event_type: "tool_call_started",
      tool_call_id: input.toolCallId,
      payload: {
        tool_call_id: input.toolCallId,
        provider_tool_name: input.providerToolName,
        action_id: input.actionId,
        tool_identity: input.toolIdentity,
        tool_input_hash: input.toolInputHash,
        tool_origin: "samurai_tool_bridge",
        input: input.input.toolInput
      }
    }) as BackendToolCallStartedEvent;
    await recordEvent(startedEvent);

    if (samuraiToolBridgeWriteTools.has(input.providerToolName)) {
      const feedback = await this.deps.executeRuntimeTool({ run: input.run, runInput, event: startedEvent });
      if (!feedback) throw this.deps.createError("conflict", "tool_bridge_write_tool_failed");
      if (isRuntimeToolQueryResult(feedback)) {
        throw this.deps.createError("conflict", "tool_bridge_write_tool_returned_query");
      }
      const outputPayload = {
        ...(feedback.outputPayload ?? {
          status: "completed",
          action_id: feedback.operation.operation,
          resource_id: feedback.operation.result_ref?.id ?? feedback.operation.id
        }),
        operation_id: feedback.operation.id
      };
      await recordEvent({
        event_type: "tool_call_output",
        tool_call_id: input.toolCallId,
        payload: {
          ...outputPayload,
          tool_call_id: input.toolCallId,
          tool_identity: input.toolIdentity,
          tool_input_hash: input.toolInputHash,
          tool_run_ids: [feedback.toolRun.id]
        },
        resource_refs: feedback.resourceRefs ?? (feedback.operation.result_ref ? [feedback.operation.result_ref] : [])
      });
      return {
        status: "completed",
        output: {
          operation_id: feedback.operation.id,
          ...(feedback.outputPayload?.output && typeof feedback.outputPayload.output === "object" && !Array.isArray(feedback.outputPayload.output)
            ? { result: feedback.outputPayload.output }
            : {}),
          ...(feedback.operation.result_ref?.kind === "collection_schema" && feedback.operation.result_ref.id ? { collection_id: feedback.operation.result_ref.id } : {}),
          ...(feedback.operation.result_ref?.kind === "collection_record" && feedback.operation.result_ref.id ? { record_id: feedback.operation.result_ref.id } : {})
        },
        resource_ref: feedback.operation.result_ref,
        tool_run_ids: [feedback.toolRun.id]
      };
    }

    if (input.providerToolName !== "samurai.artifact.create") {
      const providerQuery = getDomainQueryForProviderToolName(input.providerToolName);
      if (providerQuery) {
        const feedback = await this.deps.executeProviderQuery({
          run: input.run,
          runInput,
          event: startedEvent,
          queryId: providerQuery.id,
          args: input.input.toolInput
        });
        if (!feedback) throw this.deps.createError("conflict", "tool_bridge_query_failed");
        const output = feedback.outputPayload?.result ?? feedback.outputPayload;
        await recordEvent({
          event_type: "tool_call_output",
          tool_call_id: input.toolCallId,
          payload: {
            tool_call_id: input.toolCallId,
            provider_tool_name: input.providerToolName,
            action_id: input.actionId,
            tool_identity: input.toolIdentity,
            tool_input_hash: input.toolInputHash,
            status: "completed",
            output: output ?? null,
            ...(feedback.outputPayload?.render_specs !== undefined ? { render_specs: feedback.outputPayload.render_specs } : {})
          },
          resource_refs: feedback.resourceRefs ?? []
        });
        return { status: "completed", output, resource_ref: feedback.resourceRefs?.[0], tool_run_ids: [] };
      }

      const output = await this.deps.runReadOnlyTool({ toolName: input.providerToolName, toolInput: input.input.toolInput, runId: input.input.runId });
      await recordEvent({
        event_type: "tool_call_output",
        tool_call_id: input.toolCallId,
        payload: {
          tool_call_id: input.toolCallId,
          provider_tool_name: input.providerToolName,
          action_id: input.providerToolName,
          tool_identity: input.toolIdentity,
          tool_input_hash: input.toolInputHash,
          output_summary: summarize(JSON.stringify(output), 220),
          output
        }
      });
      return { status: "completed", output, tool_run_ids: [] };
    }

    const feedback = await this.deps.executeBackendToolStarted({
      run: input.run,
      runInput,
      event: startedEvent,
      recordEvent
    });
    const artifact = feedback.artifacts[0];
      return {
        status: "completed",
        ...(feedback.operations[0] ? { output: { operation_id: feedback.operations[0].id } } : {}),
        ...(artifact ? { artifact_id: artifact.id, title: artifact.title, resource_ref: artifact.file_ref } : {}),
        tool_run_ids: feedback.toolRuns.map((toolRun) => toolRun.id)
    };
  }

  private async findExistingResult(runId: string, attemptNo: number, toolCallId: string, toolIdentity: string, toolInputHash: string): Promise<BackendToolBridgeCallResult | undefined> {
    const events = await this.deps.listEvents(runId);
    const matching = events.filter((event) => {
      const recordedToolCallId = typeof event.payload.tool_call_id === "string" ? event.payload.tool_call_id : undefined;
      if (event.attempt_no !== attemptNo || recordedToolCallId !== undefined && recordedToolCallId !== toolCallId) return false;
      if (event.event_type !== "tool_call_started" && event.event_type !== "tool_call_output") return false;
      const identity = typeof event.payload.tool_identity === "string" ? event.payload.tool_identity : `${runId}:${attemptNo}:${event.payload.tool_call_id ?? ""}`;
      return identity === toolIdentity;
    });
    if (matching.length === 0) return undefined;
    for (const event of matching) {
      const recordedHash = typeof event.payload.tool_input_hash === "string"
        ? event.payload.tool_input_hash
        : event.event_type === "tool_call_started" && event.payload.input !== undefined
          ? stableHash({ action_id: event.payload.action_id ?? "", input: event.payload.input })
          : undefined;
      if (recordedHash && recordedHash !== toolInputHash) throw this.deps.createError("conflict", "tool_call_identity_conflict");
    }
    const output = matching.find((event) => event.event_type === "tool_call_output");
    if (!output) throw this.deps.createError("conflict", "tool_call_incomplete");
    const resourceRef = output.resource_refs[0];
    const outputValue = output.payload.output;
    const operationId = typeof output.payload.operation_id === "string" ? output.payload.operation_id : undefined;
    return {
      status: "completed",
      ...(typeof output.payload.artifact_id === "string" ? { artifact_id: output.payload.artifact_id } : {}),
      ...(typeof output.payload.title === "string" ? { title: output.payload.title } : {}),
      ...(resourceRef ? { resource_ref: resourceRef } : {}),
      ...(outputValue !== undefined
        ? { output: outputValue }
        : operationId ? { output: { operation_id: operationId } } : {}),
      tool_run_ids: Array.isArray(output.payload.tool_run_ids) ? output.payload.tool_run_ids.filter((id: unknown): id is string => typeof id === "string") : []
    };
  }
}

function timingSafeTokenEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function isRuntimeToolQueryResult(value: RuntimeToolCallResult | RuntimeToolQueryResult): value is RuntimeToolQueryResult {
  return "queryOnly" in value && value.queryOnly === true;
}

function summarize(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}
