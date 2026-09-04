import { describe, expect, it } from "vitest";
import type { PostgresWorkspaceDatabase, WorkspaceServerStore } from "@samurai-agent/workspace-server";
import { PostgresRuntimeClientEvents } from "./postgres-runtime-client-events";

const context = {
  workspaceId: "workspace-client-events-test",
  accountId: "account-client-events-test",
  operationId: "client-event-save-test"
} as const;

describe("PostgresRuntimeClientEvents", () => {
  it("normalizes PostgreSQL TIMESTAMPTZ Date values returned from client_event_save", async () => {
    const insertedRow = {
      workspace_id: context.workspaceId,
      id: "client_event_test",
      room_id: "room-client-events-test",
      target_client_kind: "desktop",
      target_client_id: "desktop-test",
      event_type: "client.notification.requested",
      status: "acked",
      payload: { title: "Runが完了しました" },
      resource_refs: [],
      created_at: new Date("2026-09-04T00:00:00.123Z"),
      delivered_at: new Date("2026-09-04T00:00:01.456Z"),
      acked_at: new Date("2026-09-04T00:00:02.789Z"),
      expires_at: new Date("2026-09-04T01:00:00.000Z"),
      error_code: null
    };
    const sql = {
      query: async (text: string) => text.includes("INSERT INTO workspace_runtime_client_events")
        ? { rows: [insertedRow] }
        : { rows: [] }
    };
    const store = {
      runIdempotentResult: async (_requestContext: unknown, _request: unknown, action: (value: typeof sql) => Promise<unknown>) => ({
        value: await action(sql),
        replayed: false
      }),
      insertAudit: async () => undefined
    } as unknown as WorkspaceServerStore;
    const event = await new PostgresRuntimeClientEvents(
      {} as PostgresWorkspaceDatabase,
      store
    ).save(context, {
      id: insertedRow.id,
      room_id: insertedRow.room_id,
      target_client_kind: "desktop",
      target_client_id: insertedRow.target_client_id,
      event_type: insertedRow.event_type,
      status: "acked",
      payload: insertedRow.payload,
      resource_refs: [],
      created_at: insertedRow.created_at.toISOString(),
      delivered_at: insertedRow.delivered_at.toISOString(),
      acked_at: insertedRow.acked_at.toISOString(),
      expires_at: insertedRow.expires_at.toISOString()
    });

    expect(event.event).toMatchObject({
      created_at: "2026-09-04T00:00:00.123Z",
      delivered_at: "2026-09-04T00:00:01.456Z",
      acked_at: "2026-09-04T00:00:02.789Z",
      expires_at: "2026-09-04T01:00:00.000Z"
    });
    expect(event.replayed).toBe(false);
  });
});
