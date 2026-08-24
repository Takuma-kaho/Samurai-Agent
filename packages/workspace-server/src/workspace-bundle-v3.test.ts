import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import type { WorkspaceServerStore } from "./workspace-server-store";
import {
  readWorkspaceBundleV3Transport,
  verifyWorkspaceBundleV3,
  WORKSPACE_BUNDLE_MAX_ENTRY_BYTES,
  WorkspaceBundleV3Service,
  writeWorkspaceBundleV3Transport
} from "./workspace-bundle-v3";

describe("Workspace Bundle v3 credential boundary", () => {
  it("serializes PostgreSQL Date values as ISO timestamps in an exported Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-date-"));
    try {
      const workspaceId = "workspace_bundle_date_test";
      const timestamp = new Date("2026-08-24T00:00:00.000Z");
      const sql = {
        query: async <T extends Record<string, unknown>>(query: string): Promise<{ rows: T[] }> => {
          if (query.includes("samurai_can_workspace")) return { rows: [{ allowed: true } as T] };
          if (query.includes("FROM workspaces")) {
            return {
              rows: [{
                id: workspaceId,
                name: "Date bundle test",
                hosting_mode: "self_host",
                database_placement: "dedicated",
                storage_namespace: `workspaces/${workspaceId}`,
                created_by: "account_owner",
                version: 1,
                created_at: timestamp,
                updated_at: timestamp
              } as T]
            };
          }
          if (query.includes("FROM workspace_members")) {
            return {
              rows: [{
                workspace_id: workspaceId,
                account_id: "account_owner",
                role: "owner",
                state: "active",
                version: 1,
                created_at: timestamp,
                updated_at: timestamp,
                revoked_at: null
              } as T]
            };
          }
          return { rows: [] };
        }
      };
      const store = {
        mode: "self_host",
        storageRoot: root,
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql),
          withReadSnapshot: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      } as unknown as WorkspaceServerStore;

      const exported = await new WorkspaceBundleV3Service(store).writePortableSnapshot({
        workspaceId,
        accountId: "account_owner",
        operationId: "operation_bundle_date_test"
      }, { destination: path.join(root, "bundle") });
      expect(exported.manifest.workspace_id).toBe(workspaceId);

      const membership = JSON.parse((await readFile(path.join(root, "bundle", "memberships.jsonl"), "utf8")).trim()) as {
        created_at: unknown;
        updated_at: unknown;
      };
      expect(membership.created_at).toBe(timestamp.toISOString());
      expect(membership.updated_at).toBe(timestamp.toISOString());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
          payload: { client_secret: "must-not-export", oauth_client_secret: "must-also-not-export" },
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

  it("accepts a complete, credential-free learning history and binds every evidence row", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-activities.jsonl": [{
            workspace_id: workspaceId, room_id: "room_root", id: "activity_one", group_key: "group_one",
            principal_account_id: accountId, source_kind: "test", source_id: null, correction_of_activity_id: null,
            instruction_summary: "Deploy", result_summary: "Passed", outcome: "completed", verification_state: "confirmed",
            failure_state: "none", explicit_remember: false, payload: {}, created_at: timestamp, finalized_at: timestamp
          }],
          "learning-resources.jsonl": [{
            workspace_id: workspaceId, id: "resource_one", scope_kind: "room", room_id: "room_root",
            resource_kind: "knowledge", state: "active", is_absolute_rule: false, ai_update_locked: false,
            title: "Deploy procedure", content: "Run the verified deployment", payload: {}, version: 1,
            created_by: accountId, updated_by: accountId, archived_at: null, created_at: timestamp, updated_at: timestamp
          }],
          "learning-resource-versions.jsonl": [{
            workspace_id: workspaceId, id: "version_one", resource_id: "resource_one", version: 1,
            change_kind: "created", scope_kind: "room", room_id: "room_root", state: "active", ai_update_locked: false,
            title: "Deploy procedure", content: "Run the verified deployment", payload: {},
            content_hash: hash(canonicalJson({ title: "Deploy procedure", content: "Run the verified deployment", payload: {} })),
            reason: "Initial evidence", actor_account_id: accountId, created_at: timestamp
          }],
          "learning-evidence.jsonl": [{
            workspace_id: workspaceId, id: "evidence_one", resource_id: "resource_one", resource_version: 1,
            activity_id: "activity_one", kind: "activity", summary: "Deploy", created_at: timestamp
          }],
          "learning-settings.jsonl": [{
            workspace_id: workspaceId, id: "workspace", scope_kind: "workspace", room_id: null, enabled: true,
            engine_id: "engine_local", model: "model_one", currency_limit: 10, token_limit: 1000,
            currency_used: 0, tokens_used: 0, version: 1, updated_by: accountId, updated_at: timestamp
          }],
          "learning-jobs.jsonl": [{
            workspace_id: workspaceId, room_id: "room_root", id: "job_one", kind: "review", status: "completed",
            priority: "normal", group_key: "group_one", high_watermark_activity_id: "activity_one", next_run_at: timestamp,
            attempt_count: 1, max_attempts: 5, lease_owner: null, lease_expires_at: null, heartbeat_at: null,
            blocked_reason: null, engine_id: "engine_local", model: "model_one", created_by: accountId,
            updated_by: accountId, created_at: timestamp, updated_at: timestamp, completed_at: timestamp
          }],
          "learning-job-attempts.jsonl": [{
            workspace_id: workspaceId, id: "attempt_one", job_id: "job_one", attempt_no: 1, worker_id: "worker_one",
            engine_id: "engine_local", model: "model_one", status: "completed", input_hash: "b".repeat(64),
            output_hash: "c".repeat(64), output: {}, error_code: null, currency_used: 1, tokens_used: 10,
            started_at: timestamp, completed_at: timestamp
          }],
          "learning-resource-uses.jsonl": [{
            workspace_id: workspaceId, id: "use_one", resource_id: "resource_one", resource_version: 1,
            activity_id: "activity_one", outcome: "confirmed_success", summary: "Worked", created_at: timestamp
          }]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { record_counts: { learning_resources: 1, learning_jobs: 1 } }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a learning settings row whose id cannot be updated through its declared scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-settings.jsonl": [{
            workspace_id: workspaceId, id: "arbitrary_settings_id", scope_kind: "workspace", room_id: null,
            enabled: true, engine_id: null, model: null, currency_limit: null, token_limit: null,
            currency_used: 0, tokens_used: 0, version: 1, updated_by: accountId, updated_at: timestamp
          }]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips a transport entry at exactly 8 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    const destination = path.join(root, "restored");
    const content = Buffer.alloc(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES, 0x61);
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        workspaceFiles: [{ path: "payload.bin", content }]
      });

      const transport = await readWorkspaceBundleV3Transport(root);
      const restored = await writeWorkspaceBundleV3Transport({ transport, destination });

      expect(restored.manifest.integrity_hash).toBe(transport.manifest.integrity_hash);
      const restoredContent = await readFile(path.join(restored.directory, "files", "payload.bin"));
      expect(restoredContent.equals(content)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an exported transport entry over 8 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        workspaceFiles: [{ path: "payload.bin", content: Buffer.alloc(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES + 1, 0x61) }]
      });

      await expect(readWorkspaceBundleV3Transport(root)).rejects.toThrow("workspace_bundle_v3_entry_too_large");
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
  input: {
    schemaVersion?: number;
    rooms: Record<string, unknown>[];
    roomMemberships: Record<string, unknown>[];
    workspaceFiles?: Array<{ path: string; content: Uint8Array }>;
    learning?: Partial<Record<LearningFile, Record<string, unknown>[]>>;
  }
): Promise<void> {
  const workspaceFiles = input.workspaceFiles ?? [];
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
    ["files.jsonl", jsonLines(workspaceFiles.map(({ path: filePath, content }) => ({
      workspace_id: workspaceId,
      room_id: "room_root",
      path: filePath,
      version: 1,
      sha256: hash(content),
      size: content.byteLength,
      created_by: accountId,
      updated_by: accountId,
      created_at: timestamp,
      updated_at: timestamp
    })))]
  ]);
  if (input.learning) {
    for (const file of learningFiles) files.set(file, jsonLines(input.learning[file] ?? []));
  }
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
    files: workspaceFiles.length,
    ...(input.learning ? Object.fromEntries(learningFiles.map((file) => [learningCountName(file), input.learning?.[file]?.length ?? 0])) : {})
  };
  const hashes = Object.fromEntries([
    ...[...files.entries()].map(([name, content]) => [name, hash(content)] as const),
    ...workspaceFiles.map(({ path: filePath, content }) => [`files/${filePath}`, hash(content)] as const)
  ].sort(([left], [right]) => left.localeCompare(right)));
  for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
  if (workspaceFiles.length > 0) await mkdir(path.join(root, "files"), { recursive: true });
  for (const { path: filePath, content } of workspaceFiles) {
    await writeFile(path.join(root, "files", filePath), content);
  }
  await writeFile(path.join(root, "manifest.json"), canonicalJson({
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: timestamp,
    source: { hosting_mode: "self_host", database_placement: "dedicated" },
    schema_version: input.schemaVersion ?? (input.learning ? 27 : 22),
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: hash(canonicalJson({ files: hashes, record_counts: recordCounts }))
  }), "utf8");
}

const learningFiles = [
  "learning-activities.jsonl",
  "learning-resources.jsonl",
  "learning-resource-versions.jsonl",
  "learning-evidence.jsonl",
  "learning-resource-links.jsonl",
  "learning-settings.jsonl",
  "learning-jobs.jsonl",
  "learning-job-attempts.jsonl",
  "learning-resource-uses.jsonl"
] as const;

type LearningFile = (typeof learningFiles)[number];

function learningCountName(file: LearningFile): string {
  return file.replace(".jsonl", "").replaceAll("-", "_");
}

function jsonLines(rows: Record<string, unknown>[]): string {
  return rows.map((row) => canonicalJson(row)).join(rows.length ? "\n" : "") + (rows.length ? "\n" : "");
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
