import { z } from "zod";

const errorSchema = z.object({ file_path: z.string(), message: z.string() }).strict();
const reindexSchema = z.object({
  files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(), updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(),
  errors: z.array(errorSchema)
}).strict();
const wikiReindexSchema = reindexSchema.extend({ active: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict();
const collectionReindexSchema = z.object({ schemas: reindexSchema, records: reindexSchema }).strict();
const layoutCheckSchema = z.object({ path: z.string(), exists: z.boolean(), kind: z.literal("directory"), required: z.boolean() }).strict();
const boundarySchema = z.object({
  resource: z.string(), source_of_truth: z.enum(["filesystem", "sqlite", "derived"]),
  file_roots: z.array(z.string()), sqlite_tables: z.array(z.string()),
  sqlite_role: z.enum(["none", "index", "history", "queue", "audit", "metadata"]), note: z.string()
}).strict();
const driftIssueSchema = z.object({
  code: z.string(), severity: z.enum(["warning", "error"]), message: z.string(),
  file_path: z.string().optional(), resource_id: z.string().optional()
}).strict();
const repairStepSchema = z.object({ operation: z.string(), reason: z.string(), effect: z.string() }).strict();
const missingTitleSchema = z.object({ id: z.string(), file_path: z.string(), title: z.string() }).strict();
const invalidFileSchema = z.object({ file_path: z.string(), message: z.string() }).strict();
const duplicateSchema = z.object({ id: z.string(), file_paths: z.array(z.string()) }).strict();

export const workspaceHealthSchema = z.object({
  ok: z.boolean(), checked_at: z.string().datetime(), root_dir: z.string(), db_path: z.string(),
  layout: z.object({ ok: z.boolean(), checks: z.array(layoutCheckSchema), missing: z.array(z.string()) }).strict(),
  resource_boundaries: z.array(boundarySchema),
  indexes: z.object({
    search: z.object({ ok: z.boolean(), mode: z.enum(["fts5_trigram", "fts5", "like"]), indexed: z.number().int().nonnegative(), source_records: z.number().int().nonnegative(), stale: z.boolean() }).strict(),
    wiki: z.object({ ok: z.boolean(), files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), active: z.number().int().nonnegative(), missing_files: z.array(missingTitleSchema), unindexed_files: z.array(z.string()), invalid_files: z.array(invalidFileSchema), duplicate_ids: z.array(duplicateSchema) }).strict(),
    artifacts: z.object({ ok: z.boolean(), files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), missing_files: z.array(missingTitleSchema), unindexed_files: z.array(z.string()) }).strict(),
    memory: z.object({ ok: z.boolean(), files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), missing_files: z.array(z.object({ id: z.string(), file_path: z.string(), topic: z.string() }).strict()), unindexed_files: z.array(z.string()), invalid_files: z.array(invalidFileSchema), duplicate_ids: z.array(duplicateSchema) }).strict(),
    skills: z.object({ ok: z.boolean(), files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), missing_files: z.array(missingTitleSchema), unindexed_files: z.array(z.string()), invalid_files: z.array(invalidFileSchema), duplicate_ids: z.array(duplicateSchema) }).strict(),
    collections: z.object({
      ok: z.boolean(),
      schemas: z.object({ files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), missing_files: z.array(z.object({ id: z.string(), file_path: z.string() }).strict()), unindexed_files: z.array(z.string()), invalid_files: z.array(invalidFileSchema) }).strict(),
      records: z.object({ files: z.number().int().nonnegative(), indexed: z.number().int().nonnegative(), missing_files: z.array(z.object({ id: z.string(), collection_id: z.string(), file_path: z.string() }).strict()), unindexed_files: z.array(z.string()), invalid_files: z.array(invalidFileSchema) }).strict()
    }).strict()
  }).strict(),
  issues: z.array(driftIssueSchema), repair_plan: z.array(repairStepSchema)
}).strict();

const backupManifestSchema = z.object({
  id: z.string().min(1), created_at: z.string().datetime(), source_root: z.string(), db_file: z.string(),
  file_roots: z.array(z.string()), resource_boundaries: z.array(boundarySchema), health_ok: z.boolean(),
  integrity_ok: z.boolean(), file_hashes: z.record(z.string())
}).strict();

export const workspaceBackupValueSchema = z.object({ id: z.string().min(1), path: z.string().min(1), manifest: backupManifestSchema }).strict();
export const workspaceRestoreValueSchema = z.object({
  backup_id: z.string().min(1), restored_at: z.string().datetime(), restored_paths: z.array(z.string()), db_restored: z.boolean(),
  manifest: backupManifestSchema, pre_restore_health: workspaceHealthSchema,
  integrity: z.object({ ok: z.boolean(), checked_at: z.string().datetime(), db: z.object({ ok: z.boolean(), result: z.string(), path: z.string() }).strict(), workspace: workspaceHealthSchema }).strict(),
  health: workspaceHealthSchema
}).strict();
export const workspaceRepairValueSchema = z.object({
  dry_run: z.boolean(), plan: z.array(repairStepSchema), applied: z.array(z.string()), skipped: z.array(z.string()),
  wiki_reindex: wikiReindexSchema.optional(), memory_reindex: reindexSchema.optional(), skill_reindex: reindexSchema.optional(),
  collection_reindex: collectionReindexSchema.optional(), health: workspaceHealthSchema
}).strict();
