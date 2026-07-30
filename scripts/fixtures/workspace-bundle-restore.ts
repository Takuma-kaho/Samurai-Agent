import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { nowIso, type SessionRecord } from "../../packages/core-schemas/src";
import { WorkspaceDatabase } from "../../packages/workspace-store/src/kernel/workspace-database";
import { WorkspaceMigrationRunner } from "../../packages/workspace-store/src/kernel/migration-runner";
import { WorkspacePaths } from "../../packages/workspace-store/src/kernel/workspace-paths";
import { workspaceMigrations } from "../../packages/workspace-store/src/migrations";
import { WorkspaceStore } from "../../packages/workspace-store/src";
import { hashFileSha256 } from "../../packages/workspace-store/src/backup/workspace-bundle-files";

const root = await mkdtemp(path.join(tmpdir(), "samurai-workspace-bundle-"));
const exportRoot = await mkdtemp(path.join(tmpdir(), "samurai-workspace-export-"));
const legacyDatabaseRoot = await mkdtemp(path.join(tmpdir(), "samurai-workspace-legacy-bundle-"));
let store = await WorkspaceStore.create({ rootDir: root });

function session(id: string, title: string): SessionRecord {
  const now = nowIso();
  return {
    id,
    session_key: `web:bundle:${id}`,
    title,
    ui_locale: "ja",
    output_locale: "ja",
    created_at: now,
    updated_at: now
  };
}

async function readManifest(backupId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "backups", backupId, "manifest.json"), "utf8")) as Record<string, unknown>;
}

async function cloneBackup(sourceId: string, destinationId: string): Promise<string> {
  const source = path.join(root, "backups", sourceId);
  const destination = path.join(root, "backups", destinationId);
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
  const manifest = await readManifest(destinationId);
  manifest.id = destinationId;
  await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

async function replaceWithLegacyDatabase(bundleDirectory: string, manifest: Record<string, unknown>): Promise<void> {
  const paths = new WorkspacePaths(legacyDatabaseRoot);
  await paths.ensureWorkspaceLayout();
  const database = new WorkspaceDatabase(paths);
  try {
    await new WorkspaceMigrationRunner(database.open(), workspaceMigrations.filter((migration) => migration.version <= 5)).migrate();
    database.checkpointTruncate();
  } finally {
    await database.close();
  }
  await cp(path.join(legacyDatabaseRoot, "workspace.sqlite"), path.join(bundleDirectory, "workspace.sqlite"), { force: true });
  await Promise.all([
    rm(path.join(bundleDirectory, "workspace.sqlite-wal"), { force: true }),
    rm(path.join(bundleDirectory, "workspace.sqlite-shm"), { force: true })
  ]);
  const hashes = manifest.file_hashes as Record<string, string>;
  hashes["workspace.sqlite"] = await hashFileSha256(path.join(bundleDirectory, "workspace.sqlite"));
  manifest.schema_version = 5;
  await writeFile(path.join(bundleDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function expectRejectedBundle(
  sourceId: string,
  destinationId: string,
  mutate: (directory: string, manifest: Record<string, unknown>) => Promise<void> | void,
  expected: RegExp
): Promise<void> {
  const destination = await cloneBackup(sourceId, destinationId);
  const manifest = await readManifest(destinationId);
  await mutate(destination, manifest);
  await assert.rejects(store.restoreWorkspaceBackup(destinationId), expected);
  assert.equal((await store.getSession("sentinel-session"))?.title, "Sentinel current state");
}

try {
  await store.createSession(session("wal-session", "Committed in WAL"));
  await store.createSession(session("sentinel-session", "Sentinel current state"));
  await mkdir(path.join(root, "profile"), { recursive: true });
  await writeFile(path.join(root, "profile", "user.md"), "backup profile\n");
  const walBeforeBackup = await stat(path.join(root, "workspace.sqlite-wal"));
  assert.ok(walBeforeBackup.size > 0, "The fixture must place data in SQLite WAL before Backup.");

  const backup = await store.createWorkspaceBackup();
  const manifest = backup.manifest as Record<string, unknown>;
  assert.equal(manifest.format_version, 2);
  assert.equal(manifest.source_root, ".");
  assert.equal(typeof manifest.schema_version, "number");
  assert.deepEqual(manifest.file_roots, ["artifacts", "profile", "memory", "skills", "wiki", "rollback", "collections", "surfaces"]);
  assert.ok(Object.keys(manifest.file_hashes as Record<string, string>).every((entry) => !entry.startsWith("/") && !entry.includes("\\")));

  const backupDatabase = new Database(path.join(root, backup.path, "workspace.sqlite"), { readonly: true });
  try {
    const row = backupDatabase.prepare("SELECT id FROM sessions WHERE id = ?").get("wal-session") as { id?: string } | undefined;
    assert.equal(row?.id, "wal-session");
  } finally {
    backupDatabase.close();
  }
  await Promise.all([
    rm(path.join(root, backup.path, "workspace.sqlite-wal"), { force: true }),
    rm(path.join(root, backup.path, "workspace.sqlite-shm"), { force: true })
  ]);

  await mkdir(path.join(root, "backups", ".create-stage-interrupted"), { recursive: true });
  assert.equal((await store.listWorkspaceBackups()).some((entry) => entry.path.includes(".create-stage-")), false);

  const firstBackup = store.createWorkspaceBackup();
  await assert.rejects(store.createWorkspaceBackup(), /workspace_maintenance_busy/);
  await firstBackup;

  await store.createSession(session("post-backup-session", "Post backup state"));
  await writeFile(path.join(root, "profile", "user.md"), "current profile\n");
  const restored = await store.restoreWorkspaceBackup(backup.id);
  assert.equal(restored.pre_restore_backup_id.startsWith("backup_"), true);
  assert.equal((await store.getSession("wal-session"))?.title, "Committed in WAL");
  assert.equal(await store.getSession("post-backup-session"), undefined);
  assert.equal(await readFile(path.join(root, "profile", "user.md"), "utf8"), "backup profile\n");
  assert.ok((await store.listWorkspaceBackups()).some((entry) => entry.id === restored.pre_restore_backup_id));

  await store.restoreWorkspaceBackup(restored.pre_restore_backup_id);
  assert.equal((await store.getSession("post-backup-session"))?.title, "Post backup state");
  assert.equal(await readFile(path.join(root, "profile", "user.md"), "utf8"), "current profile\n");

  await writeFile(path.join(root, "surfaces", "v1-source.html"), "v1 source surface\n");
  const v2ForV1 = await store.createWorkspaceBackup();
  const v1Id = "backup_v1_compatibility";
  await cloneBackup(v2ForV1.id, v1Id);
  const v1 = await readManifest(v1Id);
  delete v1.format_version;
  delete v1.schema_version;
  v1.source_root = root;
  v1.file_roots = (v1.file_roots as string[]).filter((rootName) => rootName !== "surfaces");
  delete (v1.file_hashes as Record<string, string>)["files/surfaces/v1-source.html"];
  await rm(path.join(root, "backups", v1Id, "files", "surfaces"), { recursive: true, force: true });
  await writeFile(path.join(root, "backups", v1Id, "manifest.json"), `${JSON.stringify(v1, null, 2)}\n`);
  await store.createSession(session("v1-later-session", "After v1 snapshot"));
  await writeFile(path.join(root, "surfaces", "current-only.html"), "current surface\n");
  await store.restoreWorkspaceBackup(v1Id);
  assert.equal((await store.getSession("post-backup-session"))?.title, "Post backup state");
  assert.equal(await store.getSession("v1-later-session"), undefined);
  assert.deepEqual(await readdir(path.join(root, "surfaces")), []);

  const legacySource = await store.createWorkspaceBackup();
  const legacyId = "backup_legacy_schema";
  const legacyDirectory = await cloneBackup(legacySource.id, legacyId);
  await replaceWithLegacyDatabase(legacyDirectory, await readManifest(legacyId));
  const legacyRestore = await store.restoreWorkspaceBackup(legacyId);
  assert.equal((await store.listSchemaMigrations()).at(-1)?.version, 6);
  await store.restoreWorkspaceBackup(legacyRestore.pre_restore_backup_id);
  assert.equal((await store.getSession("post-backup-session"))?.title, "Post backup state");

  const securityBase = await store.createWorkspaceBackup();
  await expectRejectedBundle(securityBase.id, "backup_future_version", async (directory, sourceManifest) => {
    sourceManifest.format_version = 3;
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_backup_manifest_format_unsupported/);
  await expectRejectedBundle(securityBase.id, "backup_hash_mismatch", async (directory, sourceManifest) => {
    const hashes = sourceManifest.file_hashes as Record<string, string>;
    hashes["workspace.sqlite"] = "0".repeat(64);
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_hash_mismatch/);
  await expectRejectedBundle(securityBase.id, "backup_path_traversal", async (directory, sourceManifest) => {
    const hashes = sourceManifest.file_hashes as Record<string, string>;
    hashes["files/profile/../escape.txt"] = "0".repeat(64);
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_hash_path_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_absolute_path", async (directory, sourceManifest) => {
    const hashes = sourceManifest.file_hashes as Record<string, string>;
    hashes["/escape.txt"] = "0".repeat(64);
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_hash_path_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_backslash_path", async (directory, sourceManifest) => {
    const hashes = sourceManifest.file_hashes as Record<string, string>;
    hashes["files\\profile\\escape.txt"] = "0".repeat(64);
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_hash_path_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_duplicate_root", async (directory, sourceManifest) => {
    const roots = sourceManifest.file_roots as string[];
    roots.push(roots[0]!);
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_root_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_unknown_root", async (directory, sourceManifest) => {
    const roots = sourceManifest.file_roots as string[];
    roots[0] = "unknown-root";
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_root_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_duplicate_hash", async (directory, sourceManifest) => {
    const original = await readFile(path.join(directory, "manifest.json"), "utf8");
    const duplicate = `"file_hashes": {\n    "workspace.sqlite": "${(sourceManifest.file_hashes as Record<string, string>)["workspace.sqlite"]}",`;
    const rewritten = original.replace('"file_hashes": {', duplicate);
    assert.notEqual(rewritten, original);
    await writeFile(path.join(directory, "manifest.json"), rewritten);
  }, /workspace_backup_manifest_duplicate_key/);
  await expectRejectedBundle(securityBase.id, "backup_extra_file", async (directory) => {
    await writeFile(path.join(directory, "files", "profile", "extra.md"), "extra\n");
  }, /workspace_bundle_file_set_mismatch/);
  await expectRejectedBundle(securityBase.id, "backup_missing_file", async (directory, sourceManifest) => {
    const key = Object.keys(sourceManifest.file_hashes as Record<string, string>).find((entry) => entry.startsWith("files/profile/"));
    assert.ok(key);
    await unlink(path.join(directory, ...key.split("/")));
  }, /workspace_bundle_file_set_mismatch/);
  await expectRejectedBundle(securityBase.id, "backup_symlink", async (directory) => {
    await symlink("user.md", path.join(directory, "files", "profile", "link.md"));
  }, /workspace_bundle_file_type_invalid/);
  await expectRejectedBundle(securityBase.id, "backup_future_schema", async (directory, sourceManifest) => {
    const database = new Database(path.join(directory, "workspace.sqlite"));
    try {
      database.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(99, "future_bundle_schema", "future_bundle_schema", nowIso());
      const checkpoint = database.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy?: number }>;
      assert.equal(Number(checkpoint[0]?.busy ?? 0), 0);
    } finally {
      database.close();
    }
    await Promise.all([
      rm(path.join(directory, "workspace.sqlite-wal"), { force: true }),
      rm(path.join(directory, "workspace.sqlite-shm"), { force: true })
    ]);
    const hashes = sourceManifest.file_hashes as Record<string, string>;
    hashes["workspace.sqlite"] = await hashFileSha256(path.join(directory, "workspace.sqlite"));
    sourceManifest.schema_version = 99;
    await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
  }, /workspace_bundle_schema_too_new/);

  const exported = await store.exportWorkspaceBundle(exportRoot);
  assert.ok(await stat(exported.path));
  const backupsBeforeRejectedExport = (await store.listWorkspaceBackups()).length;
  await assert.rejects(store.exportWorkspaceBundle(root), /workspace_export_destination_inside_workspace/);
  assert.equal((await store.listWorkspaceBackups()).length, backupsBeforeRejectedExport);

  await store.close();
  store = await WorkspaceStore.create({ rootDir: root });
  await assert.rejects(stat(path.join(root, "backups", ".create-stage-interrupted")));
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    wal_snapshot: true,
    manifest_v2: true,
    v1_restore: true,
    v1_missing_root_stages_empty: true,
    rejected_invalid_bundles: 12,
    completed_backup_visibility: true,
    pre_restore_backup: true,
    legacy_stage_migration: true,
    future_schema_rejected: true,
    maintenance_guard: true,
    export_atomic_stage: true
  })}\n`);
} finally {
  await store.close().catch(() => undefined);
  await Promise.all([root, exportRoot, legacyDatabaseRoot].map((directory) => rm(directory, { recursive: true, force: true })));
}
