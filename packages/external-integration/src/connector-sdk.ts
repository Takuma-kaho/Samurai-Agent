import {
  ConnectorEventSchema,
  ConnectorManifestSchema,
  ExternalIntegrationError,
  type ConnectorEvent,
  type ConnectorManifest
} from "./contracts.js";

/** Small third-party Connector boundary. It deliberately exposes neither a
 * Workspace Store nor a database handle: a Connector may only normalize its
 * own Hook input into the common event contract. */
export interface ExternalConnectorAdapter {
  connectorId: string;
  normalizeHook(input: unknown): ConnectorEvent;
}

/** Reusable contract test for a Connector package. It checks only public
 * Manifest/Adapter behavior, so adding a Connector never requires Core code
 * changes or gives that package a path around Formal Workspace Ingress. */
export function verifyConnectorContract(input: {
  manifest: ConnectorManifest;
  adapter: ExternalConnectorAdapter;
  hookFixture: unknown;
}): { manifest: ConnectorManifest; event: ConnectorEvent } {
  const manifest = ConnectorManifestSchema.parse(input.manifest);
  if (input.adapter.connectorId !== manifest.connector_id) {
    throw new ExternalIntegrationError("connector_manifest_invalid", "connector_adapter_id_mismatch");
  }
  let event: ConnectorEvent;
  try {
    event = ConnectorEventSchema.parse(input.adapter.normalizeHook(input.hookFixture));
  } catch {
    throw new ExternalIntegrationError("connector_manifest_invalid", "connector_adapter_event_invalid");
  }
  if (event.connector_id !== manifest.connector_id) {
    throw new ExternalIntegrationError("connector_manifest_invalid", "connector_adapter_event_connector_mismatch");
  }
  return { manifest, event };
}
