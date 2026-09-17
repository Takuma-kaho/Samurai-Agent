import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { PostgresWorkspaceShareImportCoreAdapter, createPostgresWorkspaceShareImportWorker } from "./share-import-worker-adapter";

const maintenanceContext = {
  workspaceId: "workspace-one",
  accountId: "maintenance-one",
  operationId: "worker-tick-one"
};

const lease = {
  operation_id: "operation-one",
  kind: "agent" as const,
  phase: "fetch" as const,
  lease_token: "lease-one",
  lease_until: "2026-09-17T00:00:30.000Z",
  request_hash: "a".repeat(64),
  content_hash: "b".repeat(64),
  source_origin: "https://source.example/",
  source_locator: "L".repeat(43),
  claim_id: "claim-one",
  target_room_id: null,
  reserved_agent_id: "agent-reserved",
  reserved_resource_ids: []
};

function service() {
  return {
    claimNextImport: vi.fn(async () => ({ lease, recipientAccountId: "recipient-one" })),
    recheckImportTarget: vi.fn(async () => undefined),
    executeImportLease: vi.fn(async () => ({ status: "committed" as const })),
    heartbeatImport: vi.fn(async () => lease),
    settleImportWorker: vi.fn(async () => undefined)
  };
}

describe("PostgresWorkspaceShareImportCoreAdapter", () => {
  it("claims with maintenance context but runs target, heartbeat, execute, and settle as the persisted recipient", async () => {
    const mocked = service();
    const adapter = new PostgresWorkspaceShareImportCoreAdapter(mocked);
    const claim = await adapter.claim({
      context: maintenanceContext,
      workerId: "worker-one",
      leaseMs: 30_000,
      now: "2026-09-17T00:00:00.000Z",
      signal: new AbortController().signal
    });
    expect(claim).toMatchObject({
      importId: "operation-one",
      operationId: "operation-one",
      workspaceId: "workspace-one",
      recipientAccountId: "recipient-one",
      kind: "agent",
      targetRoomId: null,
      leaseToken: "lease-one"
    });

    await adapter.recheckTarget({ claim: claim!, signal: new AbortController().signal });
    await adapter.heartbeat({ claim: claim!, leaseMs: 30_000, now: "2026-09-17T00:00:00.000Z" });
    await adapter.execute({ claim: claim!, signal: new AbortController().signal, heartbeat: async () => undefined });
    await adapter.settle({ claim: claim!, result: { status: "committed" }, now: "2026-09-17T00:00:00.000Z" });

    expect(mocked.claimNextImport).toHaveBeenCalledWith(maintenanceContext, expect.objectContaining({ workerId: "worker-one", leaseMs: 30_000 }));
    const recipient = { workspaceId: "workspace-one", accountId: "recipient-one", operationId: "operation-one" };
    expect(mocked.recheckImportTarget).toHaveBeenCalledWith(recipient, "operation-one");
    expect(mocked.heartbeatImport).toHaveBeenCalledWith(recipient, { operation_id: "operation-one", lease_token: "lease-one" });
    expect(mocked.executeImportLease).toHaveBeenCalledWith(recipient, { operation_id: "operation-one", lease_token: "lease-one" }, expect.any(Function));
    expect(mocked.settleImportWorker).toHaveBeenCalledWith(recipient, {
      operation_id: "operation-one",
      lease_token: "lease-one",
      result: { status: "committed" }
    });
    expect(mocked.executeImportLease.mock.calls[0]?.[1]).not.toHaveProperty("delegation");
  });

  it("turns a missing process capability into a retryable result without pretending to commit", async () => {
    const mocked = service();
    mocked.executeImportLease.mockRejectedValueOnce(new WorkspaceServerError("authorization_refresh_required", 409));
    const adapter = new PostgresWorkspaceShareImportCoreAdapter(mocked);
    const claim = {
      importId: "operation-one",
      operationId: "operation-one",
      workspaceId: "workspace-one",
      recipientAccountId: "recipient-one",
      kind: "agent" as const,
      targetRoomId: null,
      leaseToken: "lease-one"
    };
    await expect(adapter.execute({ claim, signal: new AbortController().signal, heartbeat: async () => undefined })).resolves.toEqual({
      status: "retryable",
      failureCode: "authorization_refresh_required"
    });
  });

  it("uses the fixed 30 second lease and 10 second heartbeat defaults in the worker factory", async () => {
    const mocked = service();
    mocked.claimNextImport.mockResolvedValueOnce(null);
    const worker = createPostgresWorkspaceShareImportWorker({ service: mocked, now: () => new Date("2026-09-17T00:00:00.000Z") });
    await worker.runTick(maintenanceContext, { workerId: "worker-one", maxRuns: 1, signal: new AbortController().signal });
    expect(mocked.claimNextImport).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ leaseMs: 30_000 }));
  });
});
