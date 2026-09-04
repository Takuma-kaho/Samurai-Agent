import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { accountIdFromPublicKey } from "./auth";
import { WorkspaceServerStore } from "./workspace-server-store";

describe("WorkspaceServerStore Workspace-first core", () => {
  it("registers an Account without creating an implicit Organization", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    const accountId = accountIdFromPublicKey(publicKeyPem);
    const queries: string[] = [];
    const store = storeWithQuery(async (text) => {
      queries.push(text);
      if (text.includes("SELECT id, public_key, display_name")) {
        return {
          rows: [{
            id: accountId,
            public_key: publicKeyPem,
            display_name: "Standalone owner",
            created_at: "2026-09-02T00:00:00.000Z",
            updated_at: "2026-09-02T00:00:00.000Z"
          }]
        };
      }
      return { rows: [] };
    });

    const account = await store.registerAccount({ id: accountId, publicKey: publicKeyPem, displayName: "Standalone owner" });

    expect(account.id).toBe(accountId);
    expect(queries.some((text) => text.includes("samurai_create_organization"))).toBe(false);
  });

  it("creates a standalone Workspace through the normal create operation", async () => {
    const workspaceId = "workspace_store_standalone";
    const operationId = "operation_store_standalone_create";
    const workspaceRow = {
      id: workspaceId,
      organization_id: null,
      name: "Standalone Workspace",
      state: "active" as const,
      hosting_mode: "hosted" as const,
      storage_namespace: `workspaces/${workspaceId}`,
      database_placement: "shared" as const,
      version: 1,
      created_at: "2026-09-02T00:00:00.000Z",
      updated_at: "2026-09-02T00:00:00.000Z"
    };
    const createCalls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = storeWithQuery(async (text, values) => {
      createCalls.push({ text, values });
      if (text.includes("INSERT INTO account_operations")) return { rows: [{ id: operationId }] };
      if (text.includes("FROM workspaces WHERE id = $1")) return { rows: [workspaceRow] };
      return { rows: [] };
    });

    const result = await store.createWorkspace({
      id: workspaceId,
      name: workspaceRow.name,
      ownerAccountId: "account_store_owner",
      operationId
    });

    expect(result.workspace).toMatchObject({ id: workspaceId, name: workspaceRow.name, role: "owner" });
    expect(result.workspace).not.toHaveProperty("organizationId");
    expect(createCalls.some(({ text, values }) => text.includes("samurai_create_workspace") && values?.length === 6)).toBe(true);
  });

  it("creates an Organization Workspace standalone before explicitly attaching it", async () => {
    const organizationId = "organization_store_create_target";
    const workspaceId = "workspace_store_org_create";
    const context = {
      accountId: "account_store_owner",
      operationId: "operation_store_org_create",
      requestId: "request_store_org_create"
    };
    const createdWorkspace = {
      id: workspaceId,
      name: "Organization Workspace",
      state: "active" as const,
      hostingMode: "hosted" as const,
      storageNamespace: `workspaces/${workspaceId}`,
      databasePlacement: "shared" as const,
      version: 1,
      role: "owner" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z"
    };
    const store = storeWithQuery(async () => ({ rows: [] }));
    const create = vi.spyOn(store, "createWorkspace").mockResolvedValue({
      workspace: createdWorkspace,
      defaultRoom: {
        id: "room_store_org_create",
        workspaceId,
        name: "General",
        version: 1,
        createdAt: createdWorkspace.createdAt,
        updatedAt: createdWorkspace.updatedAt
      },
      replayed: false
    });
    const attach = vi.spyOn(store, "attachWorkspaceToOrganization").mockResolvedValue({
      workspace: {
        organizationId,
        workspaceId,
        name: createdWorkspace.name,
        state: createdWorkspace.state,
        hasAccess: true,
        workspaceRole: "owner",
        version: 2,
        createdAt: createdWorkspace.createdAt,
        updatedAt: createdWorkspace.updatedAt
      },
      organizationId,
      addedGuestAccountIds: ["account_store_member"],
      eventId: "42",
      replayed: false
    });

    const result = await store.createOrganizationWorkspace(context, { organizationId, name: createdWorkspace.name });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("id");
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("organizationId");
    expect(attach).toHaveBeenCalledWith(context, {
      organizationId,
      workspaceId,
      expectedWorkspaceVersion: createdWorkspace.version
    });
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(attach.mock.invocationCallOrder[0]!);
    expect(result).toMatchObject({ organizationId, workspaceId, replayed: false });
  });

  it("appends a public Event with NULL Organization provenance for standalone Workspaces", async () => {
    const eventRow = {
      id: 1,
      workspace_id: "workspace_store_event",
      room_id: null,
      kind: "workspace.changed",
      record_type: null,
      record_id: null,
      operation_id: "operation_store_event",
      payload: "{\"ok\":true}",
      created_at: "2026-09-02T00:00:00.000Z",
      event_id: "event_store_standalone",
      event_version: "1.0",
      actor_kind: "system" as const,
      actor_id: null,
      organization_id: null,
      cursor: "cursor_store_standalone",
      correlation_id: "operation_store_event",
      resources: []
    };
    const store = storeWithQuery(async (text) => {
      if (text.includes("SELECT organization_id FROM workspaces")) return { rows: [{ organization_id: null }] };
      if (text.includes("INSERT INTO workspace_events")) return { rows: [eventRow] };
      if (text.includes("samurai_can_workspace")) return { rows: [{ allowed: true }] };
      return { rows: [] };
    });

    const result = await store.appendPublicEvent(
      { workspaceId: eventRow.workspace_id, accountId: "account_store_owner", operationId: eventRow.operation_id },
      {
        eventId: eventRow.event_id,
        eventType: eventRow.kind,
        actor: { kind: "system" },
        payload: { ok: true }
      }
    );

    expect(result.replayed).toBe(false);
    expect(result.event.scope).toMatchObject({ workspaceId: eventRow.workspace_id });
    expect(result.event.scope).not.toHaveProperty("organizationId");
  });

  it("attaches and detaches atomically while preserving Workspace membership", async () => {
    const organizationId = "organization_store_target";
    const workspaceId = "workspace_store_association";
    let workspaceOrganizationId: string | null = null;
    let workspaceVersion = 1;
    const moveCalls: Array<readonly unknown[]> = [];
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = storeWithQuery(async (text, values) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO organization_operations")) return { rows: [{ id: String(values?.[1] ?? "operation") }] };
      // A plain SELECT is visible through the Workspace read policy, while
      // SELECT ... FOR UPDATE is filtered by the UPDATE policy in PostgreSQL.
      // Return an empty result for the latter so this regression test fails
      // if either association path starts taking a row lock again.
      if (text.includes("FROM workspaces WHERE id = $1 FOR UPDATE")) {
        return { rows: [] };
      }
      if (text.includes("FROM workspaces WHERE id = $1")) {
        return { rows: [{
          id: workspaceId,
          organization_id: workspaceOrganizationId,
          name: "Association Workspace",
          state: "active" as const,
          version: workspaceVersion,
          created_at: "2026-09-02T00:00:00.000Z",
          updated_at: "2026-09-02T00:00:00.000Z"
        }] };
      }
      if (text.includes("samurai_can_workspace")) return { rows: [{ allowed: true }] };
      if (text.includes("SELECT samurai_move_workspace_organization")) {
        moveCalls.push(values ?? []);
        workspaceOrganizationId = (values?.[1] as string | null) ?? null;
        workspaceVersion += 1;
        return { rows: [{ result: {
          workspace_id: workspaceId,
          source_organization_id: values?.[0] ?? null,
          target_organization_id: values?.[1] ?? null,
          added_guest_account_ids: ["account_store_member"],
          event_id: 42
        } }] };
      }
      if (text.includes("SELECT role FROM workspace_members")) return { rows: [{ role: "owner" }] };
      return { rows: [] };
    });
    const context = { accountId: "account_store_owner", operationId: "operation_store_attach", requestId: "request_store_attach" };

    const attached = await store.attachWorkspaceToOrganization(context, { organizationId, workspaceId });
    expect(attached.workspace.organizationId).toBe(organizationId);
    expect(attached.addedGuestAccountIds).toEqual(["account_store_member"]);
    expect(attached.workspace.workspaceRole).toBe("owner");

    const detached = await store.detachWorkspaceFromOrganization(
      { ...context, operationId: "operation_store_detach" },
      { organizationId, workspaceId }
    );
    expect(detached.workspace).not.toHaveProperty("organizationId");
    expect(detached.previousOrganizationId).toBe(organizationId);
    expect(moveCalls).toEqual([
      [null, organizationId, workspaceId, 1, "operation_store_attach"],
      [organizationId, null, workspaceId, 2, "operation_store_detach"]
    ]);
    expect(queries.filter(({ text }) => text.includes("FROM workspaces WHERE id = $1 FOR UPDATE"))).toHaveLength(0);
    expect(queries.filter(({ text }) => text === "SAVEPOINT samurai_organization_operation_action")).toHaveLength(2);
  });

  it("returns Organization deletion from the SECURITY DEFINER wrapper when RLS hides the deleted row", async () => {
    const organizationId = "organization_store_delete";
    const operationId = "operation_store_delete";
    const queries: string[] = [];
    const store = storeWithQuery(async (text) => {
      queries.push(text);
      if (text.includes("INSERT INTO organization_operations")) return { rows: [{ id: operationId }] };
      // The preflight Organization read must stay non-locking: with the
      // runtime RLS policy, SELECT ... FOR UPDATE would hide the row.
      if (text.includes("SELECT version FROM organizations") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("SELECT version FROM organizations")) return { rows: [{ version: 1 }] };
      if (text.includes("FROM samurai_delete_organization_and_return")) return { rows: [{
        id: organizationId,
        name: "Deleted Organization",
        icon: null,
        description: null,
        created_by: "account_store_owner",
        version: 2,
        created_at: "2026-09-02T00:00:00.000Z",
        updated_at: "2026-09-02T00:01:00.000Z",
        deleted_at: "2026-09-02T00:01:00.000Z"
      }] };
      // A normal post-delete SELECT is hidden by the Organization RLS policy.
      // The Store must use the SECURITY DEFINER projection above instead of
      // trying to read the soft-deleted row again.
      if (text.includes("SELECT id, name, icon, description, created_by") && text.includes("FROM organizations WHERE id = $1")) return { rows: [] };
      return { rows: [] };
    });

    const deleted = await store.deleteOrganization(
      { accountId: "account_store_owner", operationId, requestId: "request_store_delete" },
      { organizationId }
    );

    expect(deleted).toMatchObject({ id: organizationId, deletedAt: "2026-09-02T00:01:00.000Z" });
    expect(queries.some((text) => text.includes("SELECT version FROM organizations") && text.includes("FOR UPDATE"))).toBe(false);
    expect(queries.some((text) => text.includes("FROM samurai_delete_organization_and_return($1, $2, $3)"))).toBe(true);
    expect(queries.some((text) => text.includes("SELECT id, name, icon, description, created_by") && text.includes("FROM organizations WHERE id = $1"))).toBe(false);
    expect(queries.some((text) => text.includes("DELETE FROM workspaces"))).toBe(false);
  });

  it("replays a failed transfer phase only with the same hash and explicit opt-in", async () => {
    const operationId = "operation_store_transfer_retry";
    const context = { workspaceId: "workspace_store_transfer", accountId: "account_store_owner", operationId };
    const request = { action: "workspace.transfer.begin", input: { transferId: "transfer_store_retry", phase: "begin" } };
    let inserted = false;
    let status = "";
    let requestHash = "";
    let actionCalls = 0;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) {
        if (inserted) return { rows: [] };
        inserted = true;
        status = "running";
        requestHash = String(values?.[3]);
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return { rows: [{ request_hash: requestHash, status, result: status === "completed" ? { ok: true } : null }] };
      }
      if (text.includes("SELECT transfer_action")) {
        actionCalls += 1;
        if (actionCalls === 1) throw new Error("transient transfer failure");
        return { rows: [] };
      }
      if (text.includes("SET status = 'running'")) {
        status = "running";
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SET status = 'failed'")) {
        status = "failed";
        return { rows: [] };
      }
      if (text.includes("SET status = 'completed'")) {
        status = "completed";
        return { rows: [] };
      }
      if (text.includes("FROM workspace_members")) return { rows: [] };
      return { rows: [] };
    });
    const action = async (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => {
      await sql.query("SELECT transfer_action");
      return { ok: true };
    };

    await expect(store.runTransferIdempotent(context, request, action)).rejects.toThrow("transient transfer failure");
    await expect(store.runTransferIdempotent(context, {
      ...request,
      input: { ...request.input, phase: "different" }
    }, action)).rejects.toThrow("workspace_operation_id_reused");
    expect(actionCalls).toBe(1);

    await expect(store.runTransferIdempotent(context, request, action)).resolves.toEqual({ ok: true });
    await expect(store.runTransferIdempotent(context, request, action)).resolves.toEqual({ ok: true });
    expect(actionCalls).toBe(2);
  });

  it("allows only the explicit transfer replay actions", async () => {
    const context = {
      workspaceId: "workspace_store_transfer_allowlist",
      accountId: "account_store_owner",
      operationId: "operation_store_transfer_allowlist"
    };
    const store = storeWithQuery(async () => ({ rows: [] }));
    const action = async () => ({ ok: true });

    for (const actionName of [
      "workspace.transfer.export",
      "workspace.transfer.begin.extra",
      "workspace.transfer.receipt/unsafe"
    ]) {
      await expect(store.runTransferIdempotent(context, {
        action: actionName,
        input: { transferId: "transfer_store_allowlist" }
      }, action)).rejects.toThrow("workspace_transfer_replay_not_allowed");
    }
  });

  it("reopens a completed begin ledger only for a terminal transfer", async () => {
    const operationId = "operation_store_completed_begin_retry";
    const context = {
      workspaceId: "workspace_store_completed_begin",
      accountId: "account_store_owner",
      operationId
    };
    const request = {
      action: "workspace.transfer.begin",
      input: { transferId: "transfer_store_completed_begin", destination: "/tmp/old-bundle" }
    };
    let inserted = false;
    let operationStatus = "";
    let requestHash = "";
    let transferState = "exported";
    let sourceState = "active";
    let actionCalls = 0;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) {
        if (inserted) return { rows: [] };
        inserted = true;
        operationStatus = "running";
        requestHash = String(values?.[3]);
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return {
          rows: [{
            request_hash: requestHash,
            status: operationStatus,
            result: operationStatus === "completed" ? { transferId: request.input.transferId } : null
          }]
        };
      }
      // RLS exposes the transfer row to SELECT but hides it from
      // SELECT ... FOR UPDATE because callers have no UPDATE policy.
      // Simulate that distinction so the same-operation retry regresses if
      // the terminal-state probe starts requesting a row lock again.
      if (text.includes("SELECT state FROM workspace_transfers") && text.includes("FOR UPDATE")) return { rows: [] };
      if (text.includes("SELECT state FROM workspace_transfers")) return { rows: [{ state: transferState }] };
      if (text.includes("SET status = 'running'")) {
        operationStatus = "running";
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("samurai_begin_workspace_transfer")) {
        actionCalls += 1;
        transferState = "preparing";
        sourceState = "read_only";
        return { rows: [] };
      }
      if (text.includes("SET status = 'completed'")) {
        operationStatus = "completed";
        return { rows: [] };
      }
      return { rows: [] };
    });
    const action = async (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => {
      await sql.query("SELECT samurai_begin_workspace_transfer($1, $2)");
      return { transferId: request.input.transferId };
    };

    await expect(store.runTransferIdempotent(context, request, action)).resolves.toEqual({ transferId: request.input.transferId });
    // The export failed and the transfer rollback path made the source active.
    transferState = "rolled_back";
    sourceState = "active";
    await expect(store.runTransferIdempotent(context, request, action)).resolves.toEqual({ transferId: request.input.transferId });
    await expect(store.runTransferIdempotent(context, request, action)).resolves.toEqual({ transferId: request.input.transferId });

    expect(actionCalls).toBe(2);
    expect(sourceState).toBe("read_only");
    expect(transferState).toBe("preparing");
  });

  it("keeps an ordinary failed operation terminal", async () => {
    const operationId = "operation_store_regular_failure";
    const context = { workspaceId: "workspace_store_regular", accountId: "account_store_owner", operationId };
    const request = { action: "workspace.record.put", input: { id: "record_store_failure" } };
    let inserted = false;
    let status = "";
    let requestHash = "";
    let actionCalls = 0;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) {
        if (inserted) return { rows: [] };
        inserted = true;
        status = "running";
        requestHash = String(values?.[3]);
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return { rows: [{ request_hash: requestHash, status, result: null }] };
      }
      if (text.includes("SELECT regular_action")) {
        actionCalls += 1;
        throw new Error("regular failure");
      }
      if (text.includes("SET status = 'failed'")) {
        status = "failed";
        return { rows: [] };
      }
      if (text.includes("FROM workspace_members")) return { rows: [] };
      return { rows: [] };
    });
    const action = async (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => {
      await sql.query("SELECT regular_action");
      return { ok: true };
    };

    await expect(store.runIdempotent(context, request, action)).rejects.toThrow("regular failure");
    await expect(store.runIdempotent(context, request, action)).rejects.toThrow("workspace_operation_previously_failed");
    expect(actionCalls).toBe(1);
  });

  it("does not turn an invalid transfer receipt replay into success", async () => {
    const operationId = "operation_store_invalid_receipt";
    const context = { workspaceId: "workspace_store_receipt", accountId: "account_store_owner", operationId };
    const request = { action: "workspace.transfer.receipt", input: { transferId: "transfer_store_receipt", receipt: { source_integrity_hash: "wrong" } } };
    let inserted = false;
    let status = "";
    let requestHash = "";
    let actionCalls = 0;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) {
        if (inserted) return { rows: [] };
        inserted = true;
        status = "running";
        requestHash = String(values?.[3]);
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return { rows: [{ request_hash: requestHash, status, result: null }] };
      }
      if (text.includes("SELECT invalid_receipt_action")) {
        actionCalls += 1;
        throw new Error("workspace_transfer_receipt_invalid");
      }
      if (text.includes("SET status = 'running'")) {
        status = "running";
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SET status = 'failed'")) {
        status = "failed";
        return { rows: [] };
      }
      if (text.includes("FROM workspace_members")) return { rows: [] };
      return { rows: [] };
    });
    const action = async (sql: { query: (text: string) => Promise<{ rows: unknown[] }> }) => {
      await sql.query("SELECT invalid_receipt_action");
      return { ok: true };
    };

    await expect(store.runTransferIdempotent(context, request, action)).rejects.toThrow("workspace_transfer_receipt_invalid");
    await expect(store.runTransferIdempotent(context, request, action)).rejects.toThrow("workspace_transfer_receipt_invalid");
    expect(actionCalls).toBe(2);
    expect(status).toBe("failed");
  });
});

function storeWithQuery(
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }>
): WorkspaceServerStore {
  const database = {
    withContext: vi.fn(async (_context: unknown, action: (sql: { query: typeof query }) => Promise<unknown>) => action({ query }))
  };
  return new WorkspaceServerStore({
    database: database as never,
    mode: "hosted",
    storageRoot: "/tmp/samurai-workspace-server-store-test",
    invitationTokenSecret: "test-secret-test-secret-test-secret-test-secret"
  });
}
