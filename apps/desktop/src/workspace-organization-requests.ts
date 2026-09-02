/**
 * Fixed request descriptors for the Organization bridge.
 *
 * This module intentionally knows the HTTP route names but not the signing
 * key, fetch implementation, or persistence.  Main owns those concerns and
 * turns these descriptors into signed requests.  Keeping the route surface
 * here makes a server route rename a single, reviewable change.
 */

export type OrganizationRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface OrganizationRequestDescriptor {
  method: OrganizationRequestMethod;
  path: string;
  body?: Record<string, unknown>;
  operationId?: string;
  idempotencyKey?: string;
  /** Organization routes authenticate the Account, not a Workspace. */
  workspaceScoped: false;
}

export interface WorkspaceSelectionRequestDescriptor {
  method: "GET";
  path: string;
  workspaceScoped: true;
  workspaceId: string;
}

export type WorkspaceOrganizationWorkspaceLifecycle = "archive" | "restore" | "delete";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const operationIdPattern = opaqueIdPattern;

export function workspaceOrganizationListRequest(): OrganizationRequestDescriptor {
  return get("/api/organizations");
}

export function workspaceOrganizationViewRequest(input: unknown): OrganizationRequestDescriptor {
  return get(`/api/organizations/${encodeURIComponent(requiredId(input, "organizationId"))}`);
}

export function workspaceOrganizationCreateRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const operationId = requiredOperationId(value);
  return mutation("POST", "/api/organizations", operationId, {
    name: requiredText(value, "name", 240),
    ...(optionalText(value, "description", 20_000) ? { description: optionalText(value, "description", 20_000) } : {}),
    ...(optionalText(value, "icon", 2_000) ? { icon: optionalText(value, "icon", 2_000) } : {})
  });
}

export function workspaceOrganizationPatchRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const operationId = requiredOperationId(value);
  const patch: Record<string, unknown> = {};
  if (value.name !== undefined) patch.name = requiredText(value, "name", 240);
  if (value.description !== undefined) patch.description = value.description === null ? null : requiredText(value, "description", 20_000);
  if (value.icon !== undefined) patch.icon = value.icon === null ? null : requiredText(value, "icon", 2_000);
  if (Object.keys(patch).length === 0) throw new Error("organization_patch_empty");
  return mutation("PATCH", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}`, operationId, {
    ...patch,
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationDeleteRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const operationId = requiredOperationId(value);
  return mutation("DELETE", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}`, operationId, {
    confirm: requiredBoolean(value, "confirm"),
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationMembersRequest(input: unknown): OrganizationRequestDescriptor {
  return get(`/api/organizations/${encodeURIComponent(requiredId(input, "organizationId"))}/members`);
}

export function workspaceOrganizationMemberRoleRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const role = value.role;
  if (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest") throw new Error("role_invalid");
  const operationId = requiredOperationId(value);
  return mutation("PATCH", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/members/${encodeURIComponent(requiredId(value, "accountId"))}`, operationId, {
    role,
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationMemberRemoveRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("DELETE", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/members/${encodeURIComponent(requiredId(value, "accountId"))}`, requiredOperationId(value), {
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationMemberLeaveRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/members/leave`, requiredOperationId(value), {
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationInvitationsRequest(input: unknown): OrganizationRequestDescriptor {
  return get(`/api/organizations/${encodeURIComponent(requiredId(input, "organizationId"))}/invitations`);
}

export function workspaceOrganizationInvitationCreateRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const operationId = requiredOperationId(value);
  const role = value.role;
  if (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest") throw new Error("role_invalid");
  const accountId = optionalId(value, "accountId");
  const workspaceGrants = optionalWorkspaceGrants(value.workspaceGrants);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/invitations`, operationId, {
    ...(accountId ? { target_account_id: accountId } : {}),
    role,
    workspace_grants: workspaceGrants ?? [],
    ...(optionalText(value, "expiresAt", 80) ? { expires_at: optionalText(value, "expiresAt", 80) } : {})
  });
}

export function workspaceOrganizationInvitationRevokeRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/invitations/${encodeURIComponent(requiredId(value, "invitationId"))}/revoke`, requiredOperationId(value), {
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationInvitationReissueRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/invitations/${encodeURIComponent(requiredId(value, "invitationId"))}/reissue`, requiredOperationId(value), {
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationInvitationExtendRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/invitations/${encodeURIComponent(requiredId(value, "invitationId"))}/extend`, requiredOperationId(value), {
    expires_at: requiredText(value, "expiresAt", 80),
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

/**
 * The raw token is accepted only at this boundary and is never returned by a
 * connection or logged by Main.  The Server hashes/consumes it atomically.
 */
export function workspaceOrganizationInvitationAcceptRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const token = requiredToken(value.token);
  const operationId = requiredOperationId(value);
  return mutation("POST", `/api/organization-invitations/${encodeURIComponent(token)}/accept`, operationId, {});
}

export function workspaceOrganizationWorkspacesRequest(input: unknown): OrganizationRequestDescriptor {
  return get(`/api/organizations/${encodeURIComponent(requiredId(input, "organizationId"))}/workspaces`);
}

export function workspaceSelectionWorkspaceViewRequest(input: unknown): WorkspaceSelectionRequestDescriptor {
  const workspaceId = requiredId(input, "workspaceId");
  return {
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}`,
    workspaceScoped: true,
    workspaceId
  };
}

export function workspaceSelectionRoomsRequest(input: unknown): WorkspaceSelectionRequestDescriptor {
  const workspaceId = requiredId(input, "workspaceId");
  return {
    method: "GET",
    path: `/api/workspaces/${encodeURIComponent(workspaceId)}/rooms`,
    workspaceScoped: true,
    workspaceId
  };
}

export function workspaceOrganizationWorkspaceCreateRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces`, requiredOperationId(value), {
    name: requiredText(value, "name", 240)
  });
}

export function workspaceOrganizationWorkspacePatchRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const patch: Record<string, unknown> = {};
  if (value.name !== undefined) patch.name = requiredText(value, "name", 240);
  if (Object.keys(patch).length === 0) throw new Error("workspace_patch_empty");
  return mutation("PATCH", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}`, requiredOperationId(value), {
    ...patch,
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationWorkspaceMemberGrantRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const role = value.role;
  if (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest") throw new Error("role_invalid");
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/members/${encodeURIComponent(requiredId(value, "accountId"))}`, requiredOperationId(value), { role });
}

export function workspaceOrganizationWorkspaceMemberRevokeRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("DELETE", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/members/${encodeURIComponent(requiredId(value, "accountId"))}`, requiredOperationId(value), {
    ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion") })
  });
}

export function workspaceOrganizationWorkspaceLifecycleRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  const lifecycle = value.lifecycle;
  if (lifecycle !== "archive" && lifecycle !== "restore" && lifecycle !== "delete") throw new Error("workspace_lifecycle_invalid");
  const organizationId = requiredId(value, "organizationId");
  const workspaceId = requiredId(value, "workspaceId");
  const operationId = requiredOperationId(value);
  const expectedVersion = value.expectedVersion === undefined ? undefined : requiredVersion(value, "expectedVersion");
  const confirm = requiredBoolean(value, "confirm");
  if (lifecycle === "delete") {
    return mutation("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}`, operationId, {
      confirm,
      ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion })
    });
  }
  return mutation("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/${lifecycle}`, operationId, {
    confirm,
    ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion })
  });
}

/** Move is deliberately a two-step preview/commit operation. */
export function workspaceOrganizationWorkspaceMovePreviewRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/move/preflight`, requiredOperationId(value), {
    target_organization_id: requiredId(value, "targetOrganizationId"),
    ...(value.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion") })
  });
}

export function workspaceOrganizationWorkspaceMoveRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/move/commit`, requiredOperationId(value), {
    preflight_id: requiredId(value, "preflightId"),
    target_organization_id: requiredId(value, "targetOrganizationId"),
    confirm_guest_membership: requiredBoolean(value, "confirmGuestMembership"),
    ...(value.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion") })
  });
}

export function workspaceOrganizationWorkspaceMoveStatusRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return get(`/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/move/${encodeURIComponent(requiredId(value, "operationId"))}`);
}

/**
 * Bundle restore targets an Organization explicitly.  It is kept separate
 * from Workspace-scoped routes so a restore cannot inherit the active Room.
 */
export function workspaceOrganizationBundleRestoreRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/bundles/restore`, requiredOperationId(value), {
    bundle_id: requiredId(value, "bundleId"),
    confirm: requiredBoolean(value, "confirm")
  });
}

export function workspaceOrganizationBundleExportRequest(input: unknown): OrganizationRequestDescriptor {
  const value = object(input);
  return mutation("POST", `/api/organizations/${encodeURIComponent(requiredId(value, "organizationId"))}/workspaces/${encodeURIComponent(requiredId(value, "workspaceId"))}/bundle/export`, requiredOperationId(value), {
    ...(value.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: requiredVersion(value, "expectedWorkspaceVersion") })
  });
}

/**
 * Evidence is a Workspace-scoped read.  The signed Workspace header is added
 * by Main; this descriptor is still isolated here with the Organization API
 * routes so the renderer has no URL/request capability.
 */
export function workspaceEvidenceRequest(input: unknown): {
  workspaceId: string;
  roomId?: string;
  activityPath?: string;
  runsPath: string;
  artifactsPath?: string;
  memoriesPath?: string;
} {
  const value = object(input);
  const workspaceId = requiredId(value, "workspaceId");
  const roomId = optionalId(value, "roomId");
  return {
    workspaceId,
    ...(roomId ? { roomId } : {}),
    ...(roomId ? { activityPath: `/api/workspaces/${encodeURIComponent(workspaceId)}/chat/activity?room_id=${encodeURIComponent(roomId)}` } : {}),
    runsPath: `/api/workspaces/${encodeURIComponent(workspaceId)}/chat/runs`,
    ...(roomId ? { artifactsPath: `/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts?room_id=${encodeURIComponent(roomId)}` } : {}),
    ...(roomId ? { memoriesPath: `/api/workspaces/${encodeURIComponent(workspaceId)}/knowledge-memory?room_id=${encodeURIComponent(roomId)}` } : {})
  };
}

function get(path: string): OrganizationRequestDescriptor {
  return { method: "GET", path, workspaceScoped: false };
}

function mutation(method: "POST" | "PATCH" | "DELETE", path: string, operationId: string, body?: Record<string, unknown>): OrganizationRequestDescriptor {
  return {
    method,
    path,
    operationId,
    idempotencyKey: operationId,
    workspaceScoped: false,
    ...(body === undefined ? {} : { body })
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("organization_request_invalid");
  return input as Record<string, unknown>;
}

function requiredId(input: unknown, key: string): string {
  const value = typeof input === "string" ? input : object(input)[key];
  if (typeof value !== "string" || !opaqueIdPattern.test(value)) throw new Error(`${key}_invalid`);
  return value;
}

function optionalId(input: Record<string, unknown>, key: string): string | undefined {
  if (input[key] === undefined || input[key] === null || input[key] === "") return undefined;
  return requiredId(input, key);
}

function requiredOperationId(input: Record<string, unknown>): string {
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId)) throw new Error("operation_id_invalid");
  return input.operationId;
}

function requiredText(input: Record<string, unknown>, key: string, max: number): string {
  if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > max) throw new Error(`${key}_invalid`);
  return input[key].trim();
}

function optionalText(input: Record<string, unknown>, key: string, max: number): string | undefined {
  if (input[key] === undefined || input[key] === null || input[key] === "") return undefined;
  return requiredText(input, key, max);
}

function requiredToken(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("invitation_token_invalid");
  return value.trim();
}

function optionalWorkspaceGrants(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error("workspace_grants_invalid");
  return value.map((grant) => {
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) throw new Error("workspace_grants_invalid");
    const record = grant as Record<string, unknown>;
    const workspaceId = requiredId(record, "workspaceId");
    const role = record.role;
    if (role !== "owner" && role !== "admin" && role !== "member" && role !== "guest") throw new Error("workspace_grant_role_invalid");
    const roomIds = record.roomIds === undefined ? undefined : optionalOpaqueList(record.roomIds, "roomIds");
    return {
      workspace_id: workspaceId,
      role,
      ...(roomIds ? { room_ids: roomIds } : {})
    };
  });
}

function optionalOpaqueList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string" || !opaqueIdPattern.test(item))) throw new Error(`${key}_invalid`);
  return value as string[];
}

function requiredBoolean(input: Record<string, unknown>, key: string): boolean {
  if (typeof input[key] !== "boolean") throw new Error(`${key}_invalid`);
  return input[key] as boolean;
}

function requiredVersion(input: Record<string, unknown>, key: string): number {
  if (typeof input[key] !== "number" || !Number.isSafeInteger(input[key]) || (input[key] as number) < 1) throw new Error(`${key}_invalid`);
  return input[key] as number;
}
