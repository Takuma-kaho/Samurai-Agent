import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

describe("Desktop Workspace transfer coordination", () => {
  it("keeps the source begin contract while deriving retry-stable phase keys", () => {
    expect(mainSource).toContain('if (phase === "begin") return transferId;');
    expect(mainSource).toContain('createHash("sha256").update(`${transferId}:${phase}`)');

    for (const phase of ["manifest", "bundle", "import", "complete", "rollback"]) {
      expect(mainSource).toContain(`workspaceTransferPhaseOperationId(transferId, "${phase}")`);
    }
    expect(mainSource).toContain("workspaceTransferReceiptOperationId(transferId, receipt");
  });

  it("does not let a delayed authorization apply over a newer explicit selection", () => {
    const start = mainSource.indexOf("async function activateAuthorizedWorkspaceTarget(");
    const end = mainSource.indexOf("async function persistActiveWorkspaceSelection(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const activationSource = mainSource.slice(start, end);

    expect(activationSource).toContain("const selectionGeneration = ++workspaceSelectionGeneration;");
    expect(activationSource.indexOf("const authorization = await reauthorizeWorkspaceTarget")).toBeLessThan(
      activationSource.indexOf("upsertWorkspaceTarget(nextRegistry, target)")
    );
    expect((activationSource.match(/selectionGeneration !== workspaceSelectionGeneration/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("invalidates delayed authorization when an explicit connection has no target", () => {
    const start = mainSource.indexOf('ipcMain.handle("samurai:workspace-connections:select"');
    const end = mainSource.indexOf("const listWorkspaceDirectoryHandler", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const selectionSource = mainSource.slice(start, end);
    const invalidation = selectionSource.indexOf("workspaceSelectionGeneration += 1;");
    const registrySelection = selectionSource.indexOf("selectWorkspaceConnection(workspaceConnectionRegistry, selected.id)");

    expect(invalidation).toBeGreaterThanOrEqual(0);
    expect(invalidation).toBeLessThan(registrySelection);
  });

  it("resumes an exported or read-only source with receipt before complete", () => {
    const executeStart = mainSource.indexOf("async function executeWorkspaceTargetTransferOnce(");
    const resumeStart = mainSource.indexOf("if (resumableCutover) {", executeStart);
    const resumeEnd = mainSource.indexOf("const resumedStatus", resumeStart);
    expect(executeStart).toBeGreaterThanOrEqual(0);
    expect(resumeStart).toBeGreaterThan(executeStart);
    expect(resumeEnd).toBeGreaterThan(resumeStart);
    const resumeSource = mainSource.slice(resumeStart, resumeEnd);

    expect(resumeSource).toContain('if (preflight.sourceState !== "archived")');
    expect(resumeSource.indexOf('path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/receipt`')).toBeLessThan(
      resumeSource.indexOf('path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/complete`')
    );
    expect(resumeSource).toContain("workspaceTransferReceiptOperationId(transferId, receiptForResume)");
    expect(resumeSource).toContain('workspaceTransferPhaseOperationId(transferId, "complete")');
  });

  it("checks the source Status API before trusting a local restart checkpoint", () => {
    const executeStart = mainSource.indexOf("async function executeWorkspaceTargetTransferOnce(");
    const executeEnd = mainSource.indexOf("function workspaceTransferStatusInput(", executeStart);
    expect(executeStart).toBeGreaterThanOrEqual(0);
    expect(executeEnd).toBeGreaterThan(executeStart);
    const executeSource = mainSource.slice(executeStart, executeEnd);
    expect(mainSource).toContain("/transfers/${encodeURIComponent(transferId)}/status");
    expect(executeSource.indexOf("readWorkspaceSourceTransferStatus(")).toBeLessThan(
      executeSource.indexOf("const previousTransfer = workspaceTransferStatusById.get(transferId);")
    );
    for (const state of ["preparing", "exported", "imported", "committed", "rolled_back", "failed"]) {
      expect(mainSource).toContain(`sourceTransferStatus${state === "failed" || state === "rolled_back" ? ".state" : "?.state"} === "${state}"`);
    }
  });

  it("does not re-import or rollback a source already committed and archived", () => {
    const start = mainSource.indexOf("if (sourceCommittedArchived) {");
    const end = mainSource.indexOf("if (resumableCutover) {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const committedSource = mainSource.slice(start, end);
    expect(committedSource).toContain("authorizeWorkspaceTargetForTransition");
    expect(committedSource).toContain("commitWorkspaceTargetCutover");
    expect(committedSource).not.toContain('path: "/api/workspaces/imports"');
    expect(committedSource).not.toContain('path: `/api/workspaces/${encodeURIComponent(request.source.workspaceId)}/transfers/${encodeURIComponent(transferId)}/rollback`');
  });

  it("resends an import with the same operation after an unknown response", () => {
    const start = mainSource.indexOf("const importInput: WorkspaceServerRequestInput = {");
    const end = mainSource.indexOf("const importedWorkspaceId", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const importSource = mainSource.slice(start, end);
    expect(importSource).toContain("importOutcomeUnknown = true;");
    expect(importSource.match(/transferRequest\(destinationConnection, destinationKey, importInput/g)?.length).toBe(2);
    expect(mainSource.indexOf("importOutcomeUnknown = true;", start)).toBeLessThan(end);
    expect(mainSource).toContain("!importOutcomeUnknown && sourceKey && destinationKey");
    expect(mainSource).toContain('state: importOutcomeUnknown ? "restoring"');
  });

  it("derives receipt operation IDs from the target and both integrity hashes", () => {
    const helperStart = mainSource.indexOf("function workspaceTransferReceiptOperationId(");
    const helperEnd = mainSource.indexOf("interface WorkspaceTransferPreflight", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperSource = mainSource.slice(helperStart, helperEnd);
    expect(helperSource).toContain("receipt.target_workspace_id");
    expect(helperSource).toContain("receipt.source_integrity_hash");
    expect(helperSource).toContain("receipt.target_integrity_hash");
    expect(mainSource.match(/workspaceTransferReceiptOperationId\(transferId, receipt/g)?.length).toBeGreaterThanOrEqual(1);
    expect(mainSource).toContain("reconcileWorkspaceTransferReceipt(");
  });
});
