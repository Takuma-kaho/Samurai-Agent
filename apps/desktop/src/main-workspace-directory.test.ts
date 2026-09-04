import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("Desktop Workspace directory identity status", () => {
  it("returns a setup explanation even when an identity-required Server has no local Workspace candidate", () => {
    const start = mainSource.indexOf("async function listWorkspaceDirectory()");
    const end = mainSource.indexOf("function directoryEntry(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const directorySource = mainSource.slice(start, end);

    expect(directorySource).toContain("workspaceIdentityRequiredMessage");
    expect(directorySource).toContain('directoryError(connection, "workspace_identity_required", workspaceIdentityRequiredMessage)');
    expect(directorySource).not.toContain("if (localTargets.length > 0) errors.push(directoryError(connection, \"workspace_identity_required\"");
  });

  it("keeps the permission-denied status separate from missing identity", () => {
    const start = mainSource.indexOf("function directoryEntry(");
    const end = mainSource.indexOf("function directoryError(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const entrySource = mainSource.slice(start, end);

    expect(entrySource).toContain('connectionStatus === "identity_required"');
    expect(entrySource).toContain('connectionStatus === "unauthorized"');
    expect(entrySource).toContain('"workspace_account_unauthorized"');
    expect(mainSource).not.toMatch(/console\.(log|error|warn).*privateKey/);
  });
});
