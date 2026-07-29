import { mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId, nowIso, stableHash, type AutomationJobRecord, type CollectionPatch, type CollectionRecord, type CollectionSchema } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { CollectionRecordsTable, CollectionSchemasTable, WorkspaceDb } from "../kernel/workspace-db-schema";
import type {
  CollectionNote,
  CollectionReindexResult,
  CollectionRecordResolution,
  CollectionRecordWithFilePath,
  CollectionResolvedEmbed,
  CollectionResolvedRef,
  CollectionMissingRef,
  CollectionSchemaWithFilePath,
  CollectionTriggerEffect,
  CollectionTriggerState,
  WorkspaceHealthReport
} from "../workspace-store-contracts";
import { CollectionRecordVersionConflictError } from "./collection-errors";
import {
  applyCollectionPatchLocal,
  collectionDefinitionBoolean,
  collectionDefinitionField,
  collectionDefinitionString,
  collectionFieldId,
  collectionRecordRefLocal,
  collectionRefTargetId,
  collectionSchemaHasAction,
  collectionTriggerEffect,
  collectionTriggerJobSummary,
  collectionTriggerStateStatus,
  parseCollectionRecordLocal,
  parseCollectionSchemaLocal
} from "./collection-codecs";
import { readManagedResourceFiles } from "./managed-resource-file-scan";
import { stringify } from "./serialization";
import {
  collectionPatchFromRow,
  collectionRecordFromRow,
  collectionSchemaFromRow
} from "./wiki-collection-row-codecs";
import { CollectionRecordRecoveryHandler } from "../transactions/collection-record-recovery-handler";
import { WorkspaceFileTransactionCoordinator } from "../transactions/workspace-file-transaction-coordinator";
import { errorMessage, listCollectionRecordFiles, listCollectionSchemaFiles } from "./workspace-file-codecs";

export interface CollectionAutomationPort {
  listAutomationJobs(input?: { dueAt?: string; enabledOnly?: boolean }): Promise<AutomationJobRecord[]>;
}

/** Collection schema, record, patch, and filesystem transaction ownership. */
export class CollectionRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly fileTransactions: WorkspaceFileTransactionCoordinator,
    private readonly collectionRecordRecoveryHandler: CollectionRecordRecoveryHandler,
    private readonly automation: CollectionAutomationPort
  ) {}

async saveCollectionSchema(schemaInput: CollectionSchema): Promise<CollectionSchemaWithFilePath> {
  const relativePath = path.join("collections", schemaInput.id, "schema.json");
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(schemaInput, null, 2)}\n`, { flag: "wx" });

  try {
    const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(absolutePath, "utf8")));
    const now = nowIso();
    await this.db
      .insertInto("collection_schemas")
      .values({
        id: schema.id,
        version: schema.version,
        file_path: relativePath,
        schema_json: stringify(schema),
        updated_at: now
      })
      .execute();
    return { ...schema, file_path: relativePath };
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

async getCollectionSchema(collectionId: string): Promise<CollectionSchemaWithFilePath | undefined> {
  const row = await this.db.selectFrom("collection_schemas").selectAll().where("id", "=", collectionId).executeTakeFirst();
  return row ? collectionSchemaFromRow(row) : undefined;
}

async listCollectionSchemas(): Promise<CollectionSchemaWithFilePath[]> {
  const rows = await this.db.selectFrom("collection_schemas").selectAll().orderBy("id").execute();
  return rows.map(collectionSchemaFromRow);
}

async updateCollectionSchema(schemaInput: CollectionSchema): Promise<CollectionSchemaWithFilePath> {
  const existing = await this.getCollectionSchema(schemaInput.id);
  const relativePath = existing?.file_path ?? path.join("collections", schemaInput.id, "schema.json");
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const schema = parseCollectionSchemaLocal(schemaInput);
  await writeFile(absolutePath, `${JSON.stringify(schema, null, 2)}\n`);
  await this.db
    .insertInto("collection_schemas")
    .values({
      id: schema.id,
      version: schema.version,
      file_path: relativePath,
      schema_json: stringify(schema),
      updated_at: nowIso()
    })
    .onConflict((oc) => oc.column("id").doUpdateSet({
      version: schema.version,
      file_path: relativePath,
      schema_json: stringify(schema),
      updated_at: nowIso()
    }))
    .execute();
  return { ...schema, file_path: relativePath };
}

async saveCollectionRecord(recordInput: CollectionRecord): Promise<CollectionRecordWithFilePath> {
  const schema = await this.getCollectionSchema(recordInput.collection_id);
  if (!schema) {
    throw new Error("collection_schema_not_found");
  }
  const record = parseCollectionRecordLocal(recordInput, schema);
  await this.validateCollectionRecordLinks(record, schema);
  const relativePath = path.join("collections", recordInput.collection_id, "records", `${recordInput.id}.json`);
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });

  try {
    await this.db
      .insertInto("collection_records")
      .values({
        id: record.id,
        collection_id: record.collection_id,
        file_path: relativePath,
        record_json: stringify(record),
        version: record.version,
        created_at: record.created_at,
        updated_at: record.updated_at
      })
      .execute();
    return { ...record, file_path: relativePath };
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}

async upsertCollectionRecord(recordInput: CollectionRecord): Promise<CollectionRecordWithFilePath> {
  const schema = await this.getCollectionSchema(recordInput.collection_id);
  if (!schema) {
    throw new Error("collection_schema_not_found");
  }
  const existing = await this.getCollectionRecord(recordInput.collection_id, recordInput.id);
  const record = parseCollectionRecordLocal({
    ...recordInput,
    created_at: existing?.created_at ?? recordInput.created_at
  }, schema);
  await this.validateCollectionRecordLinks(record, schema);
  const relativePath = existing?.file_path ?? path.join("collections", recordInput.collection_id, "records", `${recordInput.id}.json`);
  const absolutePath = path.join(this.rootDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(record, null, 2)}\n`);
  await this.db
    .insertInto("collection_records")
    .values({
      id: record.id,
      collection_id: record.collection_id,
      file_path: relativePath,
      record_json: stringify(record),
      version: record.version,
      created_at: record.created_at,
      updated_at: record.updated_at
    })
    .onConflict((oc) => oc.columns(["collection_id", "id"]).doUpdateSet({
      file_path: relativePath,
      record_json: stringify(record),
      version: record.version,
      updated_at: record.updated_at
    }))
    .execute();
  return { ...record, file_path: relativePath };
}

async deleteCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecordWithFilePath> {
  const existing = await this.getCollectionRecord(collectionId, recordId);
  if (!existing) {
    throw new Error("collection_record_not_found");
  }
  await rm(path.join(this.rootDir, existing.file_path), { force: true });
  await this.db
    .deleteFrom("collection_records")
    .where("collection_id", "=", collectionId)
    .where("id", "=", recordId)
    .execute();
  return existing;
}

async getCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecordWithFilePath | undefined> {
  const row = await this.db
    .selectFrom("collection_records")
    .selectAll()
    .where("collection_id", "=", collectionId)
    .where("id", "=", recordId)
    .executeTakeFirst();
  return row ? collectionRecordFromRow(row) : undefined;
}

async listCollectionRecords(collectionId?: string): Promise<CollectionRecordWithFilePath[]> {
  let query = this.db.selectFrom("collection_records").selectAll();
  if (collectionId) {
    query = query.where("collection_id", "=", collectionId);
  }
  const rows = await query.orderBy("updated_at", "desc").execute();
  return rows.map(collectionRecordFromRow);
}

async listCollectionPatches(input: { collectionId?: string; recordId?: string } = {}): Promise<CollectionPatch[]> {
  let query = this.db.selectFrom("collection_patches").selectAll();
  if (input.collectionId) {
    query = query.where("collection_id", "=", input.collectionId);
  }
  if (input.recordId) {
    query = query.where("record_id", "=", input.recordId);
  }
  const rows = await query.orderBy("created_at", "desc").execute();
  return rows.map(collectionPatchFromRow);
}

async getCollectionPatch(collectionId: string, recordId: string, patchId: string): Promise<CollectionPatch | undefined> {
  const row = await this.db
    .selectFrom("collection_patches")
    .selectAll()
    .where("collection_id", "=", collectionId)
    .where("record_id", "=", recordId)
    .where("id", "=", patchId)
    .executeTakeFirst();
  return row ? collectionPatchFromRow(row) : undefined;
}

async resolveCollectionRecordRefs(collectionId: string, recordId: string): Promise<CollectionRecordResolution> {
  const [schema, record] = await Promise.all([
    this.getCollectionSchema(collectionId),
    this.getCollectionRecord(collectionId, recordId)
  ]);
  if (!schema) {
    throw new Error("collection_schema_not_found");
  }
  if (!record) {
    throw new Error("collection_record_not_found");
  }

  const resolvedRefs: CollectionResolvedRef[] = [];
  const missingRefs: CollectionMissingRef[] = [];
  const embedFields: CollectionResolvedEmbed[] = [];

  for (const ref of schema.refs) {
    const field = collectionDefinitionField(ref);
    if (!field) {
      continue;
    }
    const refId = collectionFieldId(ref) ?? field;
    const targetCollection = collectionDefinitionString(ref, "collection_id")
      ?? collectionDefinitionString(ref, "target_collection_id")
      ?? record.collection_id;
    const value = record.data[field];
    if (value === undefined || value === null || value === "") {
      missingRefs.push({
        ref_id: refId,
        field,
        target_collection_id: targetCollection,
        reason: "empty"
      });
      continue;
    }
    const targetId = collectionRefTargetId(value);
    if (!targetId) {
      missingRefs.push({
        ref_id: refId,
        field,
        target_collection_id: targetCollection,
        reason: "invalid"
      });
      continue;
    }
    const target = await this.getCollectionRecord(targetCollection, targetId);
    if (!target) {
      missingRefs.push({
        ref_id: refId,
        field,
        target_collection_id: targetCollection,
        target_record_id: targetId,
        reason: "not_found"
      });
      continue;
    }
    resolvedRefs.push({
      ref_id: refId,
      field,
      target_collection_id: targetCollection,
      target_record_id: target.id,
      record: target,
      resource_ref: collectionRecordRefLocal(target)
    });
  }

  for (const embed of schema.embeds) {
    const field = collectionDefinitionField(embed);
    if (!field || !(field in record.data)) {
      continue;
    }
    embedFields.push({
      embed_id: collectionFieldId(embed) ?? field,
      field,
      value: record.data[field] ?? null
    });
  }

  return {
    collection_id: record.collection_id,
    record_id: record.id,
    resolved_refs: resolvedRefs,
    missing_refs: missingRefs,
    embed_fields: embedFields
  };
}

async evaluateCollectionTriggers(input: {
  collectionId: string;
  recordId: string;
  event: CollectionTriggerEffect["event"];
}): Promise<CollectionTriggerEffect[]> {
  const [schema, record] = await Promise.all([
    this.getCollectionSchema(input.collectionId),
    this.getCollectionRecord(input.collectionId, input.recordId)
  ]);
  if (!schema) {
    throw new Error("collection_schema_not_found");
  }
  if (!record) {
    throw new Error("collection_record_not_found");
  }
  return schema.triggers.map((trigger, index) => collectionTriggerEffect(trigger, index, input.event, collectionRecordRefLocal(record)));
}

async listCollectionTriggerStates(collectionId?: string): Promise<CollectionTriggerState[]> {
  const schema = collectionId ? await this.getCollectionSchema(collectionId) : undefined;
  const schemas = collectionId ? (schema ? [schema] : []) : await this.listCollectionSchemas();
  const jobs = await this.automation.listAutomationJobs();
  const states: CollectionTriggerState[] = [];

  for (const schema of schemas) {
    schema.triggers.forEach((trigger, index) => {
      const triggerId = collectionDefinitionString(trigger, "id") ?? `trigger_${index + 1}`;
      const actionId = collectionDefinitionString(trigger, "action_id")
        ?? collectionDefinitionString(trigger, "action")
        ?? collectionDefinitionString(trigger, "name")
        ?? triggerId;
      const actionKind = collectionDefinitionString(trigger, "kind") ?? collectionDefinitionString(trigger, "type") ?? "custom_instruction";
      const event = collectionDefinitionString(trigger, "event") ?? collectionDefinitionString(trigger, "on") ?? "any";
      const enabled = trigger.enabled !== false;
      const actionExists = collectionSchemaHasAction(schema, actionId);
      const triggerJobs = jobs
        .filter((job) => collectionDefinitionString(job.delivery_target, "channel") === "collection_trigger")
        .filter((job) => collectionDefinitionString(job.delivery_target, "collection_id") === schema.id)
        .filter((job) => collectionDefinitionString(job.delivery_target, "trigger_id") === triggerId)
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      const lastJob = triggerJobs[0];
      const pendingJobCount = triggerJobs.filter((job) => job.status === "enabled").length;
      states.push({
        collection_id: schema.id,
        trigger_id: triggerId,
        event,
        action_id: actionId,
        action_kind: actionKind,
        enabled,
        action_exists: actionExists,
        status: collectionTriggerStateStatus({ enabled, actionExists, pendingJobCount, lastJob }),
        pending_job_count: pendingJobCount,
        job_count: triggerJobs.length,
        last_job: lastJob ? collectionTriggerJobSummary(lastJob) : undefined,
        definition: trigger
      });
    });
  }

  return states;
}

private async validateCollectionRecordLinks(record: CollectionRecord, schema: CollectionSchema): Promise<void> {
  for (const ref of schema.refs) {
    const field = collectionDefinitionField(ref);
    if (!field) {
      continue;
    }
    const value = record.data[field];
    if (value === undefined || value === null || value === "") {
      if (collectionDefinitionBoolean(ref, "required")) {
        throw new Error(`collection_ref_required:${field}`);
      }
      continue;
    }
    const targetCollection = collectionDefinitionString(ref, "collection_id")
      ?? collectionDefinitionString(ref, "target_collection_id")
      ?? record.collection_id;
    const targetId = collectionRefTargetId(value);
    if (!targetId) {
      throw new Error(`collection_ref_invalid:${field}`);
    }
    const target = await this.getCollectionRecord(targetCollection, targetId);
    if (!target) {
      throw new Error(`collection_ref_not_found:${field}:${targetCollection}/${targetId}`);
    }
  }
  for (const embed of schema.embeds) {
    const field = collectionDefinitionField(embed);
    if (!field) {
      continue;
    }
    const value = record.data[field];
    if ((value === undefined || value === null) && collectionDefinitionBoolean(embed, "required")) {
      throw new Error(`collection_embed_required:${field}`);
    }
    if (value !== undefined && value !== null && typeof value !== "object") {
      throw new Error(`collection_embed_invalid:${field}`);
    }
  }
}



async applyCollectionRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<{
  before: CollectionRecordWithFilePath;
  after: CollectionRecordWithFilePath;
}> {
  const [schema, before] = await Promise.all([
    this.getCollectionSchema(input.collectionId),
    this.getCollectionRecord(input.collectionId, input.recordId)
  ]);
  if (!schema) {
    throw new Error("collection_schema_not_found");
  }
  if (!before) {
    throw new Error("collection_record_not_found");
  }
  if (input.patch.expected_version !== undefined && input.patch.expected_version !== before.version) {
    throw new CollectionRecordVersionConflictError(input.patch.expected_version, before);
  }
  const after = applyCollectionPatchLocal(before, input.patch, schema);
  await this.validateCollectionRecordLinks(after, schema);
  const stagedRelativePath = `${before.file_path}.pending-${input.patch.id}`;
  try {
    await this.fileTransactions.execute({
      kind: "collection_record_patch",
      targetPath: before.file_path,
      stagedPath: stagedRelativePath,
      collectionId: input.collectionId,
      recordId: input.recordId,
      patchId: input.patch.id,
      beforeJson: stringify(before),
      afterJson: stringify(after),
      stagedContent: `${JSON.stringify(after, null, 2)}\n`,
      commit: async (transaction) => {
        const updated = await this.collectionRecordRecoveryHandler.commitPatch(transaction, { collectionId: input.collectionId, recordId: input.recordId, before, after, patch: input.patch });
        if (!updated) throw new Error("collection_record_patch_version_conflict");
      },
      rollback: (transaction) => this.collectionRecordRecoveryHandler.rollbackPatch(transaction, { collectionId: input.collectionId, recordId: input.recordId, before, after, patchId: input.patch.id })
    });
  } catch (error) {
    if (error instanceof Error && error.message === "collection_record_patch_version_conflict") {
      const latest = await this.getCollectionRecord(input.collectionId, input.recordId);
      throw new CollectionRecordVersionConflictError(input.patch.expected_version ?? before.version, latest ?? before);
    }
    throw error;
  }
  return { before, after: { ...after, file_path: before.file_path } };
}

  async listCollectionNotes(collectionId: string): Promise<CollectionNote[]> {
  const notesDir = path.join(this.rootDir, "collections", collectionId, "notes");
  let entries: string[];
  try {
    entries = await readdir(notesDir);
  } catch {
    return [];
  }
  const notes: CollectionNote[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".md")).sort()) {
    const relativePath = path.join("collections", collectionId, "notes", entry);
    notes.push({
      collection_id: collectionId,
      file_path: relativePath,
      content: await readFile(path.join(this.rootDir, relativePath), "utf8"),
      role: "context_only"
    });
  }
  return notes;
}

  /**
   * Applies the existing file-transaction recovery contract while removing
   * resource references that a read-only health scan proved unavailable.
   */
  async removeBrokenResourceRefs(input: Array<{
    collection_id: string;
    record_id: string;
    ref: { kind: string; id: string; uri: string };
  }>): Promise<number> {
    const grouped = new Map<string, typeof input>();
    for (const item of input) {
      const key = `${item.collection_id}\0${item.record_id}`;
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    let repaired = 0;
    for (const items of grouped.values()) {
      const first = items[0];
      if (!first) continue;
      const before = await this.getCollectionRecord(first.collection_id, first.record_id);
      if (!before) continue;
      const brokenKeys = new Set(items.map((item) => `${item.ref.kind}\0${item.ref.id}\0${item.ref.uri}`));
      const after = {
        ...before,
        version: before.version + 1,
        resource_refs: before.resource_refs.filter((ref) => !brokenKeys.has(`${ref.kind}\0${ref.id}\0${ref.uri}`)),
        updated_at: nowIso()
      };
      const stagedRelativePath = `${before.file_path}.pending-${createId("file_transaction")}`;
      await this.fileTransactions.execute({
        kind: "collection_record_repair",
        targetPath: before.file_path,
        stagedPath: stagedRelativePath,
        collectionId: before.collection_id,
        recordId: before.id,
        beforeJson: stringify(before),
        afterJson: stringify(after),
        stagedContent: `${JSON.stringify(after, null, 2)}\n`,
        commit: async (transaction) => {
          if (!await this.collectionRecordRecoveryHandler.commitRepair(transaction, {
            collectionId: before.collection_id,
            recordId: before.id,
            before,
            after
          })) {
            throw new Error("collection_record_repair_version_conflict");
          }
        },
        rollback: (transaction) => this.collectionRecordRecoveryHandler.rollbackRepair(transaction, {
          collectionId: before.collection_id,
          recordId: before.id,
          before,
          after
        })
      });
      repaired += 1;
    }
    return repaired;
  }

  /** Rebuilds Collection schema and record indexes from validated Workspace files. */
  async synchronizeFilesystemIndex(): Promise<CollectionReindexResult> {
    const [existingSchemaRows, existingRecordRows] = await Promise.all([
      this.db.selectFrom("collection_schemas").selectAll().execute(),
      this.db.selectFrom("collection_records").selectAll().execute()
    ]);
    let schemaFiles: Awaited<ReturnType<typeof readManagedResourceFiles>>;
    let recordFiles: Awaited<ReturnType<typeof readManagedResourceFiles>>;
    try {
      [schemaFiles, recordFiles] = await Promise.all([
        readManagedResourceFiles(this.rootDir, "collections", (relativePath) => path.basename(relativePath) === "schema.json"),
        readManagedResourceFiles(this.rootDir, "collections", (relativePath) => {
          const parts = relativePath.split(path.sep);
          return parts.includes("records") && path.extname(relativePath).toLowerCase() === ".json";
        })
      ]);
    } catch (error) {
      const issue = { file_path: "collections", message: `workspace_file_scan_failed:${errorMessage(error)}` };
      return {
        schemas: { files: 0, indexed: existingSchemaRows.length, created: 0, updated: 0, removed: 0, skipped: 0, errors: [issue] },
        records: { files: 0, indexed: existingRecordRows.length, created: 0, updated: 0, removed: 0, skipped: 0, errors: [issue] }
      };
    }

    const schemaDesired = new Map<string, CollectionSchemasTable>();
    const schemas = new Map<string, CollectionSchema>();
    const schemaErrors: Array<{ file_path: string; message: string }> = [];
    let schemasSkipped = 0;
    for (const file of schemaFiles) {
      try {
        const schema = parseCollectionSchemaLocal(JSON.parse(file.content));
        if (schemaDesired.has(schema.id)) {
          schemasSkipped += 1;
          schemaErrors.push({ file_path: file.relativePath, message: `duplicate collection schema id: ${schema.id}` });
          continue;
        }
        const previous = existingSchemaRows.find((row) => row.id === schema.id);
        const schemaJson = stringify(schema);
        schemaDesired.set(schema.id, {
          id: schema.id,
          version: schema.version,
          file_path: file.relativePath,
          schema_json: schemaJson,
          updated_at: previous && previous.version === schema.version && previous.file_path === file.relativePath && previous.schema_json === schemaJson
            ? previous.updated_at
            : nowIso()
        });
        schemas.set(schema.id, schema);
      } catch (error) {
        schemasSkipped += 1;
        schemaErrors.push({ file_path: file.relativePath, message: errorMessage(error) });
      }
    }

    const recordDesired = new Map<string, CollectionRecordsTable>();
    const recordErrors: Array<{ file_path: string; message: string }> = [];
    let recordsSkipped = 0;
    for (const file of recordFiles) {
      try {
        const raw = JSON.parse(file.content) as Record<string, unknown>;
        const collectionId = typeof raw.collection_id === "string" ? raw.collection_id : "";
        const schema = schemas.get(collectionId);
        if (!schema) throw new Error("collection_schema_not_found");
        const record = parseCollectionRecordLocal(raw, schema);
        const key = `${record.collection_id}/${record.id}`;
        if (recordDesired.has(key)) {
          recordsSkipped += 1;
          recordErrors.push({ file_path: file.relativePath, message: `duplicate collection record id: ${key}` });
          continue;
        }
        recordDesired.set(key, {
          id: record.id,
          collection_id: record.collection_id,
          file_path: file.relativePath,
          record_json: stringify(record),
          version: record.version,
          created_at: record.created_at,
          updated_at: record.updated_at
        });
      } catch (error) {
        recordsSkipped += 1;
        recordErrors.push({ file_path: file.relativePath, message: errorMessage(error) });
      }
    }

    const existingSchemas = new Map(existingSchemaRows.map((row) => [row.id, row]));
    const existingRecords = new Map(existingRecordRows.map((row) => [`${row.collection_id}/${row.id}`, row]));
    let schemasCreated = 0;
    let schemasUpdated = 0;
    let schemasRemoved = 0;
    let recordsCreated = 0;
    let recordsUpdated = 0;
    let recordsRemoved = 0;
    await this.db.transaction().execute(async (transaction) => {
      for (const [id, row] of schemaDesired) {
        const previous = existingSchemas.get(id);
        if (!previous) {
          await transaction.insertInto("collection_schemas").values(row).execute();
          schemasCreated += 1;
        } else if (!sameCollectionIndexRow(previous, row)) {
          await transaction.updateTable("collection_schemas").set(row).where("id", "=", id).execute();
          schemasUpdated += 1;
        }
      }
      for (const [key, row] of recordDesired) {
        const previous = existingRecords.get(key);
        if (!previous) {
          await transaction.insertInto("collection_records").values(row).execute();
          recordsCreated += 1;
        } else if (!sameCollectionIndexRow(previous, row)) {
          await transaction.updateTable("collection_records").set(row).where("collection_id", "=", row.collection_id).where("id", "=", row.id).execute();
          recordsUpdated += 1;
        }
      }
      for (const row of existingRecordRows) {
        if (!recordDesired.has(`${row.collection_id}/${row.id}`)) {
          await transaction.deleteFrom("collection_records").where("collection_id", "=", row.collection_id).where("id", "=", row.id).execute();
          recordsRemoved += 1;
        }
      }
      for (const row of existingSchemaRows) {
        if (!schemaDesired.has(row.id)) {
          await transaction.deleteFrom("collection_schemas").where("id", "=", row.id).execute();
          schemasRemoved += 1;
        }
      }
    });

    return {
      schemas: { files: schemaFiles.length, indexed: schemaDesired.size, created: schemasCreated, updated: schemasUpdated, removed: schemasRemoved, skipped: schemasSkipped, errors: schemaErrors },
      records: { files: recordFiles.length, indexed: recordDesired.size, created: recordsCreated, updated: recordsUpdated, removed: recordsRemoved, skipped: recordsSkipped, errors: recordErrors }
    };
  }

  /** Reports Collection file/index drift without changing either source. */
  async inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["collections"]> {
    const [schemaRows, recordRows] = await Promise.all([
      this.db.selectFrom("collection_schemas").selectAll().execute(),
      this.db.selectFrom("collection_records").selectAll().execute()
    ]);
    const schemaFiles = await listCollectionSchemaFiles(this.rootDir);
    const recordFiles = await listCollectionRecordFiles(this.rootDir);
    const schemaFileSet = new Set(schemaFiles);
    const recordFileSet = new Set(recordFiles);
    const indexedSchemaIds = new Set(schemaRows.map((row) => row.id));
    const indexedRecordKeys = new Set(recordRows.map((row) => `${row.collection_id}/${row.id}`));
    const schemasById = new Map<string, CollectionSchema>();

    for (const row of schemaRows) {
      try {
        const schema = collectionSchemaFromRow(row);
        schemasById.set(schema.id, schema);
      } catch {
        // Corrupt SQLite rows are surfaced through file/index drift below.
      }
    }

    const missingSchemaFiles = schemaRows
      .filter((row) => !schemaFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, file_path: row.file_path }));
    const unindexedSchemaFiles: string[] = [];
    const invalidSchemaFiles: Array<{ file_path: string; message: string }> = [];
    for (const filePath of schemaFiles) {
      try {
        const schema = parseCollectionSchemaLocal(JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")));
        schemasById.set(schema.id, schema);
        if (!indexedSchemaIds.has(schema.id)) unindexedSchemaFiles.push(filePath);
      } catch (error) {
        invalidSchemaFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const missingRecordFiles = recordRows
      .filter((row) => !recordFileSet.has(row.file_path))
      .map((row) => ({ id: row.id, collection_id: row.collection_id, file_path: row.file_path }));
    const unindexedRecordFiles: string[] = [];
    const invalidRecordFiles: Array<{ file_path: string; message: string }> = [];
    for (const filePath of recordFiles) {
      try {
        const raw = JSON.parse(await readFile(path.join(this.rootDir, filePath), "utf8")) as Record<string, unknown>;
        const collectionId = typeof raw.collection_id === "string" ? raw.collection_id : "";
        const schema = schemasById.get(collectionId);
        if (!schema) throw new Error("collection_schema_not_found");
        const record = parseCollectionRecordLocal(raw, schema);
        if (!indexedRecordKeys.has(`${record.collection_id}/${record.id}`)) unindexedRecordFiles.push(filePath);
      } catch (error) {
        invalidRecordFiles.push({ file_path: filePath, message: errorMessage(error) });
      }
    }

    const ok = missingSchemaFiles.length === 0
      && unindexedSchemaFiles.length === 0
      && invalidSchemaFiles.length === 0
      && missingRecordFiles.length === 0
      && unindexedRecordFiles.length === 0
      && invalidRecordFiles.length === 0;
    return {
      ok,
      schemas: {
        files: schemaFiles.length,
        indexed: schemaRows.length,
        missing_files: missingSchemaFiles,
        unindexed_files: unindexedSchemaFiles,
        invalid_files: invalidSchemaFiles
      },
      records: {
        files: recordFiles.length,
        indexed: recordRows.length,
        missing_files: missingRecordFiles,
        unindexed_files: unindexedRecordFiles,
        invalid_files: invalidRecordFiles
      }
    };
  }


}

function sameCollectionIndexRow(left: object, right: object): boolean {
  return stableHash(left) === stableHash(right);
}
