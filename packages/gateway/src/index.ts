import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createId,
  nowIso,
  type ActorIdentity,
  type GatewayBoundaryPolicy,
  type GatewayBoundarySource,
  type GatewayMcpConfigRecord,
  type GatewayMcpConfigSummary,
  type GatewaySandboxWorkspaceSyncDirection,
  type McpRuntimeConfigRef,
  type McpConfigRef,
  GatewayBoundaryPolicySchema,
  GatewayMcpConfigSummarySchema,
  type GatewayInboundMessageRecord,
  type GatewayPairingPolicyRecord,
  type GatewayPairingRecord,
  type GatewayRoutingPolicyRecord,
  type InstructionSource,
  type JsonValue,
  type MessageEnvelope,
  type SecretRef,
  type SupportedLocale,
  stableHash
} from "@samurai-agent/core-schemas";
import { assertSafeGatewayHttpEndpoint, GatewayHttpEndpointError } from "./http-url-safety.js";

export { assertSafeGatewayHttpEndpoint, GatewayHttpEndpointError } from "./http-url-safety.js";

export {
  GatewayFormalWorkspaceIngress,
  type FormalWorkspaceIngressPort,
  type FormalWorkspaceTarget
} from "./formal-workspace-ingress.js";

const mcpProcessCloseGraceMs = 1_000;
const mcpProcessCloseKillWaitMs = 1_000;

const inheritedChildEnvironmentKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_LANG",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "DOCKER_CONTEXT"
] as const;

/** External tools must never inherit application credentials from the Server. */
export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    inheritedChildEnvironmentKeys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])
  );
}

export interface RouteSessionInput {
  source: MessageEnvelope["source"];
  identity: ActorIdentity;
  route?: string;
}

export function routeSession(input: RouteSessionInput): string {
  return `${input.source}:${input.identity}:${input.route ?? "main"}`;
}

export interface GatewayContext {
  source: MessageEnvelope["source"];
  actor_identity: ActorIdentity;
  instruction_source: InstructionSource;
  channel: string;
  session_key: string;
  source_identity?: string;
  source_label?: string;
}

export interface ExternalGatewaySource {
  channel: GatewayPairingRecord["channel"];
  source_identity: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  route?: string;
  metadata?: Record<string, JsonValue>;
}

export interface GatewayPairingPolicyEvaluation {
  allowed: boolean;
  trusted_without_pairing: boolean;
  reason?: "policy_disabled" | "policy_blocked" | "source_not_allowed";
  allowlist_snapshot: string[];
  allowed_tools_snapshot: string[];
  pairing_ttl_ms: number;
  duplicate_window_ms: number;
  rate_limit_window_ms: number;
  rate_limit_max: number;
}

export interface GatewayRoutingResolution {
  allowed: boolean;
  reason?: "routing_policy_disabled";
  session_key: string;
  account_id: string;
  thread_id: string;
  route: string;
  session_key_strategy: GatewayRoutingPolicyRecord["session_key_strategy"];
}

export interface ResolvedSecretRef {
  id: string;
  source: SecretRef["source"];
  provider: string;
  label?: string;
  scope?: string;
  resolved: boolean;
  value?: string;
  reason?: "missing" | "unsupported_source" | "file_root_required" | "file_outside_root" | "read_failed";
}

export interface McpToolInvocationPlan {
  status: "ready" | "blocked";
  server_name: string;
  tool_name: string;
  config_ref?: McpRuntimeConfigRef["config_ref"];
  allowed_tools: string[];
  secret_ref_ids: string[];
  sandbox: GatewayBoundaryPolicy["sandbox"];
  reason?: "server_not_allowed" | "tool_not_allowed";
}

export interface McpToolExecutionInput {
  server_name: string;
  tool_name: string;
  input?: Record<string, JsonValue>;
}

export interface McpToolAdapterInput {
  server_name: string;
  tool_name: string;
  input: Record<string, JsonValue>;
  config_ref?: McpRuntimeConfigRef["config_ref"];
  sandbox: SandboxExecutionPlan;
  secrets: SecretResolutionMaterial[];
}

export interface McpToolAdapter {
  /** Backend that actually enforces the boundary for this adapter. */
  sandboxBackend?: SandboxExecutorBackend;
  invoke(input: McpToolAdapterInput): Promise<{ output?: JsonValue; resource_refs?: Array<{ kind: string; id?: string; uri: string; label?: string }> }>;
}

export interface McpToolExecutionResult {
  status: "completed" | "blocked" | "failed";
  server_name: string;
  tool_name: string;
  output?: JsonValue;
  resource_refs: Array<{ kind: string; id?: string; uri: string; label?: string }>;
  secret_ref_ids: string[];
  resolved_secret_ref_ids: string[];
  secret_resolution: SecretResolutionSummary;
  sandbox: SandboxExecutionPlan;
  reason?: McpToolInvocationPlan["reason"] | "secret_resolution_failed" | "adapter_failed" | "sandbox_isolation_unavailable";
  error?: string;
}

export interface SandboxExecutionPlan {
  mode: GatewayBoundaryPolicy["sandbox"]["mode"];
  scope: GatewayBoundaryPolicy["sandbox"]["scope"];
  backend: GatewayBoundaryPolicy["sandbox"]["backend"];
  workspace_access: GatewayBoundaryPolicy["sandbox"]["workspace_access"];
  network_access: GatewayBoundaryPolicy["sandbox"]["network_access"];
  allowed_paths: Array<{ root: string; access: string }>;
  denied_paths: string[];
  timeout_ms?: number;
  metadata: Record<string, JsonValue>;
}

export interface SandboxSecretFileBinding extends SecretFileMaterialRequest {
  env?: string;
}

export interface SandboxCommandExecutionInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  secret_env?: Record<string, string>;
  secret_files?: SandboxSecretFileBinding[];
  timeout_ms?: number;
  metadata?: Record<string, JsonValue>;
}

export interface SandboxCommandAdapterInput extends SandboxCommandExecutionInput {
  sandbox: SandboxExecutionPlan;
  workspace_root: string;
  secrets: SecretResolutionMaterial[];
  secret_files_materialized?: MaterializedSecretFiles;
}

export interface SandboxCommandAdapterOutput {
  exit_code: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  resource_refs?: Array<{ kind: string; id?: string; uri: string; label?: string }>;
}

export interface SandboxCommandAdapter {
  execute(input: SandboxCommandAdapterInput): Promise<SandboxCommandAdapterOutput>;
}

export interface SandboxCommandExecutionResult {
  status: "completed" | "failed" | "blocked";
  command: string;
  exit_code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  resource_refs: Array<{ kind: string; id?: string; uri: string; label?: string }>;
  secret_ref_ids: string[];
  resolved_secret_ref_ids: string[];
  secret_resolution: SecretResolutionSummary;
  sandbox: SandboxExecutionPlan;
  reason?: "secret_resolution_failed" | "adapter_failed" | "command_failed" | "sandbox_disabled" | "invalid_command" | "path_not_allowed" | "sandbox_isolation_unavailable";
  error?: string;
}

export type SandboxExecutorBackend = GatewayBoundaryPolicy["sandbox"]["backend"];

export interface SandboxExecutorCapabilityStatus {
  backend: SandboxExecutorBackend;
  available: boolean;
  command?: string;
  reason: "host_process" | "command_available" | "command_not_found" | "probe_failed";
  detail?: string;
}

/**
 * A filesystem bridge for an explicitly selected Agent project worktree.
 * Composition code must never pass the Workspace Core root here; Core
 * mutations use FormalWorkspaceIngress and Domain Operation instead.
 */
export interface SandboxWorkspaceSyncInput {
  direction: GatewaySandboxWorkspaceSyncDirection;
  workspace_root: string;
  remote_workspace_root?: string;
  timeout_ms?: number;
  metadata?: Record<string, JsonValue>;
}

export interface SandboxWorkspaceSyncAdapterInput extends SandboxWorkspaceSyncInput {
  sandbox: SandboxExecutionPlan;
}

export interface SandboxWorkspaceSyncAdapterOutput {
  status: "completed" | "failed" | "skipped";
  file_count?: number;
  byte_count?: number;
  resource_refs?: Array<{ kind: string; id?: string; uri: string; label?: string }>;
  reason?: "workspace_access_none" | "docker_bind_mount" | "docker_container_required" | "remote_target_required" | "mirror_two_pass_update" | "mirror_newer_wins" | "adapter_failed" | "path_not_allowed";
  error?: string;
}

export interface SandboxWorkspaceSyncAdapter {
  sync(input: SandboxWorkspaceSyncAdapterInput): Promise<SandboxWorkspaceSyncAdapterOutput>;
}

export interface SandboxWorkspaceSyncExecutionResult extends SandboxWorkspaceSyncAdapterOutput {
  direction: GatewaySandboxWorkspaceSyncDirection;
  workspace_root: string;
  remote_workspace_root?: string;
  sandbox: SandboxExecutionPlan;
}

export type SandboxLifecycleAction = "recreate" | "delete";

export interface SandboxLifecycleAdapterInput {
  action: SandboxLifecycleAction;
  instance_key: string;
  sandbox: SandboxExecutionPlan;
  remote_workspace_root?: string;
  timeout_ms?: number;
  metadata?: Record<string, JsonValue>;
}

export interface SandboxLifecycleAdapterOutput {
  status: "completed" | "failed" | "skipped";
  reason?: "host_noop" | "docker_container_required" | "remote_target_required" | "remote_command_required" | "adapter_failed" | "path_not_allowed";
  command?: string;
  args?: string[];
  stdout?: string;
  stderr?: string;
  error?: string;
  resource_refs?: Array<{ kind: string; id?: string; uri: string; label?: string }>;
}

export interface SandboxLifecycleAdapter {
  run(input: SandboxLifecycleAdapterInput): Promise<SandboxLifecycleAdapterOutput>;
}

export interface SecretResolutionMaterial {
  id: string;
  source: SecretRef["source"];
  provider: string;
  value: string;
  label?: string;
  scope?: string;
}

export interface SecretResolutionSummary {
  secret_ref_ids: string[];
  resolved_secret_ref_ids: string[];
  unresolved_secret_ref_ids: string[];
  unresolved_reasons: Record<string, string>;
}

export interface SecretResolutionBundle {
  status: "ready" | "failed";
  materials: SecretResolutionMaterial[];
  summary: SecretResolutionSummary;
  reason?: "secret_resolution_failed";
  error?: string;
}

export interface SecretFileMaterialRequest {
  secret_ref_id: string;
  filename: string;
  mode?: number;
}

export interface MaterializedSecretFile {
  secret_ref_id: string;
  path: string;
  mode: number;
}

export interface MaterializedSecretFiles {
  root_dir: string;
  files: MaterializedSecretFile[];
  cleanup(): Promise<void>;
}

export type McpStdioFraming = "json_lines" | "content_length";

export interface StdioMcpSecretFileBinding extends SecretFileMaterialRequest {
  env: string;
}

export interface StdioMcpServerConfig {
  server_name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  secret_env?: Record<string, string>;
  secret_files?: StdioMcpSecretFileBinding[];
  framing?: McpStdioFraming;
  initialize?: boolean;
  timeout_ms?: number;
}

export interface HttpMcpServerConfig {
  server_name: string;
  endpoint_url: string;
  headers?: Record<string, string>;
  secret_headers?: Record<string, string>;
  timeout_ms?: number;
}

export interface StdioMcpToolAdapterOptions {
  resolveConfig(input: Pick<McpToolAdapterInput, "server_name" | "config_ref">): Promise<StdioMcpServerConfig | undefined> | StdioMcpServerConfig | undefined;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export interface PooledStdioMcpToolAdapterOptions extends StdioMcpToolAdapterOptions {
  maxProcesses?: number;
  idleTtlMs?: number;
}

export interface PooledMcpToolAdapterStats {
  process_count: number;
  max_processes: number;
  idle_ttl_ms: number;
  servers: Array<{ server_name: string; last_used_at: string }>;
}

export interface PooledMcpToolAdapter extends McpToolAdapter {
  closeAll(): Promise<void>;
  stats(): PooledMcpToolAdapterStats;
}

interface HttpMcpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type HttpMcpFetch = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<HttpMcpResponseLike>;

export interface HttpMcpToolAdapterOptions {
  resolveConfig(input: Pick<McpToolAdapterInput, "server_name" | "config_ref">): Promise<HttpMcpServerConfig | undefined> | HttpMcpServerConfig | undefined;
  fetch?: HttpMcpFetch;
}

export interface SandboxCommandAdapterOptions {
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
}

export interface SandboxWorkspaceSyncAdapterOptions {
  spawnProcess?: typeof spawn;
  /** Raw filesystem sync is only valid for a separately provisioned Agent worktree. */
  workspaceRootRole?: "agent_worktree";
  /** Runtime-owned Core root used to reject a mislabelled worktree. */
  coreWorkspaceRoot?: string;
}

export interface SandboxLifecycleAdapterOptions {
  spawnProcess?: typeof spawn;
}

export async function resolveSecretRefs(
  refs: SecretRef[],
  options: {
    env?: NodeJS.ProcessEnv;
    fileRoot?: string;
  } = {}
): Promise<ResolvedSecretRef[]> {
  const env = options.env ?? process.env;
  return Promise.all(refs.map(async (ref) => {
    const base = {
      id: ref.id,
      source: ref.source,
      provider: ref.provider,
      label: ref.label,
      scope: ref.scope
    };
    if (ref.source === "env") {
      const value = env[ref.key];
      return value
        ? { ...base, resolved: true, value }
        : { ...base, resolved: false, reason: "missing" as const };
    }
    if (ref.source === "file") {
      if (!options.fileRoot) {
        return { ...base, resolved: false, reason: "file_root_required" as const };
      }
      const root = path.resolve(options.fileRoot);
      const target = path.resolve(root, ref.key);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        return { ...base, resolved: false, reason: "file_outside_root" as const };
      }
      const value = await readFile(target, "utf8").then(
        (content) => content.trim(),
        () => undefined
      );
      return value
        ? { ...base, resolved: true, value }
        : { ...base, resolved: false, reason: "read_failed" as const };
    }
    return { ...base, resolved: false, reason: "unsupported_source" as const };
  }));
}

export async function createSecretResolutionBundle(
  refs: SecretRef[],
  options: {
    env?: NodeJS.ProcessEnv;
    fileRoot?: string;
  } = {}
): Promise<SecretResolutionBundle> {
  const resolved = await resolveSecretRefs(refs, options);
  const materials: SecretResolutionMaterial[] = resolved.flatMap((ref) =>
    ref.resolved && ref.value
      ? [{
          id: ref.id,
          source: ref.source,
          provider: ref.provider,
          value: ref.value,
          ...(ref.label ? { label: ref.label } : {}),
          ...(ref.scope ? { scope: ref.scope } : {})
        }]
      : []
  );
  const unresolved = resolved.filter((ref) => !ref.resolved);
  const summary: SecretResolutionSummary = {
    secret_ref_ids: resolved.map((ref) => ref.id),
    resolved_secret_ref_ids: materials.map((material) => material.id),
    unresolved_secret_ref_ids: unresolved.map((ref) => ref.id),
    unresolved_reasons: Object.fromEntries(unresolved.map((ref) => [ref.id, ref.reason ?? "unknown"]))
  };
  const firstUnresolved = unresolved[0];
  return firstUnresolved
    ? {
        status: "failed",
        materials,
        summary,
        reason: "secret_resolution_failed",
        error: firstUnresolved.reason
      }
    : {
        status: "ready",
        materials,
        summary
      };
}

export async function materializeSecretFiles(
  materials: SecretResolutionMaterial[],
  requests: SecretFileMaterialRequest[],
  options: { tmpRoot?: string } = {}
): Promise<MaterializedSecretFiles> {
  const root = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), "samurai-gateway-secrets-"));
  const materialById = new Map(materials.map((material) => [material.id, material]));
  const files: MaterializedSecretFile[] = [];
  try {
    for (const request of requests) {
      const material = materialById.get(request.secret_ref_id);
      if (!material) {
        throw new Error(`secret_material_missing:${request.secret_ref_id}`);
      }
      const filename = normalizeSecretMaterialFilename(request.filename);
      const target = path.join(root, filename);
      const mode = request.mode ?? 0o600;
      await writeFile(target, material.value, { mode });
      await chmod(target, mode);
      files.push({ secret_ref_id: request.secret_ref_id, path: target, mode });
    }
    return {
      root_dir: root,
      files,
      async cleanup() {
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function createStdioMcpToolAdapter(options: StdioMcpToolAdapterOptions): McpToolAdapter {
  return {
    async invoke(input) {
      const config = await options.resolveConfig({
        server_name: input.server_name,
        config_ref: input.config_ref
      });
      if (!config) {
        throw new Error(`mcp_config_not_found:${input.server_name}`);
      }
      const secretFiles = config.secret_files?.length
        ? await materializeSecretFiles(input.secrets, config.secret_files)
        : undefined;
      let client: StdioJsonRpcClient | undefined;
      try {
        const env = buildStdioMcpEnv({
          baseEnv: safeChildEnvironment(options.env ?? process.env),
          config,
          materials: input.secrets,
          secretFiles
        });
        client = new StdioJsonRpcClient({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env,
          framing: config.framing ?? "json_lines",
          timeoutMs: config.timeout_ms ?? input.sandbox.timeout_ms ?? 30_000,
          spawnProcess: options.spawnProcess ?? spawn
        });
        await client.start();
        if (config.initialize !== false) {
          await client.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: {
              name: "samurai-agent-gateway",
              version: "0.1.0"
            }
          });
          client.notify("notifications/initialized", {});
        }
        const output = await client.request("tools/call", {
          name: input.tool_name,
          arguments: input.input
        });
        return {
          output: jsonSafe(output),
          resource_refs: []
        };
      } finally {
        const cleanupErrors: unknown[] = [];
        try {
          await client?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await secretFiles?.cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "mcp_process_cleanup_failed");
        }
      }
    }
  };
}

export function createPooledStdioMcpToolAdapter(options: PooledStdioMcpToolAdapterOptions): PooledMcpToolAdapter {
  const pool = new StdioMcpProcessPool(options);
  return {
    invoke(input) {
      return pool.invoke(input);
    },
    closeAll() {
      return pool.closeAll();
    },
    stats() {
      return pool.stats();
    }
  };
}

export function createHttpMcpToolAdapter(options: HttpMcpToolAdapterOptions): McpToolAdapter {
  return {
    async invoke(input) {
      const config = await options.resolveConfig({
        server_name: input.server_name,
        config_ref: input.config_ref
      });
      if (!config) {
        throw new Error(`mcp_config_not_found:${input.server_name}`);
      }
      const endpoint = await assertSafeGatewayHttpEndpoint(config.endpoint_url);
      const fetcher = options.fetch ?? fetch;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeout_ms ?? input.sandbox.timeout_ms ?? 30_000);
      try {
        const response = await fetcher(endpoint.toString(), {
          method: "POST",
          headers: buildHttpMcpHeaders(config, input.secrets),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: createId("mcp_request"),
            method: "tools/call",
            params: {
              name: input.tool_name,
              arguments: input.input
            }
          }),
          signal: controller.signal,
          redirect: "manual"
        });
        if (response.status >= 300 && response.status < 400) {
          throw new GatewayHttpEndpointError("redirect_blocked");
        }
        const body = await response.text();
        if (!response.ok) {
          throw new Error(`mcp_http_status:${response.status}:${body.slice(0, 200)}`);
        }
        const parsed = parseJsonRpcResponse(body);
        if (parsed.error) {
          throw new Error(`mcp_http_error:${JSON.stringify(parsed.error).slice(0, 200)}`);
        }
        return {
          output: jsonSafe(parsed.result ?? parsed),
          resource_refs: []
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

export function createSandboxCommandAdapter(options: SandboxCommandAdapterOptions = {}): SandboxCommandAdapter {
  return {
    async execute(input) {
      const invocation = createSandboxProcessInvocation(input, safeChildEnvironment(options.env ?? process.env));
      return runSandboxProcess(invocation, {
        stdin: invocation.stdin ?? input.stdin,
        timeoutMs: input.timeout_ms ?? input.sandbox.timeout_ms ?? 30_000,
        spawnProcess: options.spawnProcess ?? spawn
      });
    }
  };
}

export function inspectSandboxExecutorCapabilities(options: {
  spawnProbe?: typeof spawnSync;
  timeoutMs?: number;
} = {}): SandboxExecutorCapabilityStatus[] {
  const spawnProbe = options.spawnProbe ?? spawnSync;
  const timeoutMs = options.timeoutMs ?? 1500;
  const remoteProbe = probeSandboxExecutor("remote", "ssh", ["-V"], spawnProbe, timeoutMs);
  return [
    {
      backend: "none",
      available: true,
      reason: "host_process",
      detail: "Host process execution is available only for trusted local_cli/cron boundaries; it is not an isolation boundary."
    },
    probeSandboxExecutor("docker", "docker", ["--version"], spawnProbe, timeoutMs),
    probeSandboxExecutor("ssh", "ssh", ["-V"], spawnProbe, timeoutMs),
    {
      ...remoteProbe,
      backend: "remote",
      detail: [
        remoteProbe.detail,
        "Remote sandbox execution uses the SSH transport probe."
      ].filter(Boolean).join(" ")
    }
  ];
}

export async function executeSandboxCommand(
  policy: GatewayBoundaryPolicy,
  input: SandboxCommandExecutionInput,
  adapter: SandboxCommandAdapter,
  options: {
    env?: NodeJS.ProcessEnv;
    fileRoot?: string;
    workspaceRoot: string;
    tmpRoot?: string;
  }
): Promise<SandboxCommandExecutionResult> {
  const sandbox = createSandboxExecutionPlan(policy.sandbox);
  const command = input.command.trim();
  const secretRefIds = policy.secret_refs.map((ref) => ref.id);
  const emptySecretSummary = secretResolutionSummaryFromIds(secretRefIds);
  if (!command) {
    return {
      status: "blocked",
      command,
      resource_refs: [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: [],
      secret_resolution: emptySecretSummary,
      sandbox,
      reason: "invalid_command",
      error: "sandbox_command_required"
    };
  }
  if (sandbox.mode === "off") {
    return {
      status: "blocked",
      command,
      resource_refs: [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: [],
      secret_resolution: emptySecretSummary,
      sandbox,
      reason: "sandbox_disabled",
      error: "sandbox_disabled"
    };
  }
  if (sandbox.workspace_access !== "none") {
    const pathError = sandboxPathPolicyError(sandbox, input.cwd?.trim() || "workspace", sandbox.workspace_access)
      ?? sandboxHostPartialPathError(sandbox);
    const dockerMountError = sandbox.backend === "docker" ? sandboxDockerMountPolicyError(sandbox) : undefined;
    if (pathError || dockerMountError) {
      return {
        status: "blocked",
        command,
        resource_refs: [],
        secret_ref_ids: secretRefIds,
        resolved_secret_ref_ids: [],
        secret_resolution: emptySecretSummary,
        sandbox,
        reason: "path_not_allowed",
        error: pathError ?? dockerMountError
      };
    }
  }

  const isolationError = sandbox.backend === "none"
    ? sandboxIsolationCapabilityError(sandbox, "none", policy.source_channel)
    : undefined;
  if (isolationError) {
    return {
      status: "blocked",
      command,
      resource_refs: [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: [],
      secret_resolution: emptySecretSummary,
      sandbox,
      reason: "sandbox_isolation_unavailable",
      error: isolationError
    };
  }

  const secretBundle = await createSecretResolutionBundle(policy.secret_refs, {
    env: options.env,
    fileRoot: options.fileRoot
  });
  if (secretBundle.status === "failed") {
    return {
      status: "failed",
      command,
      resource_refs: [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox,
      reason: secretBundle.reason,
      error: secretBundle.error
    };
  }

  const secretFiles = input.secret_files?.length
    ? await materializeSecretFiles(secretBundle.materials, input.secret_files, { tmpRoot: options.tmpRoot })
    : undefined;
  try {
    const output = await adapter.execute({
      ...input,
      command,
      sandbox,
      workspace_root: options.workspaceRoot,
      secrets: secretBundle.materials,
      secret_files_materialized: secretFiles
    });
    const stdout = redactSandboxOutput(output.stdout, secretBundle.materials);
    const stderr = redactSandboxOutput(output.stderr, secretBundle.materials);
    const failed = output.exit_code !== 0 || Boolean(output.signal);
    return {
      status: failed ? "failed" : "completed",
      command,
      exit_code: output.exit_code,
      signal: output.signal,
      stdout,
      stderr,
      resource_refs: output.resource_refs ?? [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox,
      ...(failed ? { reason: "command_failed" as const, error: stderr || `exit_code:${output.exit_code ?? "signal"}` } : {})
    };
  } catch (error) {
    const message = redactSecretText(error instanceof Error ? error.message : String(error), secretBundle.materials);
    return {
      status: "failed",
      command,
      resource_refs: [],
      secret_ref_ids: secretRefIds,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox,
      reason: "adapter_failed",
      error: secretBundle.materials.length > 0
        ? "sandbox_adapter_failed_with_secret_material"
        : message
    };
  } finally {
    await secretFiles?.cleanup();
  }
}

/**
 * Executes worktree transfer after Runtime has rejected the Core root.
 * The adapter intentionally has no Workspace Store or Domain Operation
 * capability; it only handles the Agent's separately granted worktree.
 */
export function createSandboxWorkspaceSyncAdapter(options: SandboxWorkspaceSyncAdapterOptions = {}): SandboxWorkspaceSyncAdapter {
  return {
    async sync(input) {
      if (input.sandbox.workspace_access === "none") {
        return { status: "skipped", reason: "workspace_access_none" };
      }
      if (options.workspaceRootRole !== "agent_worktree") {
        return { status: "failed", reason: "path_not_allowed", error: "sandbox_agent_worktree_required" };
      }
      if (!options.coreWorkspaceRoot?.trim()) {
        return { status: "failed", reason: "path_not_allowed", error: "sandbox_core_workspace_root_required" };
      }
      const sandbox = withWorkspaceSyncMetadata(input.sandbox, input.metadata);
      const scopedInput = { ...input, sandbox };
      assertSandboxWorkspaceSyncPathAllowed(scopedInput);
      const coreRootError = await sandboxCoreWorkspaceRootError(input.workspace_root, sandbox, options.coreWorkspaceRoot);
      if (coreRootError) {
        return { status: "failed", reason: "path_not_allowed", error: coreRootError };
      }
      if (sandbox.backend === "docker") {
        return syncDockerWorkspace(scopedInput, options.spawnProcess ?? spawn);
      }
      if (sandbox.backend === "ssh" || sandbox.backend === "remote") {
        return syncRemoteWorkspace(scopedInput, options.spawnProcess ?? spawn);
      }
      return syncLocalWorkspace(scopedInput);
    }
  };
}

export async function executeSandboxWorkspaceSync(
  sandbox: GatewayBoundaryPolicy["sandbox"],
  input: SandboxWorkspaceSyncInput,
  adapter: SandboxWorkspaceSyncAdapter
): Promise<SandboxWorkspaceSyncExecutionResult> {
  const plan = createSandboxExecutionPlan(sandbox);
  const scopedPlan = withWorkspaceSyncMetadata(plan, input.metadata);
  const workspaceRoot = path.resolve(input.workspace_root);
  try {
    const pathError = sandboxWorkspaceSyncPathError(scopedPlan, input);
    if (pathError) {
      return {
        status: "failed",
        direction: input.direction,
        workspace_root: workspaceRoot,
        remote_workspace_root: input.remote_workspace_root,
        sandbox: plan,
        reason: "path_not_allowed",
        error: pathError
      };
    }
    const coreRootError = await sandboxCoreWorkspaceRootError(workspaceRoot, scopedPlan);
    if (coreRootError) {
      return {
        status: "failed",
        direction: input.direction,
        workspace_root: workspaceRoot,
        remote_workspace_root: input.remote_workspace_root,
        sandbox: plan,
        reason: "path_not_allowed",
        error: coreRootError
      };
    }
    if (plan.backend === "none" || plan.metadata.workspace_sync_transport === "local") {
      const localSandboxRoot = input.remote_workspace_root ? path.resolve(input.remote_workspace_root) : undefined;
      const localSandboxCoreRootError = localSandboxRoot
        ? await sandboxCoreWorkspaceRootError(localSandboxRoot, scopedPlan)
        : undefined;
      if (localSandboxCoreRootError) {
        return {
          status: "failed",
          direction: input.direction,
          workspace_root: workspaceRoot,
          remote_workspace_root: input.remote_workspace_root,
          sandbox: plan,
          reason: "path_not_allowed",
          error: localSandboxCoreRootError
        };
      }
    }
    if (plan.backend === "docker") {
      const dockerRootError = sandboxDockerWorkspaceRootError(input.remote_workspace_root ?? "/workspace");
      if (dockerRootError) {
        return {
          status: "failed",
          direction: input.direction,
          workspace_root: workspaceRoot,
          remote_workspace_root: input.remote_workspace_root,
          sandbox: plan,
          reason: "path_not_allowed",
          error: dockerRootError
        };
      }
    }
    const output = await adapter.sync({
      ...input,
      workspace_root: workspaceRoot,
      sandbox: scopedPlan
    });
    return {
      ...output,
      direction: input.direction,
      workspace_root: workspaceRoot,
      remote_workspace_root: input.remote_workspace_root,
      sandbox: plan
    };
  } catch (error) {
    return {
      status: "failed",
      direction: input.direction,
      workspace_root: workspaceRoot,
      remote_workspace_root: input.remote_workspace_root,
      sandbox: plan,
      reason: "adapter_failed",
      error: redactSecretLikeString(error instanceof Error ? error.message : String(error))
    };
  }
}

export function createSandboxLifecycleAdapter(options: SandboxLifecycleAdapterOptions = {}): SandboxLifecycleAdapter {
  return {
    async run(input) {
      if (input.sandbox.backend === "docker") {
        return runDockerSandboxLifecycle(input, options.spawnProcess ?? spawn);
      }
      if (input.sandbox.backend === "ssh" || input.sandbox.backend === "remote") {
        return runRemoteSandboxLifecycle(input, options.spawnProcess ?? spawn);
      }
      return {
        status: "completed",
        reason: "host_noop",
        resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
      };
    }
  };
}

export async function executeSandboxLifecycleAction(
  sandbox: GatewayBoundaryPolicy["sandbox"],
  input: Omit<SandboxLifecycleAdapterInput, "sandbox">,
  adapter: SandboxLifecycleAdapter
): Promise<SandboxLifecycleAdapterOutput> {
  const plan = createSandboxExecutionPlan(sandbox);
  try {
    if (input.action === "delete") {
      const pathError = !sandboxPathAccessAllows(plan.workspace_access, "read_write")
        ? "sandbox_workspace_access_not_allowed"
        : sandboxPathPolicyError(plan, "workspace", "read_write");
      if (pathError) {
        return {
          status: "failed",
          reason: "path_not_allowed",
          error: pathError,
          resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
        };
      }
    }
    return await adapter.run({
      ...input,
      sandbox: plan
    });
  } catch (error) {
    return {
      status: "failed",
      reason: "adapter_failed",
      error: redactSecretLikeString(error instanceof Error ? error.message : String(error)),
      resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
    };
  }
}

export function summarizeGatewayMcpConfig(config: GatewayMcpConfigRecord): GatewayMcpConfigSummary {
  return GatewayMcpConfigSummarySchema.parse({
    id: config.id,
    server_name: config.server_name,
    transport: config.transport,
    enabled: config.enabled,
    allowed_tools: config.allowed_tools,
    config_ref: config.config_ref,
    secret_ref_ids: config.secret_refs.map((ref) => ref.id),
    has_stdio: Boolean(config.stdio),
    has_http: Boolean(config.http),
    timeout_ms: config.stdio?.timeout_ms ?? config.http?.timeout_ms,
    metadata: config.metadata,
    created_at: config.created_at,
    updated_at: config.updated_at
  });
}

export function gatewayMcpConfigToBoundaryRef(config: GatewayMcpConfigRecord): McpConfigRef {
  return {
    id: config.id,
    server_name: config.server_name,
    config_ref: config.config_ref,
    allowed_tools: config.allowed_tools,
    secret_refs: config.secret_refs
  };
}

export function stdioMcpServerConfigFromGatewayConfig(config: GatewayMcpConfigRecord): StdioMcpServerConfig | undefined {
  if (!config.enabled || config.transport !== "stdio" || !config.stdio) {
    return undefined;
  }
  return {
    server_name: config.server_name,
    command: config.stdio.command,
    args: config.stdio.args,
    cwd: config.stdio.cwd,
    env: config.stdio.env,
    secret_env: config.stdio.secret_env,
    secret_files: config.stdio.secret_files.map((file) => ({
      secret_ref_id: file.secret_ref_id,
      filename: file.filename,
      env: file.env,
      ...(file.mode ? { mode: file.mode } : {})
    })),
    framing: config.stdio.framing,
    initialize: config.stdio.initialize,
    timeout_ms: config.stdio.timeout_ms
  };
}

export function httpMcpServerConfigFromGatewayConfig(config: GatewayMcpConfigRecord): HttpMcpServerConfig | undefined {
  if (!config.enabled || config.transport !== "http" || !config.http) {
    return undefined;
  }
  return {
    server_name: config.server_name,
    endpoint_url: config.http.endpoint_url,
    headers: config.http.headers,
    secret_headers: config.http.secret_headers,
    timeout_ms: config.http.timeout_ms
  };
}

export function planMcpToolInvocation(
  boundary: Pick<GatewayBoundaryPolicy, "mcp_config_refs" | "sandbox">,
  input: { server_name: string; tool_name: string }
): McpToolInvocationPlan {
  const config = boundary.mcp_config_refs.find((ref) => ref.server_name === input.server_name);
  if (!config) {
    return {
      status: "blocked",
      server_name: input.server_name,
      tool_name: input.tool_name,
      allowed_tools: [],
      secret_ref_ids: [],
      sandbox: boundary.sandbox,
      reason: "server_not_allowed"
    };
  }
  if (!config.allowed_tools.includes(input.tool_name)) {
    return {
      status: "blocked",
      server_name: input.server_name,
      tool_name: input.tool_name,
      config_ref: config.config_ref,
      allowed_tools: config.allowed_tools,
      secret_ref_ids: config.secret_refs.map((ref) => ref.id),
      sandbox: boundary.sandbox,
      reason: "tool_not_allowed"
    };
  }
  return {
    status: "ready",
    server_name: input.server_name,
    tool_name: input.tool_name,
    config_ref: config.config_ref,
    allowed_tools: config.allowed_tools,
    secret_ref_ids: config.secret_refs.map((ref) => ref.id),
    sandbox: boundary.sandbox
  };
}

export async function executeMcpToolInvocation(
  boundary: Pick<GatewayBoundaryPolicy, "mcp_config_refs" | "sandbox" | "source_channel">,
  input: McpToolExecutionInput,
  adapter: McpToolAdapter,
  options: {
    env?: NodeJS.ProcessEnv;
    fileRoot?: string;
  } = {}
): Promise<McpToolExecutionResult> {
  const plan = planMcpToolInvocation(boundary, input);
  const sandbox = createSandboxExecutionPlan(plan.sandbox);
  const emptySecretSummary = secretResolutionSummaryFromIds(plan.secret_ref_ids);
  if (plan.status === "blocked") {
    return {
      status: "blocked",
      server_name: input.server_name,
      tool_name: input.tool_name,
      resource_refs: [],
      secret_ref_ids: plan.secret_ref_ids,
      resolved_secret_ref_ids: [],
      secret_resolution: emptySecretSummary,
      sandbox,
      reason: plan.reason
    };
  }

  const isolationError = sandboxIsolationCapabilityError(
    sandbox,
    adapter.sandboxBackend ?? "none",
    boundary.source_channel
  );
  if (isolationError) {
    return {
      status: "blocked",
      server_name: input.server_name,
      tool_name: input.tool_name,
      resource_refs: [],
      secret_ref_ids: plan.secret_ref_ids,
      resolved_secret_ref_ids: [],
      secret_resolution: emptySecretSummary,
      sandbox,
      reason: "sandbox_isolation_unavailable",
      error: isolationError
    };
  }

  const config = boundary.mcp_config_refs.find((ref) => ref.server_name === input.server_name);
  const secretBundle = await createSecretResolutionBundle(config?.secret_refs ?? [], options);
  if (secretBundle.status === "failed") {
    return {
      status: "failed",
      server_name: input.server_name,
      tool_name: input.tool_name,
      resource_refs: [],
      secret_ref_ids: plan.secret_ref_ids,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox,
      reason: secretBundle.reason,
      error: secretBundle.error
    };
  }

  try {
    const result = await adapter.invoke({
      server_name: input.server_name,
      tool_name: input.tool_name,
      input: input.input ?? {},
      config_ref: plan.config_ref,
      sandbox,
      secrets: secretBundle.materials
    });
    return {
      status: "completed",
      server_name: input.server_name,
      tool_name: input.tool_name,
      output: redactMcpOutput(result.output, secretBundle.materials),
      resource_refs: result.resource_refs ?? [],
      secret_ref_ids: plan.secret_ref_ids,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      server_name: input.server_name,
      tool_name: input.tool_name,
      resource_refs: [],
      secret_ref_ids: plan.secret_ref_ids,
      resolved_secret_ref_ids: secretBundle.summary.resolved_secret_ref_ids,
      secret_resolution: secretBundle.summary,
      sandbox,
      reason: "adapter_failed",
      error: secretBundle.materials.length > 0
        ? "mcp_adapter_failed_with_secret_material"
        : redactSecretText(errorMessage, secretBundle.materials)
    };
  }
}

function secretResolutionSummaryFromIds(secretRefIds: string[]): SecretResolutionSummary {
  return {
    secret_ref_ids: secretRefIds,
    resolved_secret_ref_ids: [],
    unresolved_secret_ref_ids: [],
    unresolved_reasons: {}
  };
}

function sandboxIsolationCapabilityError(
  sandbox: SandboxExecutionPlan,
  adapterBackend: SandboxExecutorBackend,
  sourceChannel?: GatewayBoundaryPolicy["source_channel"]
): string | undefined {
  if (adapterBackend !== sandbox.backend) {
    return "sandbox_adapter_backend_mismatch";
  }
  if (sandbox.backend !== "none") {
    return undefined;
  }
  if (sourceChannel !== "local_cli" && sourceChannel !== "cron") {
    return "sandbox_unisolated_backend_not_allowed";
  }
  if (sandbox.network_access !== "external") {
    return "sandbox_network_isolation_unavailable";
  }
  if (sandbox.workspace_access !== "read_write") {
    return "sandbox_workspace_isolation_unavailable";
  }
  if (sandbox.denied_paths.length > 0 || !sandbox.allowed_paths.some((rule) =>
    (rule.root === "workspace" || rule.root === ".") && rule.access === "read_write"
  )) {
    return "sandbox_workspace_isolation_unavailable";
  }
  return undefined;
}

export function createSandboxExecutionPlan(policy: GatewayBoundaryPolicy["sandbox"]): SandboxExecutionPlan {
  return {
    mode: policy.mode,
    scope: policy.scope,
    backend: policy.backend,
    workspace_access: policy.workspace_access,
    network_access: policy.network_access,
    allowed_paths: policy.allowed_paths.map((rule) => ({ root: normalizeGatewayWorkspacePath(rule.root), access: rule.access })),
    denied_paths: policy.denied_paths.map(normalizeGatewayWorkspacePath),
    timeout_ms: policy.timeout_ms,
    metadata: policy.metadata
  };
}

type SandboxPathAccess = "read" | "write" | "read_write";

function sandboxPathPolicyError(
  sandbox: Pick<SandboxExecutionPlan, "allowed_paths" | "denied_paths">,
  requestedPath: string,
  requiredAccess: SandboxPathAccess
): string | undefined {
  const normalizedPath = requestedPath === "workspace"
    ? "workspace"
    : normalizeGatewayWorkspacePath(requestedPath);
  if (sandbox.denied_paths.some((root) => sandboxPolicyPathMatches(normalizedPath, root))) {
    return "sandbox_path_denied";
  }
  const matchingRules = sandbox.allowed_paths.filter((rule) => sandboxPolicyPathMatches(normalizedPath, rule.root));
  if (matchingRules.some((rule) => sandboxPathAccessAllows(rule.access, requiredAccess))) {
    return undefined;
  }
  return matchingRules.length > 0 ? "sandbox_path_access_not_allowed" : "sandbox_path_not_allowed";
}

function sandboxPolicyPathMatches(requestedPath: string, policyRoot: string): boolean {
  if (policyRoot === "workspace" || policyRoot === ".") {
    return true;
  }
  return requestedPath === policyRoot || requestedPath.startsWith(`${policyRoot}/`);
}

function sandboxPathAccessAllows(grantedAccess: string, requiredAccess: SandboxPathAccess): boolean {
  if (requiredAccess === "read_write") {
    return grantedAccess === "read_write";
  }
  return grantedAccess === requiredAccess || grantedAccess === "read_write";
}

function sandboxWorkspaceSyncRequiredAccess(
  direction: GatewaySandboxWorkspaceSyncDirection,
  metadata: Record<string, JsonValue>
): SandboxPathAccess {
  if (direction === "mirror" || metadata.workspace_sync_delete === true) {
    return "read_write";
  }
  return direction === "seed_to_sandbox" ? "read" : "write";
}

function sandboxWorkspaceSyncPathError(
  sandbox: SandboxExecutionPlan,
  input: SandboxWorkspaceSyncInput
): string | undefined {
  const metadata = {
    ...sandbox.metadata,
    ...(input.metadata ?? {})
  };
  const requiredAccess = sandboxWorkspaceSyncRequiredAccess(input.direction, metadata);
  if (!sandboxPathAccessAllows(sandbox.workspace_access, requiredAccess)) {
    return "sandbox_workspace_access_not_allowed";
  }
  const syncRoots = sandboxWorkspaceSyncRoots(sandbox);
  if (syncRoots.length === 0) {
    return "sandbox_path_not_allowed";
  }
  for (const root of syncRoots) {
    const pathError = sandboxPathPolicyError(sandbox, root || "workspace", requiredAccess);
    if (pathError && pathError !== "sandbox_path_denied") {
      return pathError;
    }
  }
  return undefined;
}

function sandboxDockerMountPolicyError(sandbox: SandboxExecutionPlan): string | undefined {
  for (const rule of sandbox.allowed_paths) {
    if (sandbox.denied_paths.some((deniedPath) => sandboxPolicyPathMatches(deniedPath, rule.root))) {
      return "sandbox_path_denied";
    }
  }
  return undefined;
}

function sandboxHostPartialPathError(sandbox: SandboxExecutionPlan): string | undefined {
  if (sandbox.backend !== "none" || sandbox.allowed_paths.some((rule) => rule.root === "workspace" || rule.root === ".")) {
    return undefined;
  }
  return "sandbox_host_partial_path_not_supported";
}

function assertSandboxWorkspaceSyncPathAllowed(input: SandboxWorkspaceSyncAdapterInput): void {
  const pathError = sandboxWorkspaceSyncPathError(input.sandbox, input);
  if (pathError) {
    throw new Error(pathError);
  }
}

function withWorkspaceSyncMetadata(
  sandbox: SandboxExecutionPlan,
  metadata: Record<string, JsonValue> | undefined
): SandboxExecutionPlan {
  return metadata ? { ...sandbox, metadata: { ...sandbox.metadata, ...metadata } } : sandbox;
}

async function sandboxCoreWorkspaceRootError(workspaceRoot: string, sandbox?: SandboxExecutionPlan, coreWorkspaceRoot?: string): Promise<string | undefined> {
  if (coreWorkspaceRoot) {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const resolvedCoreRoot = path.resolve(coreWorkspaceRoot);
    if (resolvedWorkspaceRoot === resolvedCoreRoot
      || resolvedWorkspaceRoot.startsWith(`${resolvedCoreRoot}${path.sep}`)
      || resolvedCoreRoot.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)) {
      return "sandbox_core_workspace_root_not_allowed";
    }
  }
  // PostgreSQL is the only standard Core persistence. A configured Core root
  // is rejected above; there is no local database file to discover or copy.
  if (sandbox && !sandboxWorkspaceSyncRoots(sandbox).includes("")) return undefined;
  return undefined;
}

export const webGatewayContext: GatewayContext = {
  source: "web",
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  channel: "web",
  session_key: "web:owner:main"
};

export const cronMemoryReviewGatewayContext: GatewayContext = {
  source: "cron",
  actor_identity: "owner_scheduled",
  instruction_source: "scheduled_context",
  channel: "cron",
  session_key: "cron:owner_scheduled:memory-review"
};

export function localCliGatewayContext(route = "main"): GatewayContext {
  const normalizedRoute = route.trim() || "main";
  return {
    source: "local_cli",
    actor_identity: "owner",
    instruction_source: "owner_instruction",
    channel: "local_cli",
    session_key: `local_cli:owner:${gatewaySessionKeyPart(normalizedRoute)}`
  };
}

export function createWebEnvelope(userIntent: string, inputLocale: SupportedLocale = "ja", outputLocale: SupportedLocale = "ja"): MessageEnvelope {
  return createGatewayEnvelope(webGatewayContext, userIntent, inputLocale, outputLocale);
}

export function createLocalCliEnvelope(
  userIntent: string,
  route = "main",
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja"
): MessageEnvelope {
  return createGatewayEnvelope(localCliGatewayContext(route), userIntent, inputLocale, outputLocale);
}

export function createCronMemoryReviewEnvelope(
  userIntent = "Run scheduled memory review.",
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja"
): MessageEnvelope {
  return createGatewayEnvelope(cronMemoryReviewGatewayContext, userIntent, inputLocale, outputLocale);
}

export function sessionKeyForExternalSource(input: ExternalGatewaySource): string {
  const account = input.account_id?.trim() || input.source_identity;
  const thread = input.thread_id?.trim() || input.route?.trim() || "main";
  return `${input.channel}:${gatewaySessionKeyPart(account)}:${gatewaySessionKeyPart(thread)}`;
}

const defaultPairingTtlMs = 5 * 60_000;
const defaultDuplicateWindowMs = 60_000;
const defaultRateLimitWindowMs = 60_000;
const defaultRateLimitMax = 20;

export function createPendingPairing(
  input: ExternalGatewaySource,
  now = nowIso(),
  options: { pairingTtlMs?: number } = {}
): GatewayPairingRecord {
  return {
    id: createId("pairing"),
    channel: input.channel,
    source_identity: input.source_identity,
    source_label: input.source_label ?? input.source_identity,
    status: "pending",
    pairing_code: createPairingCode(),
    session_key: sessionKeyForExternalSource(input),
    metadata: gatewayPairingMetadata(input),
    requested_at: now,
    expires_at: new Date(Date.parse(now) + (options.pairingTtlMs ?? defaultPairingTtlMs)).toISOString(),
    updated_at: now
  };
}

export function createDefaultGatewayPairingPolicy(
  channel: GatewayPairingRecord["channel"],
  now = nowIso()
): GatewayPairingPolicyRecord {
  const autoApprove = channel === "local_cli" || channel === "cron";
  return {
    id: `gateway_pairing_policy_${channel}`,
    channel,
    status: "enabled",
    trust_mode: autoApprove ? "auto_approve" : "pairing_required",
    allowlist: ["*"],
    allowed_tools: [],
    pairing_ttl_ms: defaultPairingTtlMs,
    duplicate_window_ms: defaultDuplicateWindowMs,
    rate_limit_window_ms: defaultRateLimitWindowMs,
    rate_limit_max: defaultRateLimitMax,
    metadata: {
      default_policy: true,
      source: "gateway_default"
    },
    created_at: now,
    updated_at: now
  };
}

export function createDefaultGatewayRoutingPolicy(
  channel: GatewayPairingRecord["channel"],
  now = nowIso()
): GatewayRoutingPolicyRecord {
  return {
    id: `gateway_routing_policy_${channel}`,
    channel,
    status: "enabled",
    session_key_strategy: "account_thread",
    default_route: "main",
    metadata: {
      default_policy: true,
      source: "gateway_default"
    },
    created_at: now,
    updated_at: now
  };
}

export function resolveGatewaySessionRouting(
  policy: GatewayRoutingPolicyRecord,
  input: ExternalGatewaySource
): GatewayRoutingResolution {
  const defaultRoute = gatewayRoutingPart(policy.default_route || "main", "main");
  const requestedRoute = gatewayRoutingPart(input.route, defaultRoute);
  const requestedAccount = gatewayRoutingPart(input.account_id, "")
    || gatewayRoutingPart(policy.default_account_id, "")
    || gatewayRoutingPart(input.source_identity, "source");
  const requestedThread = gatewayRoutingPart(input.thread_id, "")
    || requestedRoute
    || gatewayRoutingPart(policy.default_thread_id, "")
    || defaultRoute;
  const account = policy.session_key_strategy === "channel_main"
    ? gatewayRoutingPart(policy.default_account_id, "channel")
    : requestedAccount;
  const thread = policy.session_key_strategy === "account_thread"
    ? requestedThread
    : gatewayRoutingPart(policy.default_thread_id, defaultRoute);
  const sessionKey = sessionKeyForExternalSource({
    ...input,
    account_id: account,
    thread_id: thread,
    route: requestedRoute
  });
  return {
    allowed: policy.status === "enabled",
    reason: policy.status === "disabled" ? "routing_policy_disabled" : undefined,
    session_key: sessionKey,
    account_id: account,
    thread_id: thread,
    route: requestedRoute,
    session_key_strategy: policy.session_key_strategy
  };
}

export function evaluateGatewayPairingPolicy(
  policy: GatewayPairingPolicyRecord,
  input: { channel: GatewayPairingRecord["channel"]; source_identity: string }
): GatewayPairingPolicyEvaluation {
  const allowlistSnapshot = gatewayPairingAllowlistSnapshot(policy, input);
  const base = {
    allowlist_snapshot: allowlistSnapshot,
    allowed_tools_snapshot: [...policy.allowed_tools],
    pairing_ttl_ms: policy.pairing_ttl_ms ?? defaultPairingTtlMs,
    duplicate_window_ms: policy.duplicate_window_ms ?? defaultDuplicateWindowMs,
    rate_limit_window_ms: policy.rate_limit_window_ms ?? defaultRateLimitWindowMs,
    rate_limit_max: policy.rate_limit_max ?? defaultRateLimitMax
  };
  if (policy.status === "disabled") {
    return {
      ...base,
      allowed: false,
      trusted_without_pairing: false,
      reason: "policy_disabled"
    };
  }
  if (policy.trust_mode === "blocked") {
    return {
      ...base,
      allowed: false,
      trusted_without_pairing: false,
      reason: "policy_blocked"
    };
  }
  if (allowlistSnapshot.length === 0) {
    return {
      ...base,
      allowed: false,
      trusted_without_pairing: false,
      reason: "source_not_allowed"
    };
  }
  return {
    ...base,
    allowed: true,
    trusted_without_pairing: policy.trust_mode === "auto_approve"
  };
}

export function gatewayContextForPairing(pairing: GatewayPairingRecord): GatewayContext {
  return {
    source: pairing.channel,
    actor_identity: "paired_contact",
    instruction_source: "paired_identity_message",
    channel: pairing.channel,
    session_key: pairing.session_key
  };
}

function gatewayPairingMetadata(input: ExternalGatewaySource): Record<string, JsonValue> {
  return {
    ...(input.metadata ?? {}),
    routing: {
      account_id: input.account_id?.trim() || input.source_identity,
      thread_id: input.thread_id?.trim() || input.route?.trim() || "main",
      route: input.route?.trim() || "main"
    }
  };
}

function gatewayPairingAllowlistSnapshot(
  policy: GatewayPairingPolicyRecord,
  input: { channel: GatewayPairingRecord["channel"]; source_identity: string }
): string[] {
  return policy.allowlist.filter((entry) => gatewayPairingAllowlistEntryMatches(entry, input));
}

function gatewayPairingAllowlistEntryMatches(
  entry: string,
  input: { channel: GatewayPairingRecord["channel"]; source_identity: string }
): boolean {
  const normalized = entry.trim();
  if (!normalized) {
    return false;
  }
  return normalized === "*"
    || normalized === input.source_identity
    || normalized === `${input.channel}:*`
    || normalized === `${input.channel}:${input.source_identity}`;
}

function gatewayRoutingPart(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (!normalized || normalized.length > 120 || /[\u0000-\u001F\u007F]/.test(normalized)) {
    return fallback;
  }
  return normalized;
}

function gatewaySessionKeyPart(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "~");
}

export function approvePairing(pairing: GatewayPairingRecord, now = nowIso()): GatewayPairingRecord {
  return {
    ...pairing,
    status: "approved",
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  };
}

export function rejectPairing(pairing: GatewayPairingRecord, now = nowIso()): GatewayPairingRecord {
  return {
    ...pairing,
    status: "rejected",
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  };
}

export function expirePairing(pairing: GatewayPairingRecord, now = nowIso()): GatewayPairingRecord {
  if (pairing.status !== "pending") {
    return pairing;
  }
  if (pairing.expires_at && Date.parse(pairing.expires_at) > Date.parse(now)) {
    return pairing;
  }
  return {
    ...pairing,
    status: "expired",
    pairing_code: undefined,
    resolved_at: now,
    updated_at: now
  };
}

export function rotatePairingCode(pairing: GatewayPairingRecord, now = nowIso()): GatewayPairingRecord {
  if (pairing.status !== "pending") {
    return pairing;
  }
  return {
    ...pairing,
    pairing_code: createPairingCode(),
    expires_at: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
    updated_at: now
  };
}

export function revokePairing(pairing: GatewayPairingRecord, now = nowIso()): GatewayPairingRecord {
  if (pairing.status === "revoked") {
    return pairing;
  }
  return {
    ...pairing,
    status: "revoked",
    pairing_code: undefined,
    revoked_at: now,
    resolved_at: pairing.resolved_at ?? now,
    updated_at: now
  };
}

export function createGatewayInboundMessage(input: {
  channel: GatewayInboundMessageRecord["channel"];
  source_identity: string;
  body: string;
  pairing?: GatewayPairingRecord;
  metadata?: Record<string, JsonValue>;
  messageId?: string;
  now?: string;
}): GatewayInboundMessageRecord {
  const now = input.now ?? nowIso();
  const trusted = input.pairing?.status === "approved";
  return {
    id: createId("gateway_inbound"),
    channel: input.channel,
    source_identity: input.source_identity,
    body: input.body,
    status: trusted ? "routed" : "blocked",
    trusted,
    session_key: trusted ? input.pairing?.session_key : undefined,
    pairing_id: input.pairing?.id,
    message_id: input.messageId,
    metadata: input.metadata ?? {},
    created_at: now,
    updated_at: now
  };
}

export function createDefaultGatewayBoundaryPolicy(input: {
  source_channel: GatewayBoundarySource;
  source_identity?: string;
  session_key: string;
  allowed_tools?: string[];
  allowlist?: string[];
  now?: string;
}): GatewayBoundaryPolicy {
  const now = input.now ?? nowIso();
  return GatewayBoundaryPolicySchema.parse({
    id: createId("gateway_boundary"),
    source_channel: input.source_channel,
    source_identity: input.source_identity,
    session_key: input.session_key,
    allowed_tools: input.allowed_tools ?? [],
    mcp_config_refs: [],
    secret_refs: [],
    sandbox: {
      mode: input.source_channel === "web" ? "off" : "non_main",
      scope: "session",
      backend: "none",
      workspace_access: "none",
      network_access: "none",
      allowed_paths: [{ root: "workspace", access: "read_write" }],
      denied_paths: [],
      metadata: {}
    },
    path_normalization: {
      canonical_root: "workspace",
      reject_absolute_paths: true,
      reject_parent_segments: true,
      allowed_roots: ["workspace"],
      denied_roots: []
    },
    allowlist: input.allowlist ?? [],
    concurrency_lock: {
      scope: "session",
      key: input.session_key,
      ttl_ms: 60_000
    },
    metadata: {},
    created_at: now,
    updated_at: now
  });
}

export function normalizeGatewayWorkspacePath(inputPath: string): string {
  const normalizedInput = inputPath.replaceAll("\\", "/");
  if (normalizedInput.includes("\0")) {
    throw new Error("gateway_path_contains_null_byte");
  }
  if (normalizedInput.startsWith("/")) {
    throw new Error("gateway_absolute_path_not_allowed");
  }

  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("gateway_path_outside_workspace");
  }

  return normalized;
}

export function createGatewayEnvelope(
  context: GatewayContext,
  userIntent: string,
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja",
  metadata: Record<string, unknown> = {},
  attachments: MessageEnvelope["attachments"] = []
): MessageEnvelope {
  return {
    id: createId("envelope"),
    source: context.source,
    actor_identity: context.actor_identity,
    session_key: context.session_key,
    user_intent: userIntent,
    attachments,
    input_locale: inputLocale,
    output_locale: outputLocale,
    metadata: envelopeMetadata(context, metadata),
    received_at: nowIso()
  };
}

function envelopeMetadata(context: GatewayContext, metadata: Record<string, unknown>): MessageEnvelope["metadata"] {
  return jsonRecord({
    ...metadata,
    source: context.source,
    actor_identity: context.actor_identity,
    instruction_source: context.instruction_source,
    channel: context.channel,
    session_key: context.session_key,
    ...(context.source_identity ? { source_identity: context.source_identity } : {}),
    ...(context.source_label ? { source_label: context.source_label } : {})
  });
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry, key)]));
}

function jsonSafe(value: unknown, key?: string): JsonValue {
  if (key && isSecretLikeMetadataKey(key)) {
    return "[redacted]";
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "string" ? redactSecretLikeString(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry));
  }
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, jsonSafe(entry, entryKey)]));
  }
  return null;
}

function isSecretLikeMetadataKey(key: string): boolean {
  return /secret|token|api[_-]?key|password|credential|authorization/i.test(key);
}

function redactSecretLikeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bkey\s*=\s*["']?[^"',\s}]+/gi, "key=[redacted]")
    .replace(/\b(api[_-]?key|authorization|token|secret|password|credential|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=[redacted]");
}

function normalizeSecretMaterialFilename(filename: string): string {
  if (filename === "." || filename === ".." || filename !== path.basename(filename) || !/^[A-Za-z0-9._-]+$/.test(filename)) {
    throw new Error("invalid_secret_material_filename");
  }
  return filename;
}

function buildStdioMcpEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  config: StdioMcpServerConfig;
  materials: SecretResolutionMaterial[];
  secretFiles?: MaterializedSecretFiles;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    ...(input.config.env ?? {})
  };
  const materialById = new Map(input.materials.map((material) => [material.id, material]));
  for (const [envName, secretRefId] of Object.entries(input.config.secret_env ?? {})) {
    assertSafeEnvName(envName);
    const material = materialById.get(secretRefId);
    if (!material) {
      throw new Error(`secret_material_missing:${secretRefId}`);
    }
    env[envName] = material.value;
  }
  for (const binding of input.config.secret_files ?? []) {
    assertSafeEnvName(binding.env);
    const file = input.secretFiles?.files.find((entry) => entry.secret_ref_id === binding.secret_ref_id);
    if (!file) {
      throw new Error(`secret_file_material_missing:${binding.secret_ref_id}`);
    }
    env[binding.env] = file.path;
  }
  return env;
}

function buildHttpMcpHeaders(config: HttpMcpServerConfig, materials: SecretResolutionMaterial[]): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.headers ?? {})
  };
  const materialById = new Map(materials.map((material) => [material.id, material]));
  for (const [headerName, secretRefId] of Object.entries(config.secret_headers ?? {})) {
    assertSafeHeaderName(headerName);
    const material = materialById.get(secretRefId);
    if (!material) {
      throw new Error(`secret_material_missing:${secretRefId}`);
    }
    headers[headerName] = material.value;
  }
  return headers;
}

function parseJsonRpcResponse(body: string): { result?: unknown; error?: unknown } {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed ? parsed as { result?: unknown; error?: unknown } : { result: parsed };
  } catch {
    throw new Error(`mcp_http_invalid_json:${body.slice(0, 200)}`);
  }
}

function assertSafeEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("invalid_secret_env_name");
  }
}

function assertSafeHeaderName(name: string): void {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error("invalid_secret_header_name");
  }
}

interface SandboxProcessInvocation {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}

function createSandboxProcessInvocation(input: SandboxCommandAdapterInput, baseEnv: NodeJS.ProcessEnv): SandboxProcessInvocation {
  if (input.sandbox.backend === "docker") {
    return createDockerSandboxInvocation(input, baseEnv);
  }
  if (input.sandbox.backend === "ssh" || input.sandbox.backend === "remote") {
    return createSshSandboxInvocation(input, baseEnv);
  }
  return createHostSandboxInvocation(input, baseEnv);
}

function probeSandboxExecutor(
  backend: SandboxExecutorBackend,
  command: string,
  args: string[],
  spawnProbe: typeof spawnSync,
  timeoutMs: number
): SandboxExecutorCapabilityStatus {
  const result = spawnProbe(command, args, { encoding: "utf8", timeout: timeoutMs });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      backend,
      command,
      available: false,
      reason: code === "ENOENT" ? "command_not_found" : "probe_failed",
      detail: result.error.message
    };
  }
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status === 0) {
    return {
      backend,
      command,
      available: true,
      reason: "command_available",
      ...(detail ? { detail } : {})
    };
  }
  return {
    backend,
    command,
    available: false,
    reason: "probe_failed",
    detail: detail || `exit_status:${result.status ?? "unknown"}`
  };
}

function createHostSandboxInvocation(input: SandboxCommandAdapterInput, baseEnv: NodeJS.ProcessEnv): SandboxProcessInvocation {
  return {
    command: input.command,
    args: input.args ?? [],
    cwd: resolveSandboxHostCwd(input.sandbox, input.workspace_root, input.cwd),
    env: buildSandboxCommandEnv({
      baseEnv,
      input,
      materials: input.secrets,
      secretFiles: input.secret_files_materialized,
      mapSecretFilePath: (file) => file.path
    })
  };
}

function createDockerSandboxInvocation(input: SandboxCommandAdapterInput, baseEnv: NodeJS.ProcessEnv): SandboxProcessInvocation {
  const image = stringMetadata(input.sandbox.metadata, "docker_image")
    ?? stringMetadata(input.sandbox.metadata, "image")
    ?? "samurai-agent-sandbox:latest";
  const args = ["run", "--rm"];
  args.push("--network", input.sandbox.network_access === "none" ? "none" : "bridge");
  if (input.sandbox.workspace_access !== "none") {
    const mode = input.sandbox.workspace_access === "read" ? "ro" : "rw";
    for (const rule of dockerWorkspaceMountRules(input.sandbox)) {
      const hostPath = rule.root === "workspace"
        ? path.resolve(input.workspace_root)
        : path.resolve(input.workspace_root, rule.root);
      const containerPath = rule.root === "workspace" ? "/workspace" : `/workspace/${rule.root}`;
      args.push("-v", `${hostPath}:${containerPath}:${mode}`);
    }
    args.push("-w", dockerWorkspaceCwd(input.cwd));
  }
  if (input.secret_files_materialized?.root_dir) {
    args.push("-v", `${input.secret_files_materialized.root_dir}:/run/samurai-secrets:ro`);
  }
  const containerEnv = buildSandboxCommandEnv({
    baseEnv: {},
    input,
    materials: input.secrets,
    secretFiles: input.secret_files_materialized,
    mapSecretFilePath: (file) => `/run/samurai-secrets/${path.basename(file.path)}`
  });
  for (const [key, value] of Object.entries(containerEnv)) {
    assertSafeEnvName(key);
    args.push("--env", `${key}=${value}`);
  }
  args.push(image, input.command, ...(input.args ?? []));
  return {
    command: "docker",
    args,
    env: baseEnv
  };
}

function dockerWorkspaceMountRules(sandbox: SandboxExecutionPlan): Array<{ root: string }> {
  const roots = sandbox.allowed_paths
    .map((rule) => rule.root === "." ? "workspace" : rule.root)
    .filter((root, index, all) => all.indexOf(root) === index)
    .sort((left, right) => left.length - right.length);
  return roots.filter((root, index) => !roots.slice(0, index).some((parent) => sandboxPolicyPathMatches(root, parent))).map((root) => ({ root }));
}

function createSshSandboxInvocation(input: SandboxCommandAdapterInput, baseEnv: NodeJS.ProcessEnv): SandboxProcessInvocation {
  const target = stringMetadata(input.sandbox.metadata, input.sandbox.backend === "remote" ? "remote_target" : "ssh_target")
    ?? stringMetadata(input.sandbox.metadata, "target");
  if (!target) {
    throw new Error(input.sandbox.backend === "remote" ? "sandbox_remote_target_required" : "sandbox_ssh_target_required");
  }
  const remoteRoot = stringMetadata(input.sandbox.metadata, "remote_workspace_root")
    ?? stringMetadata(input.sandbox.metadata, "workspace_root")
    ?? ".";
  const remoteCwd = input.sandbox.workspace_access === "none" ? undefined : joinRemotePath(remoteRoot, input.cwd);
  return {
    command: "ssh",
    args: [target, "sh -s"],
    env: baseEnv,
    stdin: buildSshSandboxScript(input, remoteCwd)
  };
}

function buildSshSandboxScript(input: SandboxCommandAdapterInput, remoteCwd: string | undefined): string {
  const remoteEnv = buildRemoteSandboxCommandEnv(input);
  const lines = ["set -eu"];
  if (remoteEnv.secretFiles.length > 0) {
    lines.push(
      'SAMURAI_SECRET_DIR=$(mktemp -d "${TMPDIR:-/tmp}/samurai-gateway-secrets.XXXXXX")',
      'cleanup() { rm -rf "$SAMURAI_SECRET_DIR"; }',
      "trap cleanup EXIT",
      "umask 077"
    );
    for (const file of remoteEnv.secretFiles) {
      lines.push(
        `printf %s ${shQuote(file.value)} > "$SAMURAI_SECRET_DIR/${file.filename}"`,
        `chmod ${file.mode.toString(8)} "$SAMURAI_SECRET_DIR/${file.filename}"`
      );
    }
  }
  if (remoteCwd) {
    lines.push(`cd ${shQuote(remoteCwd)}`);
  }
  const envPrefix = [
    ...Object.entries(remoteEnv.env).map(([key, value]) => {
      assertSafeEnvName(key);
      return `${key}=${shQuote(value)}`;
    }),
    ...remoteEnv.secretFiles.flatMap((file) => {
      if (!file.env) {
        return [];
      }
      assertSafeEnvName(file.env);
      return [`${file.env}="$SAMURAI_SECRET_DIR/${file.filename}"`];
    })
  ].join(" ");
  const commandLine = [envPrefix, shQuote(input.command), ...(input.args ?? []).map(shQuote)].filter(Boolean).join(" ");
  lines.push(input.stdin === undefined ? commandLine : `printf %s ${shQuote(input.stdin)} | ${commandLine}`);
  return `${lines.join("\n")}\n`;
}

function buildRemoteSandboxCommandEnv(input: SandboxCommandAdapterInput): {
  env: Record<string, string>;
  secretFiles: Array<{ secret_ref_id: string; filename: string; value: string; mode: number; env?: string }>;
} {
  const env: Record<string, string> = { ...(input.env ?? {}) };
  const materialById = new Map(input.secrets.map((material) => [material.id, material]));
  for (const [envName, secretRefId] of Object.entries(input.secret_env ?? {})) {
    assertSafeEnvName(envName);
    const material = materialById.get(secretRefId);
    if (!material) {
      throw new Error(`secret_material_missing:${secretRefId}`);
    }
    env[envName] = material.value;
  }
  const secretFiles = (input.secret_files ?? []).map((binding) => {
    const material = materialById.get(binding.secret_ref_id);
    if (!material) {
      throw new Error(`secret_material_missing:${binding.secret_ref_id}`);
    }
    return {
      secret_ref_id: binding.secret_ref_id,
      filename: normalizeSecretMaterialFilename(binding.filename),
      value: material.value,
      mode: binding.mode ?? 0o600,
      ...(binding.env ? { env: binding.env } : {})
    };
  });
  return { env, secretFiles };
}

async function syncDockerWorkspace(input: SandboxWorkspaceSyncAdapterInput, spawnProcess: typeof spawn): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const container = stringMetadata(input.sandbox.metadata, "docker_container_id")
    ?? stringMetadata(input.sandbox.metadata, "container_id");
  if (!container) {
    const stats = await countWorkspaceFiles(input.workspace_root);
    return {
      status: "completed",
      reason: "docker_bind_mount",
      file_count: stats.fileCount,
      byte_count: stats.byteCount,
      resource_refs: [sandboxWorkspaceSyncRef("docker-bind", input.workspace_root)]
    };
  }
  const remoteRoot = input.remote_workspace_root ?? "/workspace";
  assertDockerWorkspaceRoot(remoteRoot);
  const roots = sandboxWorkspaceSyncRoots(input.sandbox);
  const forward = roots.map((root) => ({
    command: "docker",
    args: input.direction === "seed_to_sandbox"
      ? ["cp", dockerLocalSource(input.workspace_root, root), `${container}:${dockerRemoteTarget(remoteRoot, root)}`]
      : ["cp", `${container}:${dockerRemoteSource(remoteRoot, root)}`, dockerLocalTarget(input.workspace_root, root)],
    env: safeChildEnvironment()
  }));
  const output = input.direction === "mirror"
    ? await runTwoStepWorkspaceSync([
      ...roots.map((root) => ({
        command: "docker",
        args: ["cp", dockerLocalSource(input.workspace_root, root), `${container}:${dockerRemoteTarget(remoteRoot, root)}`],
        env: safeChildEnvironment()
      })),
      ...roots.map((root) => ({
        command: "docker",
        args: ["cp", `${container}:${dockerRemoteSource(remoteRoot, root)}`, dockerLocalTarget(input.workspace_root, root)],
        env: safeChildEnvironment()
      }))
    ], input, spawnProcess, "mirror_two_pass_update")
    : await runWorkspaceSyncSequence(forward, input, spawnProcess);
  const stats = await countWorkspaceFiles(input.workspace_root);
  return {
    ...output,
    file_count: stats.fileCount,
    byte_count: stats.byteCount
  };
}

function assertDockerWorkspaceRoot(remoteRoot: string): void {
  const error = sandboxDockerWorkspaceRootError(remoteRoot);
  if (error) {
    throw new Error(error);
  }
}

function sandboxDockerWorkspaceRootError(remoteRoot: string): string | undefined {
  const normalized = remoteRoot.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  if (normalized !== "/workspace" && !normalized.startsWith("/workspace/")) {
    return "sandbox_remote_root_not_allowed";
  }
  return undefined;
}

async function syncRemoteWorkspace(input: SandboxWorkspaceSyncAdapterInput, spawnProcess: typeof spawn): Promise<SandboxWorkspaceSyncAdapterOutput> {
  if (stringMetadata(input.sandbox.metadata, "workspace_sync_transport") === "local") {
    return syncLocalWorkspace(input);
  }
  const target = stringMetadata(input.sandbox.metadata, input.sandbox.backend === "remote" ? "remote_target" : "ssh_target")
    ?? stringMetadata(input.sandbox.metadata, "target");
  if (!target) {
    return {
      status: "failed",
      reason: "remote_target_required",
      error: input.sandbox.backend === "remote" ? "sandbox_remote_target_required" : "sandbox_ssh_target_required"
    };
  }
  const remoteRoot = input.remote_workspace_root
    ?? stringMetadata(input.sandbox.metadata, "remote_workspace_root")
    ?? stringMetadata(input.sandbox.metadata, "workspace_root")
    ?? ".";
  const args = ["-az"];
  if (booleanMetadata(input.sandbox.metadata, "workspace_sync_delete")) {
    args.push("--delete");
  }
  const roots = sandboxWorkspaceSyncRoots(input.sandbox);
  const invocations = roots.map((root) => {
    const localRoot = `${remoteLocalRoot(input.workspace_root, root)}/`;
    const remote = `${target}:${remoteRemoteRoot(remoteRoot, root)}/`;
    const rootArgs = [...args];
    if (input.direction === "mirror") rootArgs.push("--update");
    return {
      forward: { command: "rsync", args: [...rootArgs, localRoot, remote], env: safeChildEnvironment() },
      reverse: { command: "rsync", args: [...rootArgs, remote, localRoot], env: safeChildEnvironment() }
    };
  });
  if (input.direction === "mirror") {
    const output = await runTwoStepWorkspaceSync([
      ...invocations.map((invocation) => invocation.forward),
      ...invocations.map((invocation) => invocation.reverse)
    ], input, spawnProcess, "mirror_two_pass_update");
    const stats = await countWorkspaceFiles(input.workspace_root);
    return {
      ...output,
      file_count: stats.fileCount,
      byte_count: stats.byteCount
    };
  }
  if (input.direction === "seed_to_sandbox") {
    return withWorkspaceSyncStats(await runWorkspaceSyncSequence(invocations.map((invocation) => invocation.forward), input, spawnProcess), input);
  }
  return withWorkspaceSyncStats(await runWorkspaceSyncSequence(invocations.map((invocation) => invocation.reverse), input, spawnProcess), input);
}

async function syncLocalWorkspace(input: SandboxWorkspaceSyncAdapterInput): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const remoteRoot = input.remote_workspace_root ? path.resolve(input.remote_workspace_root) : undefined;
  const workspaceRoot = path.resolve(input.workspace_root);
  if (!remoteRoot || remoteRoot === workspaceRoot) {
    const stats = await countWorkspaceFiles(workspaceRoot);
    return {
      status: "completed",
      file_count: stats.fileCount,
      byte_count: stats.byteCount,
      resource_refs: [sandboxWorkspaceSyncRef("local-workspace", workspaceRoot)]
    };
  }
  const localSandboxCoreRootError = await sandboxCoreWorkspaceRootError(remoteRoot, input.sandbox);
  if (localSandboxCoreRootError) {
    throw new Error(localSandboxCoreRootError);
  }
  assertSafeLocalWorkspaceCopy(workspaceRoot, remoteRoot);
  if (input.direction === "seed_to_sandbox") {
    await copyWorkspaceContentsByPolicy(workspaceRoot, remoteRoot, input.sandbox);
  } else if (input.direction === "pull_from_sandbox") {
    await copyWorkspaceContentsByPolicy(remoteRoot, workspaceRoot, input.sandbox);
  } else {
    await copyWorkspaceMirrorByPolicy(workspaceRoot, remoteRoot, input.sandbox);
  }
  const stats = await countWorkspaceFiles(input.direction === "pull_from_sandbox" ? remoteRoot : workspaceRoot);
  return {
    status: "completed",
    ...(input.direction === "mirror" ? { reason: "mirror_newer_wins" as const } : {}),
    file_count: stats.fileCount,
    byte_count: stats.byteCount,
    resource_refs: [
      sandboxWorkspaceSyncRef("local-workspace", workspaceRoot),
      sandboxWorkspaceSyncRef("local-sandbox-workspace", remoteRoot)
    ]
  };
}

async function runDockerSandboxLifecycle(input: SandboxLifecycleAdapterInput, spawnProcess: typeof spawn): Promise<SandboxLifecycleAdapterOutput> {
  const container = stringMetadata(input.sandbox.metadata, "docker_container_id")
    ?? stringMetadata(input.sandbox.metadata, "container_id");
  if (!container) {
    return {
      status: "skipped",
      reason: "docker_container_required",
      error: "sandbox_docker_container_required",
      resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
    };
  }
  const args = input.action === "recreate" ? ["restart", container] : ["rm", "-f", container];
  return runSandboxLifecycleProcess({ command: "docker", args, env: safeChildEnvironment() }, input, spawnProcess);
}

async function runRemoteSandboxLifecycle(input: SandboxLifecycleAdapterInput, spawnProcess: typeof spawn): Promise<SandboxLifecycleAdapterOutput> {
  const target = stringMetadata(input.sandbox.metadata, input.sandbox.backend === "remote" ? "remote_target" : "ssh_target")
    ?? stringMetadata(input.sandbox.metadata, "target");
  if (!target) {
    return {
      status: "failed",
      reason: "remote_target_required",
      error: input.sandbox.backend === "remote" ? "sandbox_remote_target_required" : "sandbox_ssh_target_required",
      resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
    };
  }
  const configuredCommand = stringMetadata(input.sandbox.metadata, input.action === "recreate" ? "sandbox_recreate_command" : "sandbox_delete_command")
    ?? stringMetadata(input.sandbox.metadata, input.action === "recreate" ? "remote_recreate_command" : "remote_delete_command");
  if (!configuredCommand) {
    return {
      status: "skipped",
      reason: "remote_command_required",
      error: input.action === "recreate" ? "sandbox_recreate_command_required" : "sandbox_delete_command_required",
      resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)]
    };
  }
  return runSandboxLifecycleProcess({
    command: "ssh",
    args: [target, configuredCommand],
    env: safeChildEnvironment()
  }, input, spawnProcess);
}

async function runSandboxLifecycleProcess(
  invocation: SandboxProcessInvocation,
  input: SandboxLifecycleAdapterInput,
  spawnProcess: typeof spawn
): Promise<SandboxLifecycleAdapterOutput> {
  const output = await runSandboxProcess(invocation, {
    timeoutMs: input.timeout_ms ?? input.sandbox.timeout_ms ?? 60_000,
    spawnProcess
  });
  const failed = output.exit_code !== 0 || Boolean(output.signal);
  return {
    status: failed ? "failed" : "completed",
    command: invocation.command,
    args: invocation.args,
    stdout: output.stdout,
    stderr: output.stderr,
    resource_refs: [sandboxLifecycleRef(input.action, input.instance_key)],
    ...(failed ? { reason: "adapter_failed" as const, error: output.stderr || `exit_code:${output.exit_code ?? "signal"}` } : {})
  };
}

async function runWorkspaceSyncProcess(
  invocation: SandboxProcessInvocation,
  input: SandboxWorkspaceSyncAdapterInput,
  spawnProcess: typeof spawn
): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const output = await runSandboxProcess(invocation, {
    timeoutMs: input.timeout_ms ?? input.sandbox.timeout_ms ?? 60_000,
    spawnProcess
  });
  const failed = output.exit_code !== 0 || Boolean(output.signal);
  return {
    status: failed ? "failed" : "completed",
    resource_refs: [sandboxWorkspaceSyncRef(invocation.command, input.workspace_root)],
    ...(failed ? { reason: "adapter_failed" as const, error: output.stderr || `exit_code:${output.exit_code ?? "signal"}` } : {})
  };
}

async function runTwoStepWorkspaceSync(
  invocations: SandboxProcessInvocation[],
  input: SandboxWorkspaceSyncAdapterInput,
  spawnProcess: typeof spawn,
  reason: SandboxWorkspaceSyncAdapterOutput["reason"]
): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const resourceRefs: Array<{ kind: string; id?: string; uri: string; label?: string }> = [];
  for (const invocation of invocations) {
    const output = await runWorkspaceSyncProcess(invocation, input, spawnProcess);
    resourceRefs.push(...(output.resource_refs ?? []));
    if (output.status !== "completed") {
      return output;
    }
  }
  return {
    status: "completed",
    reason,
    resource_refs: resourceRefs
  };
}

async function runWorkspaceSyncSequence(
  invocations: SandboxProcessInvocation[],
  input: SandboxWorkspaceSyncAdapterInput,
  spawnProcess: typeof spawn
): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const resourceRefs: Array<{ kind: string; id?: string; uri: string; label?: string }> = [];
  for (const invocation of invocations) {
    const output = await runWorkspaceSyncProcess(invocation, input, spawnProcess);
    resourceRefs.push(...(output.resource_refs ?? []));
    if (output.status !== "completed") return output;
  }
  return { status: "completed", resource_refs: resourceRefs };
}

function sandboxWorkspaceSyncRoots(sandbox: SandboxExecutionPlan): string[] {
  const allowedRoots = sandbox.allowed_paths
    .map((rule) => rule.root === "." || rule.root === "workspace" ? "" : rule.root)
    .filter((root, index, all) => all.indexOf(root) === index)
    .filter((root) => !sandboxPathIsDenied(root, sandbox))
    .sort((left, right) => left.length - right.length);
  const requestedRoots = sandbox.metadata.workspace_sync_roots;
  const roots = Array.isArray(requestedRoots)
    ? requestedRoots
      .filter((root): root is string => typeof root === "string")
      .map((root) => root === "." || root === "workspace" ? "" : normalizeGatewayWorkspacePath(root))
      .filter((root, index, all) => all.indexOf(root) === index)
      .filter((root) => allowedRoots.some((allowed) => allowed === "" || sandboxPolicyPathMatches(root, allowed)))
      .filter((root) => !sandboxPathIsDenied(root, sandbox))
      .sort((left, right) => left.length - right.length)
    : allowedRoots.includes("") ? [""] : [];
  return roots.filter((root, index) => !roots.slice(0, index).some((parent) => parent === "" || sandboxPolicyPathMatches(root, parent)));
}

function sandboxPathIsDenied(relativePath: string, sandbox: SandboxExecutionPlan): boolean {
  return sandbox.denied_paths.some((denied) => {
    if (denied === "" || denied === "." || denied === "workspace") return true;
    return relativePath === denied || relativePath.startsWith(`${denied}/`);
  });
}

function dockerLocalSource(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  return relative ? `${resolved}/.` : `${resolved}/.`;
}

function dockerLocalTarget(root: string, relative: string): string {
  return path.resolve(root, relative || ".");
}

function dockerRemoteTarget(root: string, relative: string): string {
  return relative ? `${root.replace(/\/+$/, "")}/${relative}` : root;
}

function dockerRemoteSource(root: string, relative: string): string {
  return relative ? `${root.replace(/\/+$/, "")}/${relative}/.` : `${root.replace(/\/+$/, "")}/.`;
}

function remoteLocalRoot(root: string, relative: string): string {
  return path.resolve(root, relative || ".");
}

function remoteRemoteRoot(root: string, relative: string): string {
  return relative ? `${root.replace(/\/+$/, "")}/${relative}` : root.replace(/\/+$/, "");
}

async function copyWorkspaceContentsByPolicy(sourceRoot: string, targetRoot: string, sandbox: SandboxExecutionPlan): Promise<void> {
  for (const relative of sandboxWorkspaceSyncRoots(sandbox)) {
    await copyWorkspaceTree(path.join(sourceRoot, relative), path.join(targetRoot, relative), relative, sandbox);
  }
}

async function copyWorkspaceMirrorByPolicy(sourceRoot: string, targetRoot: string, sandbox: SandboxExecutionPlan): Promise<void> {
  for (const relative of sandboxWorkspaceSyncRoots(sandbox)) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    await copyNewerWorkspaceTree(source, target, relative, sandbox);
    await copyNewerWorkspaceTree(target, source, relative, sandbox);
  }
}

async function copyWorkspaceTree(sourceRoot: string, targetRoot: string, relativeRoot: string, sandbox: SandboxExecutionPlan): Promise<void> {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (sandboxPathIsDenied(relative, sandbox)) continue;
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await copyWorkspaceTree(source, target, relative, sandbox);
    } else if (entry.isFile()) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }
  }
}

async function copyNewerWorkspaceTree(sourceRoot: string, targetRoot: string, relativeRoot: string, sandbox: SandboxExecutionPlan): Promise<void> {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (sandboxPathIsDenied(relative, sandbox)) continue;
    const source = path.join(sourceRoot, entry.name);
    const target = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await copyNewerWorkspaceTree(source, target, relative, sandbox);
    } else if (entry.isFile() && await shouldCopyNewerFile(source, target)) {
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
    }
  }
}

async function withWorkspaceSyncStats(output: SandboxWorkspaceSyncAdapterOutput, input: SandboxWorkspaceSyncAdapterInput): Promise<SandboxWorkspaceSyncAdapterOutput> {
  const stats = await countWorkspaceFiles(input.workspace_root);
  return { ...output, file_count: stats.fileCount, byte_count: stats.byteCount };
}

async function shouldCopyNewerFile(sourcePath: string, targetPath: string): Promise<boolean> {
  const sourceInfo = await stat(sourcePath);
  try {
    const targetInfo = await stat(targetPath);
    return sourceInfo.mtimeMs > targetInfo.mtimeMs;
  } catch {
    return true;
  }
}

async function countWorkspaceFiles(root: string): Promise<{ fileCount: number; byteCount: number }> {
  let info;
  try {
    info = await stat(root);
  } catch {
    return { fileCount: 0, byteCount: 0 };
  }
  if (!info.isDirectory()) {
    return { fileCount: 1, byteCount: info.size };
  }
  let fileCount = 0;
  let byteCount = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await countWorkspaceFiles(child);
      fileCount += nested.fileCount;
      byteCount += nested.byteCount;
    } else if (entry.isFile()) {
      const childStat = await stat(child);
      fileCount += 1;
      byteCount += childStat.size;
    }
  }
  return { fileCount, byteCount };
}

function assertSafeLocalWorkspaceCopy(workspaceRoot: string, remoteRoot: string): void {
  if (remoteRoot === workspaceRoot) {
    return;
  }
  if (remoteRoot.startsWith(`${workspaceRoot}${path.sep}`) || workspaceRoot.startsWith(`${remoteRoot}${path.sep}`)) {
    throw new Error("sandbox_workspace_sync_nested_roots");
  }
}

function sandboxWorkspaceSyncRef(kind: string, root: string): { kind: string; id: string; uri: string; label: string } {
  const id = stableHash({ kind, root }).slice(0, 16);
  return {
    kind: "gateway_sandbox_workspace_sync",
    id,
    uri: `gateway/sandbox-workspace-syncs/${id}`,
    label: kind
  };
}

function sandboxLifecycleRef(action: SandboxLifecycleAction, instanceKey: string): { kind: string; id: string; uri: string; label: string } {
  const id = stableHash({ action, instanceKey }).slice(0, 16);
  return {
    kind: "gateway_sandbox_lifecycle",
    id,
    uri: `gateway/sandbox-lifecycle/${id}`,
    label: action
  };
}

function buildSandboxCommandEnv(input: {
  baseEnv: NodeJS.ProcessEnv;
  input: SandboxCommandAdapterInput;
  materials: SecretResolutionMaterial[];
  secretFiles?: MaterializedSecretFiles;
  mapSecretFilePath(file: MaterializedSecretFile): string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...input.baseEnv,
    ...(input.input.env ?? {})
  };
  const materialById = new Map(input.materials.map((material) => [material.id, material]));
  for (const [envName, secretRefId] of Object.entries(input.input.secret_env ?? {})) {
    assertSafeEnvName(envName);
    const material = materialById.get(secretRefId);
    if (!material) {
      throw new Error(`secret_material_missing:${secretRefId}`);
    }
    env[envName] = material.value;
  }
  for (const binding of input.input.secret_files ?? []) {
    if (!binding.env) {
      continue;
    }
    assertSafeEnvName(binding.env);
    const file = input.secretFiles?.files.find((entry) => entry.secret_ref_id === binding.secret_ref_id);
    if (!file) {
      throw new Error(`secret_file_material_missing:${binding.secret_ref_id}`);
    }
    env[binding.env] = input.mapSecretFilePath(file);
  }
  return env;
}

function resolveSandboxHostCwd(sandbox: SandboxExecutionPlan, workspaceRoot: string, cwd?: string): string | undefined {
  if (sandbox.workspace_access === "none") {
    if (cwd) {
      throw new Error("sandbox_workspace_access_none");
    }
    return undefined;
  }
  const root = path.resolve(workspaceRoot);
  if (!cwd) {
    return root;
  }
  const relative = normalizeGatewayWorkspacePath(cwd);
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("sandbox_cwd_outside_workspace");
  }
  return absolute;
}

function dockerWorkspaceCwd(cwd?: string): string {
  if (!cwd) {
    return "/workspace";
  }
  return `/workspace/${normalizeGatewayWorkspacePath(cwd)}`;
}

function joinRemotePath(root: string, cwd?: string): string {
  if (!cwd) {
    return root;
  }
  return `${root.replace(/\/+$/, "")}/${normalizeGatewayWorkspacePath(cwd)}`;
}

function stringMetadata(metadata: Record<string, JsonValue>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanMetadata(metadata: Record<string, JsonValue>, key: string): boolean {
  return metadata[key] === true;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runSandboxProcess(
  invocation: SandboxProcessInvocation,
  options: {
    stdin?: string;
    timeoutMs: number;
    spawnProcess: typeof spawn;
  }
): Promise<SandboxCommandAdapterOutput> {
  return new Promise((resolve, reject) => {
    const child = options.spawnProcess(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (output: SandboxCommandAdapterOutput) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...output,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr)
      });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        exit_code: null,
        signal: "SIGTERM",
        stdout,
        stderr: stderr ? `${stderr}\nsandbox_command_timeout` : "sandbox_command_timeout"
      });
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      finish({
        exit_code: code,
        signal,
        stdout,
        stderr
      });
    });
    if (options.stdin) {
      child.stdin?.write(options.stdin);
    }
    child.stdin?.end();
  });
}

function truncateOutput(value: string, limit = 64_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated:${value.length - limit}]`;
}

interface PooledStdioProcessEntry {
  key: string;
  server_name: string;
  client: StdioJsonRpcClient;
  secretFiles?: MaterializedSecretFiles;
  lastUsedAt: number;
  createdAt: number;
}

interface StdioMcpStartupHandle {
  key: string;
  controller: AbortController;
  promise: Promise<PooledStdioProcessEntry | undefined>;
  client?: StdioJsonRpcClient;
  secretFiles?: MaterializedSecretFiles;
}

class StdioMcpProcessPool {
  private readonly processes = new Map<string, PooledStdioProcessEntry>();
  private readonly maxProcesses: number;
  private readonly idleTtlMs: number;
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly starting = new Map<string, StdioMcpStartupHandle>();
  private readonly closingEntries = new Set<PooledStdioProcessEntry>();

  constructor(private readonly options: PooledStdioMcpToolAdapterOptions) {
    this.maxProcesses = options.maxProcesses ?? 8;
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
  }

  async invoke(input: McpToolAdapterInput): Promise<{ output?: JsonValue; resource_refs?: Array<{ kind: string; id?: string; uri: string; label?: string }> }> {
    if (this.closed) {
      throw new Error("mcp_process_pool_closed");
    }
    const config = await this.options.resolveConfig({
      server_name: input.server_name,
      config_ref: input.config_ref
    });
    if (!config) {
      throw new Error(`mcp_config_not_found:${input.server_name}`);
    }
    if (this.closed) {
      throw new Error("mcp_process_pool_closed");
    }
    await this.reapIdle();
    if (this.closed) throw new Error("mcp_process_pool_closed");
    const key = pooledStdioProcessKey(config, input.secrets);
    let entry = this.processes.get(key);
    if (!entry || entry.client.isClosed()) {
      await entry?.secretFiles?.cleanup();
      if (this.closed) throw new Error("mcp_process_pool_closed");
      let handle = this.starting.get(key);
      if (!handle) {
        const controller = new AbortController();
        handle = {
          key,
          controller,
          promise: Promise.resolve(undefined)
        };
        const trackedHandle = handle;
        handle.promise = Promise.resolve().then(() => this.startEntry(key, config, input, trackedHandle)).then(async (started) => {
          if (this.closed) {
            this.closingEntries.add(started);
            await this.closeEntry(started);
            return undefined;
          }
          this.processes.set(key, started);
          return started;
        });
        this.starting.set(key, handle);
      }
      try {
        entry = await handle.promise;
      } finally {
        if (this.starting.get(key) === handle) {
          this.starting.delete(key);
        }
      }
      if (!entry) {
        throw new Error("mcp_process_pool_closed");
      }
      await this.evictOverflow();
    }
    entry.lastUsedAt = Date.now();
    const output = await entry.client.request("tools/call", {
      name: input.tool_name,
      arguments: input.input
    });
    entry.lastUsedAt = Date.now();
    return {
      output: jsonSafe(output),
      resource_refs: []
    };
  }

  async closeAll(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    const attempt = (async () => {
      const entries = [...new Set([...this.processes.values(), ...this.closingEntries])];
      for (const entry of entries) this.closingEntries.add(entry);
      this.processes.clear();
      const starting = [...this.starting.values()];
      for (const handle of starting) {
        handle.controller.abort();
        void handle.client?.close().catch(() => undefined);
      }
      const results = await Promise.allSettled([
        ...entries.map((entry) => this.closeEntry(entry)),
        ...starting.map((handle) => settleMcpStartup(handle))
      ]);
      const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length > 0) {
        throw new AggregateError(errors, "mcp_process_pool_close_failed");
      }
      for (const [key, handle] of this.starting) {
        if (starting.includes(handle)) this.starting.delete(key);
      }
      if (this.processes.size > 0 || this.starting.size > 0 || this.closingEntries.size > 0) {
        throw new Error("mcp_process_pool_close_incomplete");
      }
    })();
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = undefined;
    });
    return attempt;
  }

  stats(): PooledMcpToolAdapterStats {
    return {
      process_count: this.processes.size,
      max_processes: this.maxProcesses,
      idle_ttl_ms: this.idleTtlMs,
      servers: [...this.processes.values()].map((entry) => ({
        server_name: entry.server_name,
        last_used_at: new Date(entry.lastUsedAt).toISOString()
      }))
    };
  }

  private async startEntry(
    key: string,
    config: StdioMcpServerConfig,
    input: McpToolAdapterInput,
    handle: StdioMcpStartupHandle
  ): Promise<PooledStdioProcessEntry> {
    let secretFiles: MaterializedSecretFiles | undefined;
    let client: StdioJsonRpcClient | undefined;
    try {
      secretFiles = config.secret_files?.length
        ? await materializeSecretFiles(input.secrets, config.secret_files)
        : undefined;
      handle.secretFiles = secretFiles;
      if (handle.controller.signal.aborted) throw new Error("mcp_process_startup_aborted");
      const env = buildStdioMcpEnv({
        baseEnv: safeChildEnvironment(this.options.env ?? process.env),
        config,
        materials: input.secrets,
        secretFiles
      });
      client = new StdioJsonRpcClient({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env,
        framing: config.framing ?? "json_lines",
        timeoutMs: config.timeout_ms ?? input.sandbox.timeout_ms ?? 30_000,
        spawnProcess: this.options.spawnProcess ?? spawn
      });
      handle.client = client;
      const abort = () => { void client?.close().catch(() => undefined); };
      handle.controller.signal.addEventListener("abort", abort, { once: true });
      await client.start();
      if (config.initialize !== false) {
        await client.request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "samurai-agent-gateway",
            version: "0.1.0"
          }
        });
        client.notify("notifications/initialized", {});
      }
      handle.controller.signal.removeEventListener("abort", abort);
      return {
        key,
        server_name: config.server_name,
        client,
        secretFiles,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await client?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await secretFiles?.cleanup();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], "mcp_process_start_cleanup_failed");
      }
      throw error;
    }
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    const stale = [...this.processes.values()].filter((entry) =>
      entry.client.isClosed() || now - entry.lastUsedAt > this.idleTtlMs
    );
    for (const entry of stale) {
      this.closingEntries.add(entry);
      this.processes.delete(entry.key);
      await this.closeEntry(entry);
    }
  }

  private async evictOverflow(): Promise<void> {
    while (this.processes.size > this.maxProcesses) {
      const oldest = [...this.processes.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!oldest) {
        return;
      }
      this.closingEntries.add(oldest);
      this.processes.delete(oldest.key);
      await this.closeEntry(oldest);
    }
  }

  private async closeEntry(entry: PooledStdioProcessEntry): Promise<void> {
    const errors: unknown[] = [];
    try {
      await entry.client.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await entry.secretFiles?.cleanup();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `mcp_process_close_failed:${entry.server_name}`);
    }
    this.closingEntries.delete(entry);
  }
}

async function settleMcpStartup(handle: StdioMcpStartupHandle): Promise<void> {
  const timeoutMs = mcpProcessCloseGraceMs + mcpProcessCloseKillWaitMs + 500;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("mcp_process_startup_shutdown_timeout"));
    }, timeoutMs);
    handle.promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (handle.controller.signal.aborted && isExpectedMcpStartupAbort(error)) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function isExpectedMcpStartupAbort(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof AggregateError) return false;
  return error.message === "mcp_process_closed"
    || error.message === "mcp_process_startup_aborted"
    || error.message.startsWith("mcp_process_exited:");
}

function pooledStdioProcessKey(config: StdioMcpServerConfig, secrets: SecretResolutionMaterial[]): string {
  return stableHash({
    server_name: config.server_name,
    command: config.command,
    args: config.args ?? [],
    cwd: config.cwd ?? null,
    env: config.env ?? {},
    secret_env: config.secret_env ?? {},
    secret_files: config.secret_files ?? [],
    framing: config.framing ?? "json_lines",
    initialize: config.initialize !== false,
    secret_fingerprints: secrets.map((secret) => ({
      id: secret.id,
      source: secret.source,
      provider: secret.provider,
      value_hash: stableHash(secret.value)
    })).sort((a, b) => a.id.localeCompare(b.id))
  });
}

class StdioJsonRpcClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private jsonLineBuffer = "";
  private contentLengthBuffer = Buffer.alloc(0);
  private closed = false;
  private closePromise?: Promise<void>;
  private pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly options: {
    command: string;
    args: string[];
    cwd?: string;
    env: NodeJS.ProcessEnv;
    framing: McpStdioFraming;
    timeoutMs: number;
    spawnProcess: typeof spawn;
  }) {}

  async start(): Promise<void> {
    if (this.child && !this.closed) {
      return;
    }
    this.closed = false;
    this.child = this.options.spawnProcess(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: "pipe"
    }) as ChildProcessWithoutNullStreams;
    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.child.on("error", (error) => this.rejectAll(new Error(`mcp_process_error:${error.message}`)));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.rejectAll(new Error(`mcp_process_exited:${code ?? signal ?? "unknown"}`));
      }
    });
  }

  request(method: string, params: JsonValue): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("mcp_process_closed"));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp_request_timeout:${method}`));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  notify(method: string, params: JsonValue): void {
    if (this.closed) {
      throw new Error("mcp_process_closed");
    }
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    const attempt = (async () => {
      this.closed = true;
      this.rejectAll(new Error("mcp_process_closed"));
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve(true);
          return;
        }
        let settled = false;
        let timer: NodeJS.Timeout;
        let onExit: () => void;
        const done = (exited: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.off("exit", onExit);
          child.off("close", onExit);
          resolve(exited);
        };
        onExit = () => done(true);
        timer = setTimeout(() => done(false), timeoutMs);
        child.once("exit", onExit);
        child.once("close", onExit);
      });
      try {
        if (!child.killed) {
          child.kill("SIGTERM");
        }
      } catch (error) {
        // A process can race with its close event; still wait for the close event.
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        throw new Error(`mcp_process_close_signal_failed:${error instanceof Error ? error.message : String(error)}`);
      }
      if (await waitForExit(mcpProcessCloseGraceMs)) {
        return;
      }
      try {
        child.kill("SIGKILL");
      } catch (error) {
        throw new Error(`mcp_process_close_force_kill_failed:${error instanceof Error ? error.message : String(error)}`);
      }
      if (!(await waitForExit(mcpProcessCloseKillWaitMs))) {
        throw new Error("mcp_process_close_timeout");
      }
    })();
    this.closePromise = attempt;
    void attempt.catch(() => {
      if (this.closePromise === attempt) this.closePromise = undefined;
    });
    return attempt;
  }

  isClosed(): boolean {
    return this.closed || Boolean(this.child?.killed);
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.child) {
      throw new Error("mcp_process_not_started");
    }
    const body = JSON.stringify(message);
    if (this.options.framing === "content_length") {
      this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
      return;
    }
    this.child.stdin.write(`${body}\n`);
  }

  private handleStdout(chunk: Buffer): void {
    if (this.options.framing === "content_length") {
      this.handleContentLengthChunk(chunk);
      return;
    }
    this.jsonLineBuffer += chunk.toString("utf8");
    let newlineIndex = this.jsonLineBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.jsonLineBuffer.slice(0, newlineIndex).trim();
      this.jsonLineBuffer = this.jsonLineBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleJsonMessage(line);
      }
      newlineIndex = this.jsonLineBuffer.indexOf("\n");
    }
  }

  private handleContentLengthChunk(chunk: Buffer): void {
    this.contentLengthBuffer = Buffer.concat([this.contentLengthBuffer, chunk]);
    while (true) {
      const headerEnd = this.contentLengthBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const header = this.contentLengthBuffer.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /content-length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.rejectAll(new Error("mcp_invalid_content_length_header"));
        return;
      }
      const length = Number(lengthMatch[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.contentLengthBuffer.length < bodyEnd) {
        return;
      }
      const body = this.contentLengthBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.contentLengthBuffer = this.contentLengthBuffer.subarray(bodyEnd);
      this.handleJsonMessage(body);
    }
  }

  private handleJsonMessage(body: string): void {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      this.rejectAll(new Error("mcp_invalid_json_message"));
      return;
    }
    if (!message || typeof message !== "object" || !("id" in message)) {
      return;
    }
    const rpcMessage = message as { id?: unknown; result?: unknown; error?: { message?: unknown } };
    if (typeof rpcMessage.id !== "number") {
      return;
    }
    const pending = this.pending.get(rpcMessage.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(rpcMessage.id);
    if (rpcMessage.error) {
      pending.reject(new Error(typeof rpcMessage.error.message === "string" ? rpcMessage.error.message : "mcp_request_failed"));
      return;
    }
    pending.resolve(rpcMessage.result ?? null);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function createPairingCode(): string {
  // Pairing codes are an authentication factor for an external contact. Do
  // not derive them from Math.random(), which is predictable and not
  // suitable for security-sensitive admission codes.
  return randomBytes(6).toString("hex").toUpperCase();
}

function redactSecretMaterials(value: JsonValue | undefined, secrets: SecretResolutionMaterial[]): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (secrets.length === 0) {
    return value;
  }
  if (typeof value === "string") {
    return secrets.reduce<string>((current, secret) => current.replaceAll(secret.value, `[redacted:${secret.id}]`), value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretMaterials(item, secrets) ?? null);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecretMaterials(item as JsonValue, secrets) ?? null])
    ) as JsonValue;
  }
  return value;
}

function redactSecretText(value: string, secrets: SecretResolutionMaterial[]): string {
  return secrets.reduce<string>((current, secret) => current.replaceAll(secret.value, `[redacted:${secret.id}]`), redactSecretLikeString(value));
}

const secretOutputWithheldMessage = "output_withheld_secret_material_injected";

function redactSandboxOutput(value: string, secrets: SecretResolutionMaterial[]): string {
  return secrets.length > 0 ? secretOutputWithheldMessage : redactSecretText(value, secrets);
}

function redactMcpOutput(value: JsonValue | undefined, secrets: SecretResolutionMaterial[]): JsonValue | undefined {
  return secrets.length > 0
    ? { redacted: true, reason: secretOutputWithheldMessage }
    : redactSecretMaterials(value, secrets);
}
