import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { WorkspaceDb } from "../../packages/workspace-store/src/kernel/workspace-db-schema";
import { SessionSearchIndex } from "../../packages/workspace-store/src/kernel/session-search-index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-search-index-"));
let store = await WorkspaceStore.create({ rootDir: root });
const now = "2026-07-11T00:00:00.000Z";

function ftsRowCount(dbPath: string): number {
  const database = new Database(dbPath, { readonly: true });
  try {
    return Number((database.prepare("SELECT COUNT(*) AS count FROM session_search_fts").get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function clearFtsRows(dbPath: string, mode: ReturnType<WorkspaceStore["getSessionSearchMode"]>): void {
  const database = new Database(dbPath);
  try {
    database.exec("DELETE FROM session_search_fts");
    if (mode === "fts5_trigram") database.exec("DELETE FROM session_search_trigram");
  } finally {
    database.close();
  }
}

function insertRestartSentinel(dbPath: string, mode: ReturnType<WorkspaceStore["getSessionSearchMode"]>): void {
  const database = new Database(dbPath);
  try {
    const values = ["message", "restart-sentinel", "search-session", null, "restart sentinel", "restart-persistence-token"];
    database.prepare("INSERT INTO session_search_fts(kind, id, session_id, operation_id, title, body) VALUES (?, ?, ?, ?, ?, ?)").run(...values);
    if (mode === "fts5_trigram") database.prepare("INSERT INTO session_search_trigram(kind, id, session_id, operation_id, title, body) VALUES (?, ?, ?, ?, ?, ?)").run(...values);
  } finally {
    database.close();
  }
}

async function verifyLikeFallback(): Promise<void> {
  const dbPath = path.join(root, "session-search-readonly.sqlite");
  new Database(dbPath).close();
  const database = new Database(dbPath, { readonly: true });
  const db = new Kysely<WorkspaceDb>({ dialect: new SqliteDialect({ database }) });
  try {
    const index = new SessionSearchIndex(db);
    await index.initialize(async () => []);
    assert.equal(index.getMode(), "like");
  } finally {
    await db.destroy();
  }
}

try {
  await store.createSession({ id: "search-session", session_key: "web:search:main", title: "Search session", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  await store.saveMessage({ id: "message-mutable", session_id: "search-session", role: "user", content: "create-token", input_locale: "en", output_locale: "en", created_at: now });
  assert.ok((await store.search("create-token")).some((item) => item.id === "message-mutable"));
  await store.updateMessageContent("message-mutable", "updated-token");
  assert.ok(!(await store.search("create-token")).some((item) => item.id === "message-mutable"));
  assert.ok((await store.search("updated-token")).some((item) => item.id === "message-mutable"));
  await store.deleteMessage("message-mutable");
  assert.ok(!(await store.search("updated-token")).some((item) => item.id === "message-mutable"));

  for (const [id, suffix] of [["rank-a", "alpha"], ["rank-b", "beta"], ["rank-c", "gamma"]] as const) {
    await store.saveMessage({ id, session_id: "search-session", role: "user", content: `ranktoken ${suffix}`, input_locale: "en", output_locale: "en", created_at: now });
  }
  const rankBefore = (await store.search("ranktoken")).filter((item) => item.kind === "message").map((item) => item.id);
  const modeBeforeRestart = store.getSessionSearchMode();
  const indexedBeforeRestart = modeBeforeRestart === "like" ? 0 : ftsRowCount(store.dbPath);
  await store.close();
  if (modeBeforeRestart !== "like") insertRestartSentinel(store.dbPath, modeBeforeRestart);
  store = await WorkspaceStore.create({ rootDir: root });
  assert.deepEqual((await store.search("ranktoken")).filter((item) => item.kind === "message").map((item) => item.id), rankBefore);
  if (modeBeforeRestart !== "like") assert.equal(ftsRowCount(store.dbPath), indexedBeforeRestart + 1);
  const restartSentinelPreserved = modeBeforeRestart === "like" || (await store.search("restart-persistence-token")).some((item) => item.id === "restart-sentinel");
  assert.equal(restartSentinelPreserved, true);

  if (store.getSessionSearchMode() !== "like") {
    clearFtsRows(store.dbPath, store.getSessionSearchMode());
    assert.equal((await store.search("ranktoken")).filter((item) => item.kind === "message").length, 0);
  }
  await store.reindexSessionSearch();
  const rankAfter = (await store.search("ranktoken")).filter((item) => item.kind === "message").map((item) => item.id);
  assert.deepEqual(rankAfter, rankBefore);
  if (modeBeforeRestart !== "like") assert.ok(!(await store.search("restart-persistence-token")).some((item) => item.id === "restart-sentinel"));
  await verifyLikeFallback();

  process.stdout.write(`${JSON.stringify({ status: "passed", mode: store.getSessionSearchMode(), create_immediate: true, update_immediate: true, delete_immediate: true, startup_preserves_fts: restartSentinelPreserved, fts_restart_tested: modeBeforeRestart !== "like", fts_fallback: true, rank_before: rankBefore, rank_after: rankAfter, deterministic_rebuild: true })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
