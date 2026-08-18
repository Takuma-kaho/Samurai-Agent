import {
  ConnectorEventSchema,
  ExternalIntegrationError,
  hashCanonicalJson,
  type ConnectorEvent,
  type ExternalClientKind,
  type ExternalOperatingSystem
} from "./contracts.js";
import { redactExternalText, redactExternalValue } from "./capture.js";

export interface ExternalClientHookConfig {
  configPath(os: ExternalOperatingSystem): string;
  /** Configuration only references the local hook relay. Access tokens and
   * endpoint URLs stay in the OS-managed hook environment, never this file. */
  renderConfig(input: { projectRef: string; os?: ExternalOperatingSystem; relayCommand?: string; connectorVersion?: string }): string;
}

export interface ExternalClientAdapter {
  client: Exclude<ExternalClientKind, "other" | "opencode" | "openclaw">;
  configPath(os: ExternalOperatingSystem): string;
  renderConfig(input: { serverUrl: string; projectRef: string; workspaceId?: string }): string;
  hookConfig?: ExternalClientHookConfig;
  startupInstruction(): string;
  normalizeHook(input: unknown): ConnectorEvent;
}

export function getExternalClientAdapter(client: ExternalClientAdapter["client"]): ExternalClientAdapter {
  if (client === "codex") return codexAdapter;
  if (client === "claude_code") return claudeAdapter;
  return hermesAdapter;
}

const codexAdapter: ExternalClientAdapter = {
  client: "codex",
  configPath: (os) => os === "win32" ? ".codex\\config.toml (project)" : ".codex/config.toml (project)",
  renderConfig: ({ serverUrl, projectRef, workspaceId }) => [
    "[mcp_servers.samurai]",
    `url = ${tomlString(serverUrlForProject(serverUrl, projectRef, workspaceId))}`,
    "auth = \"oauth\"",
    "enabled = true",
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 60"
  ].join("\n") + "\n",
  hookConfig: {
    configPath: (os) => os === "win32" ? ".codex\\hooks.json (project)" : ".codex/hooks.json (project)",
    renderConfig: ({ projectRef, relayCommand, connectorVersion }) => JSON.stringify({
      description: "Samurai structured Activity and optional Capture relay. Credentials are supplied only by the local secure environment.",
      hooks: {
        SessionEnd: [{
          hooks: [{
            type: "command",
            command: hookCommand("codex", projectRef, "SessionEnd", relayCommand, connectorVersion),
            commandWindows: hookCommandWindows("codex", projectRef, "SessionEnd", relayCommand, connectorVersion),
            timeout: 3,
            async: true
          }]
        }]
      }
    }, null, 2) + "\n"
  },
  startupInstruction: () => "At session start, call samurai.context.snapshot. The installed project configuration supplies the Room Binding and external session. The optional Hook relay needs its URL and OAuth token in the local secret environment, never in this project file.",
  normalizeHook: (input) => normalizeCodexHook(input)
};

const claudeAdapter: ExternalClientAdapter = {
  client: "claude_code",
  configPath: (os) => os === "win32" ? ".mcp.json (project)" : ".mcp.json (project)",
  renderConfig: ({ serverUrl, projectRef, workspaceId }) => JSON.stringify({
    mcpServers: {
      samurai: { type: "http", url: serverUrlForProject(serverUrl, projectRef, workspaceId) }
    }
  }, null, 2) + "\n",
  hookConfig: {
    configPath: (os) => os === "win32" ? ".claude\\settings.local.json (project)" : ".claude/settings.local.json (project)",
    renderConfig: ({ projectRef, relayCommand, connectorVersion }) => JSON.stringify({
      hooks: {
        SessionEnd: [{
          hooks: [{
            type: "command",
            command: hookCommand("claude_code", projectRef, "SessionEnd", relayCommand, connectorVersion),
            timeout: 3,
            async: true
          }]
        }]
      }
    }, null, 2) + "\n"
  },
  startupInstruction: () => "Use samurai.context.snapshot before reading detailed resources; the project configuration already fixes the Room Binding. The optional Hook relay needs its URL and OAuth token in the local secret environment, never in this project file.",
  normalizeHook: (input) => normalizeClaudeCodeHook(input)
};

const hermesAdapter: ExternalClientAdapter = {
  client: "hermes",
  configPath: (os) => os === "win32" ? "%USERPROFILE%\\.hermes\\config.yaml" : "~/.hermes/config.yaml",
  renderConfig: ({ serverUrl, projectRef, workspaceId }) => [
    "mcp_servers:",
    "  samurai:",
    `    url: ${yamlString(serverUrlForProject(serverUrl, projectRef, workspaceId))}`,
    "    auth: oauth",
    "    tools:",
    "      include:",
    "        - samurai.capabilities",
    "        - samurai.context.snapshot",
    "        - samurai.knowledge.search",
    "        - samurai.knowledge.read",
    "        - samurai.skill.search",
    "        - samurai.skill.read",
    "        - samurai.artifact.list",
    "        - samurai.artifact.read",
    "        - samurai.collection.list",
    "        - samurai.collection.read",
    "        - samurai.activity.list",
    "        - samurai.activity.read",
    "        - samurai.activity.ingest"
  ].join("\n") + "\n",
  hookConfig: {
    configPath: (os) => os === "win32" ? "%USERPROFILE%\\.hermes\\config.yaml" : "~/.hermes/config.yaml",
    renderConfig: ({ projectRef, os, relayCommand, connectorVersion }) => [
      "hooks:",
      "  on_session_start:",
      `    - command: ${yamlString(os === "win32" ? hookCommandWindows("hermes", projectRef, "on_session_start", relayCommand, connectorVersion) : hookCommand("hermes", projectRef, "on_session_start", relayCommand, connectorVersion))}`,
      "      timeout: 3",
      "  on_session_end:",
      `    - command: ${yamlString(os === "win32" ? hookCommandWindows("hermes", projectRef, "on_session_end", relayCommand, connectorVersion) : hookCommand("hermes", projectRef, "on_session_end", relayCommand, connectorVersion))}`,
      "      timeout: 3"
    ].join("\n") + "\n"
  },
  startupInstruction: () => "Fetch the Samurai Context Snapshot as the first MCP operation for each new session; the project configuration already fixes the Room Binding. Hermes shell Hooks send structured Activity and optional Capture through the local relay; credentials remain in the secure environment.",
  normalizeHook: (input) => normalizeHermesHook(input)
};

/** Codex publishes a stable hook event name and session ID. Keep only the
 * stable structural fields in Activity. Raw Hook input is Capture-only and
 * redacted before it can be retained. */
function normalizeCodexHook(input: unknown): ConnectorEvent {
  const value = recordValue(input);
  return normalizedEvent(value, "codex", {
    eventKind: stringValue(value.hook_event_name) ?? stringValue(value.event_kind) ?? "hook.event",
    sessionId: stringValue(value.session_id) ?? stringValue(value.external_session_id),
    providerEventId: stringValue(value.event_id) ?? stringValue(value.turn_id),
    instruction: stringValue(value.prompt) ?? stringValue(value.instruction),
    result: stringValue(value.result) ?? stringValue(value.output),
    payload: publicHookPayload(value, ["hook_event_name", "turn_id", "cwd", "model", "tool_name", "permission_mode"])
  });
}

/** Claude Code command/HTTP Hooks send a JSON event on stdin/body. Use the
 * documented session/event fields, not best-effort transcript parsing. */
function normalizeClaudeCodeHook(input: unknown): ConnectorEvent {
  const value = recordValue(input);
  return normalizedEvent(value, "claude_code", {
    eventKind: stringValue(value.hook_event_name) ?? stringValue(value.event_name) ?? stringValue(value.event_kind) ?? "hook.event",
    sessionId: stringValue(value.session_id) ?? stringValue(value.external_session_id),
    providerEventId: stringValue(value.event_id) ?? stringValue(value.turn_id),
    instruction: stringValue(value.prompt) ?? stringValue(value.instruction),
    result: stringValue(value.result) ?? stringValue(value.output),
    payload: publicHookPayload(value, ["hook_event_name", "session_id", "cwd", "tool_name", "tool_use_id", "agent_id", "transcript_path"])
  });
}

/** Hermes shell Hooks provide a documented JSON envelope. Preserve only the
 * stable lifecycle fields; tool input and transcript-like values remain
 * Capture-only and are not copied into Activity. */
function normalizeHermesHook(input: unknown): ConnectorEvent {
  const value = recordValue(input);
  return normalizedEvent(value, "hermes", {
    eventKind: stringValue(value.hook_event_name) ?? stringValue(value.event_kind) ?? "hook.event",
    sessionId: stringValue(value.external_session_id) ?? stringValue(value.session_id),
    providerEventId: stringValue(value.event_id),
    instruction: stringValue(value.instruction) ?? stringValue(value.user_message),
    result: stringValue(value.result) ?? stringValue(value.assistant_response),
    payload: publicHookPayload(value, ["hook_event_name", "event_kind", "session_id", "external_session_id", "cwd", "tool_name"])
  });
}

function normalizedEvent(source: Record<string, unknown>, client: "codex" | "claude_code" | "hermes", input: {
  eventKind: string;
  sessionId?: string;
  providerEventId?: string;
  instruction?: string;
  result?: string;
  payload: Record<string, unknown>;
}): ConnectorEvent {
  const now = new Date().toISOString();
  const eventKind = `${client}.${input.eventKind}`;
  const externalSessionId = input.sessionId ?? "unknown-session";
  const identity = {
    client,
    event_kind: eventKind,
    external_session_id: externalSessionId,
    ...(input.providerEventId ? { provider_event_id: input.providerEventId } : {}),
    payload: input.payload
  };
  const failure = stringValue(source.failure) ?? stringValue(source.error);
  return ConnectorEventSchema.parse({
    connector_id: client,
    connector_version: stringValue(source.connector_version) ?? stringValue(source.version) ?? "unknown",
    event_id: input.providerEventId ?? `hook_${hashCanonicalJson(identity).slice(0, 32)}`,
    event_kind: eventKind,
    external_session_id: externalSessionId,
    app_id: client,
    instruction: input.instruction ? redactExternalText(input.instruction) : undefined,
    result: input.result ? redactExternalText(input.result) : undefined,
    changed_resources: arrayStrings(source.changed_resources),
    verification: source.verification === "confirmed" || source.verification === "failed" || source.verification === "not_run" ? source.verification : "not_run",
    ...(failure ? { failure: redactExternalText(failure) } : {}),
    outcome: explicitOutcome(source),
    occurred_at: stringValue(source.occurred_at) ?? now,
    payload: { source_client: client, hook: input.payload }
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function publicHookPayload(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, redactExternalValue(value[key], key)]]));
}

function explicitOutcome(value: Record<string, unknown>): "completed" | "failed" | "cancelled" | "unknown" {
  if (value.outcome === "completed" || value.outcome === "failed" || value.outcome === "cancelled") return value.outcome;
  if (value.success === true) return "completed";
  if (value.success === false) return "failed";
  return "unknown";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function hookCommand(client: "codex" | "claude_code" | "hermes", projectRef: string, event: string, relayCommand?: string, connectorVersion?: string): string {
  return `${requiredRelayCommand(relayCommand)} --client ${client} --project-ref ${shellQuote(projectRef)} --event ${event}${versionArgument(connectorVersion)} --capture`;
}

function hookCommandWindows(client: "codex" | "claude_code" | "hermes", projectRef: string, event: string, relayCommand?: string, connectorVersion?: string): string {
  return `${requiredRelayCommand(relayCommand)} --client ${client} --project-ref ${windowsQuote(projectRef)} --event ${event}${versionArgument(connectorVersion, true)} --capture`;
}

function versionArgument(value: string | undefined, windows = false): string {
  const version = value?.trim();
  if (!version || /[\r\n]/.test(version)) return "";
  return ` --connector-version ${windows ? windowsQuote(version) : shellQuote(version)}`;
}

function requiredRelayCommand(value: string | undefined): string {
  const command = value?.trim();
  if (!command || /[\r\n]/.test(command)) throw new ExternalIntegrationError("mcp_invalid_arguments", "hook_relay_command_required");
  return command;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '\\\"')}"`;
}

function serverUrlForProject(serverUrl: string, projectRef: string, workspaceId?: string): string {
  const url = new URL(serverUrl);
  url.searchParams.set("project_ref", projectRef);
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
  return url.toString();
}
