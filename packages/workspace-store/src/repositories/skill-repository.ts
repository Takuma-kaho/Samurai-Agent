import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  OptimizationCandidateSchema,
  OptimizationEvaluationSchema,
  OptimizationPromotionSchema,
  SkillFrontmatterSchema,
  SkillOptimizationDatasetSchema,
  SkillOptimizationRunSchema,
  SkillOptimizationSnapshotSchema,
  nowIso,
  stableHash,
  type OptimizationCandidate,
  type OptimizationEvaluation,
  type OptimizationPromotion,
  type SkillFrontmatter,
  type SkillIndexEntryReadModel,
  type SkillOptimizationDataset,
  type SkillOptimizationRun,
  type SkillOptimizationSnapshot,
  type SkillUsageRecord
} from "@samurai-agent/core-schemas";
import { sql, type Kysely } from "kysely";
import type { SkillIndexTable, SkillUsageTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import type { SkillReindexResult, SkillSupportFile, SkillWithFilePath, WorkspaceHealthReport } from "../workspace-store-contracts";
import { compareScoredSearch, scoreSearchFields, searchTerms, stateSearchBoost } from "../search/scoring";
import { readManagedResourceFiles } from "./managed-resource-file-scan";
import { skillFromRow, skillToRow, skillUsageFromRow } from "./memory-skill-row-codecs";
import { parse, stringify } from "./serialization";
import {
  assertSkillPathMatchesFrontmatter,
  buildSkillIndexEntry,
  errorMessage,
  listSkillMarkdownFiles,
  listRelativeFiles,
  normalizeSkillSupportPath,
  parseSkillMarkdownLocal,
  readWorkspaceText,
  stripFrontmatter
} from "./workspace-file-codecs";

/** Filesystem-backed Skill, operational usage, and optimization history. */
export class SkillRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string
  ) {}

async saveSkillOptimizationRun(input: SkillOptimizationRun): Promise<SkillOptimizationRun> {
  const record = SkillOptimizationRunSchema.parse(input);
  await this.db.insertInto("skill_optimization_runs").values({
    id: record.id,
    target_skill_id: record.target_skill_id,
    session_id: record.session_id ?? null,
    status: record.status,
    run_json: stringify(record),
    created_at: record.created_at,
    updated_at: record.updated_at
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({
    status: record.status,
    run_json: stringify(record),
    updated_at: record.updated_at
  })).execute();
  return record;
}

async getSkillOptimizationRun(id: string): Promise<SkillOptimizationRun | undefined> {
  const row = await this.db.selectFrom("skill_optimization_runs").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? SkillOptimizationRunSchema.parse(parse<SkillOptimizationRun>(row.run_json)) : undefined;
}

async listSkillOptimizationRuns(input: { skillId?: string; status?: SkillOptimizationRun["status"] } = {}): Promise<SkillOptimizationRun[]> {
  let query = this.db.selectFrom("skill_optimization_runs").selectAll().orderBy("created_at", "desc");
  if (input.skillId) query = query.where("target_skill_id", "=", input.skillId);
  if (input.status) query = query.where("status", "=", input.status);
  return (await query.execute()).map((row) => SkillOptimizationRunSchema.parse(parse<SkillOptimizationRun>(row.run_json)));
}

async saveSkillOptimizationDataset(input: SkillOptimizationDataset): Promise<SkillOptimizationDataset> {
  const record = SkillOptimizationDatasetSchema.parse(input);
  await this.db.insertInto("skill_optimization_datasets").values({
    id: record.id,
    skill_id: record.skill_id,
    dataset_json: stringify(record),
    created_at: record.created_at
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({ dataset_json: stringify(record) })).execute();
  return record;
}

async getSkillOptimizationDataset(id: string): Promise<SkillOptimizationDataset | undefined> {
  const row = await this.db.selectFrom("skill_optimization_datasets").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? SkillOptimizationDatasetSchema.parse(parse<SkillOptimizationDataset>(row.dataset_json)) : undefined;
}

async saveOptimizationCandidate(input: OptimizationCandidate): Promise<OptimizationCandidate> {
  const record = OptimizationCandidateSchema.parse(input);
  await this.db.insertInto("optimization_candidates").values({
    id: record.id,
    run_id: record.run_id,
    skill_id: record.skill_id,
    content_hash: record.content_hash,
    body: record.body,
    candidate_json: stringify(record),
    created_at: record.created_at,
    updated_at: record.updated_at
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({
    content_hash: record.content_hash,
    body: record.body,
    candidate_json: stringify(record),
    updated_at: record.updated_at
  })).execute();
  return record;
}

async getOptimizationCandidate(id: string): Promise<OptimizationCandidate | undefined> {
  const row = await this.db.selectFrom("optimization_candidates").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? OptimizationCandidateSchema.parse(parse<OptimizationCandidate>(row.candidate_json)) : undefined;
}

async listOptimizationCandidates(runId: string): Promise<OptimizationCandidate[]> {
  return (await this.db.selectFrom("optimization_candidates").selectAll().where("run_id", "=", runId).orderBy("created_at", "asc").execute()).map((row) => OptimizationCandidateSchema.parse(parse<OptimizationCandidate>(row.candidate_json)));
}

async saveOptimizationEvaluation(input: OptimizationEvaluation): Promise<OptimizationEvaluation> {
  const record = OptimizationEvaluationSchema.parse(input);
  await this.db.insertInto("optimization_evaluations").values({
    id: record.id,
    run_id: record.run_id,
    candidate_id: record.candidate_id,
    evaluation_json: stringify(record),
    created_at: record.created_at
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({ evaluation_json: stringify(record) })).execute();
  return record;
}

async listOptimizationEvaluations(candidateId?: string): Promise<OptimizationEvaluation[]> {
  let query = this.db.selectFrom("optimization_evaluations").selectAll().orderBy("created_at", "asc");
  if (candidateId) query = query.where("candidate_id", "=", candidateId);
  return (await query.execute()).map((row) => OptimizationEvaluationSchema.parse(parse<OptimizationEvaluation>(row.evaluation_json)));
}

async saveSkillOptimizationSnapshot(input: SkillOptimizationSnapshot): Promise<SkillOptimizationSnapshot> {
  const record = SkillOptimizationSnapshotSchema.parse(input);
  await this.db.insertInto("skill_optimization_snapshots").values({
    id: record.id,
    skill_id: record.skill_id,
    candidate_id: record.candidate_id,
    content_hash: record.content_hash,
    markdown: record.markdown,
    snapshot_json: stringify(record),
    created_at: record.created_at,
    restored_at: record.restored_at ?? null
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({ restored_at: record.restored_at ?? null, snapshot_json: stringify(record) })).execute();
  return record;
}

async getSkillOptimizationSnapshot(id: string): Promise<SkillOptimizationSnapshot | undefined> {
  const row = await this.db.selectFrom("skill_optimization_snapshots").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? SkillOptimizationSnapshotSchema.parse(parse<SkillOptimizationSnapshot>(row.snapshot_json)) : undefined;
}

async saveOptimizationPromotion(input: OptimizationPromotion): Promise<OptimizationPromotion> {
  const record = OptimizationPromotionSchema.parse(input);
  await this.db.insertInto("optimization_promotions").values({
    id: record.id,
    run_id: record.run_id,
    candidate_id: record.candidate_id,
    skill_id: record.skill_id,
    promotion_json: stringify(record),
    created_at: record.created_at
  }).onConflict((conflict) => conflict.column("id").doUpdateSet({ promotion_json: stringify(record) })).execute();
  return record;
}

async listOptimizationPromotions(input: { skillId?: string; candidateId?: string } = {}): Promise<OptimizationPromotion[]> {
  let query = this.db.selectFrom("optimization_promotions").selectAll().orderBy("created_at", "desc");
  if (input.skillId) query = query.where("skill_id", "=", input.skillId);
  if (input.candidateId) query = query.where("candidate_id", "=", input.candidateId);
  return (await query.execute()).map((row) => OptimizationPromotionSchema.parse(parse<OptimizationPromotion>(row.promotion_json)));
}

async acquireSkillOptimizationLock(input: { skillId: string; runId: string; acquiredAt?: string }): Promise<boolean> {
  const result = await this.db.insertInto("skill_optimization_locks").values({
    skill_id: input.skillId,
    run_id: input.runId,
    acquired_at: input.acquiredAt ?? nowIso()
  }).onConflict((conflict) => conflict.column("skill_id").doNothing()).executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) === 1;
}

async getSkillOptimizationLock(skillId: string): Promise<{ skill_id: string; run_id: string; acquired_at: string } | undefined> {
  return this.db.selectFrom("skill_optimization_locks").selectAll().where("skill_id", "=", skillId).executeTakeFirst();
}

async releaseSkillOptimizationLock(input: { skillId: string; runId: string }): Promise<boolean> {
  const result = await this.db.deleteFrom("skill_optimization_locks").where("skill_id", "=", input.skillId).where("run_id", "=", input.runId).executeTakeFirst();
  return Number(result.numDeletedRows) === 1;
}



async saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<SkillWithFilePath> {
  const relativePath = path.join("skills", input.state, `${input.skillId}.md`);
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.markdown, { flag: "wx" });

  try {
    const { frontmatter } = parseSkillMarkdownLocal(await readFile(absolutePath, "utf8"));
    if (frontmatter.id !== input.skillId || frontmatter.state !== input.state) {
      throw new Error("skill_frontmatter_path_mismatch");
    }
    const now = nowIso();
    await this.db
      .insertInto("skill_index")
      .values({
        id: frontmatter.id,
        state: frontmatter.state,
        title: frontmatter.title,
        description: frontmatter.description,
        tags_json: stringify(frontmatter.tags),
        required_capabilities_json: stringify(frontmatter.required_capabilities),
        file_path: relativePath,
        frontmatter_json: stringify(frontmatter),
        created_at: now,
        updated_at: now
      })
      .execute();
    return { ...buildSkillIndexEntry(frontmatter), file_path: relativePath };
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

async listSkills(): Promise<SkillWithFilePath[]> {
  const rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
  return rows.map(skillFromRow);
}

async listSkillIndexReadModel(): Promise<SkillIndexEntryReadModel[]> {
  const rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
  return rows.map((row) => ({
    id: row.id,
    state: row.state as SkillFrontmatter["state"],
    title: row.title,
    description: row.description,
    tags: parse(row.tags_json),
    required_capabilities: parse(row.required_capabilities_json),
    file_path: row.file_path,
    updated_at: row.updated_at
  }));
}

async getSkill(id: string): Promise<SkillWithFilePath | undefined> {
  const row = await this.db.selectFrom("skill_index").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? skillFromRow(row) : undefined;
}

async readSkillMarkdown(id: string): Promise<string | undefined> {
  const skill = await this.getSkill(id);
  if (!skill) {
    return undefined;
  }
  return readFile(path.join(this.rootDir, skill.file_path), "utf8");
}

async patchSkill(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string }): Promise<SkillWithFilePath | undefined> {
  await this.assertSkillWriteUnlocked(input.id);
  const current = await this.getSkill(input.id);
  const raw = await this.readSkillMarkdown(input.id);
  if (!current || !raw) return undefined;
  const parsed = parseSkillMarkdownLocal(raw);
  const now = nowIso();
  const frontmatter: SkillFrontmatter = SkillFrontmatterSchema.parse({
    ...parsed.frontmatter,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    last_reviewed_at: now
  });
  const markdown = ["---", JSON.stringify(frontmatter, null, 2), "---", (input.content ?? parsed.content).trim(), ""].join("\n");
  const absolutePath = path.join(this.rootDir, current.file_path);
  const temporaryPath = `${absolutePath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, markdown, { flag: "wx" });
  try {
    await rename(temporaryPath, absolutePath);
    await this.db.updateTable("skill_index").set({
      title: frontmatter.title,
      description: frontmatter.description,
      tags_json: stringify(frontmatter.tags),
      required_capabilities_json: stringify(frontmatter.required_capabilities),
      frontmatter_json: stringify(frontmatter),
      updated_at: now
    }).where("id", "=", input.id).execute();
  } catch (error) {
    await rm(temporaryPath, { force: true });
    await writeFile(absolutePath, raw).catch(() => undefined);
    throw error;
  }
  return { ...buildSkillIndexEntry(frontmatter), file_path: current.file_path };
}

async updateSkillState(id: string, state: SkillFrontmatter["state"]): Promise<SkillWithFilePath | undefined> {
  await this.assertSkillWriteUnlocked(id);
  const current = await this.getSkill(id);
  if (!current) {
    return undefined;
  }
  const raw = await this.readSkillMarkdown(id);
  if (!raw) {
    return undefined;
  }
  const parsed = parseSkillMarkdownLocal(raw);
  const now = nowIso();
  const nextFrontmatter: SkillFrontmatter = {
    ...parsed.frontmatter,
    state,
    last_reviewed_at: now
  };
  const nextPath = path.join("skills", state, `${id}.md`);
  const nextAbsolutePath = path.join(this.rootDir, nextPath);
  const previousAbsolutePath = path.join(this.rootDir, current.file_path);
  const nextMarkdown = ["---", JSON.stringify(nextFrontmatter, null, 2), "---", parsed.content.trim(), ""].join("\n");
  await mkdir(path.dirname(nextAbsolutePath), { recursive: true });
  if (nextAbsolutePath === previousAbsolutePath) {
    await writeFile(nextAbsolutePath, nextMarkdown);
  } else {
    await writeFile(nextAbsolutePath, nextMarkdown, { flag: "wx" });
  }

  try {
    await this.db
      .updateTable("skill_index")
      .set({
        state: nextFrontmatter.state,
        title: nextFrontmatter.title,
        description: nextFrontmatter.description,
        tags_json: stringify(nextFrontmatter.tags),
        required_capabilities_json: stringify(nextFrontmatter.required_capabilities),
        file_path: nextPath,
        frontmatter_json: stringify(nextFrontmatter),
        updated_at: now
      })
      .where("id", "=", id)
      .execute();
  } catch (error) {
    await unlink(nextAbsolutePath).catch(() => undefined);
    throw error;
  }

  if (nextAbsolutePath !== previousAbsolutePath) {
    await unlink(previousAbsolutePath).catch(() => undefined);
  }
  return { ...buildSkillIndexEntry(nextFrontmatter), file_path: nextPath };
}

async replaceSkillContent(id: string, content: string): Promise<SkillWithFilePath | undefined> {
  await this.assertSkillWriteUnlocked(id);
  const skill = await this.getSkill(id);
  if (!skill) return undefined;
  const frontmatter = { ...skill.frontmatter, last_reviewed_at: nowIso() };
  await writeFile(path.join(this.rootDir, skill.file_path), this.renderSkillMarkdown(frontmatter, content));
  await this.db.updateTable("skill_index").set({
    frontmatter_json: stringify(frontmatter),
    updated_at: frontmatter.last_reviewed_at ?? nowIso()
  }).where("id", "=", id).execute();
  return { ...buildSkillIndexEntry(frontmatter), file_path: skill.file_path };
}

async replaceSkillContentIfUnchanged(input: { id: string; expectedContentHash: string; content: string; lockRunId?: string }): Promise<SkillWithFilePath | undefined> {
  await this.assertSkillWriteUnlocked(input.id, input.lockRunId);
  const skill = await this.getSkill(input.id);
  const raw = await this.readSkillMarkdown(input.id);
  if (!skill || !raw) return undefined;
  const currentBodyHash = stableHash(stripFrontmatter(raw).trim());
  if (currentBodyHash !== input.expectedContentHash) {
    throw new Error(`skill_content_conflict:${input.id}`);
  }
  const frontmatter = { ...skill.frontmatter, last_reviewed_at: nowIso() };
  await writeFile(path.join(this.rootDir, skill.file_path), this.renderSkillMarkdown(frontmatter, input.content));
  await this.db.updateTable("skill_index").set({
    frontmatter_json: stringify(frontmatter),
    updated_at: frontmatter.last_reviewed_at ?? nowIso()
  }).where("id", "=", input.id).execute();
  return { ...buildSkillIndexEntry(frontmatter), file_path: skill.file_path };
}

  /** Rebuilds the derived skill_index from validated Workspace markdown. */
  async synchronizeFilesystemIndex(): Promise<SkillReindexResult> {
    const existingRows = await this.db.selectFrom("skill_index").selectAll().execute();
    let files: Awaited<ReturnType<typeof readManagedResourceFiles>>;
    try {
      files = await readManagedResourceFiles(this.rootDir, "skills", (relativePath) => {
        const parts = relativePath.split(path.sep);
        return parts.length === 2 && parts[0] !== "support" && path.extname(relativePath).toLowerCase() === ".md";
      });
    } catch (error) {
      return {
        files: 0,
        indexed: existingRows.length,
        created: 0,
        updated: 0,
        removed: 0,
        skipped: 0,
        errors: [{ file_path: "skills", message: `workspace_file_scan_failed:${errorMessage(error)}` }]
      };
    }

    const desired = new Map<string, SkillIndexTable>();
    const errors: Array<{ file_path: string; message: string }> = [];
    let skipped = 0;
    for (const file of files) {
      try {
        const frontmatter = parseSkillMarkdownLocal(file.content).frontmatter;
        assertSkillPathMatchesFrontmatter(file.relativePath, frontmatter);
        if (desired.has(frontmatter.id)) {
          skipped += 1;
          errors.push({ file_path: file.relativePath, message: `duplicate skill id: ${frontmatter.id}` });
          continue;
        }
        const previous = existingRows.find((row) => row.id === frontmatter.id);
        const next = skillToRow(frontmatter, file.relativePath);
        if (previous && sameSkillIndexContent(previous, next)) {
          next.created_at = previous.created_at;
          next.updated_at = previous.updated_at;
        }
        desired.set(frontmatter.id, next);
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
          await transaction.insertInto("skill_index").values(row).execute();
          created += 1;
        } else if (!sameSkillIndexRow(previous, row)) {
          await transaction.updateTable("skill_index").set(row).where("id", "=", id).execute();
          updated += 1;
        }
      }
      for (const row of existingRows) {
        if (!desired.has(row.id)) {
          await transaction.deleteFrom("skill_index").where("id", "=", row.id).execute();
          removed += 1;
        }
      }
    });
    return { files: files.length, indexed: desired.size, created, updated, removed, skipped, errors };
  }

  /** Reports Skill file/index drift without changing either source. */
  async inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["skills"]> {
    const rows = await this.db.selectFrom("skill_index").selectAll().execute();
    const skillFiles = await listSkillMarkdownFiles(this.rootDir);
    const skillFileSet = new Set(skillFiles);
    const indexedIds = new Set(rows.map((row) => row.id));
    const missingFiles = rows
      .filter((row) => !skillFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path, title: row.title }));
    const unindexedFiles: string[] = [];
    const invalidFiles: Array<{ file_path: string; message: string }> = [];
    const filesById = new Map<string, string[]>();

    for (const filePath of skillFiles) {
      try {
        const parsed = parseSkillMarkdownLocal(await readFile(path.join(this.rootDir, filePath), "utf8"));
        assertSkillPathMatchesFrontmatter(filePath, parsed.frontmatter);
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
      files: skillFiles.length,
      indexed: rows.length,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles,
      invalid_files: invalidFiles,
      duplicate_ids: duplicateIds
    };
  }

private renderSkillMarkdown(frontmatter: SkillFrontmatter, content: string): string {
  return ["---", JSON.stringify(frontmatter, null, 2), "---", content.trim(), ""].join("\n");
}

private async assertSkillWriteUnlocked(skillId: string, ownerRunId?: string): Promise<void> {
  const lock = await this.getSkillOptimizationLock(skillId);
  if (lock && lock.run_id !== ownerRunId) {
    throw new Error(`skill_locked_for_optimization:${skillId}`);
  }
}

async recordSkillUsage(input: { skillId: string; runId?: string; usedAt?: string }): Promise<SkillUsageRecord> {
  const skill = await this.getSkill(input.skillId);
  if (!skill) {
    throw new Error(`skill_not_found:${input.skillId}`);
  }
  const usedAt = input.usedAt ?? nowIso();
  const existing = await this.getSkillUsage(input.skillId);
  const next: SkillUsageRecord = existing
    ? {
        ...existing,
        use_count: existing.use_count + 1,
        last_used_at: usedAt,
        last_run_id: input.runId,
        updated_at: usedAt
      }
    : {
        skill_id: input.skillId,
        use_count: 1,
        last_used_at: usedAt,
        last_run_id: input.runId,
        created_at: usedAt,
        updated_at: usedAt
      };
  if (existing) {
    await sql`
      UPDATE skill_usage
      SET use_count = ${next.use_count},
          last_used_at = ${next.last_used_at ?? null},
          last_run_id = ${next.last_run_id ?? null},
          updated_at = ${next.updated_at}
      WHERE skill_id = ${input.skillId}
    `.execute(this.db);
  } else {
    await sql`
      INSERT INTO skill_usage (skill_id, use_count, last_used_at, last_run_id, created_at, updated_at)
      VALUES (${next.skill_id}, ${next.use_count}, ${next.last_used_at ?? null}, ${next.last_run_id ?? null}, ${next.created_at}, ${next.updated_at})
    `.execute(this.db);
  }
  return next;
}

async getSkillUsage(skillId: string): Promise<SkillUsageRecord | undefined> {
  const result = await sql<SkillUsageTable>`
    SELECT skill_id, use_count, last_used_at, last_run_id, created_at, updated_at
    FROM skill_usage
    WHERE skill_id = ${skillId}
  `.execute(this.db);
  const row = result.rows[0];
  return row ? skillUsageFromRow(row) : undefined;
}

async listSkillUsage(): Promise<SkillUsageRecord[]> {
  const result = await sql<SkillUsageTable>`
    SELECT skill_id, use_count, last_used_at, last_run_id, created_at, updated_at
    FROM skill_usage
    ORDER BY updated_at DESC
  `.execute(this.db);
  return result.rows.map(skillUsageFromRow);
}



async writeSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<SkillSupportFile> {
  await this.assertSkillWriteUnlocked(input.skillId);
  const skill = await this.getSkill(input.skillId);
  if (!skill) {
    throw new Error(`skill_not_found:${input.skillId}`);
  }
  const supportPath = normalizeSkillSupportPath(input.path);
  const filePath = path.join("skills", "support", input.skillId, supportPath);
  const absolutePath = path.join(this.rootDir, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, input.content);
  return {
    skill_id: input.skillId,
    path: supportPath,
    file_path: filePath,
    content: input.content
  };
}

async readSkillSupportFile(input: { skillId: string; path: string }): Promise<SkillSupportFile | undefined> {
  const skill = await this.getSkill(input.skillId);
  if (!skill) return undefined;
  const supportPath = normalizeSkillSupportPath(input.path);
  const filePath = path.join("skills", "support", input.skillId, supportPath);
  try {
    const supportRoot = path.join(this.rootDir, "skills", "support", input.skillId);
    const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(supportRoot), realpath(path.join(this.rootDir, filePath))]);
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) return undefined;
    return {
      skill_id: input.skillId,
      path: supportPath,
      file_path: filePath,
      content: await readFile(path.join(this.rootDir, filePath), "utf8")
    };
  } catch {
    return undefined;
  }
}

async listSkillSupportFiles(skillId: string): Promise<SkillSupportFile[]> {
  const supportRoot = path.join(this.rootDir, "skills", "support", skillId);
  const filePaths = await listRelativeFiles(supportRoot).catch(() => []);
  const files = await Promise.all(
    filePaths.map(async (supportPath) => {
      const filePath = path.join("skills", "support", skillId, supportPath);
      return {
        skill_id: skillId,
        path: supportPath,
        file_path: filePath,
        content: await readFile(path.join(this.rootDir, filePath), "utf8")
      };
    })
  );
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async searchSkills(
  query: string,
  limit = 5,
  options: { states?: SkillFrontmatter["state"][] } = {}
): Promise<SkillWithFilePath[]> {
  let rows = await this.db.selectFrom("skill_index").selectAll().orderBy("updated_at", "desc").execute();
  if (options.states?.length) {
    const allowed = new Set(options.states);
    rows = rows.filter((row) => allowed.has(row.state as SkillFrontmatter["state"]));
  }
  const terms = searchTerms(query);
  const scored = await Promise.all(
    rows.map(async (row) => {
      const skill = skillFromRow(row);
      const markdown = await readWorkspaceText(this.rootDir, row.file_path);
      const score = terms.length === 0
        ? stateSearchBoost(skill.state)
        : scoreSearchFields(terms, [
          { value: row.title, weight: 12 },
          { value: row.description, weight: 9 },
          { value: row.tags_json, weight: 5 },
          { value: stripFrontmatter(markdown), weight: 8 },
          { value: row.required_capabilities_json, weight: 3 }
        ]) + stateSearchBoost(skill.state);
      return { item: skill, score, updatedAt: row.updated_at };
    })
  );
  return scored
    .filter((entry) => terms.length === 0 ? entry.score > 0 : entry.score > stateSearchBoost(entry.item.state))
    .sort(compareScoredSearch)
    .slice(0, limit)
    .map((entry) => entry.item);
}


}

function sameSkillIndexRow(left: SkillIndexTable, right: SkillIndexTable): boolean {
  return stableHash(left) === stableHash(right);
}

function sameSkillIndexContent(left: SkillIndexTable, right: SkillIndexTable): boolean {
  return left.id === right.id
    && left.state === right.state
    && left.title === right.title
    && left.description === right.description
    && left.tags_json === right.tags_json
    && left.required_capabilities_json === right.required_capabilities_json
    && left.file_path === right.file_path
    && left.frontmatter_json === right.frontmatter_json;
}
