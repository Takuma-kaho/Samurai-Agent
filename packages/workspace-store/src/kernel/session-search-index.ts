import { Kysely, sql } from "kysely";
import type { WorkspaceDb } from "./workspace-db-schema";

export type SessionSearchIndexMode = "fts5_trigram" | "fts5" | "like";
export interface SessionSearchEntry { kind: "session" | "message" | "artifact"; id: string; sessionId?: string; operationId?: string; title: string; body: string; }
export interface SessionSearchResult { kind: "session" | "message" | "artifact"; id: string; title: string; summary: string; session_id?: string; operation_id?: string; }

/** SQLite FTS is a derived index: it is initialized once and rebuilt only on demand. */
export class SessionSearchIndex {
  private mode: SessionSearchIndexMode = "like";

  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  getMode(): SessionSearchIndexMode {
    return this.mode;
  }

  /** Returns the active derived-index size without exposing its table to callers. */
  async countEntries(): Promise<number | undefined> {
    if (this.mode === "like") return 0;
    const table = this.mode === "fts5_trigram" ? "session_search_trigram" : "session_search_fts";
    try {
      const result = await sql<{ count: number }>`SELECT COUNT(*) as count FROM ${sql.raw(table)}`.execute(this.db);
      return Number(result.rows[0]?.count ?? 0);
    } catch {
      this.mode = "like";
      return undefined;
    }
  }

  async initialize(loadEntries: () => Promise<SessionSearchEntry[]>): Promise<void> {
    try {
      if (await tableExists(this.db, "session_search_fts")) {
        this.mode = await tableExists(this.db, "session_search_trigram") ? "fts5_trigram" : "fts5";
        return;
      }
      await sql.raw("CREATE VIRTUAL TABLE session_search_fts USING fts5(kind UNINDEXED, id UNINDEXED, session_id UNINDEXED, operation_id UNINDEXED, title, body, tokenize='unicode61')").execute(this.db);
      try {
        await sql.raw("CREATE VIRTUAL TABLE session_search_trigram USING fts5(kind UNINDEXED, id UNINDEXED, session_id UNINDEXED, operation_id UNINDEXED, title, body, tokenize='trigram')").execute(this.db);
        this.mode = "fts5_trigram";
      } catch {
        this.mode = "fts5";
      }
      await this.reindex(await loadEntries());
    } catch {
      this.mode = "like";
    }
  }

  async reindex(entries: readonly SessionSearchEntry[]): Promise<{ mode: SessionSearchIndexMode; indexed: number }> {
    if (this.mode === "like") {
      try {
        if (!await tableExists(this.db, "session_search_fts")) return { mode: "like", indexed: 0 };
        this.mode = await tableExists(this.db, "session_search_trigram") ? "fts5_trigram" : "fts5";
      } catch {
        return { mode: "like", indexed: 0 };
      }
    }
    try {
      await sql.raw("DELETE FROM session_search_fts").execute(this.db);
      if (this.mode === "fts5_trigram") await sql.raw("DELETE FROM session_search_trigram").execute(this.db);
      for (const entry of entries) await this.insert(entry);
      return { mode: this.mode, indexed: entries.length };
    } catch {
      this.mode = "like";
      return { mode: "like", indexed: 0 };
    }
  }

  async upsert(entry: SessionSearchEntry): Promise<void> {
    if (this.mode === "like") return;
    try {
      await this.remove(entry.kind, entry.id);
      if (this.getMode() === "like") return;
      await this.insert(entry);
    } catch {
      this.mode = "like";
    }
  }

  async remove(kind: SessionSearchEntry["kind"], id: string): Promise<void> {
    if (this.mode === "like") return;
    try {
      await sql`DELETE FROM session_search_fts WHERE kind = ${kind} AND id = ${id}`.execute(this.db);
      if (this.mode === "fts5_trigram") await sql`DELETE FROM session_search_trigram WHERE kind = ${kind} AND id = ${id}`.execute(this.db);
    } catch {
      this.mode = "like";
    }
  }

  async search(query: string): Promise<SessionSearchResult[]> {
    if (this.mode === "like") return [];
    const table = this.mode === "fts5_trigram" && containsJapanese(query) ? "session_search_trigram" : "session_search_fts";
    const matchQuery = `"${query.replaceAll('"', '""')}"`;
    try {
      const rows = containsJapanese(query) && [...query].length < 3
        ? await sql<SessionSearchResult & { body: string }>`SELECT kind, id, session_id, operation_id, title, body FROM ${sql.raw(table)} WHERE title LIKE ${`%${query}%`} OR body LIKE ${`%${query}%`} ORDER BY kind, id LIMIT 30`.execute(this.db)
        : await sql<SessionSearchResult & { body: string }>`SELECT kind, id, session_id, operation_id, title, body FROM ${sql.raw(table)} WHERE ${sql.raw(table)} MATCH ${matchQuery} ORDER BY bm25(${sql.raw(table)}), kind, id LIMIT 30`.execute(this.db);
      return rows.rows.map((row) => ({ kind: row.kind, id: row.id, title: row.title, summary: row.body.slice(0, 120), ...(row.session_id ? { session_id: row.session_id } : {}), ...(row.operation_id ? { operation_id: row.operation_id } : {}) }));
    } catch {
      this.mode = "like";
      return [];
    }
  }

  private async insert(entry: SessionSearchEntry): Promise<void> {
    await sql`INSERT INTO session_search_fts (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
    if (this.mode === "fts5_trigram") await sql`INSERT INTO session_search_trigram (kind, id, session_id, operation_id, title, body) VALUES (${entry.kind}, ${entry.id}, ${entry.sessionId ?? null}, ${entry.operationId ?? null}, ${entry.title}, ${entry.body})`.execute(this.db);
  }
}

async function tableExists(db: Kysely<WorkspaceDb>, table: string): Promise<boolean> {
  const result = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`.execute(db);
  return result.rows.length > 0;
}

function containsJapanese(value: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(value);
}
