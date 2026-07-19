import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const phases = ["extract", "hash_verify", "swap"] as const;
const outcomes: Array<{ phase: string; current_preserved: boolean }> = [];

for (const phase of phases) {
  const root = await mkdtemp(path.join(tmpdir(), `samurai-restore-${phase}-`));
  let store = await WorkspaceStore.create({ rootDir: root });
  try {
    const base = "2026-07-11T00:00:00.000Z";
    await store.createSession({ id: "backup-session", session_key: "web:backup:main", title: "Backup state", ui_locale: "en", output_locale: "en", created_at: base, updated_at: base });
    await writeFile(path.join(root, "profile", "user.md"), "backup profile\n");
    const backup = await store.createWorkspaceBackup();
    await store.createSession({ id: "current-session", session_key: "web:current:main", title: "Current state", ui_locale: "en", output_locale: "en", created_at: base, updated_at: base });
    await writeFile(path.join(root, "profile", "user.md"), "current profile\n");
    await store.close();

    store = await WorkspaceStore.create({
      rootDir: root,
      restoreFailureInjector(current) {
        if (current === phase) throw new Error(`restore_failure:${phase}`);
      }
    });
    await assert.rejects(store.restoreWorkspaceBackup(backup.id), new RegExp(`restore_failure:${phase}`));
    assert.equal((await store.getSession("current-session"))?.title, "Current state");
    assert.equal(await readFile(path.join(root, "profile", "user.md"), "utf8"), "current profile\n");
    outcomes.push({ phase, current_preserved: true });
  } finally {
    await store.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

process.stdout.write(`${JSON.stringify({ status: "passed", failure_points: phases, outcomes, preserved_count: outcomes.length })}\n`);
