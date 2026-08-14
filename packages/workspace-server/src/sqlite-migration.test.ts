import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createWorkspaceBundleV3FromLegacySqlite } from "./sqlite-migration";
import { verifyWorkspaceBundleV3 } from "./workspace-bundle-v3";

describe("legacy SQLite migration", () => {
  it("reads SQLite without changing it and creates a credential-free Bundle v3", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-sqlite-migration-"));
    try {
      const source = path.join(root, "legacy");
      const destination = path.join(root, "bundle");
      await mkdir(path.join(source, "wiki"), { recursive: true });
      await writeFile(path.join(source, "wiki", "note.md"), "# Knowledge\n", "utf8");
      const dbPath = path.join(source, "workspace.sqlite");
      const database = new Database(dbPath);
      database.exec("CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT, secret TEXT, created_at TEXT)");
      database.prepare("INSERT INTO knowledge(id, title, secret, created_at) VALUES (?, ?, ?, ?)")
        .run("note_1", "Private note", "must-not-export", "2026-08-13T00:00:00.000Z");
      database.close();
      const sourceBefore = await readFile(dbPath);

      const result = await createWorkspaceBundleV3FromLegacySqlite({
        sourceWorkspaceRoot: source,
        destination,
        workspaceId: "workspace_migrated",
        ownerAccountId: "account_owner"
      });
      const verified = await verifyWorkspaceBundleV3(destination);
      const records = await readFile(path.join(destination, "records.jsonl"), "utf8");
      const sourceAfter = await readFile(dbPath);

      expect(result.sourceHash).toBe(createHash("sha256").update(sourceBefore).digest("hex"));
      expect(sourceAfter.equals(sourceBefore)).toBe(true);
      expect(verified.manifest.workspace_id).toBe("workspace_migrated");
      expect(records).toContain("Private note");
      expect(records).not.toContain("must-not-export");
      expect(verified.manifest.files["files/wiki/note.md"]).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a legacy credential file instead of placing it in a Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-sqlite-credential-"));
    try {
      const source = path.join(root, "legacy");
      const destination = path.join(root, "bundle");
      await mkdir(path.join(source, "wiki"), { recursive: true });
      await writeFile(path.join(source, "wiki", "id_rsa"), "-----BEGIN PRIVATE KEY-----\nunsafe\n", "utf8");
      const database = new Database(path.join(source, "workspace.sqlite"));
      database.exec("CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT)");
      database.close();

      await expect(createWorkspaceBundleV3FromLegacySqlite({
        sourceWorkspaceRoot: source,
        destination,
        workspaceId: "workspace_migrated",
        ownerAccountId: "account_owner"
      })).rejects.toThrow("workspace_bundle_v3_contains_credential");
      await expect(readFile(path.join(source, "wiki", "id_rsa"), "utf8")).resolves.toContain("PRIVATE KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a credential-looking value even when an old SQLite column is not named as a secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-sqlite-secret-value-"));
    try {
      const source = path.join(root, "legacy");
      const destination = path.join(root, "bundle");
      await mkdir(source, { recursive: true });
      const database = new Database(path.join(source, "workspace.sqlite"));
      database.exec("CREATE TABLE note (id TEXT PRIMARY KEY, content TEXT)");
      database.prepare("INSERT INTO note(id, content) VALUES (?, ?)")
        .run("note_1", "-----BEGIN PRIVATE KEY-----\\nunsafe");
      database.close();

      await expect(createWorkspaceBundleV3FromLegacySqlite({
        sourceWorkspaceRoot: source,
        destination,
        workspaceId: "workspace_migrated",
        ownerAccountId: "account_owner"
      })).rejects.toThrow("workspace_bundle_v3_contains_credential");
      await expect(readFile(path.join(source, "workspace.sqlite"))).resolves.toBeInstanceOf(Buffer);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("imports only the verified owner and reports legacy memberships that cannot prove an identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-sqlite-membership-"));
    try {
      const source = path.join(root, "legacy");
      const destination = path.join(root, "bundle");
      await mkdir(source, { recursive: true });
      const database = new Database(path.join(source, "workspace.sqlite"));
      database.exec(`
        CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE workspace_members (account_id TEXT, role TEXT, state TEXT);
        CREATE TABLE room_members (room_id TEXT, account_id TEXT, role TEXT, state TEXT);
      `);
      database.prepare("INSERT INTO rooms(id, name) VALUES (?, ?)").run("room_private", "Private");
      database.prepare("INSERT INTO workspace_members(account_id, role, state) VALUES (?, ?, ?)").run("legacy_person", "admin", "active");
      database.prepare("INSERT INTO room_members(room_id, account_id, role, state) VALUES (?, ?, ?, ?)").run("room_private", "legacy_person", "admin", "active");
      database.close();

      await createWorkspaceBundleV3FromLegacySqlite({
        sourceWorkspaceRoot: source,
        destination,
        workspaceId: "workspace_migrated",
        ownerAccountId: "account_owner"
      });
      const memberships = (await readFile(path.join(destination, "memberships.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { account_id: string });
      const roomMemberships = (await readFile(path.join(destination, "room-memberships.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { account_id: string });
      const report = (await readFile(path.join(destination, "records.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { record_type: string; payload: Record<string, unknown> })
        .find((record) => record.record_type === "migration_report");

      expect(memberships.map((member) => member.account_id)).toEqual(["account_owner"]);
      expect([...new Set(roomMemberships.map((member) => member.account_id))]).toEqual(["account_owner"]);
      expect(roomMemberships).toHaveLength(2);
      expect(report?.payload).toMatchObject({
        omitted_unverified_workspace_memberships: 1,
        omitted_unverified_room_memberships: 1
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
