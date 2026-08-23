import { describe, expect, it } from "vitest";
import { ExternalAppContextResolver } from "./external-app-context-resolver";
import type { ExternalAppConnectionRecord } from "@samurai-agent/core-schemas";

const timestamp = "2026-08-23T00:00:00.000Z";

function connection(id: string, roomId: string): ExternalAppConnectionRecord {
  return {
    id,
    workspace_id: "workspace",
    connector_id: "connector-shared",
    app_id: "app-shared",
    status: "active",
    delegated_principal: { kind: "human", participant_id: "owner" },
    allowed_room_ids: [roomId],
    ingress_classes: ["query"],
    non_secret_metadata: {},
    created_by: { kind: "human", participant_id: "owner" },
    created_at: timestamp,
    updated_at: timestamp
  };
}

describe("ExternalAppContextResolver", () => {
  it("keeps the authenticated Connection ID through Room authorization", async () => {
    const connectionA = connection("connection-a", "room-a");
    const connectionB = connection("connection-b", "room-b");
    const resolver = new ExternalAppContextResolver({
      workspaceId: "workspace",
      connections: {
        getExternalAppConnection: async ({ connectionId }) => connectionId === connectionA.id ? connectionA : connectionB,
        getExternalAppConnectionByConnector: async () => connectionB
      },
      roomAuthorization: { assertRoom: async () => undefined }
    });

    const resolved = await resolver.resolve({
      evidence: { connector_id: "connector-shared", app_id: "app-shared" },
      target: { requested_room_id: "room-a", correlation_id: "connection-id-test", connection_id: connectionA.id },
      ingressClass: "query"
    });

    expect(resolved.connection.id).toBe(connectionA.id);
    expect(resolved.workspaceContext.connection_id).toBe(connectionA.id);
    expect(resolved.trustedContext.connectionId).toBe(connectionA.id);
  });

  it("fails closed when an exact Connection lookup is unavailable", async () => {
    const connectionA = connection("connection-a", "room-a");
    const resolver = new ExternalAppContextResolver({
      workspaceId: "workspace",
      connections: {
        getExternalAppConnectionByConnector: async () => connectionA
      } as never,
      roomAuthorization: { assertRoom: async () => undefined }
    });

    await expect(resolver.resolve({
      evidence: { connector_id: connectionA.connector_id, app_id: connectionA.app_id },
      target: { requested_room_id: "room-a", correlation_id: "missing-exact-lookup", connection_id: connectionA.id },
      ingressClass: "query"
    })).rejects.toMatchObject({ code: "external_app_connection_not_found" });
  });
});
