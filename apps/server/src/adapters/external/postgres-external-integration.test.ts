import { describe, expect, it } from "vitest";
import { externalIntegrationRequestWorkspaceId, isPostgresExternalIntegrationPath, resolveExternalIntegrationPublicBaseUrl } from "./postgres-external-integration";

describe("PostgreSQL external integration boundary", () => {
  it("routes only the external protocol paths to the integration handler", () => {
    expect(isPostgresExternalIntegrationPath("/mcp")).toBe(true);
    expect(isPostgresExternalIntegrationPath("/oauth/authorize")).toBe(true);
    expect(isPostgresExternalIntegrationPath("/connectors/slack")).toBe(true);
    expect(isPostgresExternalIntegrationPath("/connector/slack/hook")).toBe(true);
    expect(isPostgresExternalIntegrationPath("/api/workspaces/workspace-1/chat/sessions")).toBe(false);
  });

  it("takes a hosted tenant only from explicit request data", () => {
    expect(externalIntegrationRequestWorkspaceId({ headers: { "x-samurai-workspace-id": "workspace-header" }, body: { workspace_id: "workspace-body" } }, { mode: "hosted" })).toBe("workspace-header");
    expect(externalIntegrationRequestWorkspaceId({ query: { workspace_id: "workspace-query" } }, { mode: "hosted" })).toBe("workspace-query");
    expect(externalIntegrationRequestWorkspaceId({ body: { input: { workspaceId: "workspace-nested" } } }, { mode: "hosted" })).toBe("workspace-nested");
    expect(externalIntegrationRequestWorkspaceId({ body: { room_id: "room-only" } }, { mode: "hosted" })).toBeUndefined();
  });

  it("uses explicit Workspace data for Self-host requests instead of a deployment-wide pin", () => {
    const config = { mode: "self_host" as const, selfHostWorkspaceId: "workspace-legacy" };
    expect(externalIntegrationRequestWorkspaceId({ headers: { "x-samurai-workspace-id": "workspace-requested" }, body: { workspace_id: "workspace-body" } }, config)).toBe("workspace-requested");
    expect(externalIntegrationRequestWorkspaceId({ body: { workspace_id: "workspace-body" } }, config)).toBe("workspace-body");
    expect(externalIntegrationRequestWorkspaceId({ body: { room_id: "room-only" } }, config)).toBeUndefined();
  });

  it("uses a loopback origin for a non-public Self-host container fallback", () => {
    expect(resolveExternalIntegrationPublicBaseUrl({
      mode: "self_host",
      publicNetwork: false,
      bindAddress: "0.0.0.0",
      port: 4318
    })).toBe("http://127.0.0.1:4318");
    expect(resolveExternalIntegrationPublicBaseUrl({
      mode: "self_host",
      publicNetwork: false,
      bindAddress: "0.0.0.0",
      port: 4318,
      publicBaseUrl: "https://server.example.test"
    })).toBe("https://server.example.test");
  });
});
