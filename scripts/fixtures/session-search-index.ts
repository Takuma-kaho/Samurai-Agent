import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-search-index-"));
const store = await WorkspaceStore.create({ rootDir: root });
const now = "2026-07-11T00:00:00.000Z";
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
  await sql.raw("DELETE FROM session_search_fts").execute(store.db);
  if (store.getSessionSearchMode() === "fts5_trigram") await sql.raw("DELETE FROM session_search_trigram").execute(store.db);
  assert.equal((await store.search("ranktoken")).filter((item) => item.kind === "message").length, 0);
  await store.reindexSessionSearch();
  const rankAfter = (await store.search("ranktoken")).filter((item) => item.kind === "message").map((item) => item.id);
  assert.deepEqual(rankAfter, rankBefore);

  process.stdout.write(`${JSON.stringify({ status: "passed", mode: store.getSessionSearchMode(), create_immediate: true, update_immediate: true, delete_immediate: true, corrupt_detected: true, rank_before: rankBefore, rank_after: rankAfter, deterministic_rebuild: true })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}
