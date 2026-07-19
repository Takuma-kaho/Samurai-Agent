import { describe, expect, it } from "vitest";
import { bindOperationDefinitions, DomainOperationRegistry, TrustedDomainContextError, type DomainOperationPorts, type TrustedDomainContext } from "../index.js";

let observedSignal: AbortSignal | undefined;
let observedDeadline: number | undefined;

const cancellationOperationId = "mcp.call";

function cancellationRegistry() {
  const ports = new Proxy({}, {
    get: (_target, operationId) => new Proxy({}, {
      get: (_ports, method) => (...args: unknown[]) => {
        if (String(operationId) === cancellationOperationId && String(method) === "executeMcpCall") {
          const [portContext] = args as [TrustedDomainContext];
          observedSignal = portContext.signal;
          observedDeadline = portContext.deadlineAt;
          return new Promise<void>(() => undefined);
        }
        return undefined;
      }
    })
  }) as DomainOperationPorts;
  const bindings = bindOperationDefinitions(ports);
  const target = bindings.find((binding) => binding.definition.id === cancellationOperationId);
  if (!target) throw new Error(`missing_test_operation:${cancellationOperationId}`);
  const hangingBinding = {
    ...target,
    handlerName: `${target.handlerName}:cancellation-test`,
    async execute(context: TrustedDomainContext, _rawInput: unknown) {
      return target.execute(context, {
        server_name: "server",
        tool_name: "tool",
        input: {},
        metadata: {}
      });
    }
  };
  return new DomainOperationRegistry(ports, bindings.map((binding) => binding.definition.id === cancellationOperationId ? hangingBinding : binding));
}

function context(overrides: Partial<TrustedDomainContext> = {}): TrustedDomainContext {
  return {
    inputSource: "runtime_api",
    workspaceId: "workspace-test",
    actorId: "owner",
    correlationId: "correlation-test",
    ...overrides
  };
}

describe("DomainOperationRegistry cancellation", () => {
  it("rejects an in-flight handler when its signal is aborted", async () => {
    const registry = cancellationRegistry();
    const controller = new AbortController();
    const execution = registry.execute({ ...context({ signal: controller.signal }), inputSource: "provider_tool_call" }, cancellationOperationId, {});
    controller.abort();
    await expect(execution).rejects.toMatchObject({ code: "unavailable" });
    expect(observedSignal).toBe(controller.signal);
  });

  it("rejects an in-flight handler when its deadline expires", async () => {
    const registry = cancellationRegistry();
    const execution = registry.execute({ ...context({ deadlineAt: Date.now() + 5 }), inputSource: "provider_tool_call" }, cancellationOperationId, {});
    await expect(execution).rejects.toMatchObject({ code: "unavailable" });
    expect(observedDeadline).toBeDefined();
  });

  it("rejects before entering a handler when the signal is already aborted", async () => {
    const registry = cancellationRegistry();
    const controller = new AbortController();
    controller.abort();

    await expect(registry.execute({ ...context({ signal: controller.signal }), inputSource: "provider_tool_call" }, cancellationOperationId, {})).rejects.toMatchObject({
      code: "unavailable",
      message: `domain_operation_cancelled:${cancellationOperationId}`
    });
  });

  it("rejects before entering a handler when the deadline has already passed", async () => {
    const registry = cancellationRegistry();

    await expect(registry.execute({ ...context({ deadlineAt: Date.now() - 1 }), inputSource: "provider_tool_call" }, cancellationOperationId, {})).rejects.toMatchObject({
      code: "unavailable",
      message: `domain_operation_deadline_exceeded:${cancellationOperationId}`
    });
  });

  it("normalizes trusted-context errors from a handler", async () => {
    const ports = new Proxy({}, {
      get: () => new Proxy({}, {
        get: () => () => undefined
      })
    }) as DomainOperationPorts;
    const bindings = bindOperationDefinitions(ports);
    const target = bindings.find((binding) => binding.definition.id === cancellationOperationId)!;
    const trustedError = new TrustedDomainContextError(cancellationOperationId, "runId");
    const errorBinding = {
      ...target,
      handlerName: `${target.handlerName}:trusted-context-test`,
      async execute(): Promise<never> {
        throw trustedError;
      }
    };
    const registry = new DomainOperationRegistry(ports, bindings.map((binding) => binding.definition.id === cancellationOperationId ? errorBinding : binding));

    await expect(registry.execute({ ...context(), inputSource: "provider_tool_call" }, cancellationOperationId, {})).rejects.toMatchObject({
      code: "internal",
      message: trustedError.message,
      handlerCause: trustedError
    });
  });

  it("keeps the registry error boundary defensive for malformed context", async () => {
    const registry = cancellationRegistry();

    await expect(registry.execute(null as never, cancellationOperationId, {})).rejects.toBeInstanceOf(Error);
  });
});
