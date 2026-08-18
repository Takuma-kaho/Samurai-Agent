import {
  ConnectorInstallationSchema,
  ConnectorManifestSchema,
  ExternalIntegrationError,
  type ConnectorInstallation,
  type ConnectorManifest,
  type ExternalIntegrationAtomicMutation,
  type ExternalIntegrationStore,
  type ExternalOperatingSystem,
  type ExternalOAuthScope
} from "./contracts.js";
import { appendAuditEvent } from "./audit.js";
import { createHash, randomBytes } from "node:crypto";
import { satisfies, valid, validRange } from "semver";

export interface ConnectorRegistryOptions {
  store: ExternalIntegrationStore;
  samuraiVersion: string;
  now?: () => Date;
  id?: () => string;
}

export interface ConnectorCapabilityInfo {
  connectorId: string;
  version: string;
  supportedOs: ExternalOperatingSystem[];
  scopes: ExternalOAuthScope[];
  contextInjection: ConnectorManifest["context_injection"];
  fullCapture: ConnectorManifest["full_capture"];
  urlElicitation: ConnectorManifest["url_elicitation"];
  supportedEvents: string[];
}

const officialConnectorScopes: ExternalOAuthScope[] = [
  "workspace.read",
  "room.read",
  "knowledge.read",
  "skill.read",
  "artifact.read",
  "collection.read",
  "activity.read",
  "resource.write",
  "activity.ingest",
  "approval.execute",
  "room.binding.write"
];

/** Official Client manifests are a small built-in catalog, not a Plugin
 * marketplace.  Each Workspace still needs its own enabled Installation and
 * an active External App Connection before OAuth can issue a Grant. */
export function officialConnectorManifests(): ConnectorManifest[] {
  return [
    officialManifest({
      connector_id: "codex",
      display_name: "Codex",
      provider: "OpenAI",
      supported_events: ["SessionEnd"],
      context_injection: "server_instructions",
      full_capture: "partial",
      url_elicitation: "fallback",
      hook_command: "server:05:hook --client codex"
    }),
    officialManifest({
      connector_id: "claude_code",
      display_name: "Claude Code",
      provider: "Anthropic",
      supported_events: ["SessionStart", "SessionEnd"],
      context_injection: "startup_tool",
      full_capture: "partial",
      url_elicitation: "fallback",
      hook_command: "server:05:hook --client claude_code"
    }),
    officialManifest({
      connector_id: "hermes",
      display_name: "Hermes",
      provider: "Hermes",
      supported_events: ["on_session_start", "on_session_end"],
      context_injection: "startup_tool",
      full_capture: "partial",
      hook_command: "server:05:hook --client hermes",
      url_elicitation: "unsupported"
    })
  ];
}

export async function registerOfficialConnectorManifests(registry: ConnectorRegistry): Promise<ConnectorManifest[]> {
  // SQLite self-hosts may serialize writers. Startup registration is tiny and
  // intentionally sequential so one manifest cannot make another look like a
  // transient installation failure.
  const registered: ConnectorManifest[] = [];
  for (const manifest of officialConnectorManifests()) {
    registered.push(await registry.registerManifest(manifest));
  }
  return registered;
}

/** Connector packages only declare capabilities. They do not receive Store or
 * database handles; all data access remains behind the server ports. */
export class ConnectorRegistry {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: ConnectorRegistryOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `installation_${randomBytes(16).toString("hex")}`);
  }

  async registerManifest(input: ConnectorManifest): Promise<ConnectorManifest> {
    const manifest = ConnectorManifestSchema.parse(input);
    if (!valid(manifest.version)) {
      throw new ExternalIntegrationError("connector_version_unsupported", "connector_manifest_version_invalid");
    }
    if (!isVersionSatisfied(this.options.samuraiVersion, manifest.required_samurai_version)) {
      throw new ExternalIntegrationError("connector_version_unsupported");
    }
    const current = await this.options.store.getRecord("connector_manifest", manifest.connector_id);
    if (!current) {
      const saved = await this.options.store.createRecord("connector_manifest", manifest);
      await appendAuditEvent(this.options.store, { eventType: "connector.manifest.registered", connectorId: manifest.connector_id, resourceType: "connector_manifest", resourceId: manifest.connector_id, data: { version: manifest.version, package_checksum: manifest.package_checksum } });
      return saved;
    }
    if (current.package_checksum !== manifest.package_checksum || current.version !== manifest.version) {
      const version = await this.options.store.getRecordVersion("connector_manifest", manifest.connector_id);
      if (!version || !await this.options.store.updateRecord("connector_manifest", manifest.connector_id, version, manifest)) {
        throw new ExternalIntegrationError("connector_manifest_invalid", "connector_manifest_version_conflict");
      }
      await appendAuditEvent(this.options.store, { eventType: "connector.manifest.updated", connectorId: manifest.connector_id, resourceType: "connector_manifest", resourceId: manifest.connector_id, data: { version: manifest.version, package_checksum: manifest.package_checksum } });
      return manifest;
    }
    return current;
  }

  async install(input: { workspaceId: string; connectorId: string; version: string }): Promise<ConnectorInstallation> {
    const manifest = await this.options.store.getRecord("connector_manifest", input.connectorId);
    if (!manifest || manifest.disabled_at) throw new ExternalIntegrationError("connector_manifest_invalid");
    if (manifest.version !== input.version) throw new ExternalIntegrationError("connector_version_unsupported");
    const existing = (await this.options.store.listRecords("connector_installation", { workspaceId: input.workspaceId, connectorId: input.connectorId }))
      .sort((left, right) => right.installed_at.localeCompare(left.installed_at))[0];
    if (existing?.enabled && !existing.disabled_at && existing.version === input.version && existing.package_checksum === manifest.package_checksum) return existing;
    if (existing && existing.version === input.version && existing.package_checksum === manifest.package_checksum) {
      if (existing.enabled) return existing;
      return this.setEnabled(existing.id, true);
    }
    const installation = ConnectorInstallationSchema.parse({
      id: this.id(),
      workspace_id: input.workspaceId,
      connector_id: input.connectorId,
      version: input.version,
      package_checksum: manifest.package_checksum,
      enabled: true,
      installed_at: this.now().toISOString()
    });
    const mutations: ExternalIntegrationAtomicMutation[] = [];
    if (existing?.enabled && !existing.disabled_at) {
      const existingVersion = await this.options.store.getRecordVersion("connector_installation", existing.id);
      if (!existingVersion) throw new ExternalIntegrationError("connector_manifest_invalid", "connector_installation_version_conflict");
      mutations.push({
        kind: "update",
        type: "connector_installation",
        id: existing.id,
        expectedVersion: existingVersion,
        record: ConnectorInstallationSchema.parse({ ...existing, enabled: false, disabled_at: this.now().toISOString() })
      });
    }
    mutations.push({ kind: "create", type: "connector_installation", record: installation });
    if (!await this.options.store.atomic(mutations)) {
      const raced = (await this.options.store.listRecords("connector_installation", { workspaceId: input.workspaceId, connectorId: input.connectorId }))
        .filter((candidate) => candidate.enabled && !candidate.disabled_at)
        .sort((left, right) => right.installed_at.localeCompare(left.installed_at))[0];
      if (raced && raced.version === input.version && raced.package_checksum === manifest.package_checksum) return raced;
      throw new ExternalIntegrationError("connector_manifest_invalid", "connector_installation_version_conflict");
    }
    const saved = installation;
    if (existing?.enabled) {
      await appendAuditEvent(this.options.store, {
        eventType: "connector.installation.disabled",
        workspaceId: existing.workspace_id,
        connectorId: existing.connector_id,
        resourceType: "connector_installation",
        resourceId: existing.id,
        data: { version: existing.version, reason: "upgrade" }
      });
    }
    await appendAuditEvent(this.options.store, { eventType: "connector.installation.created", workspaceId: input.workspaceId, connectorId: input.connectorId, resourceType: "connector_installation", resourceId: saved.id, data: { version: saved.version } });
    return saved;
  }

  async getInstallation(id: string): Promise<ConnectorInstallation | undefined> {
    return this.options.store.getRecord("connector_installation", id);
  }

  async getManifest(connectorId: string): Promise<ConnectorManifest | undefined> {
    return this.options.store.getRecord("connector_manifest", connectorId);
  }

  async listInstallations(input: { workspaceId: string; connectorId?: string }): Promise<ConnectorInstallation[]> {
    return this.options.store.listRecords("connector_installation", input)
      .then((items) => items.sort((left, right) => right.installed_at.localeCompare(left.installed_at)));
  }

  async setEnabled(id: string, enabled: boolean): Promise<ConnectorInstallation> {
    const installation = await this.options.store.getRecord("connector_installation", id);
    if (!installation) throw new ExternalIntegrationError("connector_manifest_invalid");
    if (enabled) {
      const manifest = await this.options.store.getRecord("connector_manifest", installation.connector_id);
      if (!manifest || manifest.disabled_at) throw new ExternalIntegrationError("connector_disabled");
      if (manifest.version !== installation.version || manifest.package_checksum !== installation.package_checksum) {
        throw new ExternalIntegrationError("connector_version_unsupported", "connector_installation_requires_upgrade");
      }
      const activeSibling = (await this.options.store.listRecords("connector_installation", {
        workspaceId: installation.workspace_id,
        connectorId: installation.connector_id
      })).find((candidate) => candidate.id !== installation.id && candidate.enabled && !candidate.disabled_at);
      if (activeSibling) throw new ExternalIntegrationError("connector_manifest_invalid", "connector_installation_version_conflict");
    }
    const version = await this.options.store.getRecordVersion("connector_installation", id);
    if (!version) throw new ExternalIntegrationError("connector_manifest_invalid");
    const next = ConnectorInstallationSchema.parse({ ...installation, enabled, ...(enabled ? { disabled_at: undefined } : { disabled_at: this.now().toISOString() }) });
    if (!await this.options.store.atomic([{ kind: "update", type: "connector_installation", id, expectedVersion: version, record: next }])) {
      throw new ExternalIntegrationError("connector_manifest_invalid", "connector_installation_version_conflict");
    }
    await appendAuditEvent(this.options.store, { eventType: enabled ? "connector.installation.enabled" : "connector.installation.disabled", workspaceId: installation.workspace_id, connectorId: installation.connector_id, resourceType: "connector_installation", resourceId: installation.id, data: { version: next.version } });
    return next;
  }

  async getCapabilities(input: { workspaceId: string; connectorId: string }): Promise<ConnectorCapabilityInfo> {
    const connectorId = input.connectorId;
    const manifest = await this.options.store.getRecord("connector_manifest", connectorId);
    if (!manifest || manifest.disabled_at) throw new ExternalIntegrationError("connector_disabled");
    const installations = (await this.options.store.listRecords("connector_installation", { workspaceId: input.workspaceId, connectorId }))
      .sort((left, right) => right.installed_at.localeCompare(left.installed_at));
    const installation = installations.find((candidate) => candidate.enabled
      && !candidate.disabled_at
      && candidate.version === manifest.version
      && candidate.package_checksum === manifest.package_checksum);
    if (!installation) throw new ExternalIntegrationError("connector_disabled");
    return {
      connectorId: manifest.connector_id,
      version: manifest.version,
      supportedOs: manifest.supported_os,
      scopes: manifest.requested_scopes,
      contextInjection: manifest.context_injection,
      fullCapture: manifest.full_capture,
      urlElicitation: manifest.url_elicitation,
      supportedEvents: manifest.supported_events
    };
  }
}

function officialManifest(input: Pick<ConnectorManifest,
  "connector_id" | "display_name" | "provider" | "supported_events" | "context_injection" | "full_capture" | "url_elicitation" | "hook_command"
>): ConnectorManifest {
  const version = "1.0.0";
  return ConnectorManifestSchema.parse({
    ...input,
    version,
    supported_os: ["darwin", "win32", "linux"],
    required_samurai_version: "^0.1.0",
    transport: "streamable_http",
    // DCR may register a localhost callback for an official Client. The
    // accepted URI becomes that Client's exact immutable redirect URI.
    oauth_redirect_uris: [],
    oauth_redirect_uri_policy: "loopback",
    requested_scopes: officialConnectorScopes,
    package_checksum: `sha256:${createHash("sha256").update(`samurai-server05-official-connector:${input.connector_id}:${version}`).digest("hex")}`
  });
}

function isVersionSatisfied(current: string, required: string): boolean {
  const currentVersion = valid(current);
  const requiredRange = validRange(required);
  return Boolean(currentVersion && requiredRange && satisfies(currentVersion, requiredRange, { includePrerelease: true }));
}
