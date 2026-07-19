import {
  ActionCatalogEntrySchema,
  PluginManifestSchema,
  nowIso,
  type ActionCatalogEntry,
  type JsonValue,
  type PluginManifest,
  type SurfaceRendererRegistryEntry
} from "@samurai-agent/core-schemas";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionCatalogEntries } from "./domain-catalog-projection";

export * from "./domain-catalog-projection";

export const pluginManifests: PluginManifest[] = [
  {
    id: "samurai-workspace-core",
    name: "Samurai Workspace Core",
    version: "1.0.0",
    kind: "tool",
    actions: actionCatalogEntries,
    resource_kinds: [...new Set(actionCatalogEntries.flatMap((entry) => entry.resource_kinds))],
    metadata: {
      built_in: true
    }
  }
];
const actionCatalogEntryById = new Map(actionCatalogEntries.map((entry) => [entry.id, entry] as const));
const pluginManifestById = new Map(pluginManifests.map((manifest) => [manifest.id, manifest] as const));

for (const entry of actionCatalogEntries) {
  ActionCatalogEntrySchema.parse(entry);
}

for (const manifest of pluginManifests) {
  PluginManifestSchema.parse(manifest);
}

export function getActionCatalogEntry(id: string): ActionCatalogEntry | undefined {
  return actionCatalogEntryById.get(id);
}

export function listActionCatalogEntries(category?: string): ActionCatalogEntry[] {
  return category
    ? actionCatalogEntries.filter((entry) => entry.ui_display_category === category)
    : [...actionCatalogEntries];
}

export function getPluginManifest(id: string): PluginManifest | undefined {
  return pluginManifestById.get(id);
}

export interface PluginManifestLoadIssue {
  file_path: string;
  code:
    | "invalid_manifest"
    | "duplicate_manifest"
    | "duplicate_action"
    | "duplicate_renderer"
    | "read_failed"
    | "entrypoint_missing"
    | "entrypoint_outside_plugin"
    | "entrypoint_integrity_mismatch"
    | "entrypoint_unsigned"
    | "signature_invalid"
    | "signature_untrusted"
    | "entrypoint_load_failed"
    | "invalid_entrypoint_module"
    | "version_incompatible";
  message: string;
}

function actionHasHandlerId(
  action: ActionCatalogEntry,
): action is ActionCatalogEntry & { handler_id: string } {
  return typeof action.handler_id === "string" && action.handler_id.length > 0;
}

export interface PluginTrustedSigningKey {
  key_id: string;
  public_key: string;
}

export interface PluginManifestLoadOptions {
  trustedSigningKeys?: PluginTrustedSigningKey[];
  requireSignature?: boolean;
}

export type PluginEntrypointStatus =
  | "not_declared"
  | "ready"
  | "missing"
  | "outside_plugin"
  | "integrity_mismatch";

export type PluginSignatureStatus =
  | "not_declared"
  | "trusted"
  | "untrusted_key"
  | "invalid";

export interface PluginRuntimeBinding {
  manifest_id: string;
  manifest_file_path: string;
  plugin_dir: string;
  entrypoint?: string;
  entrypoint_path?: string;
  entrypoint_sha256?: string;
  expected_entrypoint_sha256?: string;
  entrypoint_status: PluginEntrypointStatus;
  signature_status: PluginSignatureStatus;
  signature_key_id?: string;
  action_ids: string[];
  handler_ids: string[];
  renderer_ids: string[];
}

export interface PluginManifestLoadResult {
  manifests: PluginManifest[];
  actions: ActionCatalogEntry[];
  renderers: SurfaceRendererRegistryEntry[];
  bindings: PluginRuntimeBinding[];
  issues: PluginManifestLoadIssue[];
}

export interface PluginActionHandlerInput {
  action: ActionCatalogEntry;
  manifest?: PluginManifest;
  input: Record<string, JsonValue>;
  context?: Record<string, JsonValue>;
}

export interface PluginActionHandlerOutput {
  status: "completed" | "failed";
  output?: JsonValue;
  error?: string;
}

export type PluginActionHandler = (input: PluginActionHandlerInput) => Promise<PluginActionHandlerOutput> | PluginActionHandlerOutput;

export interface PluginRuntimeStatus {
  manifest_id: string;
  name: string;
  version: string;
  kind: PluginManifest["kind"];
  source: "built_in" | "filesystem";
  manifest_file_path?: string;
  plugin_dir?: string;
  entrypoint?: string;
  entrypoint_path?: string;
  entrypoint_status: PluginEntrypointStatus;
  signature_status: PluginSignatureStatus;
  action_ids: string[];
  renderer_ids: string[];
  handler_ids: string[];
  registered_handler_ids: string[];
  missing_handler_ids: string[];
  enabled: boolean;
}

export interface PluginEntrypointLoadOptions {
  allowUnsigned?: boolean;
  importModule?: (specifier: string) => Promise<unknown>;
  timeoutMs?: number;
  memoryLimitMb?: number;
}

export interface PluginEntrypointLoadResult {
  loaded: Array<{
    manifest_id: string;
    entrypoint_path: string;
    registered_handler_ids: string[];
  }>;
  issues: PluginManifestLoadIssue[];
}

export class PluginRuntimeRegistry {
  private readonly actions = new Map<string, ActionCatalogEntry>();
  private readonly renderers = new Map<string, SurfaceRendererRegistryEntry>();
  private readonly manifests = new Map<string, PluginManifest>();
  private readonly manifestsByAction = new Map<string, PluginManifest>();
  private readonly runtimeBindings = new Map<string, PluginRuntimeBinding>();
  private readonly handlers = new Map<string, PluginActionHandler>();
  private readonly disabledManifestIds = new Set<string>();

  constructor(catalog: PluginManifestLoadResult | { manifests: PluginManifest[]; actions: ActionCatalogEntry[]; renderers?: SurfaceRendererRegistryEntry[]; bindings?: PluginRuntimeBinding[] } = { manifests: pluginManifests, actions: actionCatalogEntries }) {
    for (const action of catalog.actions) {
      this.actions.set(action.id, action);
    }
    for (const renderer of catalog.renderers ?? catalog.manifests.flatMap((manifest) => manifest.renderers ?? [])) {
      this.renderers.set(renderer.id, renderer);
    }
    for (const manifest of catalog.manifests) {
      this.manifests.set(manifest.id, manifest);
      for (const action of manifest.actions) {
        this.manifestsByAction.set(action.id, manifest);
      }
    }
    for (const binding of catalog.bindings ?? []) {
      this.runtimeBindings.set(binding.manifest_id, binding);
    }
  }

  registerHandler(handlerId: string, handler: PluginActionHandler): void {
    this.handlers.set(handlerId, handler);
  }

  getAction(actionId: string): ActionCatalogEntry | undefined {
    return this.actions.get(actionId);
  }

  listActions(category?: string): ActionCatalogEntry[] {
    const actions = [...this.actions.values()].filter((action) => {
      const manifest = this.manifestsByAction.get(action.id);
      return !manifest || !this.disabledManifestIds.has(manifest.id);
    });
    return category ? actions.filter((action) => action.ui_display_category === category) : actions;
  }

  listRenderers(): SurfaceRendererRegistryEntry[] {
    return [...this.renderers.values()].filter((renderer) => {
      const manifest = [...this.manifests.values()].find((item) => item.renderers?.some((entry) => entry.id === renderer.id));
      return !manifest || !this.disabledManifestIds.has(manifest.id);
    });
  }

  setPluginEnabled(manifestId: string, enabled: boolean): boolean {
    if (!this.manifests.has(manifestId)) return false;
    if (enabled) this.disabledManifestIds.delete(manifestId); else this.disabledManifestIds.add(manifestId);
    return true;
  }

  listPluginStatuses(): PluginRuntimeStatus[] {
    return [...this.manifests.values()].map((manifest) => {
      const binding = this.runtimeBindings.get(manifest.id);
    const handlerIds = uniqueStrings(
      manifest.actions.flatMap((action) =>
        actionHasHandlerId(action) ? [action.handler_id] : [],
      ),
    );
      const registeredHandlerIds = handlerIds.filter((handlerId) => this.handlers.has(handlerId));
      return {
        manifest_id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        source: manifest.metadata.built_in === true ? "built_in" : "filesystem",
        manifest_file_path: binding?.manifest_file_path,
        plugin_dir: binding?.plugin_dir,
        entrypoint: binding?.entrypoint,
        entrypoint_path: binding?.entrypoint_path,
        entrypoint_status: binding?.entrypoint_status ?? "not_declared",
        signature_status: binding?.signature_status ?? "not_declared",
        action_ids: manifest.actions.map((action) => action.id),
        renderer_ids: manifest.renderers?.map((renderer) => renderer.id) ?? [],
        handler_ids: handlerIds,
        registered_handler_ids: registeredHandlerIds,
        missing_handler_ids: handlerIds.filter((handlerId) => !this.handlers.has(handlerId)),
        enabled: !this.disabledManifestIds.has(manifest.id)
      };
    });
  }

  hasRegisteredHandler(actionId: string): boolean {
    const action = this.actions.get(actionId);
    return action ? actionHasHandlerId(action) && this.handlers.has(action.handler_id) : false;
  }

  async executeAction(actionId: string, input: Record<string, JsonValue>, context?: Record<string, JsonValue>): Promise<PluginActionHandlerOutput & { action_id: string; handler_id?: string }> {
    const action = this.actions.get(actionId);
    if (!action) {
      return { action_id: actionId, status: "failed", error: "action_not_found" };
    }
    const manifest = this.manifestsByAction.get(action.id);
    if (manifest && this.disabledManifestIds.has(manifest.id)) {
      return { action_id: actionId, handler_id: action.handler_id, status: "failed", error: "plugin_disabled" };
    }
    if (!actionHasHandlerId(action)) {
      return {
        action_id: actionId,
        status: "failed",
        error: "handler_not_registered",
      };
    }

    const handler = this.handlers.get(action.handler_id);
    if (!handler) {
      return { action_id: actionId, handler_id: action.handler_id, status: "failed", error: "handler_not_registered" };
    }
    const result = await handler({
      action,
      manifest,
      input,
      context
    });
    return { action_id: actionId, handler_id: action.handler_id, ...result };
  }

  async loadEntrypoints(options: PluginEntrypointLoadOptions = {}): Promise<PluginEntrypointLoadResult> {
    const issues: PluginManifestLoadIssue[] = [];
    const loaded: PluginEntrypointLoadResult["loaded"] = [];
    const importModule = options.importModule;

    for (const binding of this.runtimeBindings.values()) {
      if (this.disabledManifestIds.has(binding.manifest_id)) {
        continue;
      }
      if (!binding.entrypoint || !binding.entrypoint_path || binding.entrypoint_status !== "ready") {
        continue;
      }
      if (binding.signature_status !== "trusted" && options.allowUnsigned !== true) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "entrypoint_unsigned",
          message: `plugin entrypoint ${binding.entrypoint} is not signed by a trusted key`
        });
        continue;
      }
      const manifest = this.manifests.get(binding.manifest_id);
      if (!manifest) {
        continue;
      }
      const apiVersion = typeof manifest.metadata.plugin_api_version === "string" ? manifest.metadata.plugin_api_version : "1";
      if (apiVersion !== "1") {
        issues.push({ file_path: binding.manifest_file_path, code: "version_incompatible", message: `plugin API version ${apiVersion} is incompatible with Host API version 1` });
        continue;
      }
      if (!importModule) {
        const listed = await runPluginWorker({ mode: "list", entrypoint: binding.entrypoint_path, timeoutMs: options.timeoutMs ?? 5_000, memoryLimitMb: options.memoryLimitMb ?? 64 }).catch((error) => {
          issues.push({ file_path: binding.manifest_file_path, code: "entrypoint_load_failed", message: error instanceof Error ? error.message : String(error) });
          return undefined;
        });
        if (!listed) continue;
        const handlerIds = Array.isArray((listed as { handlers?: unknown }).handlers) ? (listed as { handlers: unknown[] }).handlers.filter((id): id is string => typeof id === "string") : [];
        const registeredHandlerIds = binding.handler_ids.filter((handlerId) => handlerIds.includes(handlerId));
        for (const handlerId of registeredHandlerIds) {
          this.registerHandler(handlerId, async (handlerInput) => {
            try {
              return await runPluginWorker({ mode: "execute", entrypoint: binding.entrypoint_path!, handlerId, input: handlerInput, timeoutMs: options.timeoutMs ?? 5_000, memoryLimitMb: options.memoryLimitMb ?? 64 }) as PluginActionHandlerOutput;
            } catch (error) {
              return { status: "failed", error: error instanceof Error ? error.message : String(error) };
            }
          });
        }
        if (registeredHandlerIds.length === 0) {
          issues.push({ file_path: binding.manifest_file_path, code: "invalid_entrypoint_module", message: `plugin entrypoint did not export handlers for manifest ${binding.manifest_id}` });
          continue;
        }
        loaded.push({ manifest_id: binding.manifest_id, entrypoint_path: binding.entrypoint_path, registered_handler_ids: registeredHandlerIds });
        continue;
      }
      let moduleExports: unknown;
      try {
        moduleExports = await importModule(pathToFileURL(binding.entrypoint_path).href);
      } catch (error) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "entrypoint_load_failed",
          message: error instanceof Error ? error.message : String(error)
        });
        continue;
      }
      const registeredHandlerIds = await this.registerEntrypointModuleHandlers(moduleExports, manifest, binding).catch((error) => {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "invalid_entrypoint_module",
          message: error instanceof Error ? error.message : String(error)
        });
        return [];
      });
      if (registeredHandlerIds.length === 0) {
        issues.push({
          file_path: binding.manifest_file_path,
          code: "invalid_entrypoint_module",
          message: `plugin entrypoint did not register handlers for manifest ${binding.manifest_id}`
        });
        continue;
      }
      loaded.push({
        manifest_id: binding.manifest_id,
        entrypoint_path: binding.entrypoint_path,
        registered_handler_ids: registeredHandlerIds
      });
    }

    return { loaded, issues };
  }

  private async registerEntrypointModuleHandlers(moduleExports: unknown, manifest: PluginManifest, binding: PluginRuntimeBinding): Promise<string[]> {
    const moduleRecord = asRecord(moduleExports);
    const defaultRecord = asRecord(moduleRecord?.default);
    const register = firstFunction(moduleRecord?.register, moduleRecord?.registerPlugin, defaultRecord?.register, defaultRecord?.registerPlugin);
    const before = new Set(this.handlers.keys());
    if (register) {
      await register(this, { manifest, binding });
    }
    const handlers = asRecord(moduleRecord?.handlers) ?? asRecord(defaultRecord?.handlers) ?? {};
    for (const [handlerId, handler] of Object.entries(handlers)) {
      if (binding.handler_ids.includes(handlerId) && typeof handler === "function") {
        this.registerHandler(handlerId, handler as PluginActionHandler);
      }
    }
    return uniqueStrings(binding.handler_ids.filter((handlerId) => this.handlers.has(handlerId) && !before.has(handlerId)));
  }
}

async function runPluginWorker(input: {
  mode: "list" | "execute";
  entrypoint: string;
  handlerId?: string;
  input?: unknown;
  timeoutMs: number;
  memoryLimitMb: number;
}): Promise<unknown> {
  const workerPath = path.resolve(process.cwd(), "packages/action-catalog/src/plugin-worker.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${Math.max(16, input.memoryLimitMb)}`, workerPath, input.mode, pathToFileURL(input.entrypoint).href, input.handlerId ?? ""], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" }
    });
    let stdout = "";
    let stderr = "";
    const maxOutput = 1_000_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`plugin_timeout:${input.timeoutMs}`));
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxOutput) {
        child.kill("SIGKILL");
        reject(new Error("plugin_output_limit_exceeded"));
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-8_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`plugin_process_failed:${code ?? signal ?? "unknown"}:${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "null"));
      } catch {
        reject(new Error("plugin_output_invalid_json"));
      }
    });
    child.stdin.end(JSON.stringify(input.input ?? {}));
  });
}

export async function loadPluginManifests(rootDir: string, options: PluginManifestLoadOptions = {}): Promise<PluginManifestLoadResult> {
  const manifestPaths = await findPluginManifestFiles(rootDir);
  const issues: PluginManifestLoadIssue[] = [];
  const manifests: PluginManifest[] = [...pluginManifests];
  const actions: ActionCatalogEntry[] = [...actionCatalogEntries];
  const renderers: SurfaceRendererRegistryEntry[] = manifests.flatMap((manifest) => manifest.renderers ?? []);
  const bindings: PluginRuntimeBinding[] = [];
  const manifestIds = new Set(manifests.map((manifest) => manifest.id));
  const actionIds = new Set(actions.map((action) => action.id));
  const rendererIds = new Set(renderers.map((renderer) => renderer.id));

  for (const manifestPath of manifestPaths) {
    const relativePath = path.relative(rootDir, manifestPath) || manifestPath;
    const raw = await readFile(manifestPath, "utf8").catch((error) => {
      issues.push({
        file_path: relativePath,
        code: "read_failed",
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    });
    if (raw === undefined) {
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (error) {
      issues.push({
        file_path: relativePath,
        code: "invalid_manifest",
        message: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    const parsed = PluginManifestSchema.safeParse(decoded);
    if (!parsed.success) {
      issues.push({
        file_path: relativePath,
        code: "invalid_manifest",
        message: parsed.error.message
      });
      continue;
    }
    const manifest = parsed.data;
    if (manifestIds.has(manifest.id)) {
      issues.push({
        file_path: relativePath,
        code: "duplicate_manifest",
        message: `duplicate plugin manifest id: ${manifest.id}`
      });
      continue;
    }
    const uniqueActions: ActionCatalogEntry[] = [];
    for (const action of manifest.actions) {
      if (actionIds.has(action.id)) {
        issues.push({
          file_path: relativePath,
          code: "duplicate_action",
          message: `duplicate action id: ${action.id}`
        });
        continue;
      }
      actionIds.add(action.id);
      uniqueActions.push(action);
    }
    manifestIds.add(manifest.id);
    const uniqueRenderers: SurfaceRendererRegistryEntry[] = [];
    for (const renderer of manifest.renderers ?? []) {
      if (rendererIds.has(renderer.id)) {
        issues.push({
          file_path: relativePath,
          code: "duplicate_renderer",
          message: `duplicate renderer id: ${renderer.id}`
        });
        continue;
      }
      rendererIds.add(renderer.id);
      uniqueRenderers.push(renderer);
    }
    const filteredManifest = { ...manifest, actions: uniqueActions, ...(manifest.renderers ? { renderers: uniqueRenderers } : {}) };
    const binding = await buildPluginRuntimeBinding(rootDir, manifestPath, relativePath, filteredManifest, issues, options);
    manifests.push(filteredManifest);
    actions.push(...uniqueActions);
    renderers.push(...uniqueRenderers);
    bindings.push(binding);
  }

  return { manifests, actions, renderers, bindings, issues };
}

async function findPluginManifestFiles(rootDir: string): Promise<string[]> {
  const direct = path.join(rootDir, ".codex-plugin", "plugin.json");
  const pluginsDir = path.join(rootDir, "plugins");
  const candidates = [direct];
  const pluginEntries = await readdir(pluginsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    candidates.push(path.join(pluginsDir, entry.name, "plugin.json"));
    candidates.push(path.join(pluginsDir, entry.name, ".codex-plugin", "plugin.json"));
  }
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing.sort((left, right) => left.localeCompare(right));
}

async function fileExists(filePath: string): Promise<boolean> {
  return readFile(filePath).then(() => true, () => false);
}

async function buildPluginRuntimeBinding(
  rootDir: string,
  manifestPath: string,
  relativePath: string,
  manifest: PluginManifest,
  issues: PluginManifestLoadIssue[],
  options: PluginManifestLoadOptions
): Promise<PluginRuntimeBinding> {
  const pluginDir = pluginRootForManifestPath(manifestPath);
  const binding: PluginRuntimeBinding = {
    manifest_id: manifest.id,
    manifest_file_path: relativePath,
    plugin_dir: path.relative(rootDir, pluginDir) || ".",
    entrypoint: manifest.entrypoint,
    entrypoint_status: manifest.entrypoint ? "missing" : "not_declared",
    signature_status: "not_declared",
    signature_key_id: pluginSignatureMetadata(manifest)?.key_id,
    action_ids: manifest.actions.map((action) => action.id),
      handler_ids: uniqueStrings(
        manifest.actions.flatMap((action) =>
          actionHasHandlerId(action) ? [action.handler_id] : [],
        ),
      ),
    renderer_ids: manifest.renderers?.map((renderer) => renderer.id) ?? []
  };

  const signature = verifyPluginManifestSignature(manifest, options.trustedSigningKeys ?? []);
  binding.signature_status = signature.status;
  if (signature.key_id) {
    binding.signature_key_id = signature.key_id;
  }
  if (options.requireSignature && signature.status !== "trusted") {
    issues.push({
      file_path: relativePath,
      code: signature.status === "invalid" ? "signature_invalid" : "signature_untrusted",
      message: `plugin manifest ${manifest.id} is not signed by a trusted key`
    });
  }

  if (!manifest.entrypoint) {
    return binding;
  }

  const resolved = resolvePluginEntrypointPath(pluginDir, manifest.entrypoint);
  if (!resolved) {
    binding.entrypoint_status = "outside_plugin";
    issues.push({
      file_path: relativePath,
      code: "entrypoint_outside_plugin",
      message: `plugin entrypoint must be a relative path inside ${binding.plugin_dir}`
    });
    return binding;
  }
  binding.entrypoint_path = resolved;
  const entrypointContent = await readFile(resolved).catch(() => undefined);
  if (!entrypointContent) {
    binding.entrypoint_status = "missing";
    issues.push({
      file_path: relativePath,
      code: "entrypoint_missing",
      message: `plugin entrypoint not found: ${manifest.entrypoint}`
    });
    return binding;
  }
  const actualHash = createHash("sha256").update(entrypointContent).digest("hex");
  binding.entrypoint_sha256 = actualHash;
  const expectedHash = entrypointExpectedHash(manifest);
  if (expectedHash) {
    binding.expected_entrypoint_sha256 = expectedHash;
    if (expectedHash !== actualHash) {
      binding.entrypoint_status = "integrity_mismatch";
      issues.push({
        file_path: relativePath,
        code: "entrypoint_integrity_mismatch",
        message: `plugin entrypoint sha256 mismatch for ${manifest.entrypoint}`
      });
      return binding;
    }
  }
  binding.entrypoint_status = "ready";
  return binding;
}

function pluginRootForManifestPath(manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath);
  return path.basename(manifestDir) === ".codex-plugin" ? path.dirname(manifestDir) : manifestDir;
}

function resolvePluginEntrypointPath(pluginDir: string, entrypoint: string): string | undefined {
  if (path.isAbsolute(entrypoint) || entrypoint.includes("://")) {
    return undefined;
  }
  const resolved = path.resolve(pluginDir, entrypoint);
  const relative = path.relative(pluginDir, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}

function entrypointExpectedHash(manifest: PluginManifest): string | undefined {
  const metadata = asRecord(manifest.metadata);
  const value = typeof metadata?.entrypoint_sha256 === "string"
    ? metadata.entrypoint_sha256
    : typeof metadata?.entrypoint_integrity === "string"
      ? metadata.entrypoint_integrity
      : undefined;
  if (!value) {
    return undefined;
  }
  return value.startsWith("sha256-") ? value.slice("sha256-".length) : value;
}

interface PluginSignatureMetadata {
  algorithm: "ed25519";
  key_id: string;
  signature: string;
}

function pluginSignatureMetadata(manifest: PluginManifest): PluginSignatureMetadata | undefined {
  const metadata = asRecord(manifest.metadata);
  const raw = asRecord(metadata?.plugin_signature);
  if (!raw) {
    return undefined;
  }
  if (raw.algorithm !== "ed25519" || typeof raw.key_id !== "string" || typeof raw.signature !== "string") {
    return undefined;
  }
  return {
    algorithm: "ed25519",
    key_id: raw.key_id,
    signature: raw.signature
  };
}

function verifyPluginManifestSignature(manifest: PluginManifest, trustedKeys: PluginTrustedSigningKey[]): { status: PluginSignatureStatus; key_id?: string } {
  const signature = pluginSignatureMetadata(manifest);
  if (!signature) {
    return { status: "not_declared" };
  }
  const trustedKey = trustedKeys.find((key) => key.key_id === signature.key_id);
  if (!trustedKey) {
    return { status: "untrusted_key", key_id: signature.key_id };
  }
  try {
    const publicKey = createPublicKey(trustedKey.public_key);
    const payload = Buffer.from(createPluginManifestSignaturePayload(manifest), "utf8");
    const ok = verifySignature(null, payload, publicKey, Buffer.from(signature.signature, "base64"));
    return { status: ok ? "trusted" : "invalid", key_id: signature.key_id };
  } catch {
    return { status: "invalid", key_id: signature.key_id };
  }
}

export function createPluginManifestSignaturePayload(manifest: PluginManifest): string {
  const normalized = PluginManifestSchema.parse(manifest);
  const metadata = { ...asRecord(normalized.metadata) };
  delete metadata.plugin_signature;
  return stableJsonStringify({ ...normalized, metadata });
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function firstFunction(...values: unknown[]): ((...args: unknown[]) => unknown) | undefined {
  return values.find((value): value is (...args: unknown[]) => unknown => typeof value === "function");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
