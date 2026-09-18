import { describe, expect, it, vi } from "vitest";
import {
  PostgresWorkspaceNotificationAuthorization,
  PostgresWorkspaceNotificationStore,
  createOrganizationNotificationAwareCommands,
  createPostgresOrganizationNotificationBridge,
  createPostgresRuntimeExecutionContextSelector,
  createPostgresWorkspaceContextQueryDatabase,
  createPostgresWorkspaceNotificationOutboxPort
} from "./context-notification-postgres";

function rowResult<T>(rows: T[] = []) {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as never;
}

describe("Postgres context/notification adapters", () => {
  it("binds Context Query reads to the database read snapshot", async () => {
    const sql = { query: vi.fn(async () => rowResult()) };
    const withReadSnapshot = vi.fn(async (_context: unknown, action: (value: typeof sql) => Promise<unknown>) => action(sql));
    const database = createPostgresWorkspaceContextQueryDatabase({ withReadSnapshot } as never);
    await database.withReadSnapshot({ accountId: "account-1", workspaceId: "workspace-1" }, async (value) => value.query("SELECT 1"));
    expect(withReadSnapshot).toHaveBeenCalledWith(
      { accountId: "account-1", workspaceId: "workspace-1" },
      expect.any(Function)
    );
    expect(sql.query).toHaveBeenCalledWith("SELECT 1");
  });

  it("keeps notification reads under the recipient RLS context and marks only requested rows", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const sql = {
      query: vi.fn(async <T>(text: string, values?: readonly unknown[]) => {
        calls.push({ text, values });
        if (text.startsWith("UPDATE account_notifications")) {
          return rowResult<T>([{
            id: "notification-1",
            recipient_account_id: "account-1",
            workspace_id: "workspace-1",
            room_id: "room-1",
            kind: "work_completed",
            source_kind: "work",
            source_id: "work-1",
            source_revision: 1,
            created_at: "2026-01-01T00:00:00.000Z",
            read_at: "2026-01-01T00:01:00.000Z"
          } as T]);
        }
        return rowResult<T>();
      })
    };
    const contexts: unknown[] = [];
    const database = {
      withContext: vi.fn(async (context: unknown, action: (value: typeof sql) => Promise<unknown>) => {
        contexts.push(context);
        return action(sql);
      })
    };
    const store = new PostgresWorkspaceNotificationStore(database as never);
    const records = await store.markNotificationsRead({
      accountId: "account-1",
      workspaceId: "workspace-1",
      notificationIds: ["notification-1"],
      readAt: "2026-01-01T00:01:00.000Z"
    });
    expect(records[0]).toMatchObject({ id: "notification-1", recipientAccountId: "account-1" });
    expect(contexts).toEqual([{ accountId: "account-1", workspaceId: "workspace-1" }]);
    const update = calls.find((call) => call.text.startsWith("UPDATE account_notifications"));
    expect(update?.text).toContain("recipient_account_id = $1");
    expect(update?.text).toContain("COALESCE(read_at");
  });

  it("does not expose source internals for an unknown notification source", async () => {
    const queries: string[] = [];
    const sql = {
      query: vi.fn(async <T>(text: string) => {
        queries.push(text);
        if (text.includes("samurai_can_room")) return rowResult<T>([{ allowed: true } as T]);
        return rowResult<T>();
      })
    };
    const authorization = new PostgresWorkspaceNotificationAuthorization({
      withContext: async (_context: unknown, action: (value: typeof sql) => Promise<unknown>) => action(sql)
    } as never);
    const resolution = await authorization.resolveNotification({
      accountId: "account-1",
      workspaceId: "workspace-1",
      notification: {
        id: "notification-1",
        recipientAccountId: "account-1",
        workspaceId: "workspace-1",
        roomId: "room-1",
        kind: "future_kind",
        sourceKind: "future_internal_source",
        sourceId: "source-1",
        sourceRevision: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        readAt: null
      }
    });
    expect(resolution).toEqual(expect.objectContaining({ allowed: true, target: { kind: "room", roomId: "room-1" } }));
    expect(resolution).not.toHaveProperty("sourcePath");
    expect(queries.every((query) => !query.includes("payload") && !query.includes("path"))).toBe(true);
  });

  it("writes an explicit outbox row through the supplied transaction port", async () => {
    const query = vi.fn(async () => rowResult());
    const port = createPostgresWorkspaceNotificationOutboxPort({ withContext: vi.fn() } as never, async () => [{ workspaceId: "workspace-1", accountId: "maintenance-1" }]);
    const outbox = await port.enqueueInTransaction({ query }, {
      workspaceId: "workspace-1",
      roomId: "room-1",
      sourceKind: "work",
      sourceId: "work-1",
      sourceRevision: 1,
      kind: "work_completed",
      recipientAccountIds: ["account-1"]
    });
    expect(outbox?.workspaceId).toBe("workspace-1");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("account_notification_outbox"), expect.arrayContaining(["work-1"]));
  });

  it("selects only confirmed Room/Agent resources and never Workspace Knowledge", async () => {
    const body = {
      resource: undefined,
      version: { version: 2, contentHash: "hash", evidenceState: "confirmed", lifecycleState: "active" },
      content: "selected"
    };
    const completion = {
      searchKnowledge: vi.fn(async (_context: unknown, input: { roomId?: string; agentId?: string }) => input.roomId
        ? [{ id: "room-k", kind: "knowledge", title: "Room", scope: { kind: "room", roomId: input.roomId }, evidenceState: "confirmed", lifecycleState: "active", rank: 1 }]
        : [{ id: "agent-k", kind: "knowledge", title: "Agent", scope: { kind: "agent", agentId: input.agentId }, evidenceState: "confirmed", lifecycleState: "active", rank: 1 }, { id: "workspace-k", kind: "knowledge", title: "Workspace", scope: { kind: "workspace" }, evidenceState: "confirmed", lifecycleState: "active", rank: 2 }]),
      searchSkillsPage: vi.fn(async () => ({ items: [{ id: "agent-s", kind: "skill", title: "Skill", scope: { kind: "agent", agentId: "agent-1" }, evidenceState: "confirmed", lifecycleState: "active", rank: 1 }], nextCursor: undefined })),
      listResources: vi.fn(async () => []),
      listSkills: vi.fn(async () => []),
      getResourceBody: vi.fn(async () => body)
    };
    const selector = createPostgresRuntimeExecutionContextSelector(completion as never);
    const selected = await selector.select({ workspaceId: "workspace-1", accountId: "account-1" }, { roomId: "room-1", agentId: "agent-1", query: "hello", limit: 32 });
    expect(selected.roomKnowledge?.map((item) => item.id)).toEqual(["room-k"]);
    expect(selected.agentKnowledge?.map((item) => item.id)).toEqual(["agent-k"]);
    expect(selected.agentSkills?.map((item) => item.id)).toEqual(["agent-s"]);
    expect(selected.agentKnowledge?.some((item) => item.id === "workspace-k")).toBe(false);
  });

  it("projects only explicitly targeted Organization invitations and preserves Account scope", async () => {
    const enqueue = vi.fn(async () => ({
      id: "outbox-invitation",
      sourceKind: "organization_invitation",
      sourceId: "invitation-1",
      sourceRevision: 1,
      kind: "invitation",
      action: "create",
      recipientAccountIds: ["account-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
      processedAt: null,
      attempts: 0,
      nextAttemptAt: "2026-01-01T00:00:00.000Z",
      lastErrorCode: null
    }));
    const bridge = createPostgresOrganizationNotificationBridge({ withContext: vi.fn() } as never, {
      enqueue,
      enqueueInTransaction: vi.fn()
    });
    await bridge.created({
      invitation: {
        id: "invitation-1",
        version: 1,
        targetAccountId: "account-1",
        token: "must-not-be-forwarded"
      }
    });
    await bridge.created({ invitation: { id: "invitation-link", version: 1 } });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind: "organization_invitation",
      sourceId: "invitation-1",
      recipientAccountIds: ["account-1"]
    }));
    expect(enqueue.mock.calls[0]?.[0]).not.toHaveProperty("token");
  });

  it("wraps invitation commands without changing unrelated command receivers", async () => {
    const calls: string[] = [];
    const commands = {
      inviteOrganizationMember: vi.fn(async () => {
        calls.push("invite");
        return { invitation: { id: "invitation-1", version: 1, targetAccountId: "account-1" }, replayed: false };
      })
    };
    const bridge = {
      created: vi.fn(async () => undefined),
      invalidated: vi.fn(async () => undefined),
      reissued: vi.fn(async () => undefined),
      accepted: vi.fn(async () => undefined)
    };
    const facade = createOrganizationNotificationAwareCommands(commands as never, bridge);
    await facade.inviteOrganizationMember({} as never, {} as never);
    expect(calls).toEqual(["invite"]);
    expect(bridge.created).toHaveBeenCalledTimes(1);
  });

  it("does not project an accepted invitation for another Account", async () => {
    const withContext = vi.fn();
    const enqueue = vi.fn(async () => ({
      id: "outbox-invitation",
      sourceKind: "organization_invitation",
      sourceId: "invitation-1",
      sourceRevision: 1,
      kind: "invitation",
      action: "invalidate",
      recipientAccountIds: ["account-1"],
      createdAt: "2026-01-01T00:00:00.000Z",
      processedAt: null,
      attempts: 0,
      nextAttemptAt: "2026-01-01T00:00:00.000Z",
      lastErrorCode: null
    }));
    const bridge = createPostgresOrganizationNotificationBridge({ withContext } as never, {
      enqueue,
      enqueueInTransaction: vi.fn()
    });
    await bridge.accepted({ accountId: "account-1" }, { organizationId: "organization-1", accountId: "account-2" });
    expect(withContext).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
