import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import { verifyWorkspaceBundleV3 } from "./workspace-bundle-v3";

describe("Workspace Bundle v3 credential boundary", () => {
  it("rejects a credential-shaped field inside a portable record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const workspaceId = "workspace_bundle_test";
      const files = new Map<string, string>([
        ["workspace.json", canonicalJson({
          id: workspaceId,
          name: "Bundle test",
          hosting_mode: "self_host",
          database_placement: "dedicated",
          storage_namespace: `workspaces/${workspaceId}`,
          created_by: "account_owner",
          version: 1,
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })],
        ["accounts.jsonl", ""],
        ["rooms.jsonl", ""],
        ["memberships.jsonl", ""],
        ["room-memberships.jsonl", ""],
        ["records.jsonl", `${canonicalJson({
          workspace_id: workspaceId,
          room_id: "room_one",
          record_type: "knowledge",
          id: "record_one",
          version: 1,
          payload: { password: "must-not-export" },
          search_text: "",
          content_hash: "0".repeat(64),
          created_by: "account_owner",
          updated_by: "account_owner",
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })}\n`],
        ["events.jsonl", ""],
        ["jobs.jsonl", ""],
        ["operations.jsonl", ""],
        ["invitations.jsonl", ""],
        ["audits.jsonl", ""],
        ["files.jsonl", ""]
      ]);
      const hashes = Object.fromEntries([...files.entries()].map(([name, content]) => [name, hash(content)]).sort(([left], [right]) => left.localeCompare(right)));
      const recordCounts = {
        rooms: 0, memberships: 0, room_memberships: 0, records: 1, events: 0,
        jobs: 0, operations: 0, invitations: 0, audits: 0, files: 0
      };
      for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
      await writeFile(path.join(root, "manifest.json"), canonicalJson({
        format_version: 3,
        workspace_id: workspaceId,
        exported_at: "2026-08-14T00:00:00.000Z",
        source: { hosting_mode: "self_host", database_placement: "dedicated" },
        schema_version: 22,
        files: hashes,
        record_counts: recordCounts,
        integrity_hash: hash(canonicalJson({ files: hashes, record_counts: recordCounts }))
      }), "utf8");

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_contains_credential");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a legacy root Room with no parent field", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        schemaVersion: 21,
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")]
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { schema_version: 21 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child Room whose direct member is absent from its parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root"), room("room_child", "room_root")],
        roomMemberships: [roomMembership("room_child")]
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cyclic Room hierarchy before Restore can write anything", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_a", "room_b"), room("room_b", "room_a")],
        roomMemberships: [roomMembership("room_a"), roomMembership("room_b")]
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a deliberately deep valid hierarchy without recursive validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const rooms: Record<string, unknown>[] = [];
      const roomMemberships: Record<string, unknown>[] = [];
      let parentRoomId: string | undefined;
      for (let index = 0; index < 1200; index += 1) {
        const roomId = `room_deep_${index}`;
        rooms.push(room(roomId, parentRoomId));
        roomMemberships.push(roomMembership(roomId));
        parentRoomId = roomId;
      }
      await writeHierarchyBundle(root, { rooms, roomMemberships });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({ manifest: { record_counts: { rooms: 1200 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const workspaceId = "workspace_bundle_test";
const accountId = "account_owner";
const timestamp = "2026-08-14T00:00:00.000Z";

function room(id: string, parentRoomId?: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    id,
    ...(parentRoomId ? { parent_room_id: parentRoomId } : {}),
    name: id,
    version: 1,
    created_by: accountId,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function roomMembership(roomId: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    room_id: roomId,
    account_id: accountId,
    role: "owner",
    state: "active",
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    revoked_at: null
  };
}

async function writeHierarchyBundle(
  root: string,
  input: { schemaVersion?: number; rooms: Record<string, unknown>[]; roomMemberships: Record<string, unknown>[] }
): Promise<void> {
  const files = new Map<string, string>([
    ["workspace.json", canonicalJson({
      id: workspaceId,
      name: "Bundle test",
      hosting_mode: "self_host",
      database_placement: "dedicated",
      storage_namespace: `workspaces/${workspaceId}`,
      created_by: accountId,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    })],
    ["accounts.jsonl", ""],
    ["rooms.jsonl", jsonLines(input.rooms)],
    ["memberships.jsonl", jsonLines([{
      workspace_id: workspaceId,
      account_id: accountId,
      role: "owner",
      state: "active",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null
    }])],
    ["room-memberships.jsonl", jsonLines(input.roomMemberships)],
    ["records.jsonl", ""],
    ["events.jsonl", ""],
    ["jobs.jsonl", ""],
    ["operations.jsonl", ""],
    ["invitations.jsonl", ""],
    ["audits.jsonl", ""],
    ["files.jsonl", ""]
  ]);
  const recordCounts = {
    rooms: input.rooms.length,
    memberships: 1,
    room_memberships: input.roomMemberships.length,
    records: 0,
    events: 0,
    jobs: 0,
    operations: 0,
    invitations: 0,
    audits: 0,
    files: 0
  };
  const hashes = Object.fromEntries([...files.entries()].map(([name, content]) => [name, hash(content)]).sort(([left], [right]) => left.localeCompare(right)));
  for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
  await writeFile(path.join(root, "manifest.json"), canonicalJson({
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: timestamp,
    source: { hosting_mode: "self_host", database_placement: "dedicated" },
    schema_version: input.schemaVersion ?? 22,
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: hash(canonicalJson({ files: hashes, record_counts: recordCounts }))
  }), "utf8");
}

function jsonLines(rows: Record<string, unknown>[]): string {
  return rows.map((row) => canonicalJson(row)).join(rows.length ? "\n" : "") + (rows.length ? "\n" : "");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
