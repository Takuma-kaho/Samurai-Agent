import { describe, expect, it } from "vitest";
import { createOrganizationApi, type OrganizationApiTransport, type OrganizationApiTransportRequest } from "./organization-api";

describe("organization API client", () => {
  it("uses the organization REST prefix and normalizes access projections", async () => {
    const calls: OrganizationApiTransportRequest[] = [];
    const transport: OrganizationApiTransport = async <T>(request: OrganizationApiTransportRequest) => {
      calls.push(request);
      if (request.path === "/api/organizations") {
        return {
          organizations: [{ id: "org_1", name: "Samurai", membership_role: "owner", workspace_count: 2 }]
        } as T;
      }
      if (request.path === "/api/organizations/org_1/workspaces") {
        return {
          workspaces: [
            { id: "ws_1", organization_id: "org_1", name: "Granted", has_access: true },
            { id: "ws_2", organization_id: "org_1", name: "Private", has_access: false, state: "archived" }
          ]
        } as T;
      }
      return {} as T;
    };

    const client = createOrganizationApi(transport);
    await expect(client.listOrganizations()).resolves.toEqual([
      expect.objectContaining({ id: "org_1", role: "owner", workspaceCount: 2 })
    ]);
    await expect(client.listWorkspaces("org_1")).resolves.toEqual([
      expect.objectContaining({ id: "ws_1", access: "granted", state: "active" }),
      expect.objectContaining({ id: "ws_2", access: "none", state: "archived" })
    ]);

    expect(calls.map((call) => call.path)).toEqual([
      "/api/organizations",
      "/api/organizations/org_1/workspaces"
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("adds an idempotent create request without putting credentials in the contract", async () => {
    const calls: OrganizationApiTransportRequest[] = [];
    const transport: OrganizationApiTransport = async <T>(request: OrganizationApiTransportRequest) => {
      calls.push(request);
      return { id: "org_created", name: "Created", role: "owner" } as T;
    };

    const client = createOrganizationApi(transport);
    await client.createOrganization({ name: "Created" });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/organizations",
      body: { name: "Created" }
    });
    expect(calls[0]!.operationId).toEqual(expect.any(String));
    expect(calls[0]!.idempotencyKey).toBe(calls[0]!.operationId);
    expect(calls[0]).not.toHaveProperty("authorization");
  });

  it("uses the Electron preload when it is available", async () => {
    const calls: Array<{ method: string; input?: Record<string, unknown> }> = [];
    const desktop = {
      listOrganizations: async () => [{ id: "org_desktop", name: "Desktop", status: "active" }],
      createOrganization: async (input: Record<string, unknown>) => {
        calls.push({ method: "createOrganization", input });
        return { id: "org_created", name: "Created", status: "active" };
      },
      setOrganizationWorkspaceLifecycle: async (input: Record<string, unknown>) => {
        calls.push({ method: "setOrganizationWorkspaceLifecycle", input });
        return { id: "ws_1", organization_id: "org_desktop", name: "Project", state: "archived", can_access: true };
      },
      exportOrganizationWorkspaceBundle: async (input: Record<string, unknown>) => {
        calls.push({ method: "exportOrganizationWorkspaceBundle", input });
        return { bundle_id: "bundle_desktop", workspace_id: "ws_1", source_organization_id: "org_desktop" };
      },
      restoreOrganizationBundle: async (input: Record<string, unknown>) => {
        calls.push({ method: "restoreOrganizationBundle", input });
        return { bundle_id: "bundle_desktop", workspace_id: "ws_1", target_organization_id: "org_desktop", status: "restored" };
      }
    };
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { samuraiDesktop: desktop } });
    try {
      const client = createOrganizationApi();
      await expect(client.listOrganizations()).resolves.toEqual([expect.objectContaining({ id: "org_desktop" })]);
      await client.createOrganization({ name: "Created" });
      await client.archiveWorkspace("org_desktop", "ws_1");
      await client.exportWorkspaceBundle("org_desktop", "ws_1", 2);
      await client.restoreOrganizationBundle("org_desktop", "bundle_desktop");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
    }

    expect(calls[0]!).toMatchObject({ method: "createOrganization", input: { name: "Created", operationId: expect.any(String) } });
    expect(calls[1]!).toMatchObject({ method: "setOrganizationWorkspaceLifecycle", input: { organizationId: "org_desktop", workspaceId: "ws_1", lifecycle: "archive", confirm: true } });
    expect(calls[2]!).toMatchObject({ method: "exportOrganizationWorkspaceBundle", input: { organizationId: "org_desktop", workspaceId: "ws_1", expectedWorkspaceVersion: 2, operationId: expect.any(String) } });
    expect(calls[3]!).toMatchObject({ method: "restoreOrganizationBundle", input: { organizationId: "org_desktop", bundleId: "bundle_desktop", confirm: true, operationId: expect.any(String) } });
  });

  it("exports a workspace bundle and restores it into an explicit target organization", async () => {
    const calls: OrganizationApiTransportRequest[] = [];
    const transport: OrganizationApiTransport = async <T>(request: OrganizationApiTransportRequest) => {
      calls.push(request);
      if (request.path.endsWith("/bundle/export")) {
        return {
          bundle_id: "bundle_1",
          workspace_id: "ws_1",
          source_organization_id: "org_source",
          schema_version: 1,
          integrity_hash: "sha256:abc",
          file_count: 3,
          byte_size: 1200,
          manifest: { record_counts: { rooms: 1 } },
          created_at: "2026-08-31T00:00:00.000Z"
        } as T;
      }
      return {
        bundle_id: "bundle_1",
        workspace_id: "ws_1",
        source_organization_id: "org_source",
        target_organization_id: "org_target",
        status: "restored",
        restored_at: "2026-08-31T00:01:00.000Z"
      } as T;
    };

    const client = createOrganizationApi(transport);
    await expect(client.exportWorkspaceBundle("org_source", "ws_1", 4)).resolves.toMatchObject({
      bundleId: "bundle_1",
      sourceOrganizationId: "org_source",
      integrityHash: "sha256:abc",
      fileCount: 3
    });
    await expect(client.restoreOrganizationBundle("org_target", "bundle_1")).resolves.toMatchObject({
      bundleId: "bundle_1",
      targetOrganizationId: "org_target",
      status: "restored"
    });

    expect(calls).toMatchObject([
      {
        method: "POST",
        path: "/api/organizations/org_source/workspaces/ws_1/bundle/export",
        body: { expected_workspace_version: 4 }
      },
      {
        method: "POST",
        path: "/api/organizations/org_target/bundles/restore",
        body: { bundle_id: "bundle_1", confirm: true }
      }
    ]);
  });
});
