import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { nowIso, stableHash, type WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WikiIndexTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import type { WikiReindexResult, WikiWithFilePath, WorkspaceHealthReport } from "../workspace-store-contracts";
import { compareScoredSearch, scoreSearchFields, searchTerms, stateSearchBoost } from "../search/scoring";
import { readManagedResourceFiles } from "./managed-resource-file-scan";
import { errorMessage, listWikiMarkdownFiles, readWorkspaceText, renderFrontmatter, parseWikiMarkdownLocal, stripFrontmatter } from "./workspace-file-codecs";
import { wikiFromRow, wikiToRow } from "./wiki-collection-row-codecs";
import { withUsageScope, type UsageScopeQueryContext } from "./usage-scope";

/** Filesystem-backed Knowledge Wiki and its rebuildable SQLite index. */
export class KnowledgeWikiRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string
  ) {}

async saveWikiPage(frontmatter: WikiFrontmatter, content: string): Promise<WikiWithFilePath> {
  const scopedFrontmatter = withUsageScope(frontmatter);
  const relativePath = path.join("wiki", "pages", `${scopedFrontmatter.slug}.md`);
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${renderFrontmatter(scopedFrontmatter)}\n${content.trim()}\n`, { flag: "wx" });

  try {
    const parsed = parseWikiMarkdownLocal(await readFile(absolutePath, "utf8"));
    if (parsed.frontmatter.id !== scopedFrontmatter.id || parsed.frontmatter.slug !== scopedFrontmatter.slug) {
      throw new Error("wiki_frontmatter_path_mismatch");
    }
    await this.db
      .insertInto("wiki_index")
      .values(wikiToRow(parsed.frontmatter, relativePath))
      .execute();
    return { ...parsed.frontmatter, file_path: relativePath };
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

async listWiki(options: {
  activeOnly?: boolean;
  activityContext?: UsageScopeQueryContext;
  resourceIds?: string[];
  includeLegacy?: boolean;
} = {}): Promise<WikiWithFilePath[]> {
  let query = this.db.selectFrom("wiki_index").selectAll();
  if (options.activeOnly) {
    query = query.where("state", "=", "active");
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
            .where("boundary.resource_kind", "=", "wiki")
            .whereRef("boundary.resource_id", "=", "wiki_index.id")
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
  return rows.map(wikiFromRow);
}

async searchWiki(query: string, limit = 5, options: {
  activeOnly?: boolean;
  activityContext?: UsageScopeQueryContext;
  /** Explicit Room-bound resources, resolved before this UsageScope narrowing. */
  resourceIds?: string[];
  /** Only the current Workspace Owner can include pre-Core 06 unbounded data. */
  includeLegacy?: boolean;
} = { activeOnly: true }): Promise<WikiWithFilePath[]> {
  let dbQuery = this.db.selectFrom("wiki_index").selectAll();
  if (options.activeOnly ?? true) {
    dbQuery = dbQuery.where("state", "=", "active");
  }
  if (options.resourceIds !== undefined) {
    const resourceIds = [...new Set(options.resourceIds)];
    if (!options.includeLegacy) {
      if (resourceIds.length === 0) return [];
      dbQuery = dbQuery.where("id", "in", resourceIds);
    } else {
      // Room boundary permits the candidate; UsageScope below can only narrow
      // it. A formal boundary in another Room is never treated as legacy.
      dbQuery = dbQuery.where((eb) => eb.or([
        ...(resourceIds.length > 0 ? [eb("id", "in", resourceIds)] : []),
        eb.not(eb.exists(
          eb.selectFrom("resource_access_boundaries as boundary")
            .select("boundary.id")
            .where("boundary.resource_kind", "=", "wiki")
            .whereRef("boundary.resource_id", "=", "wiki_index.id")
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
      const wiki = wikiFromRow(row);
      const markdown = await readWorkspaceText(this.rootDir, row.file_path);
      const score = terms.length === 0
        ? stateSearchBoost(wiki.state)
        : scoreSearchFields(terms, [
          { value: row.title, weight: 12 },
          { value: row.slug, weight: 7 },
          { value: row.tags_json, weight: 5 },
          { value: stripFrontmatter(markdown), weight: 10 },
          { value: row.provenance_json, weight: 2 }
        ]) + stateSearchBoost(wiki.state);
      return { item: wiki, score, updatedAt: row.updated_at };
    })
  );
  return scored
    .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
    .sort(compareScoredSearch)
    .slice(0, limit)
    .map((entry) => entry.item);
}

async getWiki(id: string): Promise<WikiWithFilePath | undefined> {
  const row = await this.db.selectFrom("wiki_index").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? wikiFromRow(row) : undefined;
}

async readWikiContent(id: string): Promise<string | undefined> {
  const wiki = await this.getWiki(id);
  if (!wiki) {
    return undefined;
  }
  const raw = await readFile(path.join(this.rootDir, wiki.file_path), "utf8");
  return stripFrontmatter(raw).trim();
}

/** Returns the Workspace-authoritative Wiki document for version history operations. */
async readWikiMarkdown(id: string): Promise<string | undefined> {
  const wiki = await this.getWiki(id);
  if (!wiki) return undefined;
  return readFile(path.join(this.rootDir, wiki.file_path), "utf8").catch(() => undefined);
}

/** Restores a historical document as a new current Version; it never rewinds history. */
async restoreWikiVersionMarkdown(input: { id: string; markdown: string; version: string }): Promise<WikiWithFilePath | undefined> {
  const current = await this.getWiki(input.id);
  if (!current) return undefined;
  const parsed = parseWikiMarkdownLocal(input.markdown);
  if (parsed.frontmatter.id !== input.id) throw new Error("wiki_restore_id_mismatch");
  const next = withUsageScope({
    ...parsed.frontmatter,
    version: input.version,
    content_hash: stableHash(parsed.content),
    updated_at: nowIso()
  });
  const nextPath = path.join("wiki", "pages", `${next.slug}.md`);
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
    await this.db.updateTable("wiki_index").set(wikiToRow(next, nextPath)).where("id", "=", input.id).execute();
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

async updateWikiPage(input: {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  content_locale?: WikiFrontmatter["content_locale"];
  source_refs?: WikiFrontmatter["source_refs"];
  provenance?: WikiFrontmatter["provenance"];
}): Promise<WikiWithFilePath | undefined> {
  const current = await this.getWiki(input.id);
  if (!current) {
    return undefined;
  }
  const content = input.content ?? (await this.readWikiContent(input.id));
  if (content === undefined) {
    return undefined;
  }
  const { file_path: filePath, ...currentFrontmatter } = current;
  const next = withUsageScope({
    ...currentFrontmatter,
    title: input.title ?? current.title,
    tags: input.tags ?? current.tags,
    content_locale: input.content_locale ?? current.content_locale,
    source_refs: input.source_refs ?? current.source_refs,
    provenance: input.provenance ?? current.provenance,
    updated_at: nowIso()
  });
  await this.writeWikiPage(next, filePath, content);
  return { ...next, file_path: filePath };
}

/** Updates only the Core 05 metadata carried by a Workspace-authoritative Knowledge Wiki file. */
async patchWikiLearningMetadata(input: {
  id: string;
  metadata: Partial<Pick<WikiFrontmatter, "knowledge_kind" | "experience_rule" | "evidence_state" | "usage_state" | "usage_scope" | "origin_activity_context" | "source_run_ids" | "source_refs" | "provenance" | "version" | "content_hash" | "pinned">>;
}): Promise<WikiWithFilePath | undefined> {
  const current = await this.getWiki(input.id);
  const content = await this.readWikiContent(input.id);
  if (!current || content === undefined) return undefined;
  const { file_path: filePath, ...frontmatter } = current;
  const next = withUsageScope({ ...frontmatter, ...input.metadata, updated_at: nowIso() });
  await this.writeWikiPage(next, filePath, content);
  return { ...next, file_path: filePath };
}

async setWikiState(id: string, state: WikiFrontmatter["state"]): Promise<WikiWithFilePath | undefined> {
  const current = await this.getWiki(id);
  if (!current) {
    return undefined;
  }
  const content = await this.readWikiContent(id);
  if (content === undefined) {
    return undefined;
  }
  const { file_path: filePath, ...currentFrontmatter } = current;
  const next = withUsageScope({
    ...currentFrontmatter,
    state,
    updated_at: nowIso()
  });
  await this.writeWikiPage(next, filePath, content);
  return { ...next, file_path: filePath };
}

  /** Rebuilds the derived wiki_index from validated Workspace markdown. */
  async synchronizeFilesystemIndex(): Promise<WikiReindexResult> {
    const existingRows = await this.db.selectFrom("wiki_index").selectAll().execute();
    let files: Awaited<ReturnType<typeof readManagedResourceFiles>>;
    try {
      files = await readManagedResourceFiles(
        this.rootDir,
        path.join("wiki", "pages"),
        (relativePath) => path.extname(relativePath).toLowerCase() === ".md"
      );
    } catch (error) {
      const active = existingRows.filter((row) => row.state === "active").length;
      return {
        active,
        total: existingRows.length,
        files: 0,
        indexed: existingRows.length,
        created: 0,
        updated: 0,
        removed: 0,
        skipped: 0,
        errors: [{ file_path: path.join("wiki", "pages"), message: `workspace_file_scan_failed:${errorMessage(error)}` }]
      };
    }

    const desired = new Map<string, WikiIndexTable>();
    const errors: Array<{ file_path: string; message: string }> = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const frontmatter = parseWikiMarkdownLocal(file.content).frontmatter;
        if (desired.has(frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: file.relativePath, message: `duplicate wiki id: ${frontmatter.id}` });
          continue;
        }
        desired.set(frontmatter.id, wikiToRow(frontmatter, file.relativePath));
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
          await transaction.insertInto("wiki_index").values(row).execute();
          created += 1;
        } else if (!sameWikiIndexRow(previous, row)) {
          await transaction.updateTable("wiki_index").set(row).where("id", "=", id).execute();
          updated += 1;
        }
      }
      for (const row of existingRows) {
        if (!desired.has(row.id)) {
          await transaction.deleteFrom("wiki_index").where("id", "=", row.id).execute();
          removed += 1;
        }
      }
    });

    const pages = [...desired.values()];
    return {
      active: pages.filter((page) => page.state === "active").length,
      total: pages.length,
      files: files.length,
      indexed: pages.length,
      created,
      updated,
      removed,
      skipped,
      errors
    };
  }

  /** Reports Knowledge Wiki file/index drift without changing either source. */
  async inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["wiki"]> {
    const wikiFiles = await listWikiMarkdownFiles(this.rootDir);
    const wikiPages = await this.listWiki();
    const wikiFileSet = new Set(wikiFiles);
    const indexedIds = new Set(wikiPages.map((page) => page.id));
    const missingFiles = wikiPages
      .filter((page) => !wikiFileSet.has(page.file_path))
      .map((page) => ({ id: page.id, file_path: page.file_path, title: page.title }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of wikiFiles) {
      try {
        const parsed = parseWikiMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
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
      files: wikiFiles.length,
      indexed: wikiPages.length,
      active: wikiPages.filter((page) => page.state === "active").length,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles,
      invalid_files: invalidFiles,
      duplicate_ids: duplicateIds
    };
  }



  private async writeWikiPage(frontmatter: WikiFrontmatter, filePath: string, content: string): Promise<void> {
    const scopedFrontmatter = withUsageScope(frontmatter);
    const absolutePath = path.join(this.rootDir, filePath);
    await writeFile(absolutePath, `${renderFrontmatter(scopedFrontmatter)}\n${content.trim()}\n`);
    await this.db
      .updateTable("wiki_index")
      .set(wikiToRow(scopedFrontmatter, filePath))
      .where("id", "=", scopedFrontmatter.id)
      .execute();
  }
}

function sameWikiIndexRow(left: WikiIndexTable, right: WikiIndexTable): boolean {
  return stableHash(left) === stableHash(right);
}
