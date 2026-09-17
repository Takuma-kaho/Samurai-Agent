import { createServer } from "node:http";
import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { mountDomainApiV1, resolveExecutionPersonalPreferences, type V1Dependencies } from "./domain-api-v1";

const timestamp = "2026-09-17T00:00:00.000Z";

function createContextNotificationApp(options: {
  withServices?: boolean;
  notificationReadError?: WorkspaceServerError;
} = {}) {
  const app = express();
  app.use(express.json());

  const contextQuery = {
    search: vi.fn(async () => ({
      items: [{
        type: "room",
        id: "room_1",
        room_id: "room_1",
        title: "Alpha room",
        snippet: "A relevant result",
        updated_at: timestamp,
        target: { kind: "room", room_id: "room_1" }
      }],
      next_cursor: null
    }))
  };
  const notification = {
    id: "notification_1",
    kind: "work_completed",
    createdAt: timestamp,
    readAt: null,
    title: "Work completed",
    summary: "The work is complete.",
    target: { kind: "work", roomId: "room_1", workId: "work_1", messageId: "message_1" },
    actionState: "not_required"
  } as const;
  const invitation = {
    ...notification,
    id: "notification_invitation",
    kind: "invitation",
    title: "Invitation",
    target: { kind: "invitation", invitationId: "invitation_1" }
  } as const;
  const notifications = {
    listNotifications: vi.fn(async () => ({ items: [notification], nextCursor: "cursor_2" })),
    notificationSummary: vi.fn(async () => ({ unreadCount: 1, asOf: timestamp })),
    markNotificationsRead: vi.fn(async () => {
      if (options.notificationReadError) throw options.notificationReadError;
      return { updatedIds: ["notification_1"], alreadyReadIds: [], readAt: timestamp };
    }),
    listWorkspaceNotificationSummaries: vi.fn(async () => [{ workspaceId: "workspace_1", unreadCount: 1, asOf: timestamp }]),
    listInvitationNotifications: vi.fn(async () => ({ items: [invitation], nextCursor: null })),
    markInvitationNotificationsRead: vi.fn(async () => ({ updatedIds: ["notification_invitation"], alreadyReadIds: [], readAt: timestamp }))
  };
  const organizationContext = vi.fn((_req: unknown, organizationId?: string, options?: { mutation?: boolean }) => ({
    accountId: "account_1",
    requestId: "request_1",
    operationId: options?.mutation ? "operation_mutation" : "operation_read",
    ...(organizationId ? { organizationId } : {})
  }));
  const dependencies = {
    app,
    io: { on: vi.fn(), sockets: { adapter: { rooms: new Map() }, sockets: new Map() } },
    store: {},
    commands: {},
    artifacts: {},
    generatedSurfaces: {},
    interactionRequests: {},
    realtimeGate: { run: async (_workspaceId: string, callback: () => unknown) => callback() },
    authenticateWorkspace: (_req: unknown, _res: unknown, next: () => void) => next(),
    authenticateAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
    asyncRoute: (handler: (req: never, res: never, next: never) => Promise<void>) => (req: never, res: never, next: never) => {
      void handler(req, res, next).catch(next);
    },
    workspaceContext: (req: { params: Record<string, string> }) => ({ workspaceId: req.params.workspaceId!, accountId: "account_1" }),
    operationContext: (req: { params: Record<string, string>; get: (name: string) => string | undefined }) => ({
      workspaceId: req.params.workspaceId!,
      accountId: "account_1",
      operationId: req.get("x-samurai-operation-id") ?? "operation_default"
    }),
    organizationContext,
    requestId: () => "request_1",
    runtimeFor: () => ({}),
    backendRegistry: { statuses: () => [] },
    ...(options.withServices === false ? {} : { contextQuery, notifications })
  } as unknown as V1Dependencies;

  mountDomainApiV1(dependencies);
  app.use((error: { status?: number; code?: string }, _req: unknown, res: { status: (status: number) => { json: (body: unknown) => void } }, _next: unknown) => {
    res.status(error.status ?? 500).json({ error: { code: error.code ?? "test_error" } });
  });
  return { app, contextQuery, notifications, organizationContext };
}

async function withServer<T>(app: Express, callback: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function request(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as { result?: any; error?: { code?: string } } };
}

describe("Domain API v1 Context/Notification boundary", () => {
  it("allows the Account snapshot only at the execution boundary", () => {
    const personalPreferences = {
      schema_version: 1 as const,
      revision: 2,
      display_name: "Takuma",
      output_locale: "ja" as const,
      instructions: "Keep it concise."
    };
    expect(resolveExecutionPersonalPreferences("room.work.create", { personal_preferences: personalPreferences }, {})).toEqual(personalPreferences);
    expect(resolveExecutionPersonalPreferences("chat.turn.run", { personal_preferences: personalPreferences }, {
      personal_preferences: personalPreferences
    })).toEqual(personalPreferences);
    expect(() => resolveExecutionPersonalPreferences("workspace.search", { personal_preferences: personalPreferences }, {})).toThrowError(expect.objectContaining({ code: "personal_preferences_not_allowed" }));
    expect(() => resolveExecutionPersonalPreferences("room.work.create", {}, {
      personal_preferences: { ...personalPreferences, revision: 3 }
    })).toThrowError(expect.objectContaining({ code: "personal_preferences_input_forbidden" }));
    expect(() => resolveExecutionPersonalPreferences("chat.turn.run", { personal_preferences: personalPreferences }, {
      personal_preferences: { ...personalPreferences, revision: 3 }
    })).toThrowError(expect.objectContaining({ code: "personal_preferences_conflict" }));
  });

  it("dispatches Workspace search, notification list/summary, and mark-read through injected services", async () => {
    const mounted = createContextNotificationApp();
    await withServer(mounted.app, async (baseUrl) => {
      const search = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/queries/workspace.search", {
        context: {},
        input: { q: "alpha", types: ["room"], limit: 10 }
      });
      expect(search.status).toBe(200);
      expect(search.body.result).toEqual(expect.objectContaining({
        items: [expect.objectContaining({ room_id: "room_1", target: { kind: "room", room_id: "room_1" } })],
        next_cursor: null
      }));
      expect(mounted.contextQuery.search).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        expect.objectContaining({ q: "alpha", types: ["room"], limit: 10 })
      );

      const list = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/queries/notification.list", {
        context: {},
        input: { limit: 10, unread_only: true }
      });
      expect(list.status).toBe(200);
      expect(list.body.result.items[0]).toEqual(expect.objectContaining({
        id: "notification_1",
        created_at: timestamp,
        read_at: null,
        target: { kind: "work", room_id: "room_1", work_id: "work_1", message_id: "message_1" }
      }));
      expect(list.body.result.items[0]).not.toHaveProperty("sourceKind");
      expect(list.body.result.items[0]).not.toHaveProperty("recipientAccountId");

      const summary = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/queries/notification.summary", {
        context: {},
        input: {}
      });
      expect(summary.status).toBe(200);
      expect(summary.body.result).toEqual({ unread_count: 1, as_of: timestamp });

      const marked = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/operations/notification.mark_read", {
        context: {},
        input: { notification_ids: ["notification_1"] }
      }, { "x-samurai-operation-id": "operation_1" });
      expect(marked.status).toBe(201);
      expect(marked.body.result).toEqual({ updated_ids: ["notification_1"], already_read_ids: [], read_at: timestamp });
      expect(mounted.notifications.markNotificationsRead).toHaveBeenCalledWith(
        { workspaceId: "workspace_1", accountId: "account_1" },
        ["notification_1"]
      );
    });
  });

  it("dispatches Account operations without Organization membership and keeps account_id out of input", async () => {
    const mounted = createContextNotificationApp();
    await withServer(mounted.app, async (baseUrl) => {
      const catalogResponse = await fetch(`${baseUrl}/api/v1/domain/catalog`);
      const catalog = await catalogResponse.json() as { contracts: Array<{ id: string }> };
      expect(catalog.contracts.map((contract) => contract.id)).toEqual(expect.arrayContaining([
        "account.workspace_notification_summaries",
        "account.invitation_notifications",
        "account.invitation_notification_read"
      ]));

      const summaries = await request(baseUrl, "/api/v1/domain/queries/account.workspace_notification_summaries", {
        context: {},
        input: { workspace_ids: ["workspace_1"] }
      });
      expect(summaries.status).toBe(200);
      expect(summaries.body.result).toEqual({ items: [{ workspace_id: "workspace_1", unread_count: 1, as_of: timestamp }] });
      expect(mounted.notifications.listWorkspaceNotificationSummaries).toHaveBeenCalledWith(
        { accountId: "account_1" },
        ["workspace_1"]
      );
      expect(mounted.organizationContext).toHaveBeenCalledWith(expect.anything(), undefined, { mutation: false });

      const invitations = await request(baseUrl, "/api/v1/domain/queries/account.invitation_notifications", {
        context: {},
        input: { limit: 10 }
      });
      expect(invitations.status).toBe(200);
      expect(invitations.body.result.items[0]).toEqual(expect.objectContaining({
        kind: "invitation",
        target: { kind: "invitation", invitation_id: "invitation_1" }
      }));

      const marked = await request(baseUrl, "/api/v1/domain/operations/account.invitation_notification_read", {
        context: {},
        input: { notification_ids: ["notification_invitation"] }
      }, { "x-samurai-operation-id": "operation_invitation", "idempotency-key": "operation_invitation" });
      expect(marked.status).toBe(201);
      expect(marked.body.result).toEqual({ updated_ids: ["notification_invitation"], already_read_ids: [], read_at: timestamp });
      expect(mounted.organizationContext).toHaveBeenCalledWith(expect.anything(), undefined, { mutation: true });

      const strict = await request(baseUrl, "/api/v1/domain/queries/account.workspace_notification_summaries", {
        context: {},
        input: { workspace_ids: ["workspace_1"], account_id: "other_account" }
      });
      expect(strict.status).toBe(400);
      expect(strict.body.error?.code).toBe("domain_api_input_invalid");

      const organizationRoute = await request(baseUrl, "/api/v1/organizations/org_1/domain/queries/account.workspace_notification_summaries", {
        context: {},
        input: { workspace_ids: ["workspace_1"] }
      });
      expect(organizationRoute.status).toBe(404);
      expect(organizationRoute.body.error?.code).toBe("domain_query_not_available");
    });
  });

  it("preserves Core mixed-ID read rejection and fails closed when services are not injected", async () => {
    const mixedIdError = new WorkspaceServerError("workspace_notification_read_denied", 403);
    const mounted = createContextNotificationApp({ notificationReadError: mixedIdError });
    await withServer(mounted.app, async (baseUrl) => {
      const rejected = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/operations/notification.mark_read", {
        context: {},
        input: { notification_ids: ["notification_1", "notification_from_other_workspace"] }
      }, { "x-samurai-operation-id": "operation_mixed" });
      expect(rejected.status).toBe(403);
      expect(rejected.body.error?.code).toBe("workspace_notification_read_denied");
    });

    const unavailable = createContextNotificationApp({ withServices: false });
    await withServer(unavailable.app, async (baseUrl) => {
      const search = await request(baseUrl, "/api/v1/workspaces/workspace_1/domain/queries/workspace.search", {
        context: {},
        input: { q: "alpha" }
      });
      expect(search.status).toBe(503);
      expect(search.body.error?.code).toBe("domain_operation_not_available");

      const accountSummary = await request(baseUrl, "/api/v1/domain/queries/account.workspace_notification_summaries", {
        context: {},
        input: { workspace_ids: ["workspace_1"] }
      });
      expect(accountSummary.status).toBe(503);
      expect(accountSummary.body.error?.code).toBe("domain_operation_not_available");
    });
  });
});
