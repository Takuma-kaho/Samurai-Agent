import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { nowIso, type SessionRecord } from "../../packages/core-schemas/src";
import { WorkspaceStore } from "../../packages/workspace-store/src";

type KillPhase = "swap" | "committed";

function record(id: string, title: string): SessionRecord {
  const now = nowIso();
  return {
    id,
    session_key: `web:recovery:${id}`,
    title,
    ui_locale: "ja",
    output_locale: "ja",
    created_at: now,
    updated_at: now
  };
}

if (process.argv[2] === "--restore-child") {
  const root = process.argv[3];
  const backupId = process.argv[4];
  const phase = process.argv[5] as KillPhase;
  if (!root || !backupId || (phase !== "swap" && phase !== "committed")) process.exit(2);
  const store = await WorkspaceStore.create({
    rootDir: root,
    restoreFailureInjector(current) {
      if (current === phase) process.kill(process.pid, "SIGKILL");
    }
  });
  await store.restoreWorkspaceBackup(backupId);
  process.exit(3);
}

async function runKilledRestore(root: string, backupId: string, phase: KillPhase): Promise<void> {
  const child = spawn(process.execPath, [process.argv[1]!, "--restore-child", root, backupId, phase], {
    stdio: "ignore"
  });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(code, null);
  assert.equal(signal, "SIGKILL");
}

async function setupRoot(prefix: string): Promise<{ root: string; backupId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const store = await WorkspaceStore.create({ rootDir: root });
  try {
    await store.createSession(record("backup-session", "Backup state"));
    await writeFile(path.join(root, "profile", "state.md"), "backup\n");
    const backup = await store.createWorkspaceBackup();
    await store.createSession(record("current-session", "Current state"));
    await writeFile(path.join(root, "profile", "state.md"), "current\n");
    return { root, backupId: backup.id };
  } finally {
    await store.close();
  }
}

const swap = await setupRoot("samurai-restore-recovery-swap-");
const committed = await setupRoot("samurai-restore-recovery-committed-");
try {
  await runKilledRestore(swap.root, swap.backupId, "swap");
  assert.throws(() => new WorkspaceStore({ rootDir: swap.root }), /workspace_restore_recovery_required/);
  let recovered = await WorkspaceStore.create({ rootDir: swap.root });
  try {
    assert.equal((await recovered.getSession("current-session"))?.title, "Current state");
    assert.equal((await recovered.getSession("backup-session"))?.title, "Backup state");
  } finally {
    await recovered.close();
  }

  await runKilledRestore(committed.root, committed.backupId, "committed");
  assert.throws(() => new WorkspaceStore({ rootDir: committed.root }), /workspace_restore_recovery_required/);
  recovered = await WorkspaceStore.create({ rootDir: committed.root });
  try {
    assert.equal((await recovered.getSession("backup-session"))?.title, "Backup state");
    assert.equal(await recovered.getSession("current-session"), undefined);
  } finally {
    await recovered.close();
  }

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    killed_after_current_moved: true,
    recovered_original_workspace: true,
    killed_after_committed: true,
    preserved_restored_workspace: true,
    direct_constructor_requires_recovery: true
  })}\n`);
} finally {
  await Promise.all([swap.root, committed.root].map((root) => rm(root, { recursive: true, force: true })));
}
