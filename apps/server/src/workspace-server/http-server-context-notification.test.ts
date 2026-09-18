import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourcePath = path.join(process.cwd(), "apps/server/src/workspace-server/http-server.ts");

describe("standard Server context/notification composition", () => {
  it("injects Context Query and Notification Core into Domain API v1", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain("createPostgresWorkspaceContextQueryService(core.database, config)");
    expect(source).toContain("contextQuery,");
    expect(source).toContain("notifications,");
    expect(source).toContain("createPostgresWorkspaceNotificationService(core.database");
    expect(source).toContain("createOrganizationNotificationAwareCommands(commands, organizationNotificationBridge)");
  });

  it("starts and stops a durable notification projection lane", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain("await notificationProjectionWorker.start()");
    expect(source).toContain("await notificationProjectionWorker.stop()");
    expect(source).toContain("createWorkspaceNotificationProjectionWorker(notifications");
  });

  it("uses the Completion-backed execution selector for Runtime construction", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain("createPostgresRuntimeExecutionContextSelector(completion)");
    expect(source).toContain("runtimeExecutionContexts.set(core.database, runtimeExecutionContext)");
    expect(source).toContain("...(executionContext ? { executionContext } : {})");
    expect(source).not.toContain("workspaceKnowledge");
  });

  it("keeps notification.changed bodyless and does not route invitations through Workspace rooms", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('io.of("/account-notifications")');
    expect(source).toContain("accountNotificationSocketRoom(recipientAccountId)");
    expect(source).toContain('emit("notification.changed", payload)');
    expect(source).toContain("notification_id: notificationId");
    expect(source).toContain("workspace_id: outbox.workspaceId ?? null");
    expect(source).toContain("io.to(accountNotificationSocketRoom(recipientAccountId))");
    expect(source).not.toContain("io.to(workspaceSocketRoom(outbox.workspaceId))");
  });

  it("keeps invitation socket authentication Account-scoped", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('path: "/socket.io/account-notifications"');
    expect(source).toContain("account_notification_workspace_forbidden");
    expect(source).toContain("socket.data.samurai = { accountId }");
  });
});
