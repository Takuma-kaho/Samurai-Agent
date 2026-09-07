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

  it("replays Room creation after the internal Workspace version advances", async () => {
    const workspaceId = "workspace_store_room_replay";
    const accountId = "account_store_room_replay";
    const operationId = "operation_store_room_replay";
    const context = { workspaceId, accountId, operationId };
    const input = {
      name: "Replayable Room",
      newAgent: {
        name: "Replay Agent",
        role: "reviewer",
        instructions: "Review the Room work and report a decision.",
        backendId: "backend-room-replay",
        enabled: true
      }
    };
    let operationInserted = false;
    let operationStatus = "";
    let requestHash = "";
    let persistedResult: unknown = null;
    let workspaceVersion = 1;
    let workspaceVersionReads = 0;
    let roomCreateCalls = 0;
    const registeredAgentIds: string[] = [];
    let roomCreateValues: readonly unknown[] | undefined;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) {
        if (operationInserted) return { rows: [] };
        operationInserted = true;
        operationStatus = "running";
        requestHash = String(values?.[3]);
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return { rows: [{ request_hash: requestHash, status: operationStatus, result: persistedResult }] };
      }
      if (text.includes("SAVEPOINT") || text.includes("RELEASE SAVEPOINT")) return { rows: [] };
      if (text.includes("SELECT version FROM workspaces WHERE id = $1")) {
        workspaceVersionReads += 1;
        return { rows: [{ version: workspaceVersion }] };
      }
      if (text.includes("SELECT state FROM workspaces WHERE id = $1")) return { rows: [{ state: "active" }] };
      if (text.includes("samurai_register_workspace_agent_v1")) {
        registeredAgentIds.push(String(values?.[1]));
        return { rows: [] };
      }
      if (text.includes("samurai_create_room")) {
        roomCreateCalls += 1;
        roomCreateValues = values;
        return { rows: [] };
      }
      if (text.includes("FROM rooms WHERE workspace_id = $1 AND id = $2")) {
        return {
          rows: [{
            workspace_id: workspaceId,
            id: String(roomCreateValues?.[1]),
            parent_room_id: null,
            name: input.name,
            room_kind: "normal",
            default_agent_id: String(roomCreateValues?.[4]),
            default_agent_version: 1,
            dm_account_id: null,
            version: 1,
            created_at: "2026-09-06T00:00:00.000Z",
            updated_at: "2026-09-06T00:00:00.000Z"
          }]
        };
      }
      if (text.includes("samurai_append_workspace_audit")) return { rows: [] };
      if (text.includes("SET status = 'completed'")) {
        operationStatus = "completed";
        persistedResult = JSON.parse(String(values?.[2]));
        return { rows: [] };
      }
      return { rows: [] };
    });

    const first = await store.createRoom(context, input);
    workspaceVersion = 2;
    const replay = await store.createRoom(context, input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.room.id).toBe(first.room.id);
    expect(replay.room.defaultAgentId).toBe(first.room.defaultAgentId);
    expect(registeredAgentIds).toEqual([first.room.defaultAgentId]);
    expect(roomCreateCalls).toBe(1);
    expect(workspaceVersionReads).toBe(1);

    await expect(store.createRoom(context, { ...input, name: "Different Room" })).rejects.toMatchObject({
      code: "workspace_operation_id_reused",
      status: 409
    });
    expect(roomCreateCalls).toBe(1);
  });

  it("reopens the same Agent DM through a different operation without changing its Room", async () => {
    const workspaceId = "workspace_store_agent_dm_reopen";
    const accountId = "account_store_agent_dm_reopen";
    const agentId = "agent_store_agent_dm_reopen";
    const operationIds = ["operation_store_agent_dm_first", "operation_store_agent_dm_second"];
    let canonicalRoomId: string | undefined;
    const requestedRoomIds: string[] = [];
    const queriedRoomIds: string[] = [];
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: String(values?.[1]) }] };
      if (text.includes("SAVEPOINT") || text.includes("RELEASE SAVEPOINT")) return { rows: [] };
      if (text.includes("SELECT samurai_open_agent_dm")) {
        const requestedRoomId = String(values?.[1]);
        requestedRoomIds.push(requestedRoomId);
        canonicalRoomId ??= requestedRoomId;
        return {
          rows: [{ result: {
            room_id: canonicalRoomId,
            default_agent_id: agentId,
            default_agent_version: 3,
            room_kind: "agent_dm",
            replayed: canonicalRoomId !== requestedRoomId
          } }]
        };
      }
      if (text.includes("FROM rooms WHERE workspace_id = $1 AND id = $2")) {
        const queriedRoomId = String(values?.[1]);
        queriedRoomIds.push(queriedRoomId);
        // The regression is specifically that the second operation must use
        // the SQL function's existing Room ID rather than its own candidate.
        if (queriedRoomId !== canonicalRoomId) return { rows: [] };
        return {
          rows: [{
            workspace_id: workspaceId,
            id: canonicalRoomId,
            parent_room_id: null,
            name: "DM",
            room_kind: "agent_dm",
            default_agent_id: agentId,
            default_agent_version: 3,
            dm_account_id: accountId,
            version: 2,
            created_at: "2026-09-06T00:00:00.000Z",
            updated_at: "2026-09-06T00:01:00.000Z"
          }]
        };
      }
      if (text.includes("SET status = 'completed'")) return { rows: [] };
      return { rows: [] };
    });

    const first = await store.openAgentDm(
      { workspaceId, accountId, operationId: operationIds[0] },
      { agentId }
    );
    const reopened = await store.openAgentDm(
      { workspaceId, accountId, operationId: operationIds[1] },
      { agentId }
    );

    expect(first).toMatchObject({ workspaceId, roomId: canonicalRoomId, kind: "agent_dm", agentId, replayed: false });
    expect(reopened).toMatchObject({ workspaceId, roomId: first.roomId, kind: "agent_dm", agentId, replayed: false });
    expect(requestedRoomIds).toHaveLength(2);
    expect(requestedRoomIds[0]).not.toBe(requestedRoomIds[1]);
    expect(queriedRoomIds).toEqual([canonicalRoomId, canonicalRoomId]);
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

  it("claims Room work through the server-owned function without locking the guarded table directly", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = storeWithQuery(async (text, values) => {
      calls.push({ text, values });
      if (text.includes("SELECT samurai_claim_human_work_launch")) {
        return { rows: [{ claim: { reservation_id: "reservation_store_claim" } }] };
      }
      if (text.includes("FROM workspace_human_work_launch_reservations")) {
        return {
          rows: [{
            workspace_id: "workspace_store_claim",
            reservation_id: "reservation_store_claim",
            work_id: "work_store_claim",
            assignment_id: "assignment_store_claim",
            room_id: "room_store_claim",
            generation: "0",
            scheduled_at: "2026-09-05T00:00:00.000Z",
            control_generation: "0",
            instruction_version: "1",
            agent_id: "agent_store_claim",
            agent_configuration_version: "4",
            origin_kind: "parent_continuation",
            parent_assignment_id: "assignment_store_parent",
            parent_backend_id: "claude-code",
            parent_agent_id: "agent_store_claim",
            parent_backend_session_id: "claude-session-store-parent",
            parent_runtime_binding: {
              workspace_id: "workspace_store_claim",
              room_id: "room_store_claim",
              session_id: "session_store_parent",
              work_id: "work_store_claim",
              assignee_id: "assignment_store_parent",
              agent_id: "agent_store_claim",
              agent_configuration_version: 4,
              backend_id: "claude-code",
              generation: 0
            },
            session_id: "session_store_parent",
            instruction: "Run the claimed work",
            attachments: []
          }]
        };
      }
      return { rows: [] };
    });

    const result = await store.claimRoomWorkReservation(
      { workspaceId: "workspace_store_claim", accountId: "account_store_claim" },
      { workerId: "worker_store_claim", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 }
    );

    expect(result).toMatchObject({
      workId: "work_store_claim",
      assignmentId: "assignment_store_claim",
      reservationId: "reservation_store_claim",
      instruction: "Run the claimed work"
    });
    expect(result).toMatchObject({ agentConfigurationVersion: 4, agent_configuration_version: 4 });
    expect(result).toMatchObject({ sessionId: "session_store_parent", session_id: "session_store_parent" });
    expect(result).toMatchObject({
      parentAssigneeId: "assignment_store_parent",
      resumeBackendContinuation: {
        backendSessionId: "claude-session-store-parent",
        parent: expect.objectContaining({ assigneeId: "assignment_store_parent", backendId: "claude-code" })
      }
    });
    const claimCall = calls.find(({ text }) => text.includes("SELECT samurai_claim_human_work_launch"));
    expect(claimCall?.values?.[1]).toBeNull();
    const executionCall = calls.find(({ text }) => text.includes("FROM workspace_human_work_launch_reservations AS reservation"));
    expect(executionCall?.text).toContain("workspace_runtime_runs AS parent_run");
    expect(executionCall?.text).toContain("workspace_runtime_sessions AS parent_session");
    expect(calls.some(({ text }) => text.includes("FOR UPDATE"))).toBe(false);
  });

  it("terminally fails a claimed launch with unresolved legacy attachments", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    let claimCount = 0;
    const store = storeWithQuery(async (text, values) => {
      calls.push({ text, values });
      if (text.includes("SELECT samurai_claim_human_work_launch")) {
        claimCount += 1;
        return claimCount === 1
          ? { rows: [{ claim: { reservation_id: "reservation_store_legacy_attachment" } }] }
          : { rows: [{ claim: null }] };
      }
      if (text.includes("FROM workspace_human_work_launch_reservations AS reservation")) {
        return { rows: [{
          workspace_id: "workspace_store_legacy_attachment",
          reservation_id: "reservation_store_legacy_attachment",
          work_id: "work_store_legacy_attachment",
          assignment_id: "assignment_store_legacy_attachment",
          room_id: "room_store_legacy_attachment",
          generation: "2",
          scheduled_at: "2026-09-05T00:00:00.000Z",
          control_generation: "2",
          instruction_version: "1",
          agent_id: "agent_store_legacy_attachment",
          agent_configuration_version: "1",
          parent_assignment_id: null,
          parent_backend_id: null,
          parent_agent_id: null,
          parent_backend_session_id: null,
          parent_runtime_binding: null,
          session_id: null,
          instruction: "Review the historical attachment",
          attachments: [{ kind: "legacy_unresolved", reason: "reference_unavailable", ref: { uri: "old.md" } }],
          attachments_have_unresolved: true
        }] };
      }
      if (text.includes("SELECT samurai_fail_human_work_launch_preflight")) {
        return { rows: [{ failed: true }] };
      }
      return { rows: [] };
    });
    const context = { workspaceId: "workspace_store_legacy_attachment", accountId: "account_store_legacy_attachment" };
    const input = { workerId: "worker_store_legacy_attachment", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 };

    await expect(store.claimRoomWorkReservation(context, input)).resolves.toBeUndefined();
    // A committed terminal failure means a subsequent worker poll sees no
    // claimable reservation, rather than retrying the same invalid reference.
    await expect(store.claimRoomWorkReservation(context, input)).resolves.toBeUndefined();
    const preflight = calls.find(({ text }) => text.includes("SELECT samurai_fail_human_work_launch_preflight"));
    expect(preflight?.values).toEqual([
      context.workspaceId,
      "work_store_legacy_attachment",
      "assignment_store_legacy_attachment",
      "reservation_store_legacy_attachment",
      input.workerId,
      2,
      "room_work_attachment_reference_unavailable"
    ]);
    expect(calls.some(({ text }) => text.includes("FROM workspace_human_work_launch_reservations AS reservation") && text.includes("samurai_human_work_attachment_refs_have_unresolved"))).toBe(true);
  });

  it("filters obsolete whole-work stop controls and ignores a resume race", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    let claimCalls = 0;
    const store = storeWithQuery(async (text, values) => {
      calls.push({ text, values });
      if (text.includes("FROM workspace_human_work_controls")) {
        return { rows: [{ id: "control_store_obsolete_stop" }] };
      }
      if (text.includes("SELECT samurai_claim_human_work_stop_dispatch")) {
        claimCalls += 1;
        throw new Error("human_work_stop_generation_conflict");
      }
      return { rows: [] };
    });

    await expect(store.claimRoomWorkStopDispatch(
      { workspaceId: "workspace_store_stop_race", accountId: "account_store_stop_race" },
      { workerId: "worker_store_stop_race", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 }
    )).resolves.toBeUndefined();

    const candidateQuery = calls.find(({ text }) => text.includes("FROM workspace_human_work_controls"));
    expect(candidateQuery?.text).toContain("action IN ('stop_request', 'assignment_stop')");
    expect(candidateQuery?.text).toContain("action = 'assignment_stop'");
    expect(candidateQuery?.text).toContain("work.control_generation = workspace_human_work_controls.generation");
    expect(claimCalls).toBe(1);
  });

  it("does not project a parent Session or continuation when runtime binding evidence is stale", async () => {
    const store = storeWithQuery(async (text) => {
      if (text.includes("SELECT samurai_claim_human_work_launch")) {
        return { rows: [{ claim: { reservation_id: "reservation_store_stale" } }] };
      }
      if (text.includes("FROM workspace_human_work_launch_reservations AS reservation")) {
        return {
          rows: [{
            workspace_id: "workspace_store_stale",
            reservation_id: "reservation_store_stale",
            work_id: "work_store_stale",
            assignment_id: "assignment_store_child",
            room_id: "room_store_stale",
            generation: 3,
            control_generation: 3,
            instruction_version: 2,
            agent_id: "agent_store_stale",
            agent_configuration_version: 4,
            parent_assignment_id: "assignment_store_parent",
            parent_backend_id: "claude-code",
            parent_agent_id: "agent_store_stale",
            parent_backend_session_id: "stale-session",
            parent_runtime_binding: {
              workspace_id: "workspace_store_stale",
              room_id: "room_store_stale",
              session_id: "session_store_parent",
              work_id: "different-work",
              assignee_id: "assignment_store_parent",
              agent_id: "agent_store_stale",
              agent_configuration_version: 4,
              backend_id: "claude-code",
              generation: 3
            },
            session_id: "session_store_parent",
            instruction: "Run with a fresh external session",
            attachments: []
          }]
        };
      }
      return { rows: [] };
    });

    const result = await store.claimRoomWorkReservation(
      { workspaceId: "workspace_store_stale", accountId: "account_store_stale" },
      { workerId: "worker_store_stale", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 }
    );

    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("resumeBackendContinuation");
    expect(result).not.toHaveProperty("parentAssigneeId");
  });

  it("does not project a parent Session when the parent or an ancestor was reassigned", async () => {
    const calls: string[] = [];
    const store = storeWithQuery(async (text) => {
      calls.push(text);
      if (text.includes("SELECT samurai_claim_human_work_launch")) {
        return { rows: [{ claim: { reservation_id: "reservation_store_reassigned" } }] };
      }
      if (text.includes("FROM workspace_human_work_launch_reservations AS reservation")) {
        return {
          rows: [{
            workspace_id: "workspace_store_reassigned",
            reservation_id: "reservation_store_reassigned",
            work_id: "work_store_reassigned",
            assignment_id: "assignment_store_child",
            room_id: "room_store_reassigned",
            generation: 3,
            control_generation: 3,
            instruction_version: 2,
            agent_id: "agent_store_reassigned",
            agent_configuration_version: 4,
            origin_kind: "parent_continuation",
            parent_assignment_id: "assignment_store_parent",
            parent_assignment_superseded: true,
            parent_backend_id: "claude-code",
            parent_agent_id: "agent_store_reassigned",
            parent_backend_session_id: "stale-session",
            parent_runtime_binding: {
              workspace_id: "workspace_store_reassigned",
              room_id: "room_store_reassigned",
              session_id: "session_store_parent",
              work_id: "work_store_reassigned",
              assignee_id: "assignment_store_parent",
              agent_id: "agent_store_reassigned",
              agent_configuration_version: 4,
              backend_id: "claude-code",
              generation: 3
            },
            session_id: "session_store_parent",
            instruction: "Do not resume this reassigned branch",
            attachments: []
          }]
        };
      }
      return { rows: [] };
    });

    const result = await store.claimRoomWorkReservation(
      { workspaceId: "workspace_store_reassigned", accountId: "account_store_reassigned" },
      { workerId: "worker_store_reassigned", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 }
    );

    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("resumeBackendContinuation");
    expect(result).not.toHaveProperty("parentAssigneeId");
    const executionQuery = calls.find((text) => text.includes("FROM workspace_human_work_launch_reservations AS reservation"));
    expect(executionQuery).toContain("samurai_human_work_assignment_is_superseded(parent_assignment.workspace_id, parent_assignment.id)");
    expect(executionQuery).toContain("samurai_human_work_assignment_is_superseded(assignment.workspace_id, assignment.id)");
  });

  it("does not project a parent Session when nested runtime binding evidence diverges", async () => {
    const calls: string[] = [];
    const baseRow = {
      workspace_id: "workspace_store_nested_binding",
      reservation_id: "reservation_store_nested_binding",
      work_id: "work_store_nested_binding",
      assignment_id: "assignment_store_child",
      room_id: "room_store_nested_binding",
      generation: 2,
      control_generation: 2,
      instruction_version: 2,
      agent_id: "agent_store_nested_binding",
      agent_configuration_version: 4,
      origin_kind: "parent_continuation",
      parent_assignment_id: "assignment_store_parent",
      parent_assignment_parent_id: "assignment_store_grandparent",
      parent_backend_id: "claude-code",
      parent_agent_id: "agent_store_nested_binding",
      parent_backend_session_id: "stale-session",
      parent_runtime_binding: {
        workspace_id: "workspace_store_nested_binding",
        room_id: "room_store_nested_binding",
        session_id: "session_store_parent",
        work_id: "work_store_nested_binding",
        assignee_id: "assignment_store_parent",
        parent_assignee_id: "assignment_store_wrong_grandparent",
        agent_id: "agent_store_nested_binding",
        agent_configuration_version: 4,
        backend_id: "claude-code",
        generation: 2,
        agent: { backend_id: "claude-code", config_version: "99" }
      },
      session_id: "session_store_parent",
      instruction: "Use a fresh external session",
      attachments: []
    };
    const store = storeWithQuery(async (text) => {
      calls.push(text);
      if (text.includes("SELECT samurai_claim_human_work_launch")) {
        return { rows: [{ claim: { reservation_id: "reservation_store_nested_binding" } }] };
      }
      if (text.includes("FROM workspace_human_work_launch_reservations AS reservation")) {
        return { rows: [baseRow] };
      }
      return { rows: [] };
    });

    const result = await store.claimRoomWorkReservation(
      { workspaceId: "workspace_store_nested_binding", accountId: "account_store_nested_binding" },
      { workerId: "worker_store_nested_binding", leaseMs: 1_000, now: "2026-09-05T00:00:00.000Z", limit: 1 }
    );

    expect(result).not.toHaveProperty("sessionId");
    expect(result).not.toHaveProperty("resumeBackendContinuation");
    expect(result).not.toHaveProperty("parentAssigneeId");
    const executionQuery = calls.find((text) => text.includes("FROM workspace_human_work_launch_reservations AS reservation"));
    expect(executionQuery).toContain("parent_run.requested_by_participant_id = work.requester_account_id");
    expect(executionQuery).toContain("parent_run.metadata -> 'runtime_binding' -> 'agent'");
  });

  it("serializes detailed Room-work reads on the transaction-bound SQL client", async () => {
    const workspaceId = "workspace_store_view_serialized";
    const roomId = "room_store_view_serialized";
    const workId = "work_store_view_serialized";
    let activeQueries = 0;
    let maxConcurrentQueries = 0;
    const workRow = {
      workspace_id: workspaceId,
      id: workId,
      room_id: roomId,
      requester_account_id: "account_store_view_serialized",
      default_agent_id: "agent_store_view_serialized",
      default_agent_version: "1",
      title: "Serialized view",
      objective: "Read one consistent Room Work view",
      completion_criteria: [],
      status: "completed" as const,
      stop_state: "none" as const,
      instruction_version: "1",
      control_generation: "0",
      operation_id: "operation_store_view_serialized",
      created_at: "2026-09-05T00:00:00.000Z",
      updated_at: "2026-09-05T00:00:00.000Z"
    };
    const store = storeWithQuery(async (text) => {
      activeQueries += 1;
      maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries);
      // Force an async boundary so Promise.all-based implementations expose
      // overlapping calls on the same mocked SQL client.
      await Promise.resolve();
      activeQueries -= 1;
      if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) return { rows: [workRow] };
      return { rows: [] };
    });

    const view = await store.viewRoomWork(
      { workspaceId, accountId: "account_store_view_serialized" },
      { roomId, workId }
    );

    expect(view).toMatchObject({ id: workId, roomId, instructions: [], comments: [], controls: [], reactions: [], launchReservations: [] });
    expect(maxConcurrentQueries).toBe(1);
  });

  it("locks a Room default Agent through the server-owned function", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const store = storeWithQuery(async (text, values) => {
      calls.push({ text, values });
      return { rows: [{ default_agent_id: "agent_store_default", default_agent_version: "3" }] };
    });
    const sql = { query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return { rows: [{ default_agent_id: "agent_store_default", default_agent_version: "3" }] };
    } };

    const result = await (store as unknown as {
      lockRoomDefaultAgent: (value: typeof sql, workspaceId: string, roomId: string) => Promise<{ default_agent_id: string | null; default_agent_version: number | string | null }>;
    }).lockRoomDefaultAgent(sql, "workspace_store_default", "room_store_default");

    expect(result).toEqual({ default_agent_id: "agent_store_default", default_agent_version: "3" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("FROM samurai_lock_room_default_agent($1, $2)");
    expect(calls[0]?.text).not.toContain("FOR SHARE");
    expect(calls[0]?.values).toEqual(["workspace_store_default", "room_store_default"]);
  });

  it("appends a Room-work reply and preserves the idempotent replay flag", async () => {
    const workspaceId = "workspace_store_reply";
    const roomId = "room_store_reply";
    const workId = "work_store_reply";
    const accountId = "account_store_reply";
    const operationId = "operation_store_reply";
    const timestamp = "2026-09-05T00:00:00.000Z";
    const assignmentId = "assignment_store_reply_previous";
    const instructionId = "room_work_instruction_8f1e";
    const continuationAssignmentId = "room_work_assignment_continuation";
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    let persistedResult: unknown;
    let requestHash: unknown;
    const workRow = {
      workspace_id: workspaceId,
      id: workId,
      room_id: roomId,
      requester_account_id: accountId,
      default_agent_id: "agent_store_reply",
      default_agent_version: "1",
      title: "Completed work",
      objective: "Complete the work",
      completion_criteria: [],
      status: "completed" as const,
      stop_state: "none" as const,
      instruction_version: "1",
      control_generation: "0",
      operation_id: "operation_store_reply_create",
      created_at: timestamp,
      updated_at: timestamp
    };
    const previousAssignment = {
      workspace_id: workspaceId,
      id: assignmentId,
      work_id: workId,
      room_id: roomId,
      parent_assignment_id: null,
      agent_id: "agent_store_reply",
      agent_version: "1",
      instruction_version: "1",
      attempt: "1",
      priority: 0,
      status: "completed" as const,
      current_run_id: null,
      result: { run_id: "run_store_reply_previous" },
      lease_owner: null,
      lease_expires_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      started_at: timestamp,
      completed_at: timestamp
    };
    const instructionRow = {
      workspace_id: workspaceId,
      id: instructionId,
      work_id: workId,
      assignment_id: continuationAssignmentId,
      room_id: roomId,
      version: "2",
      body: "Continue the completed work",
      attachment_refs: [],
      source_kind: "reply" as const,
      source_comment_id: null,
      source_comment_version: null,
      state: "pending" as const,
      created_by: accountId,
      created_at: timestamp
    };
    const store = storeWithQuery(async (text, values) => {
      calls.push({ text, values });
      if (text.includes("INSERT INTO workspace_operations")) {
        requestHash = values?.[3];
        if (persistedResult) return { rows: [] };
        return { rows: [{ id: operationId }] };
      }
      if (text.includes("SELECT request_hash, status, result FROM workspace_operations")) {
        return { rows: [{ request_hash: requestHash, status: "completed", result: persistedResult }] };
      }
      if (text.includes("SAVEPOINT") || text.includes("RELEASE SAVEPOINT")) return { rows: [] };
      if (text.includes("SET status = 'completed'")) {
        persistedResult = JSON.parse(String(values?.[2]));
        return { rows: [] };
      }
      if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) return { rows: [workRow] };
      if (text.includes("FROM workspace_human_work_assignments")) return { rows: [previousAssignment] };
      if (text.includes("SELECT samurai_append_human_work_instruction")) {
        return { rows: [{ result: { instruction_id: instructionId, version: 2, state: "pending", assignment_id: continuationAssignmentId, reservation_id: "reservation_store_reply_continuation" } }] };
      }
      if (text.includes("FROM workspace_human_work_instructions WHERE workspace_id = $1 AND id = $2")) return { rows: [instructionRow] };
      if (text.includes("SELECT organization_id FROM workspaces")) return { rows: [{ organization_id: null }] };
      if (text.includes("INSERT INTO workspace_events")) {
        return {
          rows: [{
            id: 1,
            workspace_id: workspaceId,
            room_id: roomId,
            kind: "room.work.instruction.created",
            record_type: "room_work_instruction",
            record_id: instructionId,
            operation_id: operationId,
            payload: { work_id: workId, version: 2, source_kind: "reply" },
            created_at: timestamp
          }]
        };
      }
      if (text.includes("samurai_append_workspace_audit")) return { rows: [] };
      return { rows: [] };
    });
    const context = { workspaceId, accountId, operationId, requestId: "request_store_reply" };
    const input = { roomId, workId, assigneeId: assignmentId, instruction: "Continue the completed work", attachments: [] };

    const first = await store.replyToRoomWork(context, input);
    expect(first).toMatchObject({
      workId,
      assignmentId: continuationAssignmentId,
      version: 2,
      replayed: false
    });
    const append = calls.find(({ text }) => text.includes("SELECT samurai_append_human_work_instruction"));
    expect(append?.values?.[3]).toBe(assignmentId);
    expect(append?.values?.[6]).toBe("reply");

    const replay = await store.replyToRoomWork(context, input);
    expect(replay).toMatchObject({ workId, assignmentId: continuationAssignmentId, version: 2, replayed: true });
  });

  it.each([
    ["human_work_outcome_unknown", "room_work_outcome_unknown"],
    ["human_work_instruction_target_required", "room_work_instruction_target_required"],
    ["human_work_instruction_child_pending", "room_work_instruction_child_pending"]
  ])("maps %s Room-work continuation rejection to %s", async (postgresCode, expectedCode) => {
    const store = storeWithQuery(async (text) => {
      if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) {
        return { rows: [{
          workspace_id: "workspace_store_unknown",
          id: "work_store_unknown",
          room_id: "room_store_unknown",
          requester_account_id: "account_store_unknown",
          default_agent_id: "agent_store_unknown",
          default_agent_version: "1",
          title: "Unknown work",
          objective: "Resolve the unknown result",
          completion_criteria: [],
          status: "waiting",
          stop_state: "none",
          instruction_version: "1",
          control_generation: "0",
          operation_id: "operation_store_unknown_create",
          created_at: "2026-09-05T00:00:00.000Z",
          updated_at: "2026-09-05T00:00:00.000Z"
        }] };
      }
      if (text.includes("FROM workspace_human_work_assignments")) {
        return { rows: [{
          workspace_id: "workspace_store_unknown",
          id: "assignment_store_unknown",
          work_id: "work_store_unknown",
          room_id: "room_store_unknown",
          parent_assignment_id: null,
          agent_id: "agent_store_unknown",
          agent_version: "1",
          instruction_version: "1",
          attempt: "1",
          priority: 0,
          status: "outcome_unknown",
          current_run_id: null,
          result: { reason: "external outcome unavailable" },
          lease_owner: null,
          lease_expires_at: null,
          created_at: "2026-09-05T00:00:00.000Z",
          updated_at: "2026-09-05T00:00:00.000Z",
          started_at: "2026-09-05T00:00:00.000Z",
          completed_at: null
        }] };
      }
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: "operation_store_unknown" }] };
      if (text.includes("SAVEPOINT") || text.includes("RELEASE SAVEPOINT")) return { rows: [] };
      if (text.includes("SELECT samurai_append_human_work_instruction")) {
        throw new Error(postgresCode);
      }
      return { rows: [] };
    });

    await expect(store.replyToRoomWork(
      { workspaceId: "workspace_store_unknown", accountId: "account_store_unknown", operationId: "operation_store_unknown" },
      { roomId: "room_store_unknown", workId: "work_store_unknown", instruction: "Continue only after resolution", attachments: [] }
    )).rejects.toMatchObject({ code: expectedCode, status: 409 });
  });

  it("rejects a stale attachment hash before appending a Room-work instruction", async () => {
    const workspaceId = "workspace_store_attachment_hash";
    const roomId = "room_store_attachment_hash";
    const workId = "work_store_attachment_hash";
    const calls: string[] = [];
    const store = storeWithQuery(async (text) => {
      calls.push(text);
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: "operation_store_attachment_hash" }] };
      if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) return { rows: [{
        workspace_id: workspaceId,
        id: workId,
        room_id: roomId,
        requester_account_id: "account_store_attachment_hash",
        default_agent_id: "agent_store_attachment_hash",
        default_agent_version: "1",
        title: "Attachment hash",
        objective: "Reject stale refs",
        completion_criteria: [],
        status: "queued",
        stop_state: "none",
        instruction_version: "1",
        control_generation: "0",
        operation_id: "operation_store_attachment_create",
        created_at: "2026-09-05T00:00:00.000Z",
        updated_at: "2026-09-05T00:00:00.000Z"
      }] };
      if (text.includes("FROM workspace_human_work_assignments")) return { rows: [] };
      if (text.includes("samurai_can_room")) return { rows: [{ allowed: true }] };
      if (text.includes("FROM workspace_files")) return { rows: [{ path: "notes/hash.md", version: 2, sha256: "b".repeat(64) }] };
      return { rows: [] };
    });

    await expect(store.replyToRoomWork({
      workspaceId,
      accountId: "account_store_attachment_hash",
      operationId: "operation_store_attachment_hash"
    }, {
      roomId,
      workId,
      instruction: "Use the current file",
      attachments: [{ kind: "file", id: "a".repeat(64), uri: "notes/hash.md", version: "1" }]
    })).rejects.toMatchObject({ code: "room_work_attachment_hash_mismatch", status: 409 });
    expect(calls.some((text) => text.includes("samurai_append_human_work_instruction"))).toBe(false);
  });

  it("does not silently drop malformed Room-work attachment refs", async () => {
    const store = storeWithQuery(async () => ({ rows: [] }));
    await expect(store.replyToRoomWork({
      workspaceId: "workspace_store_attachment_invalid",
      accountId: "account_store_attachment_invalid",
      operationId: "operation_store_attachment_invalid"
    }, {
      roomId: "room_store_attachment_invalid",
      workId: "work_store_attachment_invalid",
      instruction: "Reject malformed attachment",
      attachments: [{ kind: "file", id: "id", uri: "notes/a.md", unexpected: true } as never]
    })).rejects.toMatchObject({ code: "room_work_attachment_reference_invalid", status: 400 });
  });

  it("creates the delegated child through one atomic RPC and preserves dependency input", async () => {
    const workspaceId = "workspace_store_delegate";
    const roomId = "room_store_delegate";
    const workId = "work_store_delegate";
    const parentId = "assignment_store_delegate_parent";
    const targetAgentId = "agent_store_delegate_target";
    let delegateValues: readonly unknown[] | undefined;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: "operation_store_delegate" }] };
      if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) {
        return { rows: [{
          workspace_id: workspaceId, id: workId, room_id: roomId,
          requester_account_id: "account_store_delegate", default_agent_id: "agent_store_delegate_parent",
          default_agent_version: "1", title: "Delegation", objective: "Delegate safely", completion_criteria: ["done"],
          status: "running", stop_state: "none", instruction_version: "1", control_generation: "0",
          operation_id: "operation_store_delegate_create", created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z"
        }] };
      }
      if (text.includes("FROM workspace_human_work_assignments") && text.includes("WHERE workspace_id = $1 AND work_id = $2")) {
        return { rows: [{
          workspace_id: workspaceId, id: parentId, work_id: workId, room_id: roomId,
          parent_assignment_id: null, dependency_assignment_ids: [], agent_id: "agent_store_delegate_parent",
          agent_version: "1", instruction_version: "1", attempt: "1", priority: 0, status: "running",
          current_run_id: "run_store_delegate", result: null, lease_owner: null, lease_expires_at: null,
          created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z", started_at: "2026-09-05T00:00:00.000Z", completed_at: null
        }] };
      }
      if (text.includes("samurai_delegate_human_work")) {
        delegateValues = values;
        return { rows: [{ result: { status: "waiting" } }] };
      }
      if (text.includes("FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2")) {
        const childId = String(delegateValues?.[3] ?? "assignment_store_delegate_child");
        return { rows: [{
          workspace_id: workspaceId, id: childId, work_id: workId, room_id: roomId,
          parent_assignment_id: parentId, dependency_assignment_ids: ["assignment_store_delegate_dependency"], agent_id: targetAgentId,
          agent_version: "2", instruction_version: "2", attempt: "0", priority: 0, status: "waiting",
          current_run_id: null, result: null, lease_owner: null, lease_expires_at: null,
          created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:00.000Z", started_at: null, completed_at: null
        }] };
      }
      if (text.includes("SELECT organization_id FROM workspaces")) return { rows: [{ organization_id: null }] };
      if (text.includes("INSERT INTO workspace_events")) return { rows: [{
        id: 1, workspace_id: workspaceId, room_id: roomId, kind: "room.work.assignee.delegated",
        record_type: "room_work_assignment", record_id: "assignment_store_delegate_child", operation_id: "operation_store_delegate",
        payload: "{}", created_at: "2026-09-05T00:00:00.000Z"
      }] };
      return { rows: [] };
    });

    const assignment = await store.delegateRoomWorkAssignee(
      { workspaceId, accountId: "account_store_delegate", operationId: "operation_store_delegate", requestId: "request_store_delegate" },
      {
        roomId,
        workId,
        assigneeId: parentId,
        agentId: targetAgentId,
        instruction: "Inspect the delegated branch.",
        dependencyAssigneeIds: ["assignment_store_delegate_dependency"],
        attachments: []
      }
    );

    expect(assignment).toMatchObject({ workId, parentAssignmentId: parentId, agentId: targetAgentId, status: "waiting" });
    expect(assignment.dependencyAssignmentIds).toEqual(["assignment_store_delegate_dependency"]);
    expect(delegateValues?.[2]).toBe(parentId);
    expect(delegateValues?.[6]).toBe(targetAgentId);
    expect(delegateValues?.[9]).toBe("[\"assignment_store_delegate_dependency\"]");
    expect(delegateValues?.[12]).toBeNull();
  });

  it("routes Runtime delegation through the trusted parent Run without public Work or actor IDs", async () => {
    const workspaceId = "workspace_store_runtime_delegate";
    const parentRunId = "run_store_runtime_delegate";
    let delegateValues: readonly unknown[] | undefined;
    const store = storeWithQuery(async (text, values) => {
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: "operation_store_runtime_delegate" }] };
      if (text.includes("samurai_delegate_human_work_from_runtime")) {
        delegateValues = values;
        return { rows: [{ result: { status: "waiting" } }] };
      }
      if (text.includes("FROM workspace_human_work_assignments WHERE workspace_id = $1 AND id = $2")) {
        return { rows: [{
          workspace_id: workspaceId,
          id: String(delegateValues?.[2] ?? "assignment_store_runtime_delegate"),
          work_id: "work_store_runtime_delegate",
          room_id: "room_store_runtime_delegate",
          parent_assignment_id: "assignment_store_runtime_parent",
          dependency_assignment_ids: [],
          agent_id: "agent_store_runtime_target",
          agent_version: "2",
          instruction_version: "2",
          attempt: "0",
          priority: 0,
          status: "waiting",
          current_run_id: null,
          result: null,
          lease_owner: null,
          lease_expires_at: null,
          created_at: "2026-09-05T00:00:00.000Z",
          updated_at: "2026-09-05T00:00:00.000Z",
          started_at: null,
          completed_at: null
        }] };
      }
      if (text.includes("SELECT organization_id FROM workspaces")) return { rows: [{ organization_id: null }] };
      if (text.includes("INSERT INTO workspace_events")) return { rows: [{
        id: 1,
        workspace_id: workspaceId,
        room_id: "room_store_runtime_delegate",
        kind: "room.work.assignee.delegated",
        record_type: "room_work_assignment",
        record_id: String(delegateValues?.[2] ?? "assignment_store_runtime_delegate"),
        operation_id: "operation_store_runtime_delegate",
        payload: "{}",
        created_at: "2026-09-05T00:00:00.000Z"
      }] };
      return { rows: [] };
    });

    const assignment = await store.delegateRoomWorkAssigneeFromRuntime(
      { workspaceId, accountId: "account_store_runtime_delegate", operationId: "operation_store_runtime_delegate" },
      {
        parentRunId,
        agentId: "agent_store_runtime_target",
        instruction: "Inspect the runtime child branch.",
        dependencyAssigneeIds: ["assignment_store_runtime_dependency"],
        expectedGeneration: 3
      }
    );

    expect(assignment.status).toBe("waiting");
    expect(delegateValues?.[1]).toBe(parentRunId);
    expect(delegateValues?.[5]).toBe("agent_store_runtime_target");
    expect(delegateValues?.[9]).toBe(3);
    expect(delegateValues).not.toContain("work_store_runtime_delegate");
    expect(delegateValues).not.toContain("assignment_store_runtime_parent");
  });

  it("maps missing terminal Room-work Run evidence to an explicit conflict", async () => {
    const workspaceId = "workspace_store_settle_evidence";
    const workId = "work_store_settle_evidence";
    const assignmentId = "assignment_store_settle_evidence";
    const reservationId = "reservation_store_settle_evidence";
    const operationId = "operation_store_settle_evidence";
    const calls: string[] = [];
    const store = storeWithQuery(async (text) => {
      calls.push(text);
      if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: operationId }] };
      if (text.includes("SELECT workspace_id, work_id, room_id, status FROM workspace_human_work_assignments")) {
        return { rows: [{ workspace_id: workspaceId, work_id: workId, room_id: "room_store_settle_evidence", status: "running" }] };
      }
      if (text.includes("SELECT samurai_settle_human_work_assignment")) {
        throw new Error("human_work_run_evidence_missing");
      }
      return { rows: [] };
    });

    await expect(store.settleRoomWorkAssignment(
      { workspaceId, accountId: "account_store_settle_evidence", operationId },
      {
        workId,
        assignmentId,
        reservationId,
        leaseOwner: "worker_store_settle_evidence",
        generation: 0,
        status: "completed",
        result: { status: "completed" }
      }
    )).rejects.toMatchObject({ code: "room_work_run_evidence_missing", status: 409 });
    expect(calls.some((text) => text.includes("SET status = 'failed'"))).toBe(true);
  });

  it("maps reassignment safety errors to the public Room-work conflict codes", async () => {
    const mappings = [
      ["human_work_reassign_outcome_unknown", "room_work_reassign_outcome_unknown"],
      ["human_work_reassign_stop_required", "room_work_reassign_stop_required"],
      ["human_work_reassign_stop_pending", "room_work_reassign_stop_pending"],
      ["human_work_assignment_already_reassigned", "room_work_assignment_already_reassigned"]
    ] as const;

    for (const [postgresCode, publicCode] of mappings) {
      const workspaceId = `workspace_store_reassign_${postgresCode.slice("human_work_".length)}`;
      const workId = `work_store_reassign_${postgresCode.slice("human_work_".length)}`;
      const roomId = `room_store_reassign_${postgresCode.slice("human_work_".length)}`;
      const operationId = `operation_store_reassign_${postgresCode.slice("human_work_".length)}`;
      const store = storeWithQuery(async (text) => {
        if (text.includes("INSERT INTO workspace_operations")) return { rows: [{ id: operationId }] };
        if (text.includes("FROM workspace_human_works WHERE workspace_id = $1 AND id = $2")) {
          return { rows: [{
            workspace_id: workspaceId,
            id: workId,
            room_id: roomId,
            requester_account_id: "account_store_reassign",
            default_agent_id: "agent_store_reassign",
            default_agent_version: "1",
            title: "Reassignment safety",
            objective: "Safely reassign the work",
            completion_criteria: [],
            status: "running",
            stop_state: "none",
            instruction_version: "1",
            control_generation: "0",
            operation_id: "operation_store_reassign_create",
            created_at: "2026-09-06T00:00:00.000Z",
            updated_at: "2026-09-06T00:00:00.000Z"
          }] };
        }
        if (text.includes("FROM workspace_human_work_assignments") && text.includes("WHERE workspace_id = $1 AND work_id = $2")) {
          return { rows: [] };
        }
        if (text.includes("SELECT version FROM workspace_agents")) return { rows: [{ version: "1" }] };
        if (text.includes("FROM workspace_human_work_instructions")) return { rows: [{ body: "Apply the reassignment safely.", attachment_refs: [] }] };
        if (text.includes("samurai_reassign_human_work")) throw new Error(postgresCode);
        return { rows: [] };
      });

      await expect(store.reassignRoomWorkAssignee(
        { workspaceId, accountId: "account_store_reassign", operationId },
        {
          roomId,
          workId,
          assigneeId: "assignment_store_reassign",
          agentId: "agent_store_reassign_target"
        }
      )).rejects.toMatchObject({ code: publicCode, status: 409 });
    }
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
