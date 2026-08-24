import { describe, expect, it, vi } from "vitest";

const loadWorkspaceServerConfig = vi.fn(() => ({
  bindAddress: "127.0.0.1",
  port: 4318,
  storageRoot: "/tmp/samurai-test-storage",
  databaseUrl: "postgres://test"
}));
const startWorkspaceServer = vi.fn(async (config: Record<string, unknown>) => ({
  config,
  close: vi.fn(async () => undefined)
}));

vi.mock("@samurai-agent/workspace-server", () => ({ loadWorkspaceServerConfig }));
vi.mock("./workspace-server/http-server", () => ({ startWorkspaceServer }));

const { installServerSignalHandlers, startServer } = await import("./index");

describe("standard server entry", () => {
  it("routes the public startServer entry to the PostgreSQL composition", async () => {
    const server = await startServer(4321);

    expect(loadWorkspaceServerConfig).toHaveBeenCalledOnce();
    expect(startWorkspaceServer).toHaveBeenCalledOnce();
    expect(startWorkspaceServer).toHaveBeenCalledWith({
      bindAddress: "127.0.0.1",
      port: 4321,
      storageRoot: "/tmp/samurai-test-storage",
      databaseUrl: "postgres://test"
    });
    expect(server.config).toMatchObject({ port: 4321 });
  });

  it("owns shutdown through the PostgreSQL server lifecycle", async () => {
    const close = vi.fn(async () => undefined);
    const remove = installServerSignalHandlers({ close } as never);
    process.emit("SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    remove();
    expect(close).toHaveBeenCalledOnce();
  });
});
