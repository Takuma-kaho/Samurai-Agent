import { browserWorkspaceRequest } from "./workspace-browser-auth";
import type {
  NativeOrganization,
  NativeOrganizationInvitation,
  NativeOrganizationMember,
  NativeWorkspaceMembership,
  NativeWorkspaceMovePreview,
  NativeWorkspaceMoveResult,
  NativeRoom,
  NativeWorkspace,
  NativeWorkspaceBundleExport,
  NativeWorkspaceBundleRestoreResult,
  OrganizationRole,
  OrganizationState,
  WorkspaceState
} from "../native-app/types";

export interface OrganizationApiTransportRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  operationId?: string;
  idempotencyKey?: string;
  body?: unknown;
}

export type OrganizationApiTransport = <T>(request: OrganizationApiTransportRequest) => Promise<T>;

export interface CreateOrganizationInput {
  name: string;
  description?: string;
  icon?: string;
}

export interface CreateWorkspaceInput {
  name: string;
}

export interface InviteOrganizationMemberInput {
  accountId?: string;
  role: OrganizationRole;
  workspaceGrants?: Array<{ workspaceId: string; role: OrganizationRole; roomIds?: string[] }>;
  expiresAt?: string;
}

export interface WorkspaceMovePreviewInput {
  targetOrganizationId: string;
  expectedWorkspaceVersion?: number;
}

export interface WorkspaceMoveCommitInput extends WorkspaceMovePreviewInput {
  preflightId: string;
  confirmGuestMembership: boolean;
}

export interface OrganizationApi {
  listOrganizations(): Promise<NativeOrganization[]>;
  getOrganization(organizationId: string): Promise<NativeOrganization>;
  createOrganization(input: CreateOrganizationInput): Promise<NativeOrganization>;
  patchOrganization(organizationId: string, input: Partial<CreateOrganizationInput>): Promise<NativeOrganization>;
  deleteOrganization(organizationId: string): Promise<void>;
  listWorkspaces(organizationId: string): Promise<NativeWorkspace[]>;
  createWorkspace(organizationId: string, input: CreateWorkspaceInput): Promise<NativeWorkspace>;
  patchWorkspace(organizationId: string, workspaceId: string, input: { name?: string }): Promise<NativeWorkspace>;
  archiveWorkspace(organizationId: string, workspaceId: string): Promise<NativeWorkspace>;
  restoreWorkspace(organizationId: string, workspaceId: string): Promise<NativeWorkspace>;
  deleteWorkspace(organizationId: string, workspaceId: string): Promise<void>;
  listMembers(organizationId: string): Promise<NativeOrganizationMember[]>;
  listInvitations(organizationId: string): Promise<NativeOrganizationInvitation[]>;
  inviteMember(organizationId: string, input: InviteOrganizationMemberInput): Promise<{ invitation: NativeOrganizationInvitation; token?: string }>;
  reissueInvitation(organizationId: string, invitationId: string): Promise<{ invitation: NativeOrganizationInvitation; token?: string }>;
  extendInvitation(organizationId: string, invitationId: string, expiresAt: string): Promise<NativeOrganizationInvitation>;
  acceptInvitation(token: string): Promise<{ organization?: NativeOrganization; workspaceGrants?: NativeWorkspace[] }>;
  changeMemberRole(organizationId: string, accountId: string, role: OrganizationRole): Promise<NativeOrganizationMember>;
  removeMember(organizationId: string, accountId: string): Promise<void>;
  revokeInvitation(organizationId: string, invitationId: string): Promise<void>;
  grantWorkspaceMember(organizationId: string, workspaceId: string, accountId: string, role: OrganizationRole): Promise<NativeWorkspaceMembership>;
  revokeWorkspaceMember(organizationId: string, workspaceId: string, accountId: string): Promise<void>;
  previewWorkspaceMove(organizationId: string, workspaceId: string, input: WorkspaceMovePreviewInput): Promise<NativeWorkspaceMovePreview>;
  moveWorkspace(organizationId: string, workspaceId: string, input: WorkspaceMoveCommitInput): Promise<NativeWorkspaceMoveResult>;
  exportWorkspaceBundle(organizationId: string, workspaceId: string, expectedWorkspaceVersion?: number): Promise<NativeWorkspaceBundleExport>;
  restoreOrganizationBundle(targetOrganizationId: string, bundleId: string): Promise<NativeWorkspaceBundleRestoreResult>;
}

export class OrganizationApiError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly cause?: unknown) {
    super(code);
    this.name = "OrganizationApiError";
  }
}

/**
 * The browser transport signs every request with the existing Workspace
 * bridge. Organization endpoints deliberately omit workspaceScoped: the
 * Server authenticates the Account first, then applies Organization policy.
 */
export const browserOrganizationTransport: OrganizationApiTransport = async <T>(request: OrganizationApiTransportRequest) => {
  try {
    return await browserWorkspaceRequest<T>({
      method: request.method,
      path: request.path,
      ...(request.operationId ? { operationId: request.operationId } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.body === undefined ? {} : { body: request.body })
    });
  } catch (error) {
    if (error instanceof OrganizationApiError) throw error;
    throw new OrganizationApiError(error instanceof Error ? error.message : "organization_request_failed", undefined, error);
  }
};

/**
 * Electron keeps the account key in the main process. Prefer its narrow
 * preload contract when present; the browser transport is only the fallback
 * for a browser connection with the key held in IndexedDB.
 */
export const desktopOrganizationTransport: OrganizationApiTransport = async <T>(request: OrganizationApiTransportRequest) => {
  const desktop = typeof window === "undefined" ? undefined : window.samuraiDesktop;
  if (!desktop) throw new OrganizationApiError("organization_bridge_unavailable", 503);
  try {
    return await invokeDesktopOrganization(desktop, request) as T;
  } catch (error) {
    if (error instanceof OrganizationApiError) throw error;
    throw new OrganizationApiError(error instanceof Error ? error.message : "organization_request_failed", undefined, error);
  }
};

export function createOrganizationApi(transport?: OrganizationApiTransport): OrganizationApi {
  const call = createCall(transport ?? defaultOrganizationTransport());
  return {
    listOrganizations: async () => normalizeOrganizations(await call("GET", "/api/organizations")),
    getOrganization: async (organizationId) => normalizeOrganization(await call("GET", `/api/organizations/${encodeURIComponent(organizationId)}`)),
    createOrganization: async (input) => normalizeOrganization(await call("POST", "/api/organizations", input, operationId())),
    patchOrganization: async (organizationId, input) => normalizeOrganization(await call("PATCH", `/api/organizations/${encodeURIComponent(organizationId)}`, input, operationId())),
    deleteOrganization: async (organizationId) => {
      await call("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}`, { confirm: true }, operationId());
    },
    listWorkspaces: async (organizationId) => normalizeWorkspaces(await call("GET", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces`), organizationId),
    createWorkspace: async (organizationId, input) => normalizeWorkspace(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces`, input, operationId()), organizationId),
    patchWorkspace: async (organizationId, workspaceId, input) => normalizeWorkspace(await call("PATCH", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}`, input, operationId()), organizationId),
    archiveWorkspace: async (organizationId, workspaceId) => normalizeWorkspace(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/archive`, { confirm: true }, operationId()), organizationId),
    restoreWorkspace: async (organizationId, workspaceId) => normalizeWorkspace(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/restore`, { confirm: true }, operationId()), organizationId),
    deleteWorkspace: async (organizationId, workspaceId) => {
      await call("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}`, { confirm: true }, operationId());
    },
    listMembers: async (organizationId) => normalizeMembers(await call("GET", `/api/organizations/${encodeURIComponent(organizationId)}/members`), organizationId),
    listInvitations: async (organizationId) => normalizeInvitations(await call("GET", `/api/organizations/${encodeURIComponent(organizationId)}/invitations`), organizationId),
    inviteMember: async (organizationId, input) => {
      const value = await call<unknown>("POST", `/api/organizations/${encodeURIComponent(organizationId)}/invitations`, {
        ...(input.accountId ? { target_account_id: input.accountId } : {}),
        role: input.role,
        workspace_grants: input.workspaceGrants?.map((grant) => ({
          workspace_id: grant.workspaceId,
          role: grant.role
        })) ?? [],
        ...(input.expiresAt ? { expires_at: input.expiresAt } : {})
      }, operationId());
      const body = record(value);
      const invitation = normalizeInvitation(body.invitation ?? value, organizationId);
      return { invitation, ...(typeof body.token === "string" ? { token: body.token } : {}) };
    },
    reissueInvitation: async (organizationId, invitationId) => {
      const value = await call<unknown>("POST", `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/reissue`, {}, operationId());
      const body = record(value);
      const invitation = normalizeInvitation(body.invitation ?? value, organizationId);
      return { invitation, ...(typeof body.token === "string" ? { token: body.token } : {}) };
    },
    extendInvitation: async (organizationId, invitationId, expiresAt) => normalizeInvitation(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/extend`, { expires_at: expiresAt }, operationId()), organizationId),
    acceptInvitation: async (token) => {
      const value = await call<unknown>("POST", `/api/organization-invitations/${encodeURIComponent(token)}/accept`, {}, operationId());
      const body = record(value);
      return {
        ...(body.organization ? { organization: normalizeOrganization(body.organization) } : {}),
        ...(Array.isArray(body.workspace_grants) ? { workspaceGrants: normalizeWorkspaces(body.workspace_grants, undefined) } : {})
      };
    },
    changeMemberRole: async (organizationId, accountId, role) => normalizeMember(await call("PATCH", `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(accountId)}`, { role }, operationId()), organizationId),
    removeMember: async (organizationId, accountId) => {
      await call("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(accountId)}`, undefined, operationId());
    },
    revokeInvitation: async (organizationId, invitationId) => {
      await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, {}, operationId());
    },
    grantWorkspaceMember: async (organizationId, workspaceId, accountId, role) => normalizeWorkspaceMembership(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(accountId)}`, { role }, operationId()), organizationId),
    revokeWorkspaceMember: async (organizationId, workspaceId, accountId) => {
      await call("DELETE", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(accountId)}`, undefined, operationId());
    },
    previewWorkspaceMove: async (organizationId, workspaceId, input) => normalizeWorkspaceMovePreview(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/move/preflight`, {
      target_organization_id: input.targetOrganizationId,
      ...(input.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: input.expectedWorkspaceVersion })
    }, operationId())),
    moveWorkspace: async (organizationId, workspaceId, input) => normalizeWorkspaceMoveResult(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/move/commit`, {
      preflight_id: input.preflightId,
      target_organization_id: input.targetOrganizationId,
      confirm_guest_membership: input.confirmGuestMembership,
      ...(input.expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: input.expectedWorkspaceVersion })
    }, operationId())),
    exportWorkspaceBundle: async (organizationId, workspaceId, expectedWorkspaceVersion) => normalizeWorkspaceBundleExport(await call("POST", `/api/organizations/${encodeURIComponent(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/bundle/export`, {
      ...(expectedWorkspaceVersion === undefined ? {} : { expected_workspace_version: expectedWorkspaceVersion })
    }, operationId())),
    restoreOrganizationBundle: async (targetOrganizationId, bundleId) => normalizeWorkspaceBundleRestore(await call("POST", `/api/organizations/${encodeURIComponent(targetOrganizationId)}/bundles/restore`, {
      bundle_id: bundleId,
      confirm: true
    }, operationId()))

  };
}

function defaultOrganizationTransport(): OrganizationApiTransport {
  if (typeof window !== "undefined" && window.samuraiDesktop?.listOrganizations) return desktopOrganizationTransport;
  return browserOrganizationTransport;
}

type DesktopOrganizationBridge = NonNullable<Window["samuraiDesktop"]>;

/** Map the shared REST-shaped contract to the narrow Electron preload API. */
async function invokeDesktopOrganization(desktop: DesktopOrganizationBridge, request: OrganizationApiTransportRequest): Promise<unknown> {
  const parts = request.path.split("/").filter(Boolean);
  const body = record(request.body);
  const operationId = request.operationId ?? (typeof body.operationId === "string" ? body.operationId : undefined);
  const operationInput = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...extra,
    ...(operationId ? { operationId } : {})
  });
  const organizationId = parts[0] === "api" && parts[1] === "organizations" && parts[2] ? decodeURIComponent(parts[2]) : undefined;
  const workspaceId = parts[3] === "workspaces" && parts[4] ? decodeURIComponent(parts[4]) : undefined;
  const accountId = parts[5] === "members" && parts[6] ? decodeURIComponent(parts[6]) : undefined;
  const invitationId = parts[3] === "invitations" && parts[4] ? decodeURIComponent(parts[4]) : undefined;
  const expectedVersion = body.expected_version ?? body.expectedVersion;

  if (request.path === "/api/organizations" && request.method === "GET") return invokeDesktopMethod(desktop, "listOrganizations");
  if (request.path === "/api/organizations" && request.method === "POST") {
    return invokeDesktopMethod(desktop, "createOrganization", operationInput(body));
  }
  if (organizationId && parts.length === 3) {
    if (request.method === "GET") return invokeDesktopMethod(desktop, "getOrganization", { organizationId });
    if (request.method === "PATCH") return invokeDesktopMethod(desktop, "patchOrganization", operationInput({ organizationId, ...body, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
    if (request.method === "DELETE") return invokeDesktopMethod(desktop, "deleteOrganization", operationInput({ organizationId, confirm: body.confirm === true, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
  }

  if (organizationId && parts[3] === "members" && parts.length === 4 && request.method === "GET") {
    return invokeDesktopMethod(desktop, "listOrganizationMembers", { organizationId });
  }
  if (organizationId && parts[3] === "members" && parts.length === 5) {
    const memberAccountIdPart = parts[4];
    if (!memberAccountIdPart) throw new OrganizationApiError("organization_member_id_invalid", 400);
    const memberAccountId = decodeURIComponent(memberAccountIdPart);
    if (request.method === "PATCH") return invokeDesktopMethod(desktop, "changeOrganizationMemberRole", operationInput({ organizationId, accountId: memberAccountId, ...body, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
    if (request.method === "DELETE") return invokeDesktopMethod(desktop, "removeOrganizationMember", operationInput({ organizationId, accountId: memberAccountId, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
  }

  if (organizationId && parts[3] === "invitations" && parts.length === 4) {
    if (request.method === "GET") return invokeDesktopMethod(desktop, "listOrganizationInvitations", { organizationId });
    if (request.method === "POST") return invokeDesktopMethod(desktop, "createOrganizationInvitation", operationInput({
      organizationId,
      ...(typeof body.target_account_id === "string" ? { accountId: body.target_account_id } : {}),
      role: body.role,
      workspaceGrants: Array.isArray(body.workspace_grants)
        ? body.workspace_grants.map((grant) => {
          const item = record(grant);
          return { workspaceId: item.workspace_id, role: item.role };
        })
        : [],
      ...(typeof body.expires_at === "string" ? { expiresAt: body.expires_at } : {})
    }));
  }
  if (organizationId && invitationId && parts.length === 6 && request.method === "POST") {
    if (parts[5] === "revoke") return invokeDesktopMethod(desktop, "revokeOrganizationInvitation", operationInput({ organizationId, invitationId, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
    if (parts[5] === "reissue") return invokeDesktopMethod(desktop, "reissueOrganizationInvitation", operationInput({ organizationId, invitationId, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
    if (parts[5] === "extend") return invokeDesktopMethod(desktop, "extendOrganizationInvitation", operationInput({ organizationId, invitationId, expiresAt: body.expires_at, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
  }

  if (parts[0] === "api" && parts[1] === "organization-invitations" && parts[2] && parts[3] === "accept" && request.method === "POST") {
    return invokeDesktopMethod(desktop, "acceptOrganizationInvitation", operationInput({ token: decodeURIComponent(parts[2]) }));
  }

  if (organizationId && parts[3] === "workspaces" && parts.length === 4) {
    if (request.method === "GET") return invokeDesktopMethod(desktop, "listOrganizationWorkspaces", { organizationId });
    if (request.method === "POST") return invokeDesktopMethod(desktop, "createOrganizationWorkspace", operationInput({ organizationId, ...body }));
  }
  if (organizationId && workspaceId && parts.length === 5) {
    if (request.method === "PATCH") return invokeDesktopMethod(desktop, "patchOrganizationWorkspace", operationInput({ organizationId, workspaceId, ...body }));
    if (request.method === "DELETE") return invokeDesktopMethod(desktop, "setOrganizationWorkspaceLifecycle", operationInput({ organizationId, workspaceId, lifecycle: "delete", confirm: body.confirm === true, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
  }
  if (organizationId && workspaceId && accountId && parts.length === 7) {
    if (request.method === "POST") return invokeDesktopMethod(desktop, "grantOrganizationWorkspaceMember", operationInput({ organizationId, workspaceId, accountId, role: body.role }));
    if (request.method === "DELETE") return invokeDesktopMethod(desktop, "revokeOrganizationWorkspaceMember", operationInput({ organizationId, workspaceId, accountId, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
  }
  if (organizationId && workspaceId && parts[5] && parts.length === 6) {
    const lifecycle = parts[5];
    if (request.method === "POST" || request.method === "DELETE") {
      if (lifecycle === "archive" || lifecycle === "restore") {
        return invokeDesktopMethod(desktop, "setOrganizationWorkspaceLifecycle", operationInput({ organizationId, workspaceId, lifecycle, confirm: body.confirm === true, ...(expectedVersion === undefined ? {} : { expectedVersion }) }));
      }
    }
  }
  if (organizationId && workspaceId && parts[5] === "move" && parts.length === 7 && request.method === "POST") {
    if (parts[6] === "preflight") return invokeDesktopMethod(desktop, "previewOrganizationWorkspaceMove", operationInput({ organizationId, workspaceId, targetOrganizationId: body.target_organization_id, ...(body.expected_workspace_version === undefined ? {} : { expectedWorkspaceVersion: body.expected_workspace_version }) }));
    if (parts[6] === "commit") return invokeDesktopMethod(desktop, "moveOrganizationWorkspace", operationInput({ organizationId, workspaceId, targetOrganizationId: body.target_organization_id, preflightId: body.preflight_id, confirmGuestMembership: body.confirm_guest_membership === true, ...(body.expected_workspace_version === undefined ? {} : { expectedWorkspaceVersion: body.expected_workspace_version }) }));
  }
  if (organizationId && workspaceId && parts[5] === "bundle" && parts[6] === "export" && parts.length === 7 && request.method === "POST") {
    return invokeDesktopMethod(desktop, "exportOrganizationWorkspaceBundle", operationInput({
      organizationId,
      workspaceId,
      ...(body.expected_workspace_version === undefined ? {} : { expectedWorkspaceVersion: body.expected_workspace_version })
    }));
  }
  if (organizationId && parts[3] === "bundles" && parts[4] === "restore" && request.method === "POST") {
    return invokeDesktopMethod(desktop, "restoreOrganizationBundle", operationInput({ organizationId, bundleId: body.bundle_id, confirm: body.confirm === true }));
  }

  throw new OrganizationApiError("organization_route_not_supported", 400);
}

function invokeDesktopMethod(desktop: DesktopOrganizationBridge, method: keyof DesktopOrganizationBridge, input?: Record<string, unknown>): Promise<unknown> {
  const handler = desktop[method] as unknown;
  if (typeof handler !== "function") throw new OrganizationApiError(`organization_bridge_method_unavailable:${String(method)}`, 503);
  if (input === undefined) return (handler as () => Promise<unknown>)();
  return (handler as (value: Record<string, unknown>) => Promise<unknown>)(input);
}

/** Small overload keeps call sites readable and makes mock transports easy to write. */
async function transport<T>(request: OrganizationApiTransport, method: OrganizationApiTransportRequest["method"], path: string, body?: unknown, operation?: string): Promise<T> {
  return request<T>({ method, path, ...(body === undefined ? {} : { body }), ...(operation ? { operationId: operation, idempotencyKey: operation } : {}) });
}

type ApiCall = <T>(method: OrganizationApiTransportRequest["method"], path: string, body?: unknown, operation?: string) => Promise<T>;

function createCall(transportImpl: OrganizationApiTransport): ApiCall {
  return <T>(method: OrganizationApiTransportRequest["method"], path: string, body?: unknown, operation?: string) => transport(transportImpl, method, path, body, operation);
}

function operationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `operation_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const body = record(value);
  return Array.isArray(body[key]) ? body[key] : [];
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roleValue(value: unknown): OrganizationRole {
  return value === "owner" || value === "admin" || value === "member" || value === "guest" ? value : "member";
}

function organizationState(value: unknown): OrganizationState {
  return value === "archived" || value === "deleted" ? value : "active";
}

function workspaceState(value: unknown): WorkspaceState {
  return value === "archived" || value === "read_only" ? value : "active";
}

function normalizeOrganizations(value: unknown): NativeOrganization[] {
  return list(value, "organizations").map((entry) => normalizeOrganization(entry)).filter((entry) => entry.id.length > 0);
}

function normalizeOrganization(value: unknown): NativeOrganization {
  const body = record(record(value).organization ?? value);
  const organizationId = stringValue(body.id ?? body.organization_id);
  const workspaces = body.workspaces === undefined ? undefined : normalizeWorkspaces(body.workspaces, organizationId);
  return {
    id: organizationId,
    name: stringValue(body.name, "名称未設定のOrganization"),
    ...(optionalString(body.description) ? { description: optionalString(body.description) } : {}),
    ...(optionalString(body.icon) ? { icon: optionalString(body.icon) } : {}),
    state: organizationState(body.state ?? body.status),
    role: roleValue(body.role ?? body.membership_role),
    ...(numberValue(body.workspace_count) !== undefined ? { workspaceCount: numberValue(body.workspace_count) } : {}),
    ...(optionalString(body.created_at) ? { createdAt: optionalString(body.created_at) } : {}),
    ...(optionalString(body.updated_at) ? { updatedAt: optionalString(body.updated_at) } : {}),
    ...(workspaces ? { workspaces } : {})
  };
}

function normalizeWorkspaces(value: unknown, organizationId?: string): NativeWorkspace[] {
  return list(value, "workspaces").map((entry) => normalizeWorkspace(entry, organizationId)).filter((entry) => entry.id.length > 0);
}

function normalizeWorkspace(value: unknown, organizationId?: string): NativeWorkspace {
  const body = record(record(value).workspace ?? value);
  const rooms = body.rooms === undefined ? undefined : normalizeRooms(body.rooms, stringValue(body.id ?? body.workspace_id));
  const accessValue = body.access ?? body.can_access ?? body.has_access;
  const access = accessValue === false || accessValue === "none" || body.permission === "denied" ? "none" : "granted";
  return {
    id: stringValue(body.id ?? body.workspace_id),
    organizationId: stringValue(body.organization_id ?? organizationId),
    name: stringValue(body.name, "名称未設定のWorkspace"),
    state: workspaceState(body.state),
    access,
    ...(body.role || body.membership_role ? { role: roleValue(body.role ?? body.membership_role) } : {}),
    ...(numberValue(body.version) !== undefined ? { version: numberValue(body.version) } : {}),
    ...(optionalString(body.created_at) ? { createdAt: optionalString(body.created_at) } : {}),
    ...(optionalString(body.updated_at) ? { updatedAt: optionalString(body.updated_at) } : {}),
    ...(rooms ? { rooms } : {})
  };
}

function normalizeRooms(value: unknown, workspaceId: string): NativeRoom[] {
  return list(value, "rooms").map((entry) => {
    const body = record(entry);
    return {
      id: stringValue(body.id ?? body.room_id),
      workspaceId: stringValue(body.workspace_id, workspaceId),
      name: stringValue(body.name, "名称未設定のRoom"),
      ...(optionalString(body.parent_room_id ?? body.parentRoomId) ? { parentRoomId: optionalString(body.parent_room_id ?? body.parentRoomId) } : {}),
      ...(typeof body.can_execute === "boolean" ? { canExecute: body.can_execute } : {}),
      ...(typeof body.can_manage === "boolean" ? { canManage: body.can_manage } : {}),
      ...(numberValue(body.version) !== undefined ? { version: numberValue(body.version) } : {}),
      ...(optionalString(body.created_at) ? { createdAt: optionalString(body.created_at) } : {}),
      ...(optionalString(body.updated_at) ? { updatedAt: optionalString(body.updated_at) } : {})
    } satisfies NativeRoom;
  }).filter((entry) => entry.id.length > 0);
}

function normalizeMembers(value: unknown, organizationId: string): NativeOrganizationMember[] {
  return list(value, "members").map((entry) => normalizeMember(entry, organizationId)).filter((entry) => entry.id.length > 0 || entry.accountId.length > 0);
}

function normalizeMember(value: unknown, organizationId: string): NativeOrganizationMember {
  const body = record(record(value).member ?? value);
  const accountId = stringValue(body.account_id ?? body.accountId);
  return {
    id: stringValue(body.id, accountId),
    organizationId: stringValue(body.organization_id, organizationId),
    accountId,
    ...(optionalString(body.display_name ?? body.displayName) ? { displayName: optionalString(body.display_name ?? body.displayName) } : {}),
    role: roleValue(body.role),
    state: body.state === "removed" || body.state === "revoked" ? "removed" : "active",
    ...(optionalString(body.created_at) ? { createdAt: optionalString(body.created_at) } : {}),
    ...(optionalString(body.updated_at) ? { updatedAt: optionalString(body.updated_at) } : {})
  };
}

function normalizeInvitations(value: unknown, organizationId: string): NativeOrganizationInvitation[] {
  return list(value, "invitations").map((entry) => normalizeInvitation(entry, organizationId)).filter((entry) => entry.id.length > 0);
}

function normalizeInvitation(value: unknown, organizationId: string): NativeOrganizationInvitation {
  const body = record(record(value).invitation ?? value);
  const expiresAt = stringValue(body.expires_at ?? body.expiresAt, new Date(0).toISOString());
  const rawState = body.state ?? body.status;
  const state: NativeOrganizationInvitation["state"] = rawState === "accepted" || rawState === "revoked" || rawState === "expired" ? rawState : "pending";
  return {
    id: stringValue(body.id ?? body.invitation_id),
    organizationId: stringValue(body.organization_id, organizationId),
    ...(optionalString(body.target_account_id ?? body.recipient_account_id ?? body.account_id) ? { recipientAccountId: optionalString(body.target_account_id ?? body.recipient_account_id ?? body.account_id) } : {}),
    role: roleValue(body.role),
    state,
    expiresAt,
    ...(optionalString(body.created_at) ? { createdAt: optionalString(body.created_at) } : {})
  };
}

function normalizeWorkspaceMembership(value: unknown, organizationId: string): NativeWorkspaceMembership {
  const body = record(record(value).membership ?? record(value).workspaceMembership ?? value);
  return {
    id: stringValue(body.id ?? `${body.workspace_id ?? body.workspaceId}:${body.account_id ?? body.accountId}`),
    organizationId: stringValue(body.organization_id ?? body.organizationId, organizationId),
    workspaceId: stringValue(body.workspace_id ?? body.workspaceId),
    accountId: stringValue(body.account_id ?? body.accountId),
    role: roleValue(body.role),
    state: body.state === "revoked" ? "revoked" : "active",
    ...(numberValue(body.version) !== undefined ? { version: numberValue(body.version) } : {}),
    ...(optionalString(body.created_at ?? body.createdAt) ? { createdAt: optionalString(body.created_at ?? body.createdAt) } : {}),
    ...(optionalString(body.updated_at ?? body.updatedAt) ? { updatedAt: optionalString(body.updated_at ?? body.updatedAt) } : {})
  };
}

function normalizeWorkspaceMoveMember(value: unknown): NativeWorkspaceMovePreview["existingMembers"][number] {
  const body = record(value);
  return {
    accountId: stringValue(body.account_id ?? body.accountId),
    workspaceRole: roleValue(body.workspace_role ?? body.current_workspace_role ?? body.role),
    ...(body.target_organization_role || body.targetOrganizationRole ? { targetOrganizationRole: roleValue(body.target_organization_role ?? body.targetOrganizationRole) } : {}),
    willAddAsGuest: body.will_add_as_guest === true || body.willAddAsGuest === true
  };
}

function normalizeWorkspaceMovePreview(value: unknown): NativeWorkspaceMovePreview {
  const body = record(record(value).preview ?? value);
  const existingValue = body.existing_members ?? body.existingMembers;
  const missingValue = body.missing_members ?? body.missingMembers;
  const failureValue = body.failure_conditions ?? body.failureConditions;
  const existing = Array.isArray(existingValue) ? existingValue as unknown[] : [];
  const missing = Array.isArray(missingValue) ? missingValue as unknown[] : [];
  const failureConditions = Array.isArray(failureValue) ? failureValue.filter((item): item is string => typeof item === "string") : [];
  return {
    operationId: stringValue(body.operation_id ?? body.operationId),
    sourceOrganizationId: stringValue(body.source_organization_id ?? body.sourceOrganizationId),
    targetOrganizationId: stringValue(body.target_organization_id ?? body.targetOrganizationId),
    workspaceId: stringValue(body.workspace_id ?? body.workspaceId),
    ...(numberValue(body.workspace_version ?? body.workspaceVersion ?? body.expected_workspace_version) !== undefined ? { workspaceVersion: numberValue(body.workspace_version ?? body.workspaceVersion ?? body.expected_workspace_version) } : {}),
    ...(optionalString(body.workspace_state ?? body.workspaceState ?? body.state) ? { workspaceState: workspaceState(body.workspace_state ?? body.workspaceState ?? body.state) } : {}),
    existingMembers: existing.map(normalizeWorkspaceMoveMember),
    missingMembers: missing.map(normalizeWorkspaceMoveMember),
    requiresGuestConfirmation: body.requires_guest_confirmation === true || body.requiresGuestConfirmation === true,
    writeBlocked: body.write_blocked === true || body.writeBlocked === true,
    failureConditions,
    ...(optionalString(body.expires_at ?? body.expiresAt) ? { expiresAt: optionalString(body.expires_at ?? body.expiresAt) } : {}),
    ...(optionalString(body.created_at ?? body.createdAt) ? { createdAt: optionalString(body.created_at ?? body.createdAt) } : {})
  };
}

function normalizeWorkspaceMoveResult(value: unknown): NativeWorkspaceMoveResult {
  const body = record(record(value).result ?? value);
  const guestMembershipValue = body.guest_membership_account_ids ?? body.guestMembershipAccountIds;
  const guestMembershipAccountIds = Array.isArray(guestMembershipValue)
    ? guestMembershipValue.filter((item): item is string => typeof item === "string")
    : [];
  const status = body.status === "preflight" || body.status === "queued" || body.status === "running" || body.status === "committed" || body.status === "failed" || body.status === "rolled_back"
    ? body.status
    : "failed";
  return {
    operationId: stringValue(body.operation_id ?? body.operationId),
    workspaceId: stringValue(body.workspace_id ?? body.workspaceId),
    sourceOrganizationId: stringValue(body.source_organization_id ?? body.sourceOrganizationId),
    targetOrganizationId: stringValue(body.target_organization_id ?? body.targetOrganizationId),
    status,
    guestMembershipAccountIds,
    ...(optionalString(body.event_id ?? body.eventId) ? { eventId: optionalString(body.event_id ?? body.eventId) } : {}),
    ...(optionalString(body.committed_at ?? body.committedAt) ? { committedAt: optionalString(body.committed_at ?? body.committedAt) } : {}),
    ...(optionalString(body.failure_code ?? body.failureCode) ? { failureCode: optionalString(body.failure_code ?? body.failureCode) } : {})
  };
}

function normalizeWorkspaceBundleExport(value: unknown): NativeWorkspaceBundleExport {
  const body = record(record(value).export ?? record(value).bundle ?? value);
  const manifest = record(body.manifest);
  return {
    bundleId: stringValue(body.bundle_id ?? body.bundleId ?? body.id),
    workspaceId: stringValue(body.workspace_id ?? body.workspaceId),
    sourceOrganizationId: stringValue(body.source_organization_id ?? body.sourceOrganizationId),
    ...(numberValue(body.schema_version ?? body.schemaVersion ?? body.format_version) !== undefined ? { schemaVersion: numberValue(body.schema_version ?? body.schemaVersion ?? body.format_version) } : {}),
    ...(optionalString(body.integrity_hash ?? body.integrityHash ?? body.sha256) ? { integrityHash: optionalString(body.integrity_hash ?? body.integrityHash ?? body.sha256) } : {}),
    ...(numberValue(body.file_count ?? body.fileCount) !== undefined ? { fileCount: numberValue(body.file_count ?? body.fileCount) } : {}),
    ...(numberValue(body.byte_size ?? body.byteSize) !== undefined ? { byteSize: numberValue(body.byte_size ?? body.byteSize) } : {}),
    ...(Object.keys(manifest).length ? { manifest } : {}),
    ...(optionalString(body.created_at ?? body.createdAt) ? { createdAt: optionalString(body.created_at ?? body.createdAt) } : {})
  };
}

function normalizeWorkspaceBundleRestore(value: unknown): NativeWorkspaceBundleRestoreResult {
  const body = record(record(value).result ?? record(value).restore ?? value);
  const rawStatus = body.status;
  return {
    bundleId: stringValue(body.bundle_id ?? body.bundleId ?? body.id),
    workspaceId: stringValue(body.workspace_id ?? body.workspaceId),
    ...(optionalString(body.source_organization_id ?? body.sourceOrganizationId) ? { sourceOrganizationId: optionalString(body.source_organization_id ?? body.sourceOrganizationId) } : {}),
    targetOrganizationId: stringValue(body.target_organization_id ?? body.targetOrganizationId),
    ...(numberValue(body.schema_version ?? body.schemaVersion ?? body.format_version) !== undefined ? { schemaVersion: numberValue(body.schema_version ?? body.schemaVersion ?? body.format_version) } : {}),
    ...(optionalString(body.integrity_hash ?? body.integrityHash ?? body.sha256) ? { integrityHash: optionalString(body.integrity_hash ?? body.integrityHash ?? body.sha256) } : {}),
    status: rawStatus === "restored" ? "restored" : "failed",
    ...(optionalString(body.restored_at ?? body.restoredAt ?? body.created_at ?? body.createdAt) ? { restoredAt: optionalString(body.restored_at ?? body.restoredAt ?? body.created_at ?? body.createdAt) } : {}),
    ...(optionalString(body.event_id ?? body.eventId) ? { eventId: optionalString(body.event_id ?? body.eventId) } : {}),
    ...(optionalString(body.failure_code ?? body.failureCode) ? { failureCode: optionalString(body.failure_code ?? body.failureCode) } : {})
  };
}
