import type { BackendRunInput } from "@samurai-agent/agent-backends";
import type { AdmittedTurn, HostContextPort, PreparedTurn, TurnBackendHandoffResult, TurnContextAssemblyResult } from "./host-types";
import { classifyBackendContextIntent, expectedBackendOutputs } from "./turn-preparation-policy";

/**
 * Owns the one preparation path between an admitted turn and Backend input.
 * Backend selection and execution deliberately do not belong here.
 */
export class TurnPreparer {
  constructor(private readonly context: HostContextPort) {}

  async prepare(admittedTurn: AdmittedTurn, signal?: AbortSignal): Promise<PreparedTurn> {
    throwIfAborted(signal);
    const prepared = await this.prepareThroughStages(admittedTurn, signal);
    throwIfAborted(signal);
    const backendInput = normalizeBackendInput(admittedTurn, prepared, signal);
    const result: PreparedTurn = {
      ...admittedTurn,
      context: prepared.context,
      handoff: prepared.handoff,
      backendInput
    };

    // The preparation result is a snapshot. Runtime execution creates a new
    // object when the Run gains a Backend session id or a lifecycle phase.
    return Object.freeze(result);
  }

  private async prepareThroughStages(admittedTurn: AdmittedTurn, signal?: AbortSignal): Promise<{
    context: TurnContextAssemblyResult["context"];
    availableTools?: TurnContextAssemblyResult["availableTools"];
    gatewayBoundary?: TurnContextAssemblyResult["gatewayBoundary"];
    handoff: TurnBackendHandoffResult["handoff"];
    backendInput: BackendRunInput;
  }> {
    const candidates = await this.context.getCandidates({ turn: admittedTurn, signal });
    throwIfAborted(signal);
    const assembly = await this.context.assemble({ turn: admittedTurn, candidates, signal });
    throwIfAborted(signal);
    const backendHandoff = await this.context.handoff({ turn: admittedTurn, candidates, assembly, signal });
    return {
      context: assembly.context,
      ...(assembly.availableTools ? { availableTools: assembly.availableTools } : {}),
      ...(assembly.gatewayBoundary ? { gatewayBoundary: assembly.gatewayBoundary } : {}),
      handoff: backendHandoff.handoff,
      backendInput: backendHandoff.backendInput
    };
  }
}

function normalizeBackendInput(admittedTurn: AdmittedTurn, prepared: {
  context: TurnContextAssemblyResult["context"];
  availableTools?: TurnContextAssemblyResult["availableTools"];
  gatewayBoundary?: TurnContextAssemblyResult["gatewayBoundary"];
  handoff: TurnBackendHandoffResult["handoff"];
  backendInput: BackendRunInput;
}, signal?: AbortSignal): BackendRunInput {
  const input = prepared.backendInput;
  if (!input || typeof input !== "object") throw new Error("backend_input_required");
  const agentContext = agentContextForTurn(admittedTurn);
  const backendSessionKey = backendSessionKeyForTurn(admittedTurn, agentContext);
  return {
    ...input,
    // These values are owned by Admission and cannot be changed by context
    // assembly or a late Backend adapter.
    run_id: admittedTurn.run.id,
    session_id: admittedTurn.session.id,
    ...(admittedTurn.session.room_id ? { room_id: admittedTurn.session.room_id } : {}),
    ...(agentContext ? { agent_context: agentContext } : {}),
    ...(backendSessionKey ? { backend_session_key: backendSessionKey } : {}),
    input_message_id: admittedTurn.userMessage.id,
    envelope: admittedTurn.request.envelope,
    user_input: admittedTurn.request.content,
    input_locale: admittedTurn.request.envelope.input_locale,
    output_locale: admittedTurn.session.output_locale,
    metadata: { ...(admittedTurn.request.metadata ?? {}), ...input.metadata },
    context_assembly: prepared.context,
    context_handoff: prepared.handoff,
    ...(input.context_intent === undefined ? { context_intent: classifyBackendContextIntent(admittedTurn.request.content) } : {}),
    ...(input.expected_outputs === undefined ? { expected_outputs: expectedBackendOutputs(admittedTurn.request.content) } : {}),
    ...(prepared.availableTools !== undefined && input.available_tools === undefined ? { available_tools: [...prepared.availableTools] } : {}),
    ...(prepared.gatewayBoundary !== undefined && input.gateway_boundary === undefined ? { gateway_boundary: prepared.gatewayBoundary } : {}),
    abort_signal: signal ?? input.abort_signal
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw typeof DOMException === "function"
    ? new DOMException("The operation was aborted", "AbortError")
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function agentContextForTurn(admittedTurn: AdmittedTurn): { id: string; name: string; role: string; instructions: string; authority: "supporting_context" } | undefined {
  if (admittedTurn.request.agent) {
    return {
      id: admittedTurn.request.agent.id,
      name: admittedTurn.request.agent.name,
      role: admittedTurn.request.agent.role,
      instructions: admittedTurn.request.agent.instructions,
      authority: "supporting_context"
    };
  }
  const metadata = admittedTurn.request.metadata ?? admittedTurn.run.metadata;
  const name = typeof metadata.agent_name === "string" ? metadata.agent_name : undefined;
  const role = typeof metadata.agent_role === "string" ? metadata.agent_role : undefined;
  const instructions = typeof metadata.agent_instructions === "string" ? metadata.agent_instructions : undefined;
  const id = admittedTurn.run.agent_id ?? admittedTurn.request.agentId;
  return id && name && role && instructions ? { id, name, role, instructions, authority: "supporting_context" } : undefined;
}

function backendSessionKeyForTurn(
  admittedTurn: AdmittedTurn,
  agentContext: ReturnType<typeof agentContextForTurn>
): string | undefined {
  const roomId = admittedTurn.session.room_id;
  if (!roomId || !agentContext) return undefined;
  return `${roomId}:${admittedTurn.session.id}:${agentContext.id}:${admittedTurn.binding.id}`;
}
