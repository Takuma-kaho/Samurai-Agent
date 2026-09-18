import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import {
  buildWorkspaceNotificationOutbox,
  WorkspaceNotificationService,
  type WorkspaceNotificationAuthorizationResolver,
  type WorkspaceNotificationOutbox,
  type WorkspaceNotificationProjectionTransaction,
  type WorkspaceNotificationRecord,
  type WorkspaceNotificationResolution,
  type WorkspaceNotificationStore
} from "./workspace-notification-service";

const now = "2026-09-17T00:00:00.000Z";

describe("WorkspaceNotificationService", () => {
  it("builds only recipient-scoped outbox metadata for all five kinds", () => {
    const cases = [
      { kind: "work_completed", workspaceId: "workspace-a", roomId: "room-a" },
      { kind: "work_failed", workspaceId: "workspace-a", roomId: "room-a" },
      { kind: "approval_required", workspaceId: "workspace-a", roomId: "room-a" },
      { kind: "input_required", workspaceId: "workspace-a", roomId: "room-a" },
      { kind: "invitation" }
    ] as const;
    for (const item of cases) {
      const outbox = buildWorkspaceNotificationOutbox({
        ...item,
        sourceKind: "source",
        sourceId: `${item.kind}-source`,
        sourceRevision: 1,
        recipientAccountIds: ["account-a", "account-a"],
        createdAt: now
      });
      expect(outbox).toMatchObject({ kind: item.kind, sourceKind: "source", sourceRevision: 1, processedAt: null });
      expect(outbox?.recipientAccountIds).toEqual(["account-a"]);
      expect(outbox).not.toHaveProperty("title");
      expect(outbox).not.toHaveProperty("summary");
    }
    expect(buildWorkspaceNotificationOutbox({
      kind: "invitation",
      sourceKind: "source",
      sourceId: "source-empty",
      sourceRevision: 1,
      recipientAccountIds: [],
      createdAt: now
    })).toBeUndefined();
    expect(() => buildWorkspaceNotificationOutbox({
      kind: "work_completed",
      sourceKind: "source",
      sourceId: "missing-room",
      sourceRevision: 1,
      recipientAccountIds: ["account-a"],
      createdAt: now
    })).toThrowError("workspace_notification_room_required");
  });

  it("projects create rows idempotently, keeps invalidate bodyless, and retries failures", async () => {
    const store = new MemoryNotificationStore();
    const service = new WorkspaceNotificationService(store, new AllowingResolver(), { clock: fixedClock(now) });
    store.addOutbox(buildWorkspaceNotificationOutbox({
      id: "outbox-create",
      kind: "work_completed",
      workspaceId: "workspace-a",
      roomId: "room-a",
      sourceKind: "work",
      sourceId: "work-a",
      sourceRevision: 2,
      recipientAccountIds: ["account-a", "account-b"],
      createdAt: now
    })!);

    await expect(service.projectOutbox()).resolves.toMatchObject({ processedIds: ["outbox-create"], failed: [] });
    expect(store.notifications).toHaveLength(2);
    expect(store.notifications[0]).not.toHaveProperty("title");
    store.addOutbox(buildWorkspaceNotificationOutbox({
      id: "outbox-create-duplicate",
      kind: "work_completed",
      workspaceId: "workspace-a",
      roomId: "room-a",
      sourceKind: "work",
      sourceId: "work-a",
      sourceRevision: 2,
      recipientAccountIds: ["account-a", "account-b"],
      createdAt: now
    })!);
    await expect(service.projectOutbox()).resolves.toMatchObject({ processedIds: ["outbox-create-duplicate"], failed: [] });
    expect(store.notifications).toHaveLength(2);
    await expect(service.projectOutbox()).resolves.toMatchObject({ processedIds: [], failed: [] });
    expect(store.notifications).toHaveLength(2);

    store.addOutbox(buildWorkspaceNotificationOutbox({
      id: "outbox-invalidate",
      action: "invalidate",
      kind: "work_completed",
      workspaceId: "workspace-a",
      roomId: "room-a",
      sourceKind: "work",
      sourceId: "work-a",
      sourceRevision: 3,
      recipientAccountIds: ["account-a", "account-b"],
      createdAt: now
    })!);
    await expect(service.projectOutbox()).resolves.toMatchObject({ processedIds: ["outbox-invalidate"], failed: [] });
    expect(store.notifications).toHaveLength(2);

    store.addOutbox(buildWorkspaceNotificationOutbox({
      id: "outbox-retry",
      kind: "work_failed",
      workspaceId: "workspace-a",
      roomId: "room-a",
      sourceKind: "work",
      sourceId: "work-failed",
      sourceRevision: 1,
      recipientAccountIds: ["account-a"],
      createdAt: now
    })!);
    store.failProjection = true;
    const failed = await service.projectOutbox();
    expect(failed.failed).toEqual([{ outboxId: "outbox-retry", errorCode: "workspace_notification_projection_failed" }]);
    expect(store.outbox("outbox-retry")).toMatchObject({ processedAt: null, attempts: 1, lastErrorCode: "workspace_notification_projection_failed" });
    expect(store.notifications).toHaveLength(2);
    store.failProjection = false;
    const retryAt = new Date(new Date(now).getTime() + 2_000).toISOString();
    await expect(service.projectOutbox({ now: retryAt })).resolves.toMatchObject({ processedIds: ["outbox-retry"], failed: [] });
    expect(store.notifications).toHaveLength(3);
  });

  it("rechecks current authorization, filters resolved unread items, and keeps unknown kinds safe", async () => {
    const store = new MemoryNotificationStore();
    const resolver = new AllowingResolver();
    resolver.resolvedSourceIds.add("request-resolved");
    resolver.deniedRoomIds.add("room-denied");
    const service = new WorkspaceNotificationService(store, resolver, { clock: fixedClock(now) });
    store.addNotification(record({ id: "notification-work", kind: "work_completed", sourceId: "work-a" }));
    store.addNotification(record({ id: "notification-resolved", kind: "input_required", sourceId: "request-resolved" }));
    store.addNotification(record({ id: "notification-denied", kind: "approval_required", sourceId: "request-denied", roomId: "room-denied" }));
    store.addNotification(record({ id: "notification-unknown", kind: "future_kind", sourceId: "future", roomId: "room-a" }));
    store.addNotification(record({ id: "notification-invitation", kind: "invitation", sourceId: "invite-a", workspaceId: undefined, roomId: undefined }));

    const page = await service.listNotifications({ accountId: "account-a", workspaceId: "workspace-a" }, { limit: 10 });
    expect(page.items.map((item) => item.id)).toEqual(["notification-work", "notification-unknown", "notification-resolved"]);
    const unreadPage = await service.listNotifications({ accountId: "account-a", workspaceId: "workspace-a" }, { unreadOnly: true, limit: 10 });
    expect(unreadPage.items.map((item) => item.id)).toEqual(["notification-work", "notification-unknown"]);
    expect(page.items.find((item) => item.id === "notification-unknown")).toMatchObject({
      kind: "future_kind",
      title: "新しい通知があります",
      target: { kind: "room", roomId: "room-a" },
      actionState: "not_required"
    });
    expect(await service.notificationSummary({ accountId: "account-a", workspaceId: "workspace-a" })).toMatchObject({ unreadCount: 2, asOf: now });
    expect(await service.listWorkspaceNotificationSummaries({ accountId: "account-a" }, ["workspace-a", "workspace-other"]))
      .toEqual([{ workspaceId: "workspace-a", unreadCount: 2, asOf: now }]);
    expect((await service.listInvitationNotifications({ accountId: "account-a" })).items).toMatchObject([{ id: "notification-invitation", kind: "invitation" }]);
    expect(resolver.resolveCalls).toBeGreaterThanOrEqual(8);
  });

  it("authorizes every read ID before mutation and preserves read_at on replay", async () => {
    const store = new MemoryNotificationStore();
    const resolver = new AllowingResolver();
    resolver.deniedSourceIds.add("source-denied");
    let currentTime = now;
    const service = new WorkspaceNotificationService(store, resolver, { clock: () => new Date(currentTime) });
    store.addNotification(record({ id: "notification-allowed", sourceId: "source-allowed" }));
    store.addNotification(record({ id: "notification-denied", sourceId: "source-denied" }));

    await expect(service.markNotificationsRead({ accountId: "account-a", workspaceId: "workspace-a" }, ["notification-allowed", "notification-denied"]))
      .rejects.toMatchObject({ code: "workspace_notification_read_denied", status: 403 });
    expect(store.outReadAt("notification-allowed")).toBeNull();
    expect(store.outReadAt("notification-denied")).toBeNull();

    const first = await service.markNotificationsRead({ accountId: "account-a", workspaceId: "workspace-a" }, ["notification-allowed"]);
    expect(first).toMatchObject({ updatedIds: ["notification-allowed"], alreadyReadIds: [], readAt: now });
    currentTime = "2026-09-17T00:00:10.000Z";
    const second = await service.markNotificationsRead({ accountId: "account-a", workspaceId: "workspace-a" }, ["notification-allowed"]);
    expect(second).toMatchObject({ updatedIds: [], alreadyReadIds: ["notification-allowed"], readAt: now });
    expect(store.outReadAt("notification-allowed")).toBe(now);

    await expect(service.markInvitationNotificationsRead({ accountId: "account-a" }, ["notification-allowed"]))
      .rejects.toMatchObject({ code: "workspace_notification_read_denied" });
  });
});

function record(input: Partial<WorkspaceNotificationRecord> = {}): WorkspaceNotificationRecord {
  return {
    id: "notification-default",
    recipientAccountId: "account-a",
    workspaceId: "workspace-a",
    roomId: "room-a",
    kind: "work_completed",
    sourceKind: "work",
    sourceId: "source-default",
    sourceRevision: 1,
    createdAt: now,
    readAt: null,
    ...input
  };
}

function fixedClock(initial: string): (() => Date) {
  return () => new Date(initial);
}

class AllowingResolver implements WorkspaceNotificationAuthorizationResolver {
  readonly deniedRoomIds = new Set<string>();
  readonly deniedSourceIds = new Set<string>();
  readonly resolvedSourceIds = new Set<string>();
  resolveCalls = 0;

  async authorizeWorkspace(input: { accountId: string; workspaceId: string }): Promise<boolean> {
    return input.accountId === "account-a" && input.workspaceId === "workspace-a";
  }

  async resolveNotification(input: { accountId: string; workspaceId?: string; notification: WorkspaceNotificationRecord }): Promise<WorkspaceNotificationResolution> {
    this.resolveCalls += 1;
    const notification = input.notification;
    if (notification.recipientAccountId !== input.accountId) return { allowed: false };
    if (notification.roomId && this.deniedRoomIds.has(notification.roomId)) return { allowed: false };
    if (this.deniedSourceIds.has(notification.sourceId)) return { allowed: false };
    if (input.workspaceId === undefined && notification.kind === "invitation" && notification.sourceId === "joined-invite") return { allowed: false };
    return {
      allowed: true,
      actionState: this.resolvedSourceIds.has(notification.sourceId) ? "resolved" : undefined,
      title: notification.kind === "future_kind" ? undefined : `表示:${notification.kind}`,
      summary: "安全な表示",
      target: notification.kind === "invitation"
        ? { kind: "invitation", invitationId: notification.sourceId }
        : undefined
    };
  }
}

class MemoryNotificationStore implements WorkspaceNotificationStore {
  private readonly outboxes = new Map<string, WorkspaceNotificationOutbox>();
  private readonly notificationRecords = new Map<string, WorkspaceNotificationRecord>();
  failProjection = false;

  get notifications(): WorkspaceNotificationRecord[] {
    return [...this.notificationRecords.values()].map((item) => structuredClone(item));
  }

  addOutbox(outbox: WorkspaceNotificationOutbox): void {
    this.outboxes.set(outbox.id, structuredClone(outbox));
  }

  addNotification(notification: WorkspaceNotificationRecord): void {
    this.notificationRecords.set(notification.id, structuredClone(notification));
  }

  outbox(id: string): WorkspaceNotificationOutbox | undefined {
    const outbox = this.outboxes.get(id);
    return outbox ? structuredClone(outbox) : undefined;
  }

  outReadAt(id: string): string | null | undefined {
    return this.notificationRecords.get(id)?.readAt;
  }

  async listPendingOutboxes(input: { now: string; limit: number }): Promise<readonly WorkspaceNotificationOutbox[]> {
    return [...this.outboxes.values()]
      .filter((outbox) => outbox.processedAt === null && outbox.nextAttemptAt <= input.now)
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map((outbox) => structuredClone(outbox));
  }

  async withOutboxTransaction<T>(
    outboxId: string,
    action: (transaction: WorkspaceNotificationProjectionTransaction, outbox: WorkspaceNotificationOutbox) => Promise<T>
  ): Promise<T> {
    const outbox = this.outboxes.get(outboxId);
    if (!outbox) throw new Error("outbox_not_found");
    const stagedNotifications = new Map([...this.notificationRecords.entries()].map(([id, item]) => [id, structuredClone(item)]));
    const stagedOutbox = structuredClone(outbox);
    const transaction: WorkspaceNotificationProjectionTransaction = {
      insertNotification: async (notification) => {
        if (this.failProjection) throw new Error("projection_failure");
        if (stagedNotifications.has(notification.id)) return "existing";
        stagedNotifications.set(notification.id, structuredClone(notification));
        return "inserted";
      },
      markOutboxProcessed: async (processedAt) => {
        if (this.failProjection) throw new Error("projection_failure");
        stagedOutbox.processedAt = processedAt;
      }
    };
    const result = await action(transaction, stagedOutbox);
    this.notificationRecords.clear();
    for (const [id, item] of stagedNotifications) this.notificationRecords.set(id, item);
    this.outboxes.set(outboxId, stagedOutbox);
    return result;
  }

  async markOutboxFailure(input: { outboxId: string; attempts: number; nextAttemptAt: string; lastErrorCode: string }): Promise<void> {
    const outbox = this.outboxes.get(input.outboxId);
    if (!outbox) throw new Error("outbox_not_found");
    outbox.attempts = input.attempts;
    outbox.nextAttemptAt = input.nextAttemptAt;
    outbox.lastErrorCode = input.lastErrorCode;
    outbox.processedAt = null;
  }

  async listNotifications(input: { accountId: string; workspaceId?: string; invitationOnly?: boolean }): Promise<readonly WorkspaceNotificationRecord[]> {
    return [...this.notificationRecords.values()]
      .filter((record) => record.recipientAccountId === input.accountId)
      .filter((record) => input.workspaceId === undefined || record.workspaceId === input.workspaceId)
      .filter((record) => !input.invitationOnly || record.kind === "invitation")
      .map((record) => structuredClone(record));
  }

  async getNotifications(input: { accountId: string; notificationIds: readonly string[] }): Promise<readonly WorkspaceNotificationRecord[]> {
    return input.notificationIds
      .map((id) => this.notificationRecords.get(id))
      .filter((record): record is WorkspaceNotificationRecord => Boolean(record && record.recipientAccountId === input.accountId))
      .map((record) => structuredClone(record));
  }

  async markNotificationsRead(input: { accountId: string; workspaceId?: string; notificationIds: readonly string[]; readAt: string }): Promise<readonly WorkspaceNotificationRecord[]> {
    const records = input.notificationIds.map((id) => this.notificationRecords.get(id));
    if (records.some((record) => !record || record.recipientAccountId !== input.accountId || input.workspaceId !== undefined && record.workspaceId !== input.workspaceId)) {
      throw new Error("read_target_not_found");
    }
    for (const record of records) if (record!.readAt === null) record!.readAt = input.readAt;
    return records.map((record) => structuredClone(record!));
  }
}
