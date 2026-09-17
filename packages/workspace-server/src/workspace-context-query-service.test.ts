import { describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import type { WorkspaceSql } from "./postgres";
import { WorkspaceServerError } from "./errors";
import {
  WorkspaceContextQueryService,
  type WorkspaceContextQueryDatabase,
  type WorkspaceContextQueryContext,
  type WorkspaceContextSearchItem
} from "./workspace-context-query-service";

interface TestRow extends QueryResultRow {
  type: string;
  id: string;
  room_id: string;
  title: string;
  body: string;
  updated_at: string;
  work_id?: string;
}

class FakeDatabase implements WorkspaceContextQueryDatabase {
  rows: TestRow[] = [];
  calls: Array<{ context: WorkspaceContextQueryContext; text: string; values: readonly unknown[] | undefined }> = [];

  async withReadSnapshot<T>(context: WorkspaceContextQueryContext, action: (sql: WorkspaceSql) => Promise<T>): Promise<T> {
    const sql = {
      query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        this.calls.push({ context, text, values });
        return { rows: this.rows as unknown as Row[] };
      }
    } as WorkspaceSql;
    return action(sql);
  }
}

const context: WorkspaceContextQueryContext = {
  accountId: "account-search",
  workspaceId: "workspace-search"
};

function createService(database: FakeDatabase, now: () => Date = () => new Date("2026-09-17T00:10:00.000Z")): WorkspaceContextQueryService {
  return new WorkspaceContextQueryService({
    database,
    origin: "https://samurai.example",
    cursorSecret: "context-query-test-secret",
    now
  });
}

function candidateRows(): TestRow[] {
  return [
    {
      type: "room",
      id: "room-a",
      room_id: "room-a",
      title: "Ａｌｐｈａ　Beta",
      body: "Ａｌｐｈａ　Beta",
      updated_at: "2026-09-17T00:02:00.000Z"
    },
    {
      type: "knowledge",
      id: "knowledge-a",
      room_id: "room-a",
      title: "Alpha Beta Notes",
      body: "prefix ".repeat(20) + "<b>alpha</b> and beta " + "tail ".repeat(60),
      updated_at: "2026-09-17T00:09:00.000Z"
    },
    {
      type: "conversation",
      id: "message-a",
      room_id: "room-a",
      title: "Work thread",
      body: "The alpha result also contains beta.",
      work_id: "work-a",
      updated_at: "2026-09-17T00:08:00.000Z"
    }
  ];
}

function expectServerError(error: unknown, code: string, status = 400): void {
  expect(error).toBeInstanceOf(WorkspaceServerError);
  expect(error).toMatchObject({ code, status });
}

describe("WorkspaceContextQueryService", () => {
  it("normalizes Unicode terms, performs AND matching, orders by the stable key, and returns limit+1 cursor", async () => {
    const database = new FakeDatabase();
    database.rows = candidateRows();
    const service = createService(database);

    const page = await service.search(context, {
      q: " ＡＬＰＨＡ　 beta alpha ",
      limit: 2
    });

    expect(page.items.map((item) => [item.type, item.id])).toEqual([
      ["room", "room-a"],
      ["knowledge", "knowledge-a"]
    ]);
    expect(page.next_cursor).toEqual(expect.any(String));
    expect(page.items[1]?.snippet).not.toContain("<b>");
    expect(page.items[1]?.snippet.length).toBeLessThanOrEqual(200);

    const call = database.calls[0]!;
    expect(call.text).toContain("JOIN workspace_members");
    expect(call.text).toContain("samurai_can_room(room.workspace_id, room.id, 'read')");
    expect(call.text).toContain("resource.scope_kind = 'room'");
    expect(call.text).toContain("resource.current_confirmed_version");
    expect(call.text).toContain("projection.resource_version = current_version.version");
    expect(call.text).toContain("LIKE ALL($6::TEXT[])");
    expect(call.values?.[0]).toBe(context.workspaceId);
    expect(call.values?.[1]).toBe(context.accountId);
    expect(call.values?.[4]).toEqual(["room", "conversation", "knowledge"]);
    expect(call.values?.[5]).toEqual(["%alpha%", "%beta%"]);
  });

  it("continues from the signed cursor without reintroducing rows newer than as_of", async () => {
    const database = new FakeDatabase();
    database.rows = candidateRows();
    const service = createService(database);
    const first = await service.search(context, { q: "alpha beta", limit: 1 });
    expect(first.next_cursor).toEqual(expect.any(String));

    database.rows = [
      ...candidateRows(),
      {
        type: "knowledge",
        id: "newer-knowledge",
        room_id: "room-a",
        title: "Alpha Beta New",
        body: "alpha beta",
        updated_at: "2026-09-17T00:11:00.000Z"
      }
    ];
    const second = await service.search(context, { q: "alpha beta", limit: 1, cursor: first.next_cursor! });
    expect(second.items.map((item) => item.id)).toEqual(["knowledge-a"]);
    expect(second.next_cursor).toEqual(expect.any(String));
    expect(database.calls).toHaveLength(2);
  });

  it("rejects invalid input, tampered cursors, scope changes, and expiry", async () => {
    const database = new FakeDatabase();
    database.rows = candidateRows();
    let currentNow = new Date("2026-09-17T00:10:00.000Z");
    const service = createService(database, () => currentNow);
    const first = await service.search(context, { q: "alpha beta", limit: 1 });
    const cursor = first.next_cursor!;

    await expect(service.search(context, { q: "   " })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "workspace_search_query_invalid");
      return true;
    });
    await expect(service.search(context, { q: "alpha", types: ["room", "room"] })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "workspace_search_types_invalid");
      return true;
    });
    await expect(service.search(context, { q: "alpha", limit: 101 })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "workspace_search_limit_invalid");
      return true;
    });

    const tampered = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
    await expect(service.search(context, { q: "alpha beta", limit: 1, cursor: tampered })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "search_cursor_invalid");
      return true;
    });
    await expect(service.search({ ...context, accountId: "other-account" }, { q: "alpha beta", limit: 1, cursor })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "search_cursor_invalid");
      return true;
    });

    currentNow = new Date("2026-09-17T00:26:00.000Z");
    await expect(service.search(context, { q: "alpha beta", limit: 1, cursor })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "search_cursor_invalid");
      return true;
    });
  });

  it("re-authorizes a result when opening its detail", async () => {
    const database = new FakeDatabase();
    database.rows = candidateRows();
    const service = createService(database);

    const result = await service.getSearchItem(context, { type: "conversation", id: "message-a", room_id: "room-a" });
    expect(result).toMatchObject<Partial<WorkspaceContextSearchItem>>({
      type: "conversation",
      id: "message-a",
      room_id: "room-a",
      target: { kind: "work", room_id: "room-a", work_id: "work-a", message_id: "message-a" }
    });
    expect(database.calls[0]?.text).toContain("samurai_can_room(room.workspace_id, room.id, 'read')");

    database.rows = [];
    await expect(service.getSearchItem(context, { type: "conversation", id: "message-a" })).rejects.toSatisfy((error: unknown) => {
      expectServerError(error, "search_result_not_found", 404);
      return true;
    });
  });
});
