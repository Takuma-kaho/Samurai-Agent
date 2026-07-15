import { domainResultEnvelopeSchema, type DomainInputSource, type DomainResult, type OperationDefinition, type OperationHandler, type TrustedDomainContext } from "../definition/index.js";
import { bindOperationDefinitions, type BoundOperationDefinition, type DomainOperationPorts } from "../generated/operation-binder.generated.js";
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
  readonly #handlers = new Map<string, OperationHandler<unknown, unknown>>();
  readonly #logs: DomainOperationLogEntry[] = [];

  constructor(ports: DomainOperationPorts, bindings: readonly BoundOperationDefinition[] = bindOperationDefinitions(ports)) {
    const handlers = new Set<unknown>();
    for (const binding of bindings) {
      const { definition, handler } = binding;
      if (!definition || typeof definition.id !== "string" || !definition.id) throw new Error("domain_operation_definition_missing");
      if (!isZodSchema(definition.input)) throw new Error(`domain_operation_input_schema_missing:${definition.id}`);
      if (!isZodSchema(definition.output)) throw new Error(`domain_operation_output_schema_missing:${definition.id}`);
      if (!handler || typeof handler.execute !== "function") throw new Error(`domain_operation_handler_missing:${definition.id}`);
      if (this.#definitions.has(definition.id)) throw new Error(`duplicate_domain_operation_id:${definition.id}`);
      if (handlers.has(handler)) throw new Error(`domain_operation_handler_reused:${definition.id}`);
      handlers.add(handler);
      this.#definitions.set(definition.id, definition);
      this.#handlers.set(definition.id, handler);
    }
    if (this.#definitions.size !== operationDefinitions.length) throw new Error("domain_operation_registry_incomplete");
    Object.freeze(this);
  }

  get(id: string): OperationDefinition | undefined {
    return this.#definitions.get(id);
  }

  bindingIdentity(id: string): { operationId: string; version: string; handlerSymbol: string } | undefined {
    const definition = this.#definitions.get(id);
    const handler = this.#handlers.get(id);
    if (!definition || !handler) return undefined;
    return { operationId: definition.id, version: definition.version, handlerSymbol: handler.execute.name };
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
    const handler = this.#handlers.get(id);
    try {
      if (!definition || !handler) throw new DomainOperationError("not_found", `domain_operation_not_found:${id}`);
      if (definition.availability !== "active") throw new DomainOperationError("unavailable", `domain_operation_unavailable:${id}`);
      if (!definition.sources.includes(context.inputSource)) throw new DomainOperationError("source_not_allowed", `domain_operation_source_not_allowed:${id}:${context.inputSource}`);
      validatePayloadLimits(rawInput, id);
      assertContextActive(context, id);
      const input = definition.input.safeParse(rawInput);
      if (!input.success) throw new DomainOperationError("invalid_input", `domain_operation_input_invalid:${id}:${formatIssue(input.error.issues[0])}`);
      let result: unknown;
      try {
        result = await handler.execute(context, input.data);
      } catch (error) {
        throw normalizeHandlerError(error, id);
      }
      assertContextActive(context, id);
      const envelope = domainResultEnvelopeSchema.safeParse(result);
      if (!envelope.success) throw new DomainOperationError("invalid_output", `domain_operation_result_invalid:${id}:${formatIssue(envelope.error.issues[0])}`);
      const output = definition.output.safeParse(envelope.data.value);
      if (!output.success) throw new DomainOperationError("invalid_output", `domain_operation_output_invalid:${id}:${formatIssue(output.error.issues[0])}`);
      this.#recordLog(context, definition, startedAt, "succeeded");
      return { ok: true, value: output.data };
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

const handlerErrorCodes = new Set(["not_found", "unavailable", "conflict", "outcome_unknown", "bad_request", "forbidden", "provider_not_configured", "provider_failed", "backend_cancelled", "backend_execution_root_not_ready"]);

function normalizeHandlerError(error: unknown, operationId: string): DomainOperationError {
  if (error instanceof DomainOperationError) return error;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && handlerErrorCodes.has(error.code)) {
    const code: DomainOperationError["code"] = error.code === "not_found" ? "not_found" : error.code === "unavailable" ? "unavailable" : error.code === "outcome_unknown" ? "outcome_unknown" : "conflict";
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
