import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const freshRoot = await mkdtemp(path.join(tmpdir(), "samurai-migration-fresh-"));
const legacyRoot = await mkdtemp(path.join(tmpdir(), "samurai-migration-legacy-"));
const versionOneRoot = await mkdtemp(path.join(tmpdir(), "samurai-migration-v1-"));
try {
  const fresh = await WorkspaceStore.create({ rootDir: freshRoot });
  const freshMigrations = await fresh.listSchemaMigrations();
  assert.equal(freshMigrations.length, 2);
  assert.equal(freshMigrations[0].version, 1);
  assert.equal(freshMigrations[1].version, 2);
  await fresh.close();

  const legacySeed = await WorkspaceStore.create({ rootDir: legacyRoot });
  await legacySeed.close();
  const legacyDb = new Database(path.join(legacyRoot, "workspace.sqlite"));
  legacyDb.exec("DROP TABLE schema_migrations");
  legacyDb.close();

  const upgraded = await WorkspaceStore.create({ rootDir: legacyRoot });
  const upgradedMigrations = await upgraded.listSchemaMigrations();
  assert.equal(upgradedMigrations.length, 2);
  assert.deepEqual(upgradedMigrations.map((item) => item.checksum), freshMigrations.map((item) => item.checksum));
  await upgraded.close();

  const versionOneSeed = await WorkspaceStore.create({ rootDir: versionOneRoot });
  await versionOneSeed.close();
  const versionOneDb = new Database(path.join(versionOneRoot, "workspace.sqlite"));
  versionOneDb.exec("DROP TABLE gateway_deliveries; DELETE FROM schema_migrations WHERE version = 2");
  versionOneDb.close();
  const versionOneUpgraded = await WorkspaceStore.create({ rootDir: versionOneRoot });
  const versionOneMigrations = await versionOneUpgraded.listSchemaMigrations();
  assert.deepEqual(versionOneMigrations.map((item) => item.checksum), freshMigrations.map((item) => item.checksum));
  assert.equal((await versionOneUpgraded.listGatewayDeliveries()).length, 0);
  await versionOneUpgraded.close();

  const tamperedDb = new Database(path.join(legacyRoot, "workspace.sqlite"));
  tamperedDb.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1").run("tampered");
  tamperedDb.close();
  await assert.rejects(WorkspaceStore.create({ rootDir: legacyRoot }), /schema_migration_checksum_mismatch:1/);

  process.stdout.write(`${JSON.stringify({
    status: "passed", fresh_install: true, supported_legacy_versions: ["unversioned_baseline", "v1"],
    upgraded_versions: 2, checksum_equal: true, checksum_tamper_rejected: true,
    latest_version: freshMigrations.at(-1)!.version, checksums: freshMigrations.map((item) => item.checksum)
  })}\n`);
} finally {
  await rm(freshRoot, { recursive: true, force: true });
  await rm(legacyRoot, { recursive: true, force: true });
  await rm(versionOneRoot, { recursive: true, force: true });
}
