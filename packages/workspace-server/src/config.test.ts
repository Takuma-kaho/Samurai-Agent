import { describe, expect, it } from "vitest";
import { loadWorkspaceServerConfig, resolveRequestWorkspaceId } from "./config";

const common = {
  SAMURAI_DATABASE_URL: "postgresql://runtime@example.test/samurai",
  SAMURAI_DATABASE_RUNTIME_ROLE: "samurai_app",
  SAMURAI_INVITATION_TOKEN_SECRET: "01234567890123456789012345678901",
  SAMURAI_WORKSPACE_STORAGE_ROOT: "/tmp/samurai-workspaces"
};

describe("Workspace Server configuration", () => {
  it("keeps hosted Workspace selection explicit", () => {
    const config = loadWorkspaceServerConfig({ ...common, SAMURAI_SERVER_MODE: "hosted" });
    expect(config.selfHostBootstrapMode).toBe("create");
    expect(resolveRequestWorkspaceId(config, "workspace_team")).toBe("workspace_team");
    expect(() => resolveRequestWorkspaceId(config, undefined)).toThrow("workspace_id_required");
  });

  it("accepts a Self-host server without a fixed Workspace and resolves the requested Workspace", () => {
    const config = loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "self_host",
      SAMURAI_SELF_HOST_BOOTSTRAP_MODE: "empty"
    });
    expect(config.selfHostBootstrapMode).toBe("empty");
    expect(resolveRequestWorkspaceId(config, "workspace_other")).toBe("workspace_other");
    expect(() => resolveRequestWorkspaceId(config, undefined)).toThrow("workspace_id_required");
  });

  it("keeps the legacy Self-host Workspace ID as optional bootstrap input only", () => {
    const config = loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "self_host",
      SAMURAI_SELF_HOST_WORKSPACE_ID: "workspace_legacy"
    });
    expect(config.selfHostWorkspaceId).toBe("workspace_legacy");
    expect(resolveRequestWorkspaceId(config, "workspace_other")).toBe("workspace_other");
  });

  it("requires a sufficiently long invitation-token secret", () => {
    expect(() => loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "hosted",
      SAMURAI_INVITATION_TOKEN_SECRET: "too-short"
    })).toThrow("samurai_invitation_token_secret_too_short");
  });

  it("does not allow an admin database URL in the long-running Server process", () => {
    expect(() => loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "hosted",
      SAMURAI_DATABASE_ADMIN_URL: "postgresql://owner@example.test/samurai"
    })).toThrow("samurai_database_admin_url_forbidden_at_runtime");
  });

  it("requires a fixed HTTPS public base URL before it issues public invitation links", () => {
    expect(() => loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "hosted",
      SAMURAI_SERVER_PUBLIC: "1",
      SAMURAI_BIND_ADDRESS: "0.0.0.0",
      SAMURAI_CORS_ORIGINS: "https://app.samurai.example"
    })).toThrow("samurai_public_base_url_required");
    const config = loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "hosted",
      SAMURAI_SERVER_PUBLIC: "1",
      SAMURAI_BIND_ADDRESS: "0.0.0.0",
      SAMURAI_CORS_ORIGINS: "https://app.samurai.example",
      SAMURAI_PUBLIC_BASE_URL: "https://server.samurai.example/"
    });
    expect(config.publicBaseUrl).toBe("https://server.samurai.example");
    expect(() => loadWorkspaceServerConfig({
      ...common,
      SAMURAI_SERVER_MODE: "hosted",
      SAMURAI_PUBLIC_BASE_URL: "http://server.samurai.example"
    })).toThrow("samurai_public_base_url_invalid");
  });
});
