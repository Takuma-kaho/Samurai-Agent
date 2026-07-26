import { timingSafeEqual } from "node:crypto";
import { getDomainQueryForProviderToolName } from "@samurai-agent/action-catalog";
import type { BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import {
  type ArtifactRecord,
  type BackendEventRecord,
  type BackendRunRecord,
  type JsonValue,
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
  artifacts: ArtifactRecord[];
  toolRuns: ToolRunRecord[];
}

export interface BackendToolBridgeServiceDependencies {
  getRun(runId: string): Promise<BackendRunRecord | undefined>;
  buildRunInput(run: BackendRunRecord): Promise<BackendRunInput>;
  recordEvent(run: BackendRunRecord, event: BackendOutputEvent): Promise<BackendEventRecord>;
  executeRuntimeTool(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendOutputEvent;
  }): Promise<RuntimeToolCallResult | RuntimeToolQueryResult | undefined>;
  executeProviderQuery(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendOutputEvent;
    queryId: string;
    args: Record<string, JsonValue>;
  }): Promise<RuntimeToolQueryResult | undefined>;
  runReadOnlyTool(input: { toolName: string; toolInput: Record<string, JsonValue>; runId: string }): Promise<JsonValue>;
  executeBackendToolStarted(input: {
    run: BackendRunRecord;
    runInput: BackendRunInput;
    event: BackendOutputEvent;
    recordEvent: (event: BackendOutputEvent) => Promise<BackendEventRecord>;
  }): Promise<BackendToolStartedResult>;
  createError(code: BackendToolBridgeErrorCode, message: string): Error;
}

/** Process-local HTTP Tool Bridge state and execution path. */
export class BackendToolBridgeService {
  private readonly tokens = new Map<string, string>();

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

    const runInput = await this.deps.buildRunInput(run);
    const recordEvent = (event: BackendOutputEvent) => this.deps.recordEvent(run, {
      ...event,
      source_event_id: event.source_event_id
        ?? `tool-bridge:${run.id}:${toolCallId}:${event.event_type}:${stableHash(event.payload)}`
    });
    const startedEvent = normalizeBackendOutputEvent({
      event_type: "tool_call_started",
      tool_call_id: toolCallId,
      payload: {
        provider_tool_name: providerToolName,
        action_id: samuraiToolBridgeActionId(providerToolName),
        tool_origin: "samurai_tool_bridge",
        input: input.toolInput
      }
    });
    await recordEvent(startedEvent);

    if (samuraiToolBridgeWriteTools.has(providerToolName)) {
      const feedback = await this.deps.executeRuntimeTool({ run, runInput, event: startedEvent });
      if (!feedback) throw this.deps.createError("conflict", "tool_bridge_write_tool_failed");
      if (isRuntimeToolQueryResult(feedback)) {
        throw this.deps.createError("conflict", "tool_bridge_write_tool_returned_query");
      }
      await recordEvent({
        event_type: "tool_call_output",
        tool_call_id: toolCallId,
        payload: feedback.outputPayload ?? {
          status: "completed",
          action_id: feedback.operation.operation,
          resource_id: feedback.operation.result_ref?.id ?? feedback.operation.id
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

    if (providerToolName !== "samurai.artifact.create") {
      const providerQuery = getDomainQueryForProviderToolName(providerToolName);
      if (providerQuery) {
        const feedback = await this.deps.executeProviderQuery({
          run,
          runInput,
          event: startedEvent,
          queryId: providerQuery.id,
          args: input.toolInput
        });
        if (!feedback) throw this.deps.createError("conflict", "tool_bridge_query_failed");
        const output = feedback.outputPayload?.result ?? feedback.outputPayload;
        await recordEvent({
          event_type: "tool_call_output",
          tool_call_id: toolCallId,
          payload: {
            provider_tool_name: providerToolName,
            action_id: samuraiToolBridgeActionId(providerToolName),
            status: "completed",
            output: output ?? null,
            ...(feedback.outputPayload?.render_specs !== undefined ? { render_specs: feedback.outputPayload.render_specs } : {})
          },
          resource_refs: feedback.resourceRefs ?? []
        });
        return { status: "completed", output, resource_ref: feedback.resourceRefs?.[0], tool_run_ids: [] };
      }

      const output = await this.deps.runReadOnlyTool({ toolName: providerToolName, toolInput: input.toolInput, runId: input.runId });
      await recordEvent({
        event_type: "tool_call_output",
        tool_call_id: toolCallId,
        payload: {
          provider_tool_name: providerToolName,
          action_id: providerToolName,
          output_summary: summarize(JSON.stringify(output), 220),
          output
        }
      });
      return { status: "completed", output, tool_run_ids: [] };
    }

    const feedback = await this.deps.executeBackendToolStarted({
      run,
      runInput,
      event: startedEvent,
      recordEvent
    });
    const artifact = feedback.artifacts[0];
    return {
      status: "completed",
      ...(artifact ? { artifact_id: artifact.id, title: artifact.title, resource_ref: artifact.file_ref } : {}),
      tool_run_ids: feedback.toolRuns.map((toolRun) => toolRun.id)
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
