import path from "node:path";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceServerMode } from "./types";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const roleNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface WorkspaceServerConfig {
  mode: WorkspaceServerMode;
  databaseUrl: string;
  databaseRuntimeRole: string;
  invitationTokenSecret: string;
  storageRoot: string;
  selfHostWorkspaceId?: string;
  selfHostBootstrapMode: "create" | "empty";
  initialAdminId?: string;
  initialAdminPublicKey?: string;
  initialAdminDisplayName: string;
  port: number;
  bindAddress: string;
  corsOrigins: readonly string[];
  publicNetwork: boolean;
  /** Canonical public Server origin used in Native App invitation links. */
  publicBaseUrl?: string;
}

export interface WorkspaceServerAdminConfig {
  databaseAdminUrl: string;
  databaseRuntimeRole: string;
}

export function loadWorkspaceServerConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceServerConfig {
  if (env.SAMURAI_DATABASE_ADMIN_URL?.trim()) {
    throw new WorkspaceServerError("samurai_database_admin_url_forbidden_at_runtime", 500);
  }
  const mode = env.SAMURAI_SERVER_MODE?.trim();
  if (mode !== "hosted" && mode !== "self_host") {
    throw new WorkspaceServerError("samurai_server_mode_required", 500);
  }
  const databaseUrl = requiredEnv(env, "SAMURAI_DATABASE_URL");
  const databaseRuntimeRole = requiredEnv(env, "SAMURAI_DATABASE_RUNTIME_ROLE");
  const invitationTokenSecret = requiredEnv(env, "SAMURAI_INVITATION_TOKEN_SECRET");
  if (Buffer.byteLength(invitationTokenSecret, "utf8") < 32) {
    throw new WorkspaceServerError("samurai_invitation_token_secret_too_short", 500);
  }
  if (!roleNamePattern.test(databaseRuntimeRole)) {
    throw new WorkspaceServerError("samurai_database_runtime_role_invalid", 500);
  }
  const storageRoot = path.resolve(requiredEnv(env, "SAMURAI_WORKSPACE_STORAGE_ROOT"));
  const selfHostWorkspaceId = env.SAMURAI_SELF_HOST_WORKSPACE_ID?.trim();
  // This value is retained only as a one-release compatibility input for
  // bootstrap/migration. It must not be required to start a Self-host Server:
  // request routing is always selected and authorized per Workspace.
  if (selfHostWorkspaceId) assertOpaqueId(selfHostWorkspaceId, "workspace_id_invalid");
  const selfHostBootstrapMode = env.SAMURAI_SELF_HOST_BOOTSTRAP_MODE?.trim() || "create";
  if (selfHostBootstrapMode !== "create" && selfHostBootstrapMode !== "empty") {
    throw new WorkspaceServerError("samurai_self_host_bootstrap_mode_invalid", 500);
  }
  const initialAdminId = env.SAMURAI_INITIAL_ADMIN_ID?.trim();
  const initialAdminPublicKey = env.SAMURAI_INITIAL_ADMIN_PUBLIC_KEY?.trim();
  if (Boolean(initialAdminId) !== Boolean(initialAdminPublicKey)) {
    throw new WorkspaceServerError("samurai_initial_admin_identity_incomplete", 500);
  }
  if (initialAdminId) assertOpaqueId(initialAdminId, "account_id_invalid");
  const port = Number(env.PORT ?? env.SAMURAI_API_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new WorkspaceServerError("samurai_server_port_invalid", 500);
  }
  const bindAddress = env.SAMURAI_BIND_ADDRESS?.trim() || "127.0.0.1";
  const publicNetwork = env.SAMURAI_SERVER_PUBLIC?.trim() === "1";
  const containerNetwork = env.SAMURAI_SERVER_CONTAINER_NETWORK?.trim() === "1";
  const corsOrigins = (env.SAMURAI_CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new WorkspaceServerError("samurai_cors_origin_invalid", 500);
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new WorkspaceServerError("samurai_cors_origin_invalid", 500);
      }
      return url.origin;
    });
  if (publicNetwork && corsOrigins.length === 0) {
    throw new WorkspaceServerError("samurai_cors_origins_required_for_public_server", 500);
  }
  if (publicNetwork && (bindAddress === "127.0.0.1" || bindAddress === "::1" || bindAddress === "localhost")) {
    throw new WorkspaceServerError("samurai_public_server_bind_address_invalid", 500);
  }
  if (!publicNetwork && !containerNetwork && bindAddress !== "127.0.0.1" && bindAddress !== "::1" && bindAddress !== "localhost") {
    throw new WorkspaceServerError("samurai_non_loopback_bind_requires_public_mode", 500);
  }
  if (publicNetwork && corsOrigins.some((origin) => new URL(origin).protocol !== "https:")) {
    throw new WorkspaceServerError("samurai_public_cors_origin_must_use_https", 500);
  }
  const configuredPublicBaseUrl = env.SAMURAI_PUBLIC_BASE_URL?.trim();
  if (publicNetwork && !configuredPublicBaseUrl) {
    throw new WorkspaceServerError("samurai_public_base_url_required", 500);
  }
  const publicBaseUrl = configuredPublicBaseUrl ? normalizePublicBaseUrl(configuredPublicBaseUrl, publicNetwork) : undefined;
  return {
    mode,
    databaseUrl,
    databaseRuntimeRole,
    invitationTokenSecret,
    storageRoot,
    ...(selfHostWorkspaceId ? { selfHostWorkspaceId } : {}),
    selfHostBootstrapMode,
    ...(initialAdminId ? { initialAdminId } : {}),
    ...(initialAdminPublicKey ? { initialAdminPublicKey } : {}),
    initialAdminDisplayName: env.SAMURAI_INITIAL_ADMIN_DISPLAY_NAME?.trim() || "Owner",
    port,
    bindAddress,
    corsOrigins,
    publicNetwork,
    ...(publicBaseUrl ? { publicBaseUrl } : {})
  };
}

function normalizePublicBaseUrl(value: string, publicNetwork: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WorkspaceServerError("samurai_public_base_url_invalid", 500);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || (publicNetwork && url.protocol !== "https:")) {
    throw new WorkspaceServerError("samurai_public_base_url_invalid", 500);
  }
  return url.origin;
}

/** Only migration and operator commands may load this configuration. */
export function loadWorkspaceServerAdminConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceServerAdminConfig {
  const databaseRuntimeRole = requiredEnv(env, "SAMURAI_DATABASE_RUNTIME_ROLE");
  if (!roleNamePattern.test(databaseRuntimeRole)) {
    throw new WorkspaceServerError("samurai_database_runtime_role_invalid", 500);
  }
  return {
    databaseAdminUrl: requiredEnv(env, "SAMURAI_DATABASE_ADMIN_URL"),
    databaseRuntimeRole
  };
}

export function resolveRequestWorkspaceId(_config: Pick<WorkspaceServerConfig, "mode" | "selfHostWorkspaceId">, requestedWorkspaceId: string | undefined): string {
  const requested = requestedWorkspaceId?.trim();
  if (!requested) throw new WorkspaceServerError("workspace_id_required", 400);
  assertOpaqueId(requested, "workspace_id_invalid");
  return requested;
}

export function assertOpaqueId(value: string, code = "opaque_id_invalid"): string {
  if (!opaqueIdPattern.test(value)) throw new WorkspaceServerError(code, 400);
  return value;
}

export function assertSafeRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new WorkspaceServerError("workspace_file_path_invalid", 400);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new WorkspaceServerError("workspace_file_path_invalid", 400);
  }
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new WorkspaceServerError(`${key.toLowerCase()}_required`, 500);
  return value;
}
