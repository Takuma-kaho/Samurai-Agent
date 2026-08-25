import { DomainContractError, TrustedDomainContextError, type BoundOperationDefinition, type DomainInputSource, type DomainResult, type OperationDefinition, type TrustedDomainContext } from "../definition/index.js";
import { bindOperationDefinitions, type DomainOperationPorts } from "../generated/operation-binder.generated.js";
import { operationDefinitions } from "../generated/operation-index.generated.js";

export class DomainOperationError extends Error {
  constructor(readonly code: "not_found" | "invalid_input" | "invalid_output" | "source_not_allowed" | "unavailable" | "conflict" | "outcome_unknown" | "internal", message: string, readonly handlerCause?: unknown) {
    super(message);
    this.name = "DomainOperationError";
  }
}

export interface DomainOperationLogEntry {
  operationId: string;
  version: string;
  source: DomainInputSource;
  correlationId: string;
  durationMs: number;
  outcome: "succeeded" | "failed";
  errorCode?: DomainOperationError["code"];
}

export class DomainOperationRegistry {
  readonly #definitions = new Map<string, OperationDefinition>();
  readonly #bindings = new Map<string, BoundOperationDefinition>();
  readonly #logs: DomainOperationLogEntry[] = [];

  constructor(ports: DomainOperationPorts, bindings: readonly BoundOperationDefinition[] = bindOperationDefinitions(ports)) {
    const handlers = new Set<unknown>();
    for (const binding of bindings) {
      const { definition } = binding;
      if (!definition || typeof definition.id !== "string" || !definition.id) throw new Error("domain_operation_definition_missing");
      if (!isZodSchema(definition.input)) throw new Error(`domain_operation_input_schema_missing:${definition.id}`);
      if (!isZodSchema(definition.output)) throw new Error(`domain_operation_output_schema_missing:${definition.id}`);
      if (!binding || typeof binding.execute !== "function") throw new Error(`domain_operation_handler_missing:${definition.id}`);
      if (this.#definitions.has(definition.id)) throw new Error(`duplicate_domain_operation_id:${definition.id}`);
      if (handlers.has(binding.handlerName)) throw new Error(`domain_operation_handler_reused:${definition.id}`);
      handlers.add(binding.handlerName);
      this.#definitions.set(definition.id, definition);
      this.#bindings.set(definition.id, binding);
    }
    if (this.#definitions.size !== operationDefinitions.length) throw new Error("domain_operation_registry_incomplete");
    Object.freeze(this);
  }

  get(id: string): OperationDefinition | undefined {
    return this.#definitions.get(id);
  }

  bindingIdentity(id: string): { operationId: string; version: string; handlerSymbol: string } | undefined {
    const definition = this.#definitions.get(id);
    const binding = this.#bindings.get(id);
    if (!definition || !binding) return undefined;
    return { operationId: definition.id, version: definition.version, handlerSymbol: binding.handlerName };
  }

  list(source?: DomainInputSource): OperationDefinition[] {
    const definitions = [...this.#definitions.values()].filter((definition) => definition.availability === "active");
    return source ? definitions.filter((definition) => definition.sources.includes(source)) : definitions;
  }

  listLogEntries(): DomainOperationLogEntry[] {
    return this.#logs.map((entry) => ({ ...entry }));
  }

  async execute(context: TrustedDomainContext, id: string, rawInput: unknown): Promise<DomainResult<unknown>> {
    const startedAt = performance.now();
    const definition = this.#definitions.get(id);
    const binding = this.#bindings.get(id);
    try {
      if (!definition || !binding) throw new DomainOperationError("not_found", `domain_operation_not_found:${id}`);
      if (definition.availability !== "active") throw new DomainOperationError("unavailable", `domain_operation_unavailable:${id}`);
      if (!definition.sources.includes(context.inputSource)) throw new DomainOperationError("source_not_allowed", `domain_operation_source_not_allowed:${id}:${context.inputSource}`);
      validatePayloadLimits(rawInput, id);
      assertContextActive(context, id);
      let result: DomainResult<unknown>;
      try {
        result = await executeWithContextCancellation(context, id, binding, rawInput);
      } catch (error) {
        if (error instanceof DomainContractError) {
          const code = error.stage === "input" ? "invalid_input" : "invalid_output";
          throw new DomainOperationError(code, `domain_operation_${error.stage}_invalid:${id}:${formatIssue(error.issue)}`);
        }
        throw normalizeHandlerError(error, id);
      }
      assertContextActive(context, id);
      this.#recordLog(context, definition, startedAt, "succeeded");
      return result;
    } catch (error) {
      const normalized = error instanceof DomainOperationError ? error : new DomainOperationError("internal", `domain_operation_internal:${id}`);
      this.#recordLog(context, definition, startedAt, "failed", normalized.code);
      throw normalized;
    }
  }

  #recordLog(context: TrustedDomainContext, definition: OperationDefinition | undefined, startedAt: number, outcome: DomainOperationLogEntry["outcome"], errorCode?: DomainOperationError["code"]): void {
    this.#logs.push({
      operationId: definition?.id ?? "unknown",
      version: definition?.version ?? "unknown",
      source: context.inputSource,
      correlationId: context.correlationId,
      durationMs: Math.max(0, performance.now() - startedAt),
      outcome,
      ...(errorCode ? { errorCode } : {})
    });
    if (this.#logs.length > 1_000) this.#logs.shift();
  }
}

/**
 * Keep cancellation and deadlines live while a handler is inside a port call.
 * Ports still receive the same TrustedDomainContext (including signal and
 * deadline), while the Registry prevents a slow/non-cooperative port from
 * holding the command ingress past its caller's cancellation boundary. Once
 * the handler has started, an interruption is outcome_unknown because the
 * handler may have performed an external side effect before it stopped (or
 * before it eventually settles). The bounded race must not wait forever.
 */
async function executeWithContextCancellation(
  context: TrustedDomainContext,
  operationId: string,
  binding: BoundOperationDefinition,
  rawInput: unknown
): Promise<DomainResult<unknown>> {
  const work = binding.execute(context, rawInput);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    const rejectCancelled = () => reject(new DomainOperationError("outcome_unknown", `domain_operation_outcome_unknown:${operationId}:cancelled`));
    if (context.signal) {
      if (context.signal.aborted) {
        rejectCancelled();
        return;
      }
      context.signal.addEventListener("abort", rejectCancelled, { once: true });
      removeAbortListener = () => context.signal?.removeEventListener("abort", rejectCancelled);
    }
    if (context.deadlineAt !== undefined) {
      const remaining = context.deadlineAt - Date.now();
      if (remaining <= 0) {
        reject(new DomainOperationError("outcome_unknown", `domain_operation_outcome_unknown:${operationId}:deadline_exceeded`));
        return;
      }
      timer = setTimeout(() => reject(new DomainOperationError("outcome_unknown", `domain_operation_outcome_unknown:${operationId}:deadline_exceeded`)), remaining);
    }
  });
  try {
    return await Promise.race([work, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

const handlerErrorCodes = new Set(["not_found", "unavailable", "conflict", "outcome_unknown", "bad_request", "validation", "forbidden", "provider_not_configured", "provider_failed", "backend_cancelled", "backend_execution_root_not_ready", "resource_mutation_evidence_failed", "workspace_change_notification_failed"]);

function normalizeHandlerError(error: unknown, operationId: string): DomainOperationError {
  if (error instanceof DomainOperationError) return error;
  if (error instanceof TrustedDomainContextError) {
    return new DomainOperationError("internal", error.message, error);
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && handlerErrorCodes.has(error.code)) {
    const code: DomainOperationError["code"] = error.code === "not_found" ? "not_found" : error.code === "unavailable" ? "unavailable" : error.code === "outcome_unknown" ? "outcome_unknown" : error.code === "validation" ? "invalid_input" : "conflict";
    return new DomainOperationError(code, `domain_operation_handler_failed:${operationId}:${error.code}`, error);
  }
  return new DomainOperationError("internal", `domain_operation_internal:${operationId}`);
}

function isZodSchema(value: unknown): value is OperationDefinition["input"] {
  if (value === null || typeof value !== "object" || !("safeParse" in value)) return false;
  return typeof value.safeParse === "function";
}

const payloadLimits = Object.freeze({
  maximumDepth: 32,
  maximumArrayItems: 1_000,
  maximumObjectKeys: 1_000,
  maximumStringLength: 1_000_000,
  maximumTotalCharacters: 2_000_000
});
const forbiddenObjectKeys = new Set(["__proto__", "prototype", "constructor"]);

function validatePayloadLimits(value: unknown, operationId: string): void {
  let totalCharacters = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > payloadLimits.maximumDepth) fail("depth");
    if (typeof current === "string") {
      totalCharacters += current.length;
      if (current.length > payloadLimits.maximumStringLength) fail("string_length");
    } else if (Array.isArray(current)) {
      if (current.length > payloadLimits.maximumArrayItems) fail("array_items");
      for (const item of current) visit(item, depth + 1);
    } else if (current !== null && typeof current === "object") {
      const keys = Object.keys(current);
      if (keys.length > payloadLimits.maximumObjectKeys) fail("object_keys");
      for (const key of keys) {
        if (forbiddenObjectKeys.has(key)) fail("forbidden_key");
        totalCharacters += key.length;
        visit((current as Record<string, unknown>)[key], depth + 1);
      }
    }
    if (totalCharacters > payloadLimits.maximumTotalCharacters) fail("total_characters");
  };
  const fail = (reason: string): never => {
    throw new DomainOperationError("invalid_input", `domain_operation_payload_limit:${operationId}:${reason}`);
  };
  visit(value, 0);
}

function assertContextActive(context: TrustedDomainContext, operationId: string): void {
  if (context.signal?.aborted) {
    throw new DomainOperationError("unavailable", `domain_operation_cancelled:${operationId}`);
  }
  if (context.deadlineAt !== undefined && Date.now() >= context.deadlineAt) {
    throw new DomainOperationError("unavailable", `domain_operation_deadline_exceeded:${operationId}`);
  }
}

function formatIssue(issue: { path: (string | number)[]; message: string } | undefined): string {
  return `${issue?.path.length ? `$.${issue.path.join(".")}` : "$"}:${issue?.message ?? "invalid_value"}`;
}
