/**
 * Client-side relay used by the project Hook configurations generated for
 * Server 05. It deliberately has no Workspace or database access: it accepts
 * a documented Client Hook envelope on stdin and sends it to the authenticated
 * Activity/Capture HTTP entrances.
 *
 * Required local secret environment (never written into a project config):
 * - SAMURAI_EXTERNAL_HOOK_URL   e.g. https://samurai.example
 * - SAMURAI_EXTERNAL_HOOK_TOKEN OAuth access token with activity.ingest
 */
// This relay is invoked through the Server 05 project script, so resolve the
// local package source without depending on a globally linked workspace name.
import { getExternalClientAdapter, type ExternalClientAdapter } from "../packages/external-integration/src/index.ts";

type Client = ExternalClientAdapter["client"];

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const raw = await readStdin();
  if (!raw.trim()) return report({ accepted: false, reason: "hook_input_empty" });
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return report({ accepted: false, reason: "hook_input_json_invalid" });
  }
  const adapter = getExternalClientAdapter(options.client);
  const event = adapter.normalizeHook({
    ...(record(payload)),
    event_kind: options.event,
    ...(options.connectorVersion ? { connector_version: options.connectorVersion } : {})
  });
  if (event.external_session_id === "unknown-session") {
    return report({ accepted: false, reason: "hook_session_id_unavailable" });
  }
  const baseUrl = process.env.SAMURAI_EXTERNAL_HOOK_URL;
  const token = process.env.SAMURAI_EXTERNAL_HOOK_TOKEN;
  if (!baseUrl || !token) {
    return report({ accepted: false, reason: "hook_secret_environment_missing" });
  }
  const request = {
    project_ref: options.projectRef,
    event
  };
  const activity = await post(baseUrl, "/connector/activity", token, request);
  if (!activity.ok) return report({ accepted: false, reason: `activity_delivery_failed_${activity.status}` });

  // Capture is opt-in at both ends. The relay sends only the Hook envelope;
  // it never reads an unstable transcript path or terminal history itself.
  if (options.capture) {
    const capture = await post(baseUrl, "/connector/capture", token, {
      project_ref: options.projectRef,
      external_session_id: event.external_session_id,
      event_id: event.event_id,
      kind: "intermediate_log",
      payload: record(payload)
    });
    if (!capture.ok) return report({ accepted: true, capture: `delivery_failed_${capture.status}` });
    return report({ accepted: true, capture: "submitted" });
  }
  return report({ accepted: true });
}

function parseOptions(values: string[]): { client: Client; projectRef: string; event: string; connectorVersion?: string; capture: boolean } {
  let client: Client | undefined;
  let projectRef: string | undefined;
  let event = "hook.event";
  let connectorVersion: string | undefined;
  let capture = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--client") client = asClient(values[++index]);
    else if (value === "--project-ref") projectRef = nonEmpty(values[++index]);
    else if (value === "--event") event = nonEmpty(values[++index]) ?? event;
    else if (value === "--connector-version") connectorVersion = nonEmpty(values[++index]);
    else if (value === "--capture") capture = true;
  }
  if (!client || !projectRef) throw new Error("hook_arguments_require_client_and_project_ref");
  return { client, projectRef, event, ...(connectorVersion ? { connectorVersion } : {}), capture };
}

function asClient(value: string | undefined): Client | undefined {
  return value === "codex" || value === "claude_code" || value === "hermes" ? value : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function post(baseUrl: string, pathname: string, token: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  const url = new URL(pathname, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2_500)
  });
  return { ok: response.ok, status: response.status };
}

function report(value: Record<string, unknown>): void {
  // Hook output is intentionally small and never includes a token, endpoint,
  // raw Hook input, or server response body.
  process.stdout.write(`${JSON.stringify({ samurai_hook: value })}\n`);
}

main().catch((error) => {
  report({ accepted: false, reason: error instanceof Error ? error.message : "hook_relay_failed" });
  // A telemetry failure must never block the external Client's own work.
  process.exitCode = 0;
});
