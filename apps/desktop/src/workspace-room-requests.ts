export type WorkspaceMemberRole = "owner" | "admin" | "member" | "guest";
export type WorkspaceMemberState = "active" | "revoked";

export interface WorkspaceRoomAgentPermissionRequest {
  can_view: boolean;
  can_edit: boolean;
  can_execute: boolean;
}

export interface WorkspaceRoomNewAgentRequest {
  name: string;
  role: string;
  instructions: string;
  backend_id: string;
  enabled: boolean;
  permission?: WorkspaceRoomAgentPermissionRequest;
}

export interface WorkspaceRoomTargetRequest {
  connectionId: string;
  workspaceId: string;
}

export interface WorkspaceAgentTargetRequest {
  connectionId: string;
  workspaceId: string;
}

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

/** Target-aware Agent operations use the same connection + Workspace boundary
 * as Room creation. The target is optional only for older callers; current
 * Native UI always supplies it and Main rejects a mismatch. */
export function workspaceAgentListRequest(input: unknown): { target?: WorkspaceAgentTargetRequest } {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  return target ? { target } : {};
}

export function workspaceAgentViewRequest(input: unknown): { agentId: string; target?: WorkspaceAgentTargetRequest } {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  return { agentId: requiredWorkspaceOpaqueField(value, "agentId"), ...(target ? { target } : {}) };
}

export function workspaceAgentCreateRequest(input: unknown): {
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { name: string; role: string; instructions: string; backend_id: string; enabled: boolean };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const backendId = requiredWorkspaceOpaqueField(value, "backendId");
  const enabled = value.enabled;
  if (typeof enabled !== "boolean") throw new Error("enabled_invalid");
  return {
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: {
      name: requiredAgentText(value.name, "name", 200),
      role: requiredAgentText(value.role, "role", 500),
      instructions: requiredAgentText(value.instructions, "instructions", 20_000),
      backend_id: backendId,
      enabled
    }
  };
}

export function workspaceAgentPatchRequest(input: unknown): {
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expected_version?: number };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const body: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expected_version?: number } = {
    id: requiredWorkspaceOpaqueField(value, "agentId")
  };
  if (value.name !== undefined) body.name = requiredAgentText(value.name, "name", 200);
  if (value.role !== undefined) body.role = requiredAgentText(value.role, "role", 500);
  if (value.instructions !== undefined) body.instructions = requiredAgentText(value.instructions, "instructions", 20_000);
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("enabled_invalid");
    body.enabled = value.enabled;
  }
  const expectedVersion = optionalVersionField(value, "expectedVersion");
  if (expectedVersion !== undefined) body.expected_version = expectedVersion;
  if (Object.keys(body).length === 1) throw new Error("agent_patch_empty");
  return { operationId: requiredOperationId(value), ...(target ? { target } : {}), body };
}

export function workspaceAgentBackendBindRequest(input: unknown): {
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { id: string; backend_id: string; expected_version?: number };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const expectedVersion = optionalVersionField(value, "expectedVersion");
  return {
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: {
      id: requiredWorkspaceOpaqueField(value, "agentId"),
      backend_id: requiredWorkspaceOpaqueField(value, "backendId"),
      ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion })
    }
  };
}

export function workspaceRoomAgentMemberListRequest(input: unknown): { roomId: string; target?: WorkspaceAgentTargetRequest } {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  return { roomId: requiredWorkspaceOpaqueField(value, "roomId"), ...(target ? { target } : {}) };
}

export function workspaceRoomAgentPermissionRequest(input: unknown): {
  roomId: string;
  agentId: string;
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { agent_id: string; can_view: boolean; can_edit: boolean; can_execute: boolean };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const canView = value.canView;
  const canEdit = value.canEdit;
  const canExecute = value.canExecute;
  if (typeof canView !== "boolean" || typeof canEdit !== "boolean" || typeof canExecute !== "boolean") throw new Error("permission_invalid");
  if ((canEdit || canExecute) && !canView) throw new Error("room_agent_view_required");
  const agentId = requiredWorkspaceOpaqueField(value, "agentId");
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    agentId,
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: { agent_id: agentId, can_view: canView, can_edit: canEdit, can_execute: canExecute }
  };
}

export function workspaceRoomAgentRemoveRequest(input: unknown): {
  roomId: string;
  agentId: string;
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { agent_id: string };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const agentId = requiredWorkspaceOpaqueField(value, "agentId");
  return {
    roomId: requiredWorkspaceOpaqueField(value, "roomId"),
    agentId,
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: { agent_id: agentId }
  };
}

/** Target-aware Room default-Agent mutation. The target stays outside the
 * public Domain input and is checked against Main's active snapshot. */
export function workspaceRoomDefaultAgentRequest(input: unknown): {
  roomId: string;
  agentId: string;
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { agent_id: string; expected_version?: number };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const roomId = requiredWorkspaceOpaqueField(value, "roomId");
  const agentId = requiredWorkspaceOpaqueField(value, "agentId");
  const expectedVersion = optionalVersionField(value, "expectedVersion");
  return {
    roomId,
    agentId,
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: {
      agent_id: agentId,
      ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion })
    }
  };
}

/** Target-aware Agent DM mutation. No Session or credential field is accepted. */
export function workspaceAgentDmRequest(input: unknown): {
  agentId: string;
  operationId: string;
  target?: WorkspaceAgentTargetRequest;
  body: { agent_id: string };
} {
  const value = roomRequestObject(input);
  const target = optionalWorkspaceTarget(value.target);
  const agentId = requiredWorkspaceOpaqueField(value, "agentId");
  return {
    agentId,
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: { agent_id: agentId }
  };
}

export function workspaceRoomCreateRequest(input: unknown): {
  operationId: string;
  target?: WorkspaceRoomTargetRequest;
  body: {
    name: string;
    parent_room_id?: string;
    expected_workspace_version: number;
    default_agent_id?: string;
    default_agent_version?: number;
    new_agent?: WorkspaceRoomNewAgentRequest;
    agent_permission?: WorkspaceRoomAgentPermissionRequest;
  };
} {
  const value = roomRequestObject(input);
  const parentRoomId = optionalOpaqueField(value, "parentRoomId");
  const target = optionalWorkspaceTarget(value.target);
  const defaultAgentId = optionalOpaqueField(value, "defaultAgentId");
  const defaultAgentVersion = optionalVersionField(value, "defaultAgentVersion");
  const newAgent = optionalNewAgent(value.newAgent);
  const agentPermission = optionalAgentPermission(value.agentPermission);
  if (defaultAgentId && newAgent) throw new Error("room_default_agent_selection_conflict");
  if (defaultAgentVersion !== undefined && !defaultAgentId) throw new Error("room_default_agent_required");
  if (agentPermission && !defaultAgentId && !newAgent) throw new Error("room_agent_permission_target_required");
  if (newAgent?.permission && agentPermission && !sameAgentPermission(newAgent.permission, agentPermission)) {
    throw new Error("room_agent_permission_conflict");
  }
  if (newAgent?.enabled === false) throw new Error("room_default_agent_enabled_required");
  const effectivePermission = agentPermission ?? newAgent?.permission;
  if ((defaultAgentId || newAgent) && effectivePermission && (!effectivePermission.can_view || !effectivePermission.can_execute)) {
    throw new Error("room_default_agent_permission_required");
  }
  return {
    operationId: requiredOperationId(value),
    ...(target ? { target } : {}),
    body: {
      name: requiredRoomName(value),
      ...(parentRoomId ? { parent_room_id: parentRoomId } : {}),
      expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion", 1),
      ...(defaultAgentId ? { default_agent_id: defaultAgentId } : {}),
      ...(defaultAgentVersion === undefined ? {} : { default_agent_version: defaultAgentVersion }),
      ...(newAgent ? { new_agent: newAgent } : {}),
      ...(agentPermission ? { agent_permission: agentPermission } : {})
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

function optionalWorkspaceTarget(input: unknown): WorkspaceRoomTargetRequest | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_target_invalid");
  const value = input as Record<string, unknown>;
  const connectionId = value.connectionId;
  const workspaceId = value.workspaceId;
  if (typeof connectionId !== "string" || !opaqueIdPattern.test(connectionId)
    || typeof workspaceId !== "string" || !opaqueIdPattern.test(workspaceId)) {
    throw new Error("workspace_target_invalid");
  }
  return { connectionId, workspaceId };
}

function optionalVersionField(input: Record<string, unknown>, key: string): number | undefined {
  if (input[key] === undefined || input[key] === null || input[key] === "") return undefined;
  return requiredVersion(input, key, 1);
}

function optionalAgentPermission(input: unknown): WorkspaceRoomAgentPermissionRequest | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("agent_permission_invalid");
  const value = input as Record<string, unknown>;
  const canView = value.can_view;
  const canEdit = value.can_edit;
  const canExecute = value.can_execute;
  if (typeof canView !== "boolean" || typeof canEdit !== "boolean" || typeof canExecute !== "boolean") {
    throw new Error("agent_permission_invalid");
  }
  if ((canEdit || canExecute) && !canView) throw new Error("room_agent_view_required");
  return { can_view: canView, can_edit: canEdit, can_execute: canExecute };
}

function optionalNewAgent(input: unknown): WorkspaceRoomNewAgentRequest | undefined {
  if (input === undefined || input === null) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("new_agent_invalid");
  const value = input as Record<string, unknown>;
  const name = boundedText(value.name, "new_agent_name_invalid", 200);
  const role = boundedText(value.role, "new_agent_role_invalid", 500);
  const instructions = boundedText(value.instructions, "new_agent_instructions_invalid", 20_000);
  const backendId = value.backend_id;
  if (typeof backendId !== "string" || !opaqueIdPattern.test(backendId)) throw new Error("new_agent_backend_id_invalid");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("new_agent_enabled_invalid");
  const permission = optionalAgentPermission(value.permission);
  return {
    name,
    role,
    instructions,
    backend_id: backendId,
    enabled: value.enabled ?? true,
    ...(permission ? { permission } : {})
  };
}

function boundedText(value: unknown, error: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(error);
  return value.trim();
}

function requiredAgentText(value: unknown, key: string, maximum: number): string {
  return boundedText(value, `agent_${key}_invalid`, maximum);
}

function sameAgentPermission(left: WorkspaceRoomAgentPermissionRequest, right: WorkspaceRoomAgentPermissionRequest): boolean {
  return left.can_view === right.can_view && left.can_edit === right.can_edit && left.can_execute === right.can_execute;
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
