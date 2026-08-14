export type WorkspaceMemberRole = "owner" | "admin" | "member" | "guest";
export type WorkspaceMemberState = "active" | "revoked";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The renderer can ask only for these fixed Room operations.  This module
 * deliberately produces request bodies, never a URL, signature, or key.
 */
export function requiredWorkspaceOpaqueField(input: unknown, key: string): string {
  const value = roomRequestObject(input)[key];
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error(`${key}_invalid`);
  return value;
}

export function workspaceRoomCreateRequest(input: unknown): {
  operationId: string;
  body: { name: string; parent_room_id?: string; expected_workspace_version: number };
} {
  const value = roomRequestObject(input);
  const parentRoomId = optionalOpaqueField(value, "parentRoomId");
  return {
    operationId: requiredOperationId(value),
    body: {
      name: requiredRoomName(value),
      ...(parentRoomId ? { parent_room_id: parentRoomId } : {}),
      expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion", 1)
    }
  };
}

export function workspaceRoomMovePreviewRequest(input: unknown): {
  roomId: string;
  body: { parent_room_id: string | null };
} {
  const value = roomRequestObject(input);
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    body: { parent_room_id: nullableOpaqueField(value, "parentRoomId") }
  };
}

export function workspaceRoomMoveRequest(input: unknown): {
  roomId: string;
  operationId: string;
  body: { parent_room_id: string | null; expected_room_version: number; expected_workspace_version: number };
} {
  const value = roomRequestObject(input);
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    operationId: requiredOperationId(value),
    body: {
      parent_room_id: nullableOpaqueField(value, "parentRoomId"),
      expected_room_version: requiredVersion(value, "expectedRoomVersion", 1),
      expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion", 1)
    }
  };
}

export function workspaceRoomMemberPreviewRequest(input: unknown): {
  roomId: string;
  accountId: string;
  body: { role: WorkspaceMemberRole; state: WorkspaceMemberState };
} {
  const value = roomRequestObject(input);
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    accountId: requiredWorkspaceOpaqueField(value, "accountId"),
    body: { role: memberRole(value), state: memberState(value) }
  };
}

export function workspaceRoomMemberRequest(input: unknown): {
  roomId: string;
  accountId: string;
  operationId: string;
  body: { role: WorkspaceMemberRole; state: WorkspaceMemberState; expected_version: number };
} {
  const value = roomRequestObject(input);
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    accountId: requiredWorkspaceOpaqueField(value, "accountId"),
    operationId: requiredOperationId(value),
    body: {
      role: memberRole(value),
      state: memberState(value),
      expected_version: requiredVersion(value, "expectedVersion", 0)
    }
  };
}

function roomRequestObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_room_request_invalid");
  return input as Record<string, unknown>;
}

function optionalOpaqueField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error(`${key}_invalid`);
  return value;
}

function nullableOpaqueField(input: Record<string, unknown>, key: string): string | null {
  if (!(key in input)) throw new Error(`${key}_required`);
  if (input[key] === null) return null;
  const value = input[key];
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error(`${key}_invalid`);
  return value;
}

function requiredRoomName(input: Record<string, unknown>): string {
  const value = input.name;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 240) throw new Error("room_name_invalid");
  return value.trim();
}

function requiredVersion(input: Record<string, unknown>, key: string, minimum: number): number {
  const value = input[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new Error(`${key}_invalid`);
  return value;
}

function requiredOperationId(input: Record<string, unknown>): string {
  const value = input.operationId;
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error("operation_id_invalid");
  return value;
}

function memberRole(input: Record<string, unknown>): WorkspaceMemberRole {
  const value = input.role;
  if (value === "owner" || value === "admin" || value === "member" || value === "guest") return value;
  throw new Error("role_invalid");
}

function memberState(input: Record<string, unknown>): WorkspaceMemberState {
  const value = input.state;
  if (value === "active" || value === "revoked") return value;
  throw new Error("state_invalid");
}
