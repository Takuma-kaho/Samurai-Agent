import { afterEach, describe, expect, it, vi } from "vitest";
import { configureBrowserWorkspaceConnection } from "./workspace-browser-auth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Browser Workspace connection origin policy", () => {
  it("rejects non-loopback HTTP before any Account key operation", async () => {
    vi.stubGlobal("window", { crypto: { subtle: {} }, indexedDB: {} });

    for (const serverUrl of [
      "http://workspace.example/",
      "http://workspace.example:4318/",
      "http://127.0.0.1:4318/api",
      "https://workspace.example/path",
      "https://user:pass@workspace.example/"
    ]) {
      await expect(configureBrowserWorkspaceConnection({
        label: "Workspace",
        serverUrl,
        workspaceId: "workspace_1",
        accountId: "account_1",
        publicKey: "",
        privateKey: ""
      })).rejects.toThrow("workspace_server_url_invalid");
    }
  });
});
