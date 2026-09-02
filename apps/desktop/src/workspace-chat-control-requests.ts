const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type WorkspaceChatRunControlAction = "cancel" | "retry";

export interface WorkspaceChatRunControlRequest {
  action: WorkspaceChatRunControlAction;
  runId: string;
  operationId: string;
  body: Record<string, unknown>;
}

/**
 * Stop/retry share one narrow request contract.  Main adds the active
 * Workspace scope and signs the request; the renderer never gets a generic
 * request function.
 */
export function workspaceChatRunControlRequest(input: unknown, action: WorkspaceChatRunControlAction): WorkspaceChatRunControlRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_chat_run_control_request_invalid");
  const value = input as Record<string, unknown>;
  const runId = requiredOpaque(value, "runId");
  const operationId = requiredOpaque(value, "operationId");
  return {
    action,
    runId,
    operationId,
    body: action === "retry"
      ? { confirm_unknown: value.confirmUnknown === true }
      : {}
  };
}

export function workspaceChatReconnectRequest(input: unknown): { connectionId?: string } {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_chat_reconnect_request_invalid");
  const value = input as Record<string, unknown>;
  if (value.connectionId === undefined || value.connectionId === null || value.connectionId === "") return {};
  return { connectionId: requiredOpaque(value, "connectionId") };
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}
