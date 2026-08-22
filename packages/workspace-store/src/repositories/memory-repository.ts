import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MemoryFrontmatterSchema,
  nowIso,
  stableHash,
  type MemoryFrontmatter,
  type MessageRecord
} from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { MemoryIndexTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import type { ArchiveMemoryResult, MemoryReindexResult, MemoryWithFilePath, WorkspaceHealthReport } from "../workspace-store-contracts";
import { compareScoredSearch, scoreSearchFields, searchTerms, stateSearchBoost } from "../search/scoring";
import { readManagedResourceFiles } from "./managed-resource-file-scan";
import { memoryToRow } from "./memory-skill-row-codecs";
import { withUsageScope, type UsageScopeQueryContext } from "./usage-scope";
import { parse, stringify } from "./serialization";
import {
  assertMemoryPathMatchesFrontmatter,
  errorMessage,
  listMemoryMarkdownFiles,
  parseMemoryMarkdownLocal,
  readWorkspaceText,
  renderFrontmatter,
  stripFrontmatter
} from "./workspace-file-codecs";

export interface MemorySessionPort {
  listMessages(sessionId: string): Promise<MessageRecord[]>;
}

/** Filesystem-backed Memory with a rebuildable SQLite search index. */
export class MemoryRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly sessions: MemorySessionPort
  ) {}

async saveMemory(frontmatter: MemoryFrontmatter, content: string): Promise<MemoryFrontmatter> {
  const validated = withUsageScope(MemoryFrontmatterSchema.parse(frontmatter));
  const relativePath = path.join("memory", validated.state, `${validated.id}.md`);
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${renderFrontmatter(validated)}\n${content.trim()}\n`);
  await this.db
    .insertInto("memory_index")
    .values(memoryToRow(validated, relativePath))
    .execute();
  return validated;
}

async replaceMemoryContent(id: string, content: string): Promise<MemoryWithFilePath | undefined> {
  const memory = await this.getMemory(id);
  if (!memory) return undefined;
  const { file_path: filePath, ...frontmatter } = memory;
  const next = withUsageScope({ ...frontmatter, updated_at: nowIso() });
  await writeFile(path.join(this.rootDir, filePath), `${renderFrontmatter(next)}\n${content.trim()}\n`);
  await this.db.updateTable("memory_index").set(memoryToRow(next, filePath)).where("id", "=", id).execute();
  return { ...next, file_path: filePath };
}

/** Updates only the Core 05 metadata carried by a Workspace-authoritative Memory file. */
async patchMemoryLearningMetadata(input: {
  id: string;
  metadata: Partial<Pick<MemoryFrontmatter, "evidence_state" | "usage_state" | "usage_scope" | "origin_activity_context" | "source_run_ids" | "source_refs" | "provenance" | "version" | "content_hash" | "pinned">>;
}): Promise<MemoryWithFilePath | undefined> {
  const current = await this.getMemory(input.id);
  const content = await this.readMemoryContent(input.id);
  if (!current || content === undefined) return undefined;
  const { file_path: filePath, ...frontmatter } = current;
  const next = withUsageScope({ ...frontmatter, ...input.metadata, updated_at: nowIso() });
  await writeFile(path.join(this.rootDir, filePath), `${renderFrontmatter(next)}\n${content.trim()}\n`);
  await this.db.updateTable("memory_index").set(memoryToRow(next, filePath)).where("id", "=", input.id).execute();
  return { ...next, file_path: filePath };
}

async listMemory(options: {
  includeArchived?: boolean;
  activityContext?: UsageScopeQueryContext;
  resourceIds?: string[];
  includeLegacy?: boolean;
} = {}): Promise<MemoryWithFilePath[]> {
  let query = this.db.selectFrom("memory_index").selectAll();
  if (!options.includeArchived) {
    query = query.where("state", "!=", "archived");
  }
  if (options.resourceIds !== undefined) {
    const resourceIds = [...new Set(options.resourceIds)];
    if (!options.includeLegacy) {
      if (resourceIds.length === 0) return [];
      query = query.where("id", "in", resourceIds);
    } else {
      query = query.where((eb) => eb.or([
        ...(resourceIds.length > 0 ? [eb("id", "in", resourceIds)] : []),
        eb.not(eb.exists(
          eb.selectFrom("resource_access_boundaries as boundary")
            .select("boundary.id")
            .where("boundary.resource_kind", "=", "memory")
            .whereRef("boundary.resource_id", "=", "memory_index.id")
        ))
      ]));
    }
  }
  if (options.activityContext) {
    query = query.where((eb) => eb.or([
      eb("usage_scope_kind", "=", "workspace"),
      eb.and([eb("usage_scope_kind", "=", "room"), eb("usage_scope_ref_id", "=", options.activityContext!.room_id)]),
      eb.and([eb("usage_scope_kind", "=", "agent"), eb("usage_scope_ref_id", "=", options.activityContext!.agent_id)]),
      eb.and([eb("usage_scope_kind", "=", "session"), eb("usage_scope_ref_id", "=", options.activityContext!.session_id)])
    ]));
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map((row) => ({ ...withUsageScope(parse<MemoryFrontmatter>(row.frontmatter_json)), file_path: row.file_path }));
}

async listMemoryForSession(sessionId: string, options: {
  includeArchived?: boolean;
  activityContext?: UsageScopeQueryContext;
  resourceIds?: string[];
  includeLegacy?: boolean;
} = {}): Promise<MemoryWithFilePath[]> {
  const messages = await this.sessions.listMessages(sessionId);
  const envelopeIds = new Set<string>();
  for (const message of messages) {
    envelopeIds.add(message.id);
    if (message.envelope?.id) {
      envelopeIds.add(message.envelope.id);
    }
  }
  if (envelopeIds.size === 0) {
    return [];
  }

  let query = this.db.selectFrom("memory_index").selectAll();
  if (!options.includeArchived) {
    query = query.where("state", "!=", "archived");
  }
  if (options.resourceIds !== undefined) {
    const resourceIds = [...new Set(options.resourceIds)];
    if (!options.includeLegacy) {
      if (resourceIds.length === 0) return [];
      query = query.where("id", "in", resourceIds);
    } else {
      query = query.where((eb) => eb.or([
        ...(resourceIds.length > 0 ? [eb("id", "in", resourceIds)] : []),
        eb.not(eb.exists(
          eb.selectFrom("resource_access_boundaries as boundary")
            .select("boundary.id")
            .where("boundary.resource_kind", "=", "memory")
            .whereRef("boundary.resource_id", "=", "memory_index.id")
        ))
      ]));
    }
  }
  if (options.activityContext) {
    query = query.where((eb) => eb.or([
      eb("usage_scope_kind", "=", "workspace"),
      eb.and([eb("usage_scope_kind", "=", "room"), eb("usage_scope_ref_id", "=", options.activityContext!.room_id)]),
      eb.and([eb("usage_scope_kind", "=", "agent"), eb("usage_scope_ref_id", "=", options.activityContext!.agent_id)]),
      eb.and([eb("usage_scope_kind", "=", "session"), eb("usage_scope_ref_id", "=", options.activityContext!.session_id)])
    ]));
  }
  const roomTopicSource = `session:${sessionId}`;
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows
    .filter((row) => envelopeIds.has(row.source) || row.source === roomTopicSource)
    .map((row) => ({ ...withUsageScope(parse<MemoryFrontmatter>(row.frontmatter_json)), file_path: row.file_path }));
}

async searchMemory(query: string, limit = 5, options: {
  includeArchived?: boolean;
  activityContext?: UsageScopeQueryContext;
  /** Explicit Room-bound resources, resolved before this UsageScope narrowing. */
  resourceIds?: string[];
  /** Only the current Workspace Owner can include pre-Core 06 unbounded data. */
  includeLegacy?: boolean;
} = {}): Promise<MemoryWithFilePath[]> {
  let dbQuery = this.db.selectFrom("memory_index").selectAll();
  if (!options.includeArchived) {
    dbQuery = dbQuery.where("state", "!=", "archived");
  }
  if (options.resourceIds !== undefined) {
    const resourceIds = [...new Set(options.resourceIds)];
    if (!options.includeLegacy) {
      if (resourceIds.length === 0) return [];
      dbQuery = dbQuery.where("id", "in", resourceIds);
    } else {
      // A Workspace Owner may read only a genuinely unbounded legacy Memory,
      // never a formally Room-bound Memory from another Room. Room boundary
      // and UsageScope are separate AND-ed constraints.
      dbQuery = dbQuery.where((eb) => eb.or([
        ...(resourceIds.length > 0 ? [eb("id", "in", resourceIds)] : []),
        eb.not(eb.exists(
          eb.selectFrom("resource_access_boundaries as boundary")
            .select("boundary.id")
            .where("boundary.resource_kind", "=", "memory")
            .whereRef("boundary.resource_id", "=", "memory_index.id")
        ))
      ]));
    }
  }
  if (options.activityContext) {
    dbQuery = dbQuery.where((eb) => eb.or([
      eb("usage_scope_kind", "=", "workspace"),
      eb.and([eb("usage_scope_kind", "=", "room"), eb("usage_scope_ref_id", "=", options.activityContext!.room_id)]),
      eb.and([eb("usage_scope_kind", "=", "agent"), eb("usage_scope_ref_id", "=", options.activityContext!.agent_id)]),
      eb.and([eb("usage_scope_kind", "=", "session"), eb("usage_scope_ref_id", "=", options.activityContext!.session_id)])
    ]));
  }
  const rows = await dbQuery.orderBy("updated_at", "desc").execute();
  const terms = searchTerms(query);
  const scored = await Promise.all(
    rows.map(async (row) => {
      const memory = { ...withUsageScope(parse<MemoryFrontmatter>(row.frontmatter_json)), file_path: row.file_path };
      const content = await readWorkspaceText(this.rootDir, row.file_path);
      const score = terms.length === 0
        ? stateSearchBoost(memory.state)
        : scoreSearchFields(terms, [
          { value: row.topic, weight: 12 },
          { value: row.source, weight: 3 },
          { value: stripFrontmatter(content), weight: 10 },
          { value: row.frontmatter_json, weight: 2 }
        ]) + stateSearchBoost(memory.state) + memory.confidence;
      return { item: memory, score, updatedAt: row.updated_at };
    })
  );
  return scored
    .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
    .sort(compareScoredSearch)
    .slice(0, limit)
    .map((entry) => entry.item);
}

async getMemory(id: string): Promise<MemoryWithFilePath | undefined> {
  const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? { ...withUsageScope(parse<MemoryFrontmatter>(row.frontmatter_json)), file_path: row.file_path } : undefined;
}

async readMemoryContent(id: string): Promise<string | undefined> {
  const memory = await this.getMemory(id);
  if (!memory) {
    return undefined;
  }
  const raw = await readFile(path.join(this.rootDir, memory.file_path), "utf8");
  return stripFrontmatter(raw).trim();
}

/** Returns the Workspace-authoritative Memory document for version history operations. */
async readMemoryMarkdown(id: string): Promise<string | undefined> {
  const memory = await this.getMemory(id);
  if (!memory) return undefined;
  return readFile(path.join(this.rootDir, memory.file_path), "utf8").catch(() => undefined);
}

/** Restores a historical document as a new current Version; it never rewinds history. */
async restoreMemoryVersionMarkdown(input: { id: string; markdown: string; version: string }): Promise<MemoryWithFilePath | undefined> {
  const current = await this.getMemory(input.id);
  if (!current) return undefined;
  const parsed = parseMemoryMarkdownLocal(input.markdown);
  if (parsed.frontmatter.id !== input.id) throw new Error("memory_restore_id_mismatch");
  const next = withUsageScope(MemoryFrontmatterSchema.parse({
    ...parsed.frontmatter,
    version: input.version,
    content_hash: stableHash(parsed.content),
    updated_at: nowIso()
  }));
  const nextPath = path.join("memory", next.state, `${next.id}.md`);
  const previousPath = current.file_path;
  const nextAbsolutePath = path.join(this.rootDir, nextPath);
  const previousAbsolutePath = path.join(this.rootDir, previousPath);
  const previousMarkdown = await readFile(previousAbsolutePath, "utf8");
  const nextMarkdown = `${renderFrontmatter(next)}\n${parsed.content.trim()}\n`;
  await mkdir(path.dirname(nextAbsolutePath), { recursive: true });
  if (nextPath === previousPath) {
    await writeFile(nextAbsolutePath, nextMarkdown);
  } else {
    await writeFile(nextAbsolutePath, nextMarkdown, { flag: "wx" });
  }
  try {
    await this.db.updateTable("memory_index").set(memoryToRow(next, nextPath)).where("id", "=", input.id).execute();
  } catch (error) {
    if (nextPath === previousPath) {
      await writeFile(previousAbsolutePath, previousMarkdown).catch(() => undefined);
    } else {
      await unlink(nextAbsolutePath).catch(() => undefined);
    }
    throw error;
  }
  if (nextPath !== previousPath) await unlink(previousAbsolutePath).catch(() => undefined);
  return { ...next, file_path: nextPath };
}

async archiveMemory(id: string): Promise<ArchiveMemoryResult | undefined> {
  const row = await this.db.selectFrom("memory_index").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row) {
    return undefined;
  }

  const frontmatter = withUsageScope(parse<MemoryFrontmatter>(row.frontmatter_json));
  const content = await this.readMemoryContent(id);
  if (content === undefined) {
    return undefined;
  }
  const before = memorySnapshot(frontmatter, row.file_path);

  if (frontmatter.state === "archived") {
    return {
      before,
      after: before,
      content,
      changed: false
    };
  }

  const nextFrontmatter: MemoryFrontmatter = withUsageScope(MemoryFrontmatterSchema.parse({
    ...frontmatter,
    state: "archived",
    updated_at: nowIso()
  }));
  const archivedPath = path.join("memory", "archived", `${id}.md`);
  const previousAbsolutePath = path.join(this.rootDir, row.file_path);
  const archivedAbsolutePath = path.join(this.rootDir, archivedPath);
  await mkdir(path.dirname(archivedAbsolutePath), { recursive: true });
  await writeFile(archivedAbsolutePath, `${renderFrontmatter(nextFrontmatter)}\n${content.trim()}\n`);

  try {
    await this.db
      .updateTable("memory_index")
      .set(memoryToRow(nextFrontmatter, archivedPath))
      .where("id", "=", id)
      .execute();
  } catch (error) {
    await unlink(archivedAbsolutePath).catch(() => undefined);
    throw error;
  }

  let warning: string | undefined;
  try {
    await unlink(previousAbsolutePath);
  } catch (error) {
    warning = error instanceof Error ? `old_file_delete_failed:${error.message}` : "old_file_delete_failed";
  }

  return {
    before,
    after: memorySnapshot(nextFrontmatter, archivedPath),
    content,
    changed: true,
    warning
  };
}

  /** Rebuilds the derived memory_index from validated Workspace markdown. */
  async synchronizeFilesystemIndex(): Promise<MemoryReindexResult> {
    const existingRows = await this.db.selectFrom("memory_index").selectAll().execute();
    let files: Awaited<ReturnType<typeof readManagedResourceFiles>>;
    try {
      files = await readManagedResourceFiles(
        this.rootDir,
        "memory",
        (relativePath) => path.extname(relativePath).toLowerCase() === ".md"
      );
    } catch (error) {
      return {
        files: 0,
        indexed: existingRows.length,
        created: 0,
        updated: 0,
        removed: 0,
        skipped: 0,
        errors: [{ file_path: "memory", message: `workspace_file_scan_failed:${errorMessage(error)}` }]
      };
    }

    const desired = new Map<string, MemoryIndexTable>();
    const errors: Array<{ file_path: string; message: string }> = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const frontmatter = parseMemoryMarkdownLocal(file.content).frontmatter;
        assertMemoryPathMatchesFrontmatter(file.relativePath, frontmatter);
        if (desired.has(frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: file.relativePath, message: `duplicate memory id: ${frontmatter.id}` });
          continue;
        }
        desired.set(frontmatter.id, memoryToRow(frontmatter, file.relativePath));
      } catch (error) {
        skipped += 1;
        errors.push({ file_path: file.relativePath, message: errorMessage(error) });
      }
    }

    const existing = new Map(existingRows.map((row) => [row.id, row]));
    let created = 0;
    let updated = 0;
    let removed = 0;
    await this.db.transaction().execute(async (transaction) => {
      for (const [id, row] of desired) {
        const previous = existing.get(id);
        if (!previous) {
          await transaction.insertInto("memory_index").values(row).execute();
          created += 1;
        } else if (!sameMemoryIndexRow(previous, row)) {
          await transaction.updateTable("memory_index").set(row).where("id", "=", id).execute();
          updated += 1;
        }
      }
      for (const row of existingRows) {
        if (!desired.has(row.id)) {
          await transaction.deleteFrom("memory_index").where("id", "=", row.id).execute();
          removed += 1;
        }
      }
    });

    return { files: files.length, indexed: desired.size, created, updated, removed, skipped, errors };
  }

  /** Reports memory file/index drift without changing either source. */
  async inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["memory"]> {
    const rows = await this.db.selectFrom("memory_index").selectAll().execute();
    const memoryFiles = await listMemoryMarkdownFiles(this.rootDir);
    const memoryFileSet = new Set(memoryFiles);
    const indexedIds = new Set(rows.map((row) => row.id));
    const missingFiles = rows
      .filter((row) => !memoryFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path, topic: row.topic }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of memoryFiles) {
      try {
        const parsed = parseMemoryMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertMemoryPathMatchesFrontmatter(filePath, parsed.frontmatter);
        const paths = filesById.get(parsed.frontmatter.id) ?? [];
        paths.push(filePath);
        filesById.set(parsed.frontmatter.id, paths);
        if (!indexedIds.has(parsed.frontmatter.id)) unindexedFiles.push(filePath);
      } catch (error) {
        invalidFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const duplicateIds = [...filesById.entries()]
      .filter(([, filePaths]) => filePaths.length > 1)
      .map(([id, filePaths]) => ({ id, file_paths: filePaths }));
    return {
      ok: missingFiles.length === 0 && unindexedFiles.length === 0 && invalidFiles.length === 0 && duplicateIds.length === 0,
      files: memoryFiles.length,
      indexed: rows.length,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles,
      invalid_files: invalidFiles,
      duplicate_ids: duplicateIds
    };
  }


}

function memorySnapshot(frontmatter: MemoryFrontmatter, filePath: string) {
  return {
    frontmatter,
    file_path: filePath,
    state: frontmatter.state,
    updated_at: frontmatter.updated_at
  };
}

function sameMemoryIndexRow(left: MemoryIndexTable, right: MemoryIndexTable): boolean {
  return stableHash(left) === stableHash(right);
}
