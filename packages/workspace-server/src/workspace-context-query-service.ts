import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceSql } from "./postgres";

/** The three resources intentionally exposed by Workspace search. */
export const workspaceContextSearchTypes = ["room", "conversation", "knowledge"] as const;
export type WorkspaceContextSearchType = (typeof workspaceContextSearchTypes)[number];

export interface WorkspaceContextQueryContext {
  accountId: string;
  workspaceId: string;
}

/** PostgresWorkspaceDatabase satisfies this seam. */
export interface WorkspaceContextQueryDatabase {
  withReadSnapshot<T>(
    context: WorkspaceContextQueryContext,
    action: (sql: WorkspaceSql) => Promise<T>
  ): Promise<T>;
}

export interface WorkspaceContextQueryInput {
  q: unknown;
  types?: unknown;
  room_id?: unknown;
  /** Server-internal spelling retained for direct Core callers. */
  roomId?: unknown;
  limit?: unknown;
  cursor?: unknown;
}

export interface WorkspaceContextSearchTarget {
  kind: "room" | "work" | "knowledge";
  room_id: string;
  work_id?: string;
  message_id?: string;
  resource_id?: string;
}

export interface WorkspaceContextSearchItem {
  type: WorkspaceContextSearchType;
  id: string;
  room_id: string;
  title: string;
  snippet: string;
  updated_at: string;
  target: WorkspaceContextSearchTarget;
}

export interface WorkspaceContextSearchPage {
  items: readonly WorkspaceContextSearchItem[];
  next_cursor: string | null;
}

export interface WorkspaceContextSearchDetailInput {
  type: unknown;
  id: unknown;
  room_id?: unknown;
  roomId?: unknown;
}

export interface WorkspaceContextQueryServiceOptions {
  database: WorkspaceContextQueryDatabase;
  /** Canonical Server origin, bound into every cursor. */
  origin: string;
  /** Required dependency-injected HMAC key. */
  cursorSecret: Uint8Array | string;
  now?: () => Date;
  cursorTtlMs?: number;
}

interface SearchCandidateRow {
  type: WorkspaceContextSearchType;
  id: string;
  room_id: string;
  title: string;
  body: string;
  updated_at: Date;
  work_id?: string;
}

interface ScoredCandidate {
  row: SearchCandidateRow;
  rank: 0 | 1 | 2;
  typeOrder: 0 | 1 | 2;
  updatedAt: string;
}

interface SearchCursorPayload {
  format_version: 1;
  origin: string;
  account_id: string;
  workspace_id: string;
  condition_hash: string;
  as_of: string;
  issued_at: string;
  last_key: {
    rank: 0 | 1 | 2;
    updated_at: string;
    type_order: 0 | 1 | 2;
    id: string;
  };
}

interface EncodedCursor extends SearchCursorPayload {
  signature: string;
}

interface CandidateDbRow {
  type?: unknown;
  id?: unknown;
  room_id?: unknown;
  title?: unknown;
  body?: unknown;
  updated_at?: unknown;
  work_id?: unknown;
}

const defaultPageSize = 30;
const maxPageSize = 100;
const maxCursorSize = 4096;
const defaultCursorTtlMs = 15 * 60 * 1000;
const unicodeWhitespace = /[\p{White_Space}]+/gu;
const htmlTag = /<[^>]*>/g;

/**
 * Context Query Core. The SQL creates the authorized Room set before reading
 * any title, body, projection, count, rank, or snippet.
 */
export class WorkspaceContextQueryService {
  private readonly now: () => Date;
  private readonly cursorTtlMs: number;
  private readonly cursorSecret: Buffer;

  constructor(private readonly options: WorkspaceContextQueryServiceOptions) {
    if (!options.database || typeof options.database.withReadSnapshot !== "function") {
      throw new WorkspaceServerError("workspace_search_database_required", 500);
    }
    if (typeof options.origin !== "string" || options.origin.trim().length === 0 || options.origin.length > 2048) {
      throw new WorkspaceServerError("workspace_search_origin_invalid", 500);
    }
    if (typeof options.cursorSecret !== "string" && !(options.cursorSecret instanceof Uint8Array)) {
      throw new WorkspaceServerError("workspace_search_cursor_secret_required", 500);
    }
    const secret = typeof options.cursorSecret === "string"
      ? Buffer.from(options.cursorSecret, "utf8")
      : Buffer.from(options.cursorSecret);
    if (secret.byteLength === 0) throw new WorkspaceServerError("workspace_search_cursor_secret_required", 500);
    this.cursorSecret = secret;
    this.now = options.now ?? (() => new Date());
    this.cursorTtlMs = options.cursorTtlMs ?? defaultCursorTtlMs;
    if (!Number.isInteger(this.cursorTtlMs) || this.cursorTtlMs <= 0 || this.cursorTtlMs > defaultCursorTtlMs) {
      throw new WorkspaceServerError("workspace_search_cursor_ttl_invalid", 500);
    }
  }

  async search(context: WorkspaceContextQueryContext, input: WorkspaceContextQueryInput): Promise<WorkspaceContextSearchPage> {
    const validatedContext = validateContext(context);
    const query = validateSearchInput(input);
    const conditionHash = searchConditionHash(query);
    const now = validNow(this.now);
    const cursor = query.cursor
      ? decodeSearchCursor(query.cursor, this.options.origin, validatedContext, conditionHash, now, this.cursorSecret, this.cursorTtlMs)
      : undefined;
    const asOf = cursor?.as_of ?? now.toISOString();

    return this.options.database.withReadSnapshot(validatedContext, async (sql) => {
      const result = await sql.query<CandidateDbRow>(
        contextSearchSql,
        [
          validatedContext.workspaceId,
          validatedContext.accountId,
          query.roomId,
          asOf,
          query.types,
          query.likePatterns
        ]
      );
      const asOfMs = Date.parse(asOf);
      const uniqueCandidates = new Map<string, SearchCandidateRow>();
      for (const row of result.rows.map(normalizeCandidateRow)) {
        if (!row || uniqueCandidates.has(row.type + ":" + row.id)) continue;
        uniqueCandidates.set(row.type + ":" + row.id, row);
      }
      const scored = Array.from(uniqueCandidates.values())
        .filter((row) => query.types.includes(row.type))
        .filter((row) => row.updated_at.getTime() <= asOfMs)
        .map((row) => scoreCandidate(row, query.terms))
        .filter((candidate): candidate is ScoredCandidate => Boolean(candidate))
        .sort(compareScoredCandidates)
        .filter((candidate) => !cursor || isAfterCursor(candidate, cursor.last_key));

      const visibleAndExtra = scored.slice(0, query.limit + 1);
      const pageRows = visibleAndExtra.slice(0, query.limit);
      const last = pageRows[pageRows.length - 1];
      const next_cursor = visibleAndExtra.length > query.limit && last
        ? encodeSearchCursor({
          format_version: 1,
          origin: this.options.origin,
          account_id: validatedContext.accountId,
          workspace_id: validatedContext.workspaceId,
          condition_hash: conditionHash,
          as_of: asOf,
          issued_at: now.toISOString(),
          last_key: {
            rank: last.rank,
            updated_at: last.updatedAt,
            type_order: last.typeOrder,
            id: last.row.id
          }
        }, this.cursorSecret)
        : null;
      return {
        items: pageRows.map((candidate) => toSearchItem(candidate, query.terms)),
        next_cursor
      };
    });
  }

  /** Compatibility name for an adapter that calls this a Workspace search. */
  async searchWorkspace(context: WorkspaceContextQueryContext, input: WorkspaceContextQueryInput): Promise<WorkspaceContextSearchPage> {
    return this.search(context, input);
  }

  async query(context: WorkspaceContextQueryContext, input: WorkspaceContextQueryInput): Promise<WorkspaceContextSearchPage> {
    return this.search(context, input);
  }

  /**
   * Re-resolves a selected result through the current authorized Room set.
   * A revoked result is intentionally indistinguishable from an unknown one.
   */
  async getSearchItem(context: WorkspaceContextQueryContext, input: WorkspaceContextSearchDetailInput): Promise<WorkspaceContextSearchItem> {
    const validatedContext = validateContext(context);
    const target = validateDetailInput(input);
    const now = validNow(this.now);
    return this.options.database.withReadSnapshot(validatedContext, async (sql) => {
      const result = await sql.query<CandidateDbRow>(
        contextSearchSql,
        [validatedContext.workspaceId, validatedContext.accountId, target.roomId, now.toISOString(), [target.type], []]
      );
      const row = result.rows
        .map(normalizeCandidateRow)
        .find((candidate): candidate is SearchCandidateRow => candidate !== undefined && candidate.type === target.type && candidate.id === target.id);
      if (!row) throw new WorkspaceServerError("search_result_not_found", 404);
      return toSearchItem({
        row,
        rank: 2,
        typeOrder: typeOrder(row.type),
        updatedAt: row.updated_at.toISOString()
      }, []);
    });
  }

  async getSearchResult(context: WorkspaceContextQueryContext, input: WorkspaceContextSearchDetailInput): Promise<WorkspaceContextSearchItem> {
    return this.getSearchItem(context, input);
  }

  async readSearchItem(context: WorkspaceContextQueryContext, input: WorkspaceContextSearchDetailInput): Promise<WorkspaceContextSearchItem> {
    return this.getSearchItem(context, input);
  }

  async getDetail(context: WorkspaceContextQueryContext, input: WorkspaceContextSearchDetailInput): Promise<WorkspaceContextSearchItem> {
    return this.getSearchItem(context, input);
  }
}

/** NFKC -> Unicode lowercase -> Unicode whitespace -> remove/dedupe. */
export function normalizeWorkspaceSearchTerms(value: string): readonly string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of value.normalize("NFKC").toLowerCase().split(unicodeWhitespace)) {
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

/** Escape LIKE metacharacters before the patterns become bind values. */
export function escapeWorkspaceSearchLikeTerm(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (character) => "\\" + character) + "%";
}

function validateContext(context: WorkspaceContextQueryContext): WorkspaceContextQueryContext {
  if (!context || typeof context !== "object") throw new WorkspaceServerError("workspace_search_context_invalid", 400);
  if (typeof context.accountId !== "string") throw new WorkspaceServerError("account_id_invalid", 400);
  if (typeof context.workspaceId !== "string") throw new WorkspaceServerError("workspace_id_invalid", 400);
  assertOpaqueId(context.accountId, "account_id_invalid");
  assertOpaqueId(context.workspaceId, "workspace_id_invalid");
  return { accountId: context.accountId, workspaceId: context.workspaceId };
}

interface ValidatedSearchInput {
  terms: readonly string[];
  types: readonly WorkspaceContextSearchType[];
  roomId?: string;
  limit: number;
  cursor?: string;
  likePatterns: readonly string[];
}

function validateSearchInput(input: WorkspaceContextQueryInput): ValidatedSearchInput {
  if (!input || typeof input !== "object") throw new WorkspaceServerError("workspace_search_input_invalid", 400);
  if (typeof input.q !== "string") throw new WorkspaceServerError("workspace_search_query_invalid", 400);
  const trimmedQuery = input.q.trim();
  if (trimmedQuery.length < 1 || trimmedQuery.length > 512) {
    throw new WorkspaceServerError("workspace_search_query_invalid", 400);
  }
  const terms = normalizeWorkspaceSearchTerms(trimmedQuery);
  if (terms.length === 0) throw new WorkspaceServerError("workspace_search_query_invalid", 400);

  const types = validateTypes(input.types);
  const roomId = validateRoomId(input.room_id, input.roomId);
  const limit = validateLimit(input.limit);
  let cursor: string | undefined;
  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > maxCursorSize) {
      throw new WorkspaceServerError("search_cursor_invalid", 400);
    }
    cursor = input.cursor;
  }
  return {
    terms,
    types,
    ...(roomId ? { roomId } : {}),
    limit,
    ...(cursor ? { cursor } : {}),
    likePatterns: terms.map(escapeWorkspaceSearchLikeTerm)
  };
}

function validateTypes(value: unknown): readonly WorkspaceContextSearchType[] {
  if (value === undefined) return workspaceContextSearchTypes;
  if (!Array.isArray(value) || value.length < 1 || value.length > workspaceContextSearchTypes.length) {
    throw new WorkspaceServerError("workspace_search_types_invalid", 400);
  }
  const seen = new Set<string>();
  for (const type of value) {
    if (typeof type !== "string" || !workspaceContextSearchTypes.includes(type as WorkspaceContextSearchType) || seen.has(type)) {
      throw new WorkspaceServerError("workspace_search_types_invalid", 400);
    }
    seen.add(type);
  }
  return value as WorkspaceContextSearchType[];
}

function validateRoomId(roomIdValue: unknown, roomIdAlias: unknown): string | undefined {
  if (roomIdValue !== undefined && roomIdAlias !== undefined && roomIdValue !== roomIdAlias) {
    throw new WorkspaceServerError("workspace_search_room_id_invalid", 400);
  }
  const value = roomIdValue ?? roomIdAlias;
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new WorkspaceServerError("workspace_search_room_id_invalid", 400);
  assertOpaqueId(value, "room_id_invalid");
  return value;
}

function validateLimit(value: unknown): number {
  if (value === undefined) return defaultPageSize;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maxPageSize) {
    throw new WorkspaceServerError("workspace_search_limit_invalid", 400);
  }
  return value;
}

function validateDetailInput(input: WorkspaceContextSearchDetailInput): { type: WorkspaceContextSearchType; id: string; roomId?: string } {
  if (!input || typeof input !== "object" || typeof input.type !== "string" || !workspaceContextSearchTypes.includes(input.type as WorkspaceContextSearchType)) {
    throw new WorkspaceServerError("search_result_invalid", 400);
  }
  if (typeof input.id !== "string") throw new WorkspaceServerError("search_result_invalid", 400);
  assertOpaqueId(input.id, "search_result_invalid");
  const roomId = validateRoomId(input.room_id, input.roomId);
  return { type: input.type as WorkspaceContextSearchType, id: input.id, ...(roomId ? { roomId } : {}) };
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new WorkspaceServerError("workspace_search_clock_invalid", 500);
  return value;
}

function searchConditionHash(input: ValidatedSearchInput): string {
  const condition = JSON.stringify({
    terms: input.terms,
    types: input.types,
    room_id: input.roomId ?? null
  });
  return createHash("sha256").update(condition).digest("hex");
}

function normalizeCandidateRow(row: CandidateDbRow): SearchCandidateRow | undefined {
  if (!row || typeof row.type !== "string" || !workspaceContextSearchTypes.includes(row.type as WorkspaceContextSearchType)) return undefined;
  if (typeof row.id !== "string" || typeof row.room_id !== "string") return undefined;
  const updated = row.updated_at instanceof Date ? new Date(row.updated_at.getTime()) : new Date(String(row.updated_at ?? ""));
  if (!Number.isFinite(updated.getTime())) return undefined;
  const title = typeof row.title === "string" ? row.title : "";
  const body = typeof row.body === "string" ? row.body : "";
  const workId = typeof row.work_id === "string" && row.work_id.length > 0 ? row.work_id : undefined;
  return {
    type: row.type as WorkspaceContextSearchType,
    id: row.id,
    room_id: row.room_id,
    title,
    body,
    updated_at: updated,
    ...(workId ? { work_id: workId } : {})
  };
}

function scoreCandidate(row: SearchCandidateRow, terms: readonly string[]): ScoredCandidate | undefined {
  const normalizedTitle = normalizeSearchText(row.title);
  const normalizedBody = normalizeSearchText(row.body);
  const normalizedSearchable = (normalizedTitle + " " + normalizedBody).trim();
  if (!terms.every((term) => normalizedSearchable.includes(term))) return undefined;
  const termsInTitle = terms.every((term) => normalizedTitle.includes(term));
  const normalizedFullQuery = terms.join(" ");
  const rank: 0 | 1 | 2 = normalizedTitle === normalizedFullQuery ? 0 : termsInTitle ? 1 : 2;
  return { row, rank, typeOrder: typeOrder(row.type), updatedAt: row.updated_at.toISOString() };
}

function normalizeSearchText(value: string): string {
  return normalizeWorkspaceSearchTerms(value).join(" ");
}

function typeOrder(type: WorkspaceContextSearchType): 0 | 1 | 2 {
  return type === "room" ? 0 : type === "conversation" ? 1 : 2;
}

function compareScoredCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? -1 : 1;
  if (left.typeOrder !== right.typeOrder) return left.typeOrder - right.typeOrder;
  return left.row.id < right.row.id ? -1 : left.row.id > right.row.id ? 1 : 0;
}

function isAfterCursor(candidate: ScoredCandidate, key: SearchCursorPayload["last_key"]): boolean {
  if (candidate.rank !== key.rank) return candidate.rank > key.rank;
  if (candidate.updatedAt !== key.updated_at) return candidate.updatedAt < key.updated_at;
  if (candidate.typeOrder !== key.type_order) return candidate.typeOrder > key.type_order;
  return candidate.row.id > key.id;
}

function toSearchItem(candidate: ScoredCandidate, terms: readonly string[]): WorkspaceContextSearchItem {
  const { row } = candidate;
  const plainTitle = toPlainText(row.title);
  const plainBody = toPlainText(row.body);
  const title = plainTitle.slice(0, 200);
  const snippet = makeSnippet(plainBody || plainTitle, terms);
  if (row.type === "room") {
    return {
      type: row.type,
      id: row.id,
      room_id: row.room_id,
      title,
      snippet,
      updated_at: candidate.updatedAt,
      target: { kind: "room", room_id: row.room_id }
    };
  }
  if (row.type === "knowledge") {
    return {
      type: row.type,
      id: row.id,
      room_id: row.room_id,
      title,
      snippet,
      updated_at: candidate.updatedAt,
      target: { kind: "knowledge", room_id: row.room_id, resource_id: row.id }
    };
  }
  return {
    type: row.type,
    id: row.id,
    room_id: row.room_id,
    title,
    snippet,
    updated_at: candidate.updatedAt,
    target: {
      kind: "work",
      room_id: row.room_id,
      work_id: row.work_id ?? row.id,
      message_id: row.id
    }
  };
}

function toPlainText(value: string): string {
  return value.replace(htmlTag, " ");
}

function makeSnippet(body: string, terms: readonly string[]): string {
  if (body.length <= 200) return body;
  const normalizedBody = body.normalize("NFKC").toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const index = normalizedBody.indexOf(term);
    if (index >= 0 && (firstMatch < 0 || index < firstMatch)) firstMatch = index;
  }
  const start = firstMatch < 0 ? 0 : Math.max(0, firstMatch - 40);
  return body.slice(start, start + 200);
}

function encodeSearchCursor(payload: SearchCursorPayload, secret: Buffer): string {
  const signature = createHmac("sha256", secret).update(canonicalJson(payload)).digest("base64url");
  const envelope: EncodedCursor = { ...payload, signature };
  return Buffer.from(canonicalJson(envelope), "utf8").toString("base64url");
}

function decodeSearchCursor(
  encoded: string,
  origin: string,
  context: WorkspaceContextQueryContext,
  conditionHash: string,
  now: Date,
  secret: Buffer,
  ttlMs: number
): SearchCursorPayload {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > maxCursorSize) throw new Error("invalid cursor alphabet");
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<EncodedCursor>;
    if (!decoded || typeof decoded !== "object" || typeof decoded.signature !== "string") throw new Error("missing signature");
    const { signature, ...payload } = decoded;
    if (!isCursorPayload(payload)) throw new Error("invalid payload");
    const expected = createHmac("sha256", secret).update(canonicalJson(payload)).digest("base64url");
    const expectedBytes = Buffer.from(expected, "utf8");
    const actualBytes = Buffer.from(signature, "utf8");
    if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) throw new Error("signature mismatch");
    if (payload.origin !== origin || payload.account_id !== context.accountId || payload.workspace_id !== context.workspaceId || payload.condition_hash !== conditionHash) {
      throw new Error("cursor scope mismatch");
    }
    const asOfMs = Date.parse(payload.as_of);
    const issuedAtMs = Date.parse(payload.issued_at);
    if (!Number.isFinite(asOfMs) || !Number.isFinite(issuedAtMs) || asOfMs > now.getTime() || issuedAtMs > now.getTime() || now.getTime() - issuedAtMs > ttlMs || now.getTime() - asOfMs > ttlMs) {
      throw new Error("cursor expired");
    }
    return payload;
  } catch {
    throw new WorkspaceServerError("search_cursor_invalid", 400);
  }
}

function isCursorPayload(value: Partial<SearchCursorPayload>): value is SearchCursorPayload {
  const key = value.last_key;
  return value.format_version === 1
    && typeof value.origin === "string"
    && typeof value.account_id === "string"
    && typeof value.workspace_id === "string"
    && typeof value.condition_hash === "string"
    && typeof value.as_of === "string"
    && typeof value.issued_at === "string"
    && Boolean(key)
    && (key?.rank === 0 || key?.rank === 1 || key?.rank === 2)
    && typeof key?.updated_at === "string"
    && (key?.type_order === 0 || key?.type_order === 1 || key?.type_order === 2)
    && typeof key?.id === "string"
    && key.id.length > 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * The authorization boundary is the first CTE. The search projection is
 * joined only through an authorized Room and only at its confirmed current
 * version. Agent/workspace-scoped resources cannot enter this candidate set.
 *
 * The final Unicode match is intentionally done in Core after this authorized
 * set is materialized. PostgreSQL collations must not change NFKC/lowercase/
 * Unicode-whitespace behavior. PostgreSQL 17's NFKC normalization is used as
 * a coarse candidate predicate, and Core repeats the exact match before
 * ranking/snippet generation.
 */
const contextSearchSql = [
  "WITH authorized_rooms AS MATERIALIZED (",
  "  SELECT room.workspace_id, room.id, room.name, room.updated_at",
  "  FROM rooms AS room",
  "  JOIN workspaces AS workspace",
  "    ON workspace.id = room.workspace_id",
  "   AND workspace.state IN ('active', 'read_only')",
  "  JOIN workspace_members AS membership",
  "    ON membership.workspace_id = room.workspace_id",
  "   AND membership.account_id = $2",
  "   AND membership.state = 'active'",
  "  WHERE room.workspace_id = $1",
  "    AND samurai_can_room(room.workspace_id, room.id, 'read')",
  "    AND ($3::TEXT IS NULL OR room.id = $3)",
  "),",
  "conversation_candidates AS (",
  "  SELECT DISTINCT ON (message.workspace_id, message.id)",
  "    'conversation'::TEXT AS type,",
  "    message.id,",
  "    room.id AS room_id,",
  "    session.title,",
  "    message.content AS body,",
  "    message.created_at AS updated_at,",
  "    NULLIF(run.metadata ->> 'work_id', '') AS work_id",
  "  FROM authorized_rooms AS room",
  "  JOIN workspace_runtime_sessions AS session",
  "    ON session.workspace_id = room.workspace_id AND session.room_id = room.id",
  "  JOIN workspace_runtime_messages AS message",
  "    ON message.workspace_id = session.workspace_id AND message.session_id = session.id",
  "  LEFT JOIN workspace_runtime_runs AS run",
  "    ON run.workspace_id = message.workspace_id",
  "   AND (run.input_message_id = message.id OR run.output_message_id = message.id)",
  // Runtime runs expose started_at/completed_at rather than a mutable
  // updated_at column. Keep the latest terminal timestamp when present so a
  // joined run can deterministically break ties without relying on a column
  // that does not exist in the PostgreSQL schema.
  "  ORDER BY message.workspace_id, message.id, COALESCE(run.completed_at, run.started_at) DESC NULLS LAST",
  "),",
  "work_conversation_candidates AS (",
  "  SELECT",
  "    'conversation'::TEXT AS type,",
  "    instruction.id,",
  "    room.id AS room_id,",
  "    work.title,",
  "    instruction.body,",
  "    instruction.created_at AS updated_at,",
  "    work.id AS work_id",
  "  FROM authorized_rooms AS room",
  "  JOIN workspace_human_work_instructions AS instruction",
  "    ON instruction.workspace_id = room.workspace_id AND instruction.room_id = room.id",
  "  JOIN workspace_human_works AS work",
  "    ON work.workspace_id = instruction.workspace_id AND work.id = instruction.work_id",
  "  UNION ALL",
  "  SELECT",
  "    'conversation'::TEXT AS type,",
  "    comment.id,",
  "    room.id AS room_id,",
  "    work.title,",
  "    comment.body,",
  "    comment.created_at AS updated_at,",
  "    work.id AS work_id",
  "  FROM authorized_rooms AS room",
  "  JOIN workspace_human_work_comments AS comment",
  "    ON comment.workspace_id = room.workspace_id AND comment.room_id = room.id",
  "  JOIN workspace_human_works AS work",
  "    ON work.workspace_id = comment.workspace_id AND work.id = comment.work_id",
  "),",
  "knowledge_candidates AS (",
  "  SELECT",
  "    'knowledge'::TEXT AS type,",
  "    resource.id,",
  "    resource.room_id,",
  "    resource.title,",
  "    projection.search_text AS body,",
  "    resource.updated_at,",
  "    NULL::TEXT AS work_id",
  "  FROM authorized_rooms AS room",
  "  JOIN workspace_completion_resources AS resource",
  "    ON resource.workspace_id = room.workspace_id AND resource.room_id = room.id",
  "   AND resource.scope_kind = 'room'",
  "   AND resource.resource_kind = 'knowledge'",
  "   AND resource.evidence_state = 'confirmed'",
  "   AND resource.current_confirmed_version IS NOT NULL",
  "   AND resource.lifecycle_state <> 'archived'",
  "  JOIN workspace_completion_resource_versions AS current_version",
  "    ON current_version.workspace_id = resource.workspace_id",
  "   AND current_version.resource_id = resource.id",
  "   AND current_version.version = resource.current_confirmed_version",
  "   AND current_version.evidence_state = 'confirmed'",
  "   AND current_version.lifecycle_state <> 'archived'",
  "  JOIN workspace_completion_search_projection AS projection",
  "    ON projection.workspace_id = current_version.workspace_id",
  "   AND projection.resource_id = current_version.resource_id",
  "   AND projection.resource_version = current_version.version",
  "  LEFT JOIN workspace_completion_file_batches AS batch",
  "    ON batch.workspace_id = current_version.workspace_id AND batch.id = current_version.file_batch_id",
  "  WHERE current_version.file_batch_id IS NULL OR batch.status = 'renamed'",
  "),",
  "candidates AS (",
  "  SELECT 'room'::TEXT AS type, id, id AS room_id, name AS title, name AS body, updated_at, NULL::TEXT AS work_id",
  "  FROM authorized_rooms",
  "  UNION ALL",
  "  SELECT type, id, room_id, title, body, updated_at, work_id FROM conversation_candidates",
  "  UNION ALL",
  "  SELECT type, id, room_id, title, body, updated_at, work_id FROM work_conversation_candidates",
  "  UNION ALL",
  "  SELECT type, id, room_id, title, body, updated_at, work_id FROM knowledge_candidates",
  ")",
  "SELECT type, id, room_id, title, body, updated_at, work_id",
  "FROM candidates",
  "WHERE updated_at <= $4::TIMESTAMPTZ",
  "  AND type = ANY($5::TEXT[])",
  "  AND lower(normalize(COALESCE(title, '') || ' ' || COALESCE(body, ''), NFKC)) LIKE ALL($6::TEXT[])"
].join("\n");
