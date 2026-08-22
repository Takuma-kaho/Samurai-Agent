import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { WorkspaceDatabase } from "../../packages/workspace-store/src/kernel/workspace-database";
import { WorkspaceMigrationRunner, migrationChecksum, type WorkspaceMigration } from "../../packages/workspace-store/src/kernel/migration-runner";
import { WorkspacePaths } from "../../packages/workspace-store/src/kernel/workspace-paths";
import { coreBaselineChecksum, coreBaselineMigration } from "../../packages/workspace-store/src/migrations/001-core-baseline";
import { gatewayDeliveryMigration } from "../../packages/workspace-store/src/migrations/002-gateway-delivery";
import { skillOptimizationMigration } from "../../packages/workspace-store/src/migrations/003-skill-optimization";
import { toolRunErrorCodeMigration } from "../../packages/workspace-store/src/migrations/004-tool-run-error-code";
import { gatewayPairingPolicyAllowedToolsMigration } from "../../packages/workspace-store/src/migrations/005-gateway-allowed-tools";
import { workspaceMigrations } from "../../packages/workspace-store/src/migrations";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const roots: string[] = [];
const expectedChecksums = [
  "718605c93db76d3548d493701b1130b9d0e19d1d02240a02e3dfa069f4f5f539",
  "9ca7054dfb37369ebafa0ce3452918e6048f2629c3f71602a8e3f3812f9713d1",
  "106ed93c492c08b93dfb60f7aaf3256f961fb5c9905efdb3dfd1d6cbeb274110",
  "53c4d1bf86547a9f7ffd56f0a96b2c30c5b7dac8541ed10cc0080da87796f653",
  "6393e3fb037d082b68a7d976d6f7dc2f4d1ad63c144341238d797c61be4eebd2"
];

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `samurai-migration-${name}-`));
  roots.push(root);
  return root;
}

async function seedAtVersion(root: string, version: number): Promise<void> {
  const paths = new WorkspacePaths(root);
  await paths.ensureWorkspaceLayout();
  const database = new WorkspaceDatabase(paths);
  try {
    await new WorkspaceMigrationRunner(database.open(), workspaceMigrations.filter((migration) => migration.version <= version)).migrate();
  } finally {
    await database.close();
  }
}

function dbPath(root: string): string {
  return path.join(root, "workspace.sqlite");
}

function dropMigrationHistory(root: string): void {
  const database = new Database(dbPath(root));
  try {
    database.exec("DROP TABLE schema_migrations");
  } finally {
    database.close();
  }
}

function schemaSignature(root: string): Array<{ type: string; name: string; table_name: string; sql: string | null }> {
  const database = new Database(dbPath(root), { readonly: true });
  try {
    return database.prepare("SELECT type, name, tbl_name AS table_name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY type, name").all() as Array<{ type: string; name: string; table_name: string; sql: string | null }>;
  } finally {
    database.close();
  }
}

async function upgrade(root: string): Promise<{ migrations: Awaited<ReturnType<WorkspaceStore["listSchemaMigrations"]>>; signature: ReturnType<typeof schemaSignature> }> {
  const store = await WorkspaceStore.create({ rootDir: root });
  try {
    return { migrations: await store.listSchemaMigrations(), signature: schemaSignature(root) };
  } finally {
    await store.close();
  }
}

function assertLatest(result: Awaited<ReturnType<typeof upgrade>>, freshSignature: ReturnType<typeof schemaSignature>): void {
  assert.deepEqual(result.migrations.map((migration) => migration.version), workspaceMigrations.map((migration) => migration.version));
  assert.deepEqual(result.migrations.map((migration) => migration.name), workspaceMigrations.map((migration) => migration.name));
  assert.deepEqual(result.migrations.slice(0, 5).map((migration) => migration.checksum), expectedChecksums);
  assert.deepEqual(result.signature, freshSignature);
}

async function assertRejected(root: string, pattern: RegExp): Promise<void> {
  await assert.rejects(WorkspaceStore.create({ rootDir: root }), pattern);
}

async function verifyFailureRollback(): Promise<void> {
  const root = await temporaryRoot("failure");
  const paths = new WorkspacePaths(root);
  await paths.ensureWorkspaceLayout();
  const database = new WorkspaceDatabase(paths);
  const failingMigration: WorkspaceMigration = {
    version: 1,
    name: "transactional_failure",
    steps: [
      { kind: "sql", statement: "CREATE TABLE migration_atomicity_probe (id TEXT PRIMARY KEY)" },
      { kind: "sql", statement: "THIS IS NOT VALID SQL" }
    ]
  };
  try {
    await assert.rejects(new WorkspaceMigrationRunner(database.open(), [failingMigration]).migrate());
  } finally {
    await database.close();
  }
  const raw = new Database(dbPath(root), { readonly: true });
  try {
    const probe = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_atomicity_probe'").get();
    const history = raw.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number };
    const journal = raw.prepare("SELECT status FROM migration_journal ORDER BY created_at DESC LIMIT 1").get() as { status?: string } | undefined;
    assert.equal(probe, undefined);
    assert.equal(Number(history.count), 0);
    assert.equal(journal?.status, "failed");
  } finally {
    raw.close();
  }
}

async function verifyKnowledgeWikiCaptureMigration(): Promise<void> {
  const bothColumnsRoot = await temporaryRoot("knowledge-wiki-both-columns");
  await seedAtVersion(bothColumnsRoot, 5);
  let raw = new Database(dbPath(bothColumnsRoot));
  try {
    raw.exec("ALTER TABLE settings ADD COLUMN llm_wiki_capture_mode TEXT");
    raw.prepare("INSERT INTO settings(id, ui_locale, output_locale, memory_capture_mode, knowledge_wiki_capture_mode, skill_capture_mode, external_provider_role, default_backend_id, updated_at, llm_wiki_capture_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("default", "ja", "ja", "auto", "manual", "auto", "assistive", null, "2026-07-29T00:00:00.000Z", "off");
  } finally {
    raw.close();
  }
  let store = await WorkspaceStore.create({ rootDir: bothColumnsRoot });
  try {
    assert.equal((await store.getSettings()).knowledge_wiki_capture_mode, "manual");
  } finally {
    await store.close();
  }

  const legacyOnlyRoot = await temporaryRoot("knowledge-wiki-legacy-only");
  await seedAtVersion(legacyOnlyRoot, 5);
  raw = new Database(dbPath(legacyOnlyRoot));
  try {
    raw.exec(`
      ALTER TABLE settings RENAME TO settings_before_v6;
      CREATE TABLE settings (
        id TEXT PRIMARY KEY,
        ui_locale TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        memory_capture_mode TEXT NOT NULL DEFAULT 'auto',
        llm_wiki_capture_mode TEXT,
        skill_capture_mode TEXT NOT NULL DEFAULT 'auto',
        external_provider_role TEXT NOT NULL DEFAULT 'assistive',
        default_backend_id TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO settings(id, ui_locale, output_locale, memory_capture_mode, llm_wiki_capture_mode, skill_capture_mode, external_provider_role, default_backend_id, updated_at)
      VALUES ('default', 'ja', 'ja', 'auto', 'off', 'auto', 'assistive', NULL, '2026-07-29T00:00:00.000Z');
      DROP TABLE settings_before_v6;
    `);
  } finally {
    raw.close();
  }
  store = await WorkspaceStore.create({ rootDir: legacyOnlyRoot });
  try {
    assert.equal((await store.getSettings()).knowledge_wiki_capture_mode, "off");
  } finally {
    await store.close();
  }
}

try {
  assert.equal(coreBaselineChecksum, expectedChecksums[0]);
  assert.deepEqual(
    [coreBaselineMigration, gatewayDeliveryMigration, skillOptimizationMigration, toolRunErrorCodeMigration, gatewayPairingPolicyAllowedToolsMigration].map(migrationChecksum),
    expectedChecksums
  );

  const freshRoot = await temporaryRoot("fresh");
  const fresh = await upgrade(freshRoot);
  assertLatest(fresh, fresh.signature);

  const unversionedRoot = await temporaryRoot("unversioned");
  await seedAtVersion(unversionedRoot, 3);
  dropMigrationHistory(unversionedRoot);
  assertLatest(await upgrade(unversionedRoot), fresh.signature);

  const unversionedExistingColumnsRoot = await temporaryRoot("unversioned-existing-columns");
  await seedAtVersion(unversionedExistingColumnsRoot, 5);
  dropMigrationHistory(unversionedExistingColumnsRoot);
  assertLatest(await upgrade(unversionedExistingColumnsRoot), fresh.signature);

  for (const version of [1, 3, 5]) {
    const root = await temporaryRoot(`v${version}`);
    await seedAtVersion(root, version);
    assertLatest(await upgrade(root), fresh.signature);
  }

  const checksumRoot = await temporaryRoot("checksum");
  await seedAtVersion(checksumRoot, 6);
  let raw = new Database(dbPath(checksumRoot));
  raw.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered");
  raw.close();
  await assertRejected(checksumRoot, /schema_migration_checksum_mismatch:1/);

  const nameRoot = await temporaryRoot("name");
  await seedAtVersion(nameRoot, 6);
  raw = new Database(dbPath(nameRoot));
  raw.prepare("UPDATE schema_migrations SET name = ? WHERE version = 1").run("tampered_name");
  raw.close();
  await assertRejected(nameRoot, /schema_migration_name_mismatch:1/);

  const gapRoot = await temporaryRoot("gap");
  await seedAtVersion(gapRoot, 6);
  raw = new Database(dbPath(gapRoot));
  raw.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
  raw.close();
  await assertRejected(gapRoot, /schema_migration_history_gap:2:3/);

  const futureRoot = await temporaryRoot("future");
  const latestVersion = workspaceMigrations.at(-1)!.version;
  await seedAtVersion(futureRoot, latestVersion);
  raw = new Database(dbPath(futureRoot));
  raw.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(latestVersion + 1, "future", "future", new Date().toISOString());
  raw.close();
  await assertRejected(futureRoot, new RegExp(`schema_migration_version_too_new:${latestVersion + 1}`));

  await verifyFailureRollback();
  await verifyKnowledgeWikiCaptureMigration();

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    fresh_install: true,
    supported_legacy_versions: ["unversioned", "unversioned_with_v4_v5_columns", "v1", "v3", "v5"],
    upgraded_versions: 5,
    checksum_equal: true,
    checksum_tamper_rejected: true,
    name_tamper_rejected: true,
    history_gap_rejected: true,
    future_version_rejected: true,
    migration_failure_rollback: true,
    knowledge_wiki_capture_migration_preserves_current_value: true,
    knowledge_wiki_capture_migration_adopts_legacy_value: true,
    latest_version: fresh.migrations.at(-1)!.version,
    checksums: fresh.migrations.map((migration) => migration.checksum)
  })}\n`);
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
