import { describe, expect, it } from "vitest";
import type { CollectionPatch, CollectionRecord, CollectionSchema } from "@samurai-agent/core-schemas";
import { WorkspaceServerError, type WorkspaceRecord } from "@samurai-agent/workspace-server";
import { PostgresCollection } from "./postgres-collection";

const context = {
  workspaceId: "workspace-collection-test",
  accountId: "account-collection-test",
  operationId: "operation-collection-test",
  caller: { kind: "human", accountId: "account-collection-test" }
} as const;

function schema(triggers: CollectionSchema["triggers"] = []): CollectionSchema {
  return {
    id: "orders",
    version: "1",
    labels: { en: "Orders" },
    descriptions: { en: "Orders" },
    fields: [
      { id: "customer_id", type: "string", label: "Customer" },
      { id: "status", type: "string", label: "Status" }
    ],
    refs: [{ id: "customer", field: "customer_id", collection_id: "customers" }],
    embeds: [],
    derived_fields: [],
    triggers,
    actions: [],
    views: [{ id: "orders_table", renderer: "collection_table", label: "Orders" }],
    permissions: {}
  };
}

function record(collectionId: string, id: string, data: Record<string, string>): CollectionRecord {
  return { id, collection_id: collectionId, data, resource_refs: [], created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z", version: 1 };
}

class FakeFiles {
  private readonly values = new Map<string, { content: Buffer; version: number }>();

  async read(_context: unknown, input: { roomId: string; path: string }) {
    const value = this.values.get(`${input.roomId}:${input.path}`);
    if (!value) throw new WorkspaceServerError("workspace_file_not_found", 404);
    return { file: { path: input.path, version: value.version }, content: value.content };
  }

  async write(_context: unknown, input: { roomId: string; path: string; content: Buffer; expectedVersion: number }) {
    const key = `${input.roomId}:${input.path}`;
    const current = this.values.get(key);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("workspace_file_version_conflict");
    const next = { content: Buffer.from(input.content), version: input.expectedVersion + 1 };
    this.values.set(key, next);
    return { file: { path: input.path, version: next.version } };
  }

  async remove(_context: unknown, input: { roomId: string; path: string; expectedVersion: number }) {
    const key = `${input.roomId}:${input.path}`;
    const current = this.values.get(key);
    if (!current || current.version !== input.expectedVersion) throw new Error("workspace_file_version_conflict");
    this.values.delete(key);
    return { file: { path: input.path, version: current.version + 1 } };
  }
}

class FakeCommands {
  private readonly rows = new Map<string, WorkspaceRecord>();

  async putRecord(_context: unknown, input: { roomId: string; recordType: string; id: string; expectedVersion: number; payload: Record<string, unknown>; searchText?: string }) {
    const key = `${input.roomId}:${input.recordType}:${input.id}`;
    const current = this.rows.get(key);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new Error("workspace_record_version_conflict");
    const record: WorkspaceRecord = { id: input.id, room_id: input.roomId, record_type: input.recordType, version: input.expectedVersion + 1, payload: input.payload as never, search_text: input.searchText ?? "", created_at: "2026-08-24T00:00:00.000Z", updated_at: "2026-08-24T00:00:00.000Z" };
    this.rows.set(key, record);
    return { record, event: {} as never, replayed: false };
  }

  async getRecord(_context: unknown, input: { roomId: string; recordType: string; id: string }) {
    const value = this.rows.get(`${input.roomId}:${input.recordType}:${input.id}`);
    if (!value) throw new WorkspaceServerError("workspace_record_not_found", 404);
    return value;
  }

  async listRecords(_context: unknown, input: { roomId: string; recordType: string }) {
    return [...this.rows.values()].filter((row) => row.room_id === input.roomId && row.record_type === input.recordType);
  }

  async assertRoomExecutable() {}
}

describe("PostgreSQL Collection compatibility surface", () => {
  it("keeps schema, records, patch history, and linked-record resolution on the PG port", async () => {
    const commands = new FakeCommands();
    const files = new FakeFiles();
    const collections = new PostgresCollection(commands as never, files as never);
    await collections.saveSchema(context, "room-collection-test", schema(), 0);
    await collections.saveSchema({ ...context, operationId: "customer-schema" }, "room-collection-test", { ...schema(), id: "customers", refs: [{ id: "name", field: "name" }], fields: [{ id: "name", type: "string", label: "Name" }] }, 0);
    await collections.createRecord({ ...context, operationId: "customer-create" }, "room-collection-test", record("customers", "customer-1", { name: "Ada" }));
    await collections.createRecord({ ...context, operationId: "order-create" }, "room-collection-test", record("orders", "order-1", { customer_id: "customer-1", status: "open" }));

    const resolution = await collections.resolveRecordRefs(context, "room-collection-test", "orders", "order-1");
    expect(resolution.resolved_refs).toHaveLength(1);
    expect(resolution.resolved_refs[0]?.record.id).toBe("customer-1");

    const patched = await collections.applyPatch({ ...context, operationId: "order-patch" }, "room-collection-test", "orders", "order-1", { changes: { status: "closed" }, expected_version: 1 });
    expect(patched.data.status).toBe("closed");
    expect(await collections.listPatches(context, "room-collection-test", "orders", "order-1")).toHaveLength(1);
    const patch = (await collections.listPatches(context, "room-collection-test", "orders", "order-1"))[0] as CollectionPatch;
    expect(await collections.getPatch(context, "room-collection-test", "orders", "order-1", patch.id)).toMatchObject({ record_id: "order-1" });
  });

  it("queues enabled create and patch triggers through the PostgreSQL automation port", async () => {
    const commands = new FakeCommands();
    const files = new FakeFiles();
    const queued: Array<{ event: string; trigger: Record<string, unknown>; recordId: string }> = [];
    const collections = new PostgresCollection(commands as never, files as never, {
      enqueue: async (_context, input) => {
        queued.push({ event: input.event, trigger: input.trigger, recordId: input.recordId });
      }
    });
    const triggerSchema = schema([{ id: "created-action", event: "record.created", action_id: "refresh" }, { id: "patched-action", event: "record.patched", action_id: "refresh" }]);
    await collections.saveSchema(context, "room-collection-test", triggerSchema, 0);
    await collections.createRecord({ ...context, operationId: "trigger-create" }, "room-collection-test", record("orders", "order-trigger", { customer_id: "customer-1", status: "open" }));
    await collections.applyPatch({ ...context, operationId: "trigger-patch" }, "room-collection-test", "orders", "order-trigger", { changes: { status: "closed" }, expected_version: 1 });
    expect(queued.map((item) => item.event)).toEqual(["record.created", "record.patched"]);
    expect(queued.every((item) => item.recordId === "order-trigger")).toBe(true);
  });

  it("replays a blocked trigger delivery without duplicating the record", async () => {
    const commands = new FakeCommands();
    const files = new FakeFiles();
    let attempts = 0;
    const collections = new PostgresCollection(commands as never, files as never, {
      enqueue: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary_trigger_outage");
      }
    });
    const triggerSchema = schema([{ id: "created-action", event: "record.created", action_id: "refresh" }]);
    await collections.saveSchema(context, "room-collection-test", triggerSchema, 0);
    const operation = { ...context, operationId: "trigger-recovery" };
    const input = record("orders", "order-recovery", { customer_id: "customer-1", status: "open" });

    await expect(collections.createRecord(operation, "room-collection-test", input)).rejects.toMatchObject({ code: "collection_trigger_enqueue_failed" });
    const resumed = await collections.createRecord(operation, "room-collection-test", input);
    expect(resumed.replayed).toBe(true);
    expect(attempts).toBe(2);
    await expect(collections.getRecord(context, "room-collection-test", "orders", "order-recovery")).resolves.toMatchObject({ id: "order-recovery" });
  });
});
