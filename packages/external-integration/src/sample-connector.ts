import { createHash } from "node:crypto";
import {
  ConnectorEventSchema,
  ConnectorManifestSchema,
  type ConnectorEvent,
  type ConnectorManifest
} from "./contracts.js";
import type { ExternalConnectorAdapter } from "./connector-sdk.js";

/** A test-only example for a third party package. It is never automatically
 * installed or published as a Samurai-owned Connector. */
export const sampleConnectorManifest: ConnectorManifest = ConnectorManifestSchema.parse({
  connector_id: "sample_connector",
  display_name: "Sample Connector",
  provider: "Example",
  version: "1.0.0",
  supported_os: ["darwin", "win32", "linux"],
  required_samurai_version: "^0.1.0",
  transport: "streamable_http",
  oauth_redirect_uris: ["https://sample.example/oauth/callback"],
  oauth_redirect_uri_policy: "exact",
  requested_scopes: ["workspace.read", "activity.ingest"],
  supported_events: ["sample.completed"],
  context_injection: "startup_tool",
  full_capture: "unsupported",
  url_elicitation: "fallback",
  package_checksum: `sha256:${createHash("sha256").update("samurai-server05-sample-connector:1.0.0").digest("hex")}`
});

/** The sample keeps only documented event identity. It demonstrates that an
 * Adapter normalizes provider input; it does not preserve a transcript or
 * receive a Workspace access capability. */
export const sampleConnectorAdapter: ExternalConnectorAdapter = {
  connectorId: "sample_connector",
  normalizeHook(input: unknown): ConnectorEvent {
    const value = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
    return ConnectorEventSchema.parse({
      connector_id: "sample_connector",
      connector_version: typeof value.version === "string" ? value.version : "1.0.0",
      event_id: typeof value.event_id === "string" ? value.event_id : "sample-event",
      event_kind: "sample.completed",
      external_session_id: typeof value.session_id === "string" ? value.session_id : "sample-session",
      app_id: "sample_connector",
      changed_resources: [],
      verification: "not_run",
      outcome: value.success === false ? "failed" : "completed",
      occurred_at: typeof value.occurred_at === "string" ? value.occurred_at : new Date(0).toISOString(),
      payload: { source: "sample_connector" }
    });
  }
};
