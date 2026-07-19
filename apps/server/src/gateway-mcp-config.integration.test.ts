import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeProviderAdapter } from "@samurai-agent/runtime";
import { closeApiServer, createApiServer, type ApiServer } from "./index.js";

let server: ApiServer | undefined;
let workspaceDataDir: string | undefined;

afterEach(async () => {
  if (server) await closeApiServer(server);
  if (workspaceDataDir) await rm(workspaceDataDir, { recursive: true, force: true });
  server = undefined;
  workspaceDataDir = undefined;
});

describe("Gateway MCP config API contract", () => {
  it("accepts and persists a valid stdio configuration through the domain operation", async () => {
    workspaceDataDir = await mkdtemp(path.join(tmpdir(), "samurai-gateway-mcp-"));
    server = await createApiServer({
      workspaceDataDir,
      automationScheduler: false,
      provider: new FakeProviderAdapter("fake/gateway-mcp", async () => ({ content: "Done.", toolCalls: [] }))
    });
    await new Promise<void>((resolve) => server?.httpServer.listen(0, "127.0.0.1", resolve));
    const address = server.httpServer.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/gateway/mcp-configs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "gateway-mcp-config-test"
      },
      body: JSON.stringify({
        id: "gateway_mcp_test",
        server_name: "test-server",
        transport: "stdio",
        enabled: true,
        allowed_tools: ["read_resource"],
        secret_refs: [],
        metadata: {},
        stdio: {
          command: "test-mcp-server",
          args: ["--stdio"],
          env: {},
          secret_env: {},
          secret_files: [],
          framing: "json_lines",
          initialize: true
        }
      })
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      id: "gateway_mcp_test",
      server_name: "test-server",
      transport: "stdio"
    });
    await expect(server.store.getGatewayMcpConfig("gateway_mcp_test")).resolves.toMatchObject({
      id: "gateway_mcp_test",
      stdio: { command: "test-mcp-server" }
    });
  });
});
