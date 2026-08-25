import { describe, expect, it } from "vitest";
import { externalIntegrationRequestWorkspaceId, isPostgresExternalIntegrationPath } from "./postgres-external-integration";

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

  it("pins self-host requests regardless of client-supplied tenant fields", () => {
    expect(externalIntegrationRequestWorkspaceId({ headers: { "x-samurai-workspace-id": "spoofed" }, body: { workspace_id: "spoofed-body" } }, { mode: "self_host", selfHostWorkspaceId: "workspace-pinned" })).toBe("workspace-pinned");
  });
});
