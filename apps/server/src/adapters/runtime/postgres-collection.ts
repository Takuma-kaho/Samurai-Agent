import { createHash } from "node:crypto";
import {
  applyCollectionPatch,
  parseCollectionMarkdown,
  parseCollectionRecord,
  parseCollectionSchema,
  renderCollectionMarkdown
} from "@samurai-agent/collections";
import {
  nowIso,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type JsonValue,
  type ResourceRef
} from "@samurai-agent/core-schemas";
import { collectionRecordResourceId } from "@samurai-agent/room-permissions";
import { createSurfaceRenderSpec, type SurfaceOperation, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  WorkspaceServerError,
  type WorkspaceServerCommandService,
  type WorkspaceFileStore,
  type WorkspaceRecord,
  type WorkspaceRequestContext
} from "@samurai-agent/workspace-server";

const schemaRecordType = "collection_schema";
const recordRecordType = "collection_record";
const patchRecordType = "collection_patch";

export interface PostgresCollectionSchema extends CollectionSchema {
  file_path: string;
  resource_version: number;
  room_id: string;
}

export type PostgresCollectionRecord = CollectionRecord & { file_path: string };

export interface PostgresCollectionRecordResolution {
  collection_id: string;
  record_id: string;
  resolved_refs: Array<{
    ref_id: string;
    field: string;
    target_collection_id: string;
    target_record_id: string;
    record: PostgresCollectionRecord;
    resource_ref: ResourceRef;
  }>;
  missing_refs: Array<{
    ref_id: string;
    field: string;
    target_collection_id: string;
    target_record_id?: string;
    reason: "empty" | "invalid" | "not_found";
  }>;
  embed_fields: Array<{ embed_id: string; field: string; value: JsonValue }>;
}

type PostgresCollectionSchemaMutation = PostgresCollectionSchema & { replayed: boolean };
type PostgresCollectionRecordMutation = PostgresCollectionRecord & { replayed: boolean };

export interface PostgresCollectionTriggerEnqueuer {
  enqueue(context: WorkspaceRequestContext, input: {
    roomId: string;
    collectionId: string;
    recordId: string;
    event: "record.created" | "record.patched";
    record: CollectionRecord;
    patch?: CollectionPatch;
    trigger: Record<string, JsonValue>;
  }): Promise<void>;
}

interface CollectionIndexPayload {
  kind: "schema" | "record" | "patch";
  state: "pending" | "ready" | "deleting" | "deleted" | "blocked";
  collection_id: string;
  file_path: string;
  file_version?: number;
  operation_id?: string;
  schema?: CollectionSchema;
  record?: CollectionRecord;
  patch?: CollectionPatch;
  error?: string;
  recovery?: {
    kind: "patch_history";
    patch_index_id: string;
    patch: CollectionPatch;
  };
}

/**
 * PostgreSQL Collection use case. The generic Workspace record is only an
 * index/authorization ledger; the user-editable Markdown file is read back
 * and validated on every query. Surface data is regenerated from that file.
 */
export class PostgresCollection {
  constructor(
    private readonly commands: WorkspaceServerCommandService,
    private readonly files: WorkspaceFileStore,
    private readonly triggerEnqueuer?: PostgresCollectionTriggerEnqueuer
  ) {}

  async listSchemas(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<PostgresCollectionSchema[]> {
    const rows = await this.commands.listRecords(context, { roomId, recordType: schemaRecordType, limit: 500 });
    const result: PostgresCollectionSchema[] = [];
    for (const row of rows) {
      const payload = indexPayload(row, "schema");
      if (payload.state !== "ready") continue;
      const schema = await this.readSchema(context, roomId, payload);
      result.push({ ...schema, file_path: payload.file_path, resource_version: row.version, room_id: roomId });
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  async getSchema(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, collectionId: string): Promise<PostgresCollectionSchema> {
    const row = await this.getIndex(context, roomId, schemaRecordType, collectionId);
    const payload = indexPayload(row, "schema");
    if (payload.state !== "ready") throw new WorkspaceServerError("collection_recovery_required", 503);
    const schema = await this.readSchema(context, roomId, payload);
    return { ...schema, file_path: payload.file_path, resource_version: row.version, room_id: roomId };
  }

  async saveSchema(context: WorkspaceRequestContext, roomId: string, schemaInput: CollectionSchema, expectedVersion?: number): Promise<PostgresCollectionSchemaMutation> {
    const schema = parseCollectionSchemaSafe(schemaInput);
    assertCollectionId(schema.id);
    const current = await this.tryGetIndex(context, roomId, schemaRecordType, schema.id);
    const currentPayload = current ? indexPayload(current, "schema") : undefined;
    if (current && currentPayload?.state === "ready" && currentPayload.operation_id === context.operationId) {
      const existing = await this.readSchema(context, roomId, currentPayload);
      if (JSON.stringify(existing) !== JSON.stringify(schema)) throw new WorkspaceServerError("collection_schema_operation_conflict", 409);
      return { ...existing, file_path: currentPayload.file_path, resource_version: current.version, room_id: roomId, replayed: true };
    }
    if (!current || currentPayload?.state === "pending") {
      if ((expectedVersion ?? 0) !== 0) throw new WorkspaceServerError("collection_schema_version_conflict", 409);
      const filePath = `collections/${schema.id}/schema.md`;
      if (currentPayload?.schema && JSON.stringify(currentPayload.schema) !== JSON.stringify(schema)) {
        throw new WorkspaceServerError("collection_schema_operation_conflict", 409);
      }
      const pending = current && currentPayload?.state === "pending"
        ? (assertPendingOperation(currentPayload, context), { record: current, replayed: true })
        : await this.commands.putRecord(indexContext(context, "schema-prepare"), {
          roomId, recordType: schemaRecordType, id: schema.id, expectedVersion: 0,
          payload: indexPayloadValue({ kind: "schema", state: "pending", collection_id: schema.id, file_path: filePath, operation_id: context.operationId, schema }), searchText: schemaText(schema)
        });
      try {
        const file = await ensureCollectionFile(this.files, context, roomId, filePath, Buffer.from(renderCollectionMarkdown("schema", schema)), 0, "schema");
        const finalized = await this.commands.putRecord(indexContext(context, "schema-finalize"), {
          roomId, recordType: schemaRecordType, id: schema.id, expectedVersion: pending.record.version,
          payload: indexPayloadValue({ kind: "schema", state: "ready", collection_id: schema.id, file_path: filePath, file_version: file.file.version, operation_id: context.operationId, schema }), searchText: schemaText(schema)
        });
        return { ...schema, file_path: filePath, resource_version: finalized.record.version, room_id: roomId, replayed: pending.replayed };
      } catch (error) {
        await this.markBlocked(context, roomId, schemaRecordType, schema.id, pending.record.version, `schema_create:${errorCode(error)}`);
        throw error;
      }
    }
    const readyPayload = currentPayload!;
    await this.readSchema(context, roomId, readyPayload);
    const requiredVersion = expectedVersion ?? current.version;
    if (requiredVersion !== current.version) throw new WorkspaceServerError("collection_schema_version_conflict", 409, { latest_version: current.version });
    const oldFile = await this.files.read(context, { roomId, path: readyPayload.file_path });
    const nextFile = await this.files.write(fileContext(context, "schema-file"), { roomId, path: readyPayload.file_path, content: Buffer.from(renderCollectionMarkdown("schema", schema)), expectedVersion: oldFile.file.version });
    try {
      const updated = await this.commands.putRecord(indexContext(context, "schema-index"), {
        roomId, recordType: schemaRecordType, id: schema.id, expectedVersion: current.version,
        payload: indexPayloadValue({ kind: "schema", state: "ready", collection_id: schema.id, file_path: readyPayload.file_path, file_version: nextFile.file.version, operation_id: context.operationId, schema }), searchText: schemaText(schema)
      });
      return { ...schema, file_path: readyPayload.file_path, resource_version: updated.record.version, room_id: roomId, replayed: false };
    } catch (error) {
      try {
        await this.files.write(fileContext(context, "schema-rollback"), { roomId, path: readyPayload.file_path, content: oldFile.content, expectedVersion: nextFile.file.version });
      } catch (rollbackError) {
        let blockedError: unknown;
        try {
          await this.markBlocked(context, roomId, schemaRecordType, schema.id, current.version, `schema_rollback:${errorCode(rollbackError)}`);
        } catch (stateError) {
          blockedError = stateError;
        }
        throw new WorkspaceServerError("collection_schema_recovery_required", 503, {
          collection_id: schema.id,
          cause: errorCode(error),
          ...(blockedError ? { recovery_state_error: errorCode(blockedError) } : {})
        });
      }
      throw error;
    }
  }

  async listRecords(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, collectionId: string): Promise<PostgresCollectionRecord[]> {
    const schema = await this.getSchema(context, roomId, collectionId);
    const rows = await this.commands.listRecords(context, { roomId, recordType: recordRecordType, limit: 500 });
    const result: PostgresCollectionRecord[] = [];
    for (const row of rows) {
      const payload = indexPayload(row, "record");
      if (payload.state !== "ready" || payload.collection_id !== collectionId) continue;
      result.push(await this.readRecord(context, roomId, payload, schema));
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  /**
   * Patch history is a first-class PostgreSQL record.  The old local store
   * exposed it through a separate legacy table; keeping the read model here
   * ensures clients can inspect history without reopening that store.
   */
  async listPatches(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    collectionId: string,
    recordId?: string
  ): Promise<CollectionPatch[]> {
    const rows = await this.commands.listRecords(context, { roomId, recordType: patchRecordType, limit: 2_000 });
    return rows
      .map((row) => row.payload as Partial<CollectionIndexPayload>)
      .filter((payload): payload is CollectionIndexPayload & { patch: CollectionPatch } =>
        payload.kind === "patch"
        && payload.state === "ready"
        && payload.collection_id === collectionId
        && Boolean(payload.patch && typeof payload.patch.id === "string" && typeof payload.patch.record_id === "string")
        && (recordId === undefined || payload.patch!.record_id === recordId)
      )
      .map((payload) => payload.patch)
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  }

  async getPatch(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    collectionId: string,
    recordId: string,
    patchId: string
  ): Promise<CollectionPatch | undefined> {
    const row = await this.tryGetIndex(context, roomId, patchRecordType, compoundId(collectionId, `${recordId}-${patchId}`));
    if (!row) return undefined;
    const payload = row.payload as Partial<CollectionIndexPayload>;
    if (payload.kind !== "patch" || payload.state !== "ready" || payload.collection_id !== collectionId || payload.patch?.record_id !== recordId || payload.patch?.id !== patchId) {
      return undefined;
    }
    return payload.patch;
  }

  async resolveRecordRefs(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    collectionId: string,
    recordId: string
  ): Promise<PostgresCollectionRecordResolution> {
    const [schema, record] = await Promise.all([
      this.getSchema(context, roomId, collectionId),
      this.getRecord(context, roomId, collectionId, recordId)
    ]);
    const resolvedRefs: PostgresCollectionRecordResolution["resolved_refs"] = [];
    const missingRefs: PostgresCollectionRecordResolution["missing_refs"] = [];
    const embedFields: PostgresCollectionRecordResolution["embed_fields"] = [];
    for (const ref of schema.refs) {
      const field = collectionDefinitionField(ref);
      if (!field) continue;
      const refId = collectionDefinitionString(ref, "id") ?? collectionDefinitionString(ref, "field") ?? field;
      const targetCollection = collectionDefinitionString(ref, "collection_id")
        ?? collectionDefinitionString(ref, "target_collection_id")
        ?? record.collection_id;
      const value = record.data[field];
      if (value === undefined || value === null || value === "") {
        missingRefs.push({ ref_id: refId, field, target_collection_id: targetCollection, reason: "empty" });
        continue;
      }
      const targetId = collectionRefTargetId(value);
      if (!targetId) {
        missingRefs.push({ ref_id: refId, field, target_collection_id: targetCollection, reason: "invalid" });
        continue;
      }
      try {
        const target = await this.getRecord(context, roomId, targetCollection, targetId);
        resolvedRefs.push({
          ref_id: refId,
          field,
          target_collection_id: targetCollection,
          target_record_id: target.id,
          record: target,
          resource_ref: { kind: "collection_record", id: collectionRecordResourceId(target.collection_id, target.id), uri: target.file_path, label: `${target.collection_id}/${target.id}` }
        });
      } catch (error) {
        if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
        missingRefs.push({ ref_id: refId, field, target_collection_id: targetCollection, target_record_id: targetId, reason: "not_found" });
      }
    }
    for (const embed of schema.embeds) {
      const field = collectionDefinitionField(embed);
      if (!field || !(field in record.data)) continue;
      embedFields.push({ embed_id: collectionDefinitionString(embed, "id") ?? field, field, value: record.data[field] ?? null });
    }
    return { collection_id: record.collection_id, record_id: record.id, resolved_refs: resolvedRefs, missing_refs: missingRefs, embed_fields: embedFields };
  }

  async getRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, collectionId: string, recordId: string): Promise<PostgresCollectionRecord> {
    const schema = await this.getSchema(context, roomId, collectionId);
    const row = await this.getIndex(context, roomId, recordRecordType, compoundId(collectionId, recordId));
    const payload = indexPayload(row, "record");
    if (payload.state === "deleted") throw new WorkspaceServerError("collection_not_found", 404);
    if (payload.state !== "ready") throw new WorkspaceServerError("collection_recovery_required", 503);
    return this.readRecord(context, roomId, payload, schema);
  }

  async createRecord(context: WorkspaceRequestContext, roomId: string, recordInput: CollectionRecord): Promise<PostgresCollectionRecordMutation> {
    const schema = await this.getSchema(context, roomId, recordInput.collection_id);
    const record = parseRecordSafe(recordInput, schema);
    assertRecordId(record.id);
    const id = compoundId(record.collection_id, record.id);
    const filePath = `collections/${record.collection_id}/records/${record.id}.md`;
    const triggers = collectionTriggersFor(schema, "record.created");
    const existing = await this.tryGetIndex(context, roomId, recordRecordType, id);
    if (existing) {
      const existingPayload = indexPayload(existing, "record");
      if (existingPayload.operation_id === context.operationId && existingPayload.state === "ready") {
        return { ...(await this.readRecord(context, roomId, existingPayload, schema)), replayed: true };
      }
      if (existingPayload.state === "deleted") throw new WorkspaceServerError("collection_record_exists", 409);
      if (existingPayload.record && JSON.stringify(existingPayload.record) !== JSON.stringify(record)) {
        throw new WorkspaceServerError("collection_record_operation_conflict", 409);
      }
      if (
        existingPayload.state === "blocked"
        && existingPayload.operation_id === context.operationId
        && existingPayload.error?.startsWith("trigger_enqueue:")
        && existingPayload.record
      ) {
        const resumed = await this.resumeBlockedTrigger(context, roomId, existing, existingPayload, triggers, { record: existingPayload.record });
        return { ...resumed, replayed: true };
      }
      if (existingPayload.state !== "pending" || existingPayload.operation_id !== context.operationId) {
        throw new WorkspaceServerError(existingPayload.state === "blocked" ? "collection_recovery_required" : "collection_record_exists", existingPayload.state === "blocked" ? 503 : 409);
      }
    }
    assertPostgresCollectionTriggerDeliverySupported(schema, "record.created", this.triggerEnqueuer);
    const pending = existing
      ? { record: existing, replayed: true }
      : await this.commands.putRecord(indexContext(context, "record-prepare"), {
        roomId, recordType: recordRecordType, id, expectedVersion: 0,
        payload: indexPayloadValue({ kind: "record", state: "pending", collection_id: record.collection_id, file_path: filePath, operation_id: context.operationId, record }), searchText: recordText(record)
      });
    try {
      const file = await ensureCollectionFile(this.files, context, roomId, filePath, Buffer.from(renderCollectionMarkdown("record", record)), 0, "record");
      const finalized = await this.commands.putRecord(indexContext(context, "record-finalize"), {
        roomId, recordType: recordRecordType, id, expectedVersion: pending.record.version,
        payload: indexPayloadValue({ kind: "record", state: "ready", collection_id: record.collection_id, file_path: filePath, file_version: file.file.version, operation_id: context.operationId, record }), searchText: recordText(record)
      });
      try {
        await this.enqueueCollectionTriggers(context, roomId, triggers, { record });
      } catch (error) {
        await this.markBlocked(context, roomId, recordRecordType, id, finalized.record.version, `trigger_enqueue:${errorCode(error)}`);
        throw new WorkspaceServerError("collection_trigger_enqueue_failed", 503, { collection_id: record.collection_id, record_id: record.id });
      }
      return { ...record, file_path: filePath, version: record.version ?? 1, replayed: pending.replayed };
    } catch (error) {
      await this.markBlocked(context, roomId, recordRecordType, id, pending.record.version, `record_create:${errorCode(error)}`);
      throw error;
    }
  }

  async applyPatch(context: WorkspaceRequestContext, roomId: string, collectionId: string, recordId: string, patchInput: Omit<CollectionPatch, "id" | "record_id" | "source_operation_id" | "created_at"> & { id?: string; created_at?: string }): Promise<PostgresCollectionRecordMutation> {
    const schema = await this.getSchema(context, roomId, collectionId);
    const patchId = patchInput.id ?? deterministicPatchId(context.operationId);
    const patchIndexId = compoundId(collectionId, `${recordId}-${patchId}`);
    const triggers = collectionTriggersFor(schema, "record.patched");
    const previousPatch = await this.tryGetIndex(context, roomId, patchRecordType, patchIndexId);
    if (previousPatch) {
      const previousPayload = indexPayload(previousPatch, "patch");
      if (previousPayload.state === "blocked") throw new WorkspaceServerError("collection_patch_history_blocked", 503, { record_id: recordId });
      if (previousPayload.state !== "ready" || previousPayload.patch?.source_operation_id !== context.operationId) {
        throw new WorkspaceServerError("collection_patch_operation_conflict", 409, { record_id: recordId });
      }
      const current = await this.tryGetIndex(context, roomId, recordRecordType, compoundId(collectionId, recordId));
      const currentPayload = current ? indexPayload(current, "record") : undefined;
      if (
        current
        && currentPayload?.state === "blocked"
        && currentPayload.operation_id === context.operationId
        && currentPayload.error?.startsWith("trigger_enqueue:")
        && currentPayload.record
        && previousPayload.patch
      ) {
        const resumed = await this.resumeBlockedTrigger(context, roomId, current, currentPayload, triggers, {
          record: currentPayload.record,
          patch: previousPayload.patch
        });
        return { ...resumed, replayed: true };
      }
      return { ...(await this.getRecord(context, roomId, collectionId, recordId)), replayed: true };
    }
    assertPostgresCollectionTriggerDeliverySupported(schema, "record.patched", this.triggerEnqueuer);
    const before = await this.getRecord(context, roomId, collectionId, recordId);
    const patch: CollectionPatch = {
      id: patchId, record_id: recordId, changes: patchInput.changes,
      expected_version: patchInput.expected_version ?? before.version,
      source_operation_id: context.operationId, created_at: patchInput.created_at ?? deterministicPatchTimestamp(context.operationId)
    };
    let after: CollectionRecord;
    try { after = applyCollectionPatch(before, patch, schema); } catch (error) { throw new WorkspaceServerError(errorCode(error), 422); }
    const current = await this.getIndex(context, roomId, recordRecordType, compoundId(collectionId, recordId));
    const payload = indexPayload(current, "record");
    if (patch.expected_version !== before.version) throw new WorkspaceServerError("collection_record_version_conflict", 409, { latest_version: before.version });
    const oldFile = await this.files.read(context, { roomId, path: payload.file_path });
    const nextFile = await this.files.write(fileContext(context, "record-file"), { roomId, path: payload.file_path, content: Buffer.from(renderCollectionMarkdown("record", after)), expectedVersion: oldFile.file.version });
    let indexed: Awaited<ReturnType<WorkspaceServerCommandService["putRecord"]>> | undefined;
    try {
      indexed = await this.commands.putRecord(indexContext(context, "record-index"), {
        roomId, recordType: recordRecordType, id: current.id, expectedVersion: current.version,
        payload: indexPayloadValue({ kind: "record", state: "ready", collection_id: collectionId, file_path: payload.file_path, file_version: nextFile.file.version, operation_id: context.operationId, record: after }), searchText: recordText(after)
      });
      try {
        await this.commands.putRecord(indexContext(context, `patch-${patch.id}`), {
          roomId, recordType: patchRecordType, id: patchIndexId, expectedVersion: 0,
          payload: indexPayloadValue({ kind: "patch", state: "ready", collection_id: collectionId, file_path: payload.file_path, patch }), searchText: JSON.stringify(patch.changes)
        });
      } catch (error) {
        // The record and file are already durable. Do not roll them back
        // while silently losing the patch history; expose a blocked index so
        // the recovery worker can surface and repair the exact inconsistency.
        await this.markBlocked(context, roomId, recordRecordType, current.id, indexed.record.version, `patch_history:${errorCode(error)}`, {
          kind: "patch_history",
          patch_index_id: patchIndexId,
          patch
        });
        throw new WorkspaceServerError("collection_patch_history_blocked", 503, { record_id: recordId });
      }
      try {
        await this.enqueueCollectionTriggers(context, roomId, triggers, { record: after, patch });
      } catch (error) {
        await this.markBlocked(context, roomId, recordRecordType, current.id, indexed.record.version, `trigger_enqueue:${errorCode(error)}`);
        throw new WorkspaceServerError("collection_trigger_enqueue_failed", 503, { collection_id: collectionId, record_id: recordId });
      }
      return { ...after, file_path: payload.file_path, replayed: false };
    } catch (error) {
      if (!indexed) {
        try {
          await this.files.write(fileContext(context, "record-rollback"), { roomId, path: payload.file_path, content: oldFile.content, expectedVersion: nextFile.file.version });
        } catch (rollbackError) {
          await this.markBlocked(context, roomId, recordRecordType, current.id, current.version, `record_rollback:${errorCode(rollbackError)}`);
          throw new WorkspaceServerError("collection_record_recovery_required", 503, { record_id: recordId, cause: errorCode(error) });
        }
      }
      throw error;
    }
  }

  async deleteRecord(context: WorkspaceRequestContext, roomId: string, collectionId: string, recordId: string, expectedVersion: number): Promise<PostgresCollectionRecordMutation> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new WorkspaceServerError("collection_record_expected_version_required", 400);
    const index = await this.getIndex(context, roomId, recordRecordType, compoundId(collectionId, recordId));
    const payload = indexPayload(index, "record");
    if (payload.state === "deleted") {
      if (!payload.record) throw new WorkspaceServerError("collection_index_invalid", 503);
      return { ...payload.record, file_path: payload.file_path, replayed: true };
    }
    if (payload.state === "blocked") throw new WorkspaceServerError("collection_recovery_required", 503);
    if (payload.state === "deleting" && payload.operation_id !== context.operationId) throw new WorkspaceServerError("collection_recovery_required", 503);
    const current = payload.state === "deleting" && payload.record
      ? payload.record
      : await this.getRecord(context, roomId, collectionId, recordId);
    if (expectedVersion !== undefined && expectedVersion !== current.version) throw new WorkspaceServerError("collection_record_version_conflict", 409, { latest_version: current.version });
    const pending = payload.state === "deleting"
      ? { record: index, replayed: true }
      : await this.commands.putRecord(indexContext(context, "record-delete-prepare"), {
        roomId, recordType: recordRecordType, id: index.id, expectedVersion: index.version,
        payload: indexPayloadValue({ ...payload, state: "deleting", operation_id: context.operationId, record: current }), searchText: recordText(current)
      });
    let fileDeleteCommitted = false;
    try {
      await this.files.remove(fileContext(context, "record-delete-file"), { roomId, path: payload.file_path, expectedVersion: payload.file_version ?? 1 });
      fileDeleteCommitted = true;
      await this.commands.putRecord(indexContext(context, "record-delete-index"), {
        roomId, recordType: recordRecordType, id: index.id, expectedVersion: pending.record.version,
        payload: indexPayloadValue({ ...payload, state: "deleted", operation_id: context.operationId, record: current }), searchText: recordText(current)
      });
      return { ...current, file_path: payload.file_path, replayed: pending.replayed };
    } catch (error) {
      const fileDeleteNeedsRecovery = error instanceof WorkspaceServerError
        && (error.code === "workspace_file_delete_recovery_required" || error.code === "workspace_file_transaction_finalize_failed");
      if (fileDeleteCommitted || fileDeleteNeedsRecovery) {
        await this.markBlocked(context, roomId, recordRecordType, index.id, pending.record.version, `record_delete:${errorCode(error)}`);
      } else {
        await this.commands.putRecord(indexContext(context, "record-delete-rollback"), { roomId, recordType: recordRecordType, id: index.id, expectedVersion: pending.record.version, payload: indexPayloadValue({ ...payload, state: "ready" }), searchText: recordText(current) });
      }
      throw error;
    }
  }

  async listNotes(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, collectionId: string): Promise<Array<{ collection_id: string; file_path: string; content: string; role: "context_only" }>> {
    // Notes are explicitly indexed as context-only generic records. No note
    // content is synthesized from Collection records.
    const rows = await this.commands.listRecords(context, { roomId, recordType: "collection_note", limit: 500 });
    return rows.flatMap((row) => {
      const payload = row.payload as Record<string, unknown>;
      return payload.collection_id === collectionId && typeof payload.file_path === "string" && typeof payload.content === "string"
        ? [{ collection_id: collectionId, file_path: payload.file_path, content: payload.content, role: "context_only" as const }]
        : [];
    });
  }

  async presentView(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, collectionId: string, viewId?: string): Promise<{ schema: PostgresCollectionSchema; records: PostgresCollectionRecord[]; render_spec: SurfaceRenderSpec }> {
    const schema = await this.getSchema(context, roomId, collectionId);
    const records = await this.listRecords(context, roomId, collectionId);
    return { schema, records, render_spec: collectionRenderSpec(schema, records, viewId) };
  }

  /** Executes only declarative Collection actions that have a concrete local
   * Domain Operation. Provider/custom-instruction actions remain blocked with
   * a reason instead of being reported as a successful no-op. */
  async runAction(context: WorkspaceRequestContext, roomId: string, operation: Extract<SurfaceOperation, { kind: "collection.action.run" }>): Promise<{ result: unknown; presented: Awaited<ReturnType<PostgresCollection["presentView"]>> }> {
    await this.commands.assertRoomExecutable(context, roomId);
    const schema = await this.getSchema(context, roomId, operation.collection_id);
    const action = schema.actions.find((candidate) => jsonString(candidate, "id") === operation.action_id || jsonString(candidate, "action_id") === operation.action_id);
    if (!action) throw new WorkspaceServerError("collection_action_not_found", 404, { action_id: operation.action_id });
    const actionKind = jsonString(action, "kind") ?? jsonString(action, "type") ?? "custom_instruction";
    const payload = jsonObject(operation.payload);
    if (["refresh", "view", "present"].includes(actionKind)) {
      const presented = await this.presentView(context, roomId, operation.collection_id, operation.view_id);
      return { result: { action_id: operation.action_id, status: "completed" }, presented };
    }
    if (["patch", "patch_record"].includes(actionKind)) {
      if (!operation.record_id) throw new WorkspaceServerError("collection_action_record_required", 400);
      const changes = jsonObject(payload?.changes);
      if (!changes) throw new WorkspaceServerError("collection_action_changes_required", 400);
      const record = await this.applyPatch(context, roomId, operation.collection_id, operation.record_id, {
        id: `action_${operation.id}`,
        changes,
        ...(typeof payload?.expected_version === "number" ? { expected_version: payload.expected_version } : {})
      });
      const presented = await this.presentView(context, roomId, operation.collection_id, operation.view_id);
      const { replayed: _replayed, ...resource } = record;
      return { result: { action_id: operation.action_id, record: resource }, presented };
    }
    if (["delete", "delete_record"].includes(actionKind)) {
      if (!operation.record_id) throw new WorkspaceServerError("collection_action_record_required", 400);
      if (typeof payload?.expected_version !== "number") throw new WorkspaceServerError("collection_record_expected_version_required", 400);
      const record = await this.deleteRecord(context, roomId, operation.collection_id, operation.record_id, payload.expected_version);
      const presented = await this.presentView(context, roomId, operation.collection_id, operation.view_id);
      const { replayed: _replayed, ...resource } = record;
      return { result: { action_id: operation.action_id, record: resource }, presented };
    }
    if (["create", "create_record"].includes(actionKind)) {
      const data = jsonObject(payload?.data);
      if (!data) throw new WorkspaceServerError("collection_action_data_required", 400);
      const record = await this.createRecord(context, roomId, {
        id: operation.record_id ?? `record_${operation.id}`,
        collection_id: operation.collection_id,
        data,
        resource_refs: [],
        created_at: nowIso(),
        updated_at: nowIso()
      });
      const presented = await this.presentView(context, roomId, operation.collection_id, operation.view_id);
      const { replayed: _replayed, ...resource } = record;
      return { result: { action_id: operation.action_id, record: resource }, presented };
    }
    throw new WorkspaceServerError("collection_action_blocked", 409, { action_id: operation.action_id, action_kind: actionKind });
  }

  async reindex(context: WorkspaceRequestContext, roomId: string): Promise<{ schemas: { files: number; indexed: number; errors: Array<{ file_path: string; message: string }> }; records: { files: number; indexed: number; errors: Array<{ file_path: string; message: string }> } }> {
    const schemaRows = await this.commands.listRecords(context, { roomId, recordType: schemaRecordType, limit: 500 });
    const recordRows = await this.commands.listRecords(context, { roomId, recordType: recordRecordType, limit: 500 });
    const schemas = { files: 0, indexed: 0, errors: [] as Array<{ file_path: string; message: string }> };
    const records = { files: 0, indexed: 0, errors: [] as Array<{ file_path: string; message: string }> };
    for (const row of schemaRows) {
      const payload = row.payload as Record<string, unknown>;
      if (payload.state === "deleting") {
        try { await this.commands.deleteRecord(indexContext(context, "schema-reindex-delete"), { roomId, recordType: schemaRecordType, id: row.id, expectedVersion: row.version }); }
        catch (error) { schemas.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: `deleting:${errorCode(error)}` }); }
        continue;
      }
      if (payload.state === "blocked") { schemas.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: "collection_recovery_required" }); continue; }
      if (typeof payload.file_path !== "string") continue;
      try {
        const file = await this.files.read(context, { roomId, path: payload.file_path });
        schemas.files++;
        const schema = parseCollectionSchemaSafe(parseCollectionMarkdown(file.content.toString("utf8"), "schema"));
        if (payload.state === "pending" || payload.file_version !== file.file.version || JSON.stringify(payload.schema) !== JSON.stringify(schema)) {
        await this.commands.putRecord(indexContext(context, `schema-reindex-${row.id}`), {
            roomId, recordType: schemaRecordType, id: row.id, expectedVersion: row.version,
            payload: indexPayloadValue({ kind: "schema", state: "ready", collection_id: schema.id, file_path: payload.file_path, file_version: file.file.version, schema }),
            searchText: schemaText(schema)
          });
        }
        schemas.indexed++;
      } catch (error) {
        if (payload.state === "pending") await this.markBlocked(context, roomId, schemaRecordType, row.id, row.version, `schema_reindex:${errorCode(error)}`);
        schemas.errors.push({ file_path: payload.file_path, message: errorCode(error) });
      }
    }
    for (const row of recordRows) {
      const payload = row.payload as unknown as CollectionIndexPayload;
      if (payload.state === "deleting") {
        try {
          await this.files.read(context, { roomId, path: String(payload.file_path) });
          records.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: "deleting:workspace_file_delete_pending" });
        } catch (error) {
          const deletingRecord = payload.record as CollectionRecord | undefined;
          if (error instanceof WorkspaceServerError && error.status === 404 && deletingRecord && payload.collection_id === deletingRecord.collection_id) {
            await this.commands.putRecord(indexContext(context, `record-reindex-delete-${row.id}`), {
              roomId, recordType: recordRecordType, id: row.id, expectedVersion: row.version,
              payload: indexPayloadValue({ ...(payload as unknown as CollectionIndexPayload), state: "deleted", record: deletingRecord }),
              searchText: recordText(deletingRecord)
            });
          } else {
            records.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: `deleting:${errorCode(error)}` });
          }
        }
        continue;
      }
      if (payload.state === "deleted") continue;
      if (payload.state === "blocked") {
        try {
          const repaired = await this.repairBlockedPatchHistory(context, roomId, row, payload);
          if (repaired) {
            records.files++;
            records.indexed++;
            continue;
          }
        } catch (error) {
          records.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: errorCode(error) });
          continue;
        }
        records.errors.push({ file_path: typeof payload.file_path === "string" ? payload.file_path : row.id, message: "collection_recovery_required" });
        continue;
      }
      if (typeof payload.file_path !== "string") continue;
      try {
        const file = await this.files.read(context, { roomId, path: payload.file_path });
        records.files++;
        const schema = await this.getSchema(context, roomId, String(payload.collection_id));
        const record = parseRecordSafe(parseCollectionMarkdown(file.content.toString("utf8"), "record"), schema);
        if (payload.state === "pending" || payload.file_version !== file.file.version || JSON.stringify(payload.record) !== JSON.stringify(record)) {
        await this.commands.putRecord(indexContext(context, `record-reindex-${row.id}`), {
            roomId, recordType: recordRecordType, id: row.id, expectedVersion: row.version,
            payload: indexPayloadValue({ kind: "record", state: "ready", collection_id: record.collection_id, file_path: payload.file_path, file_version: file.file.version, record }),
            searchText: recordText(record)
          });
        }
        records.indexed++;
      } catch (error) {
        if (payload.state === "pending") await this.markBlocked(context, roomId, recordRecordType, row.id, row.version, `record_reindex:${errorCode(error)}`);
        records.errors.push({ file_path: payload.file_path, message: errorCode(error) });
      }
    }
    return { schemas, records };
  }

  private async readSchema(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, payload: CollectionIndexPayload): Promise<CollectionSchema> {
    try {
      const file = await this.files.read(context, { roomId, path: payload.file_path });
      return parseCollectionSchemaSafe(parseCollectionMarkdown(file.content.toString("utf8"), "schema"));
    } catch (error) { throw new WorkspaceServerError(`collection_schema_file_invalid:${errorCode(error)}`, 503); }
  }

  private async readRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, payload: CollectionIndexPayload, schema: CollectionSchema): Promise<PostgresCollectionRecord> {
    try {
      const file = await this.files.read(context, { roomId, path: payload.file_path });
      return { ...parseRecordSafe(parseCollectionMarkdown(file.content.toString("utf8"), "record"), schema), file_path: payload.file_path };
    } catch (error) { throw new WorkspaceServerError(`collection_record_file_invalid:${errorCode(error)}`, 503); }
  }

  private async getIndex(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, recordType: string, id: string): Promise<WorkspaceRecord> {
    try { return await this.commands.getRecord(context, { roomId, recordType, id }); }
    catch (error) { if (error instanceof WorkspaceServerError && error.status === 404) throw new WorkspaceServerError("collection_not_found", 404); throw error; }
  }

  private async tryGetIndex(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, recordType: string, id: string): Promise<WorkspaceRecord | undefined> {
    try { return await this.commands.getRecord(context, { roomId, recordType, id }); }
    catch (error) { if (error instanceof WorkspaceServerError && error.status === 404) return undefined; throw error; }
  }

  private async repairBlockedPatchHistory(context: WorkspaceRequestContext, roomId: string, row: WorkspaceRecord, payload: CollectionIndexPayload): Promise<boolean> {
    const recovery = payload.recovery;
    if (payload.kind !== "record" || recovery?.kind !== "patch_history" || !payload.record || !payload.operation_id) return false;
    const schema = await this.getSchema(context, roomId, payload.collection_id);
    const file = await this.files.read(context, { roomId, path: payload.file_path });
    const record = parseRecordSafe(parseCollectionMarkdown(file.content.toString("utf8"), "record"), schema);
    if (JSON.stringify(record) !== JSON.stringify(payload.record)) throw new WorkspaceServerError("collection_patch_recovery_file_changed", 503, { record_id: record.id });
    if (payload.file_version !== undefined && payload.file_version !== file.file.version) throw new WorkspaceServerError("collection_patch_recovery_file_version_changed", 503, { record_id: record.id });
    const patch = recovery.patch;
    if (patch.record_id !== record.id || patch.source_operation_id !== payload.operation_id || typeof patch.id !== "string") {
      throw new WorkspaceServerError("collection_patch_recovery_invalid", 503, { record_id: record.id });
    }
    try { applyCollectionPatch(record, patch, schema); } catch (error) { throw new WorkspaceServerError(`collection_patch_recovery_invalid:${errorCode(error)}`, 503, { record_id: record.id }); }
    const existingPatch = await this.tryGetIndex(context, roomId, patchRecordType, recovery.patch_index_id);
    if (existingPatch) {
      const existingPayload = indexPayload(existingPatch, "patch");
      if (existingPayload.state !== "ready" || JSON.stringify(existingPayload.patch) !== JSON.stringify(patch)) {
        throw new WorkspaceServerError("collection_patch_recovery_conflict", 503, { record_id: record.id });
      }
    } else {
      await this.commands.putRecord(indexContext(context, "patch-history-repair"), {
        roomId,
        recordType: patchRecordType,
        id: recovery.patch_index_id,
        expectedVersion: 0,
        payload: indexPayloadValue({ kind: "patch", state: "ready", collection_id: payload.collection_id, file_path: payload.file_path, patch }),
        searchText: JSON.stringify(patch.changes)
      });
    }
    const current = await this.tryGetIndex(context, roomId, recordRecordType, row.id);
    if (!current || current.version !== row.version) throw new WorkspaceServerError("collection_patch_recovery_conflict", 503, { record_id: record.id });
    const { error: _error, recovery: _recovery, ...withoutRecovery } = payload;
    await this.commands.putRecord(indexContext(context, "patch-history-unblock"), {
      roomId,
      recordType: recordRecordType,
      id: row.id,
      expectedVersion: row.version,
      payload: indexPayloadValue({ ...(withoutRecovery as unknown as CollectionIndexPayload), state: "ready", file_version: file.file.version, record }),
      searchText: recordText(record)
    });
    return true;
  }

  private async enqueueCollectionTriggers(
    context: WorkspaceRequestContext,
    roomId: string,
    triggers: Array<Record<string, JsonValue>>,
    input: { record: CollectionRecord; patch?: CollectionPatch }
  ): Promise<void> {
    if (triggers.length === 0) return;
    if (!this.triggerEnqueuer) throw new WorkspaceServerError("collection_trigger_delivery_not_supported", 503);
    const event = input.patch ? "record.patched" : "record.created";
    for (const trigger of triggers) {
      await this.triggerEnqueuer.enqueue(context, {
        roomId,
        collectionId: input.record.collection_id,
        recordId: input.record.id,
        event,
        record: input.record,
        ...(input.patch ? { patch: input.patch } : {}),
        trigger
      });
    }
  }

  private async resumeBlockedTrigger(
    context: WorkspaceRequestContext,
    roomId: string,
    row: WorkspaceRecord,
    payload: CollectionIndexPayload,
    triggers: Array<Record<string, JsonValue>>,
    input: { record: CollectionRecord; patch?: CollectionPatch }
  ): Promise<PostgresCollectionRecord> {
    try {
      await this.enqueueCollectionTriggers(context, roomId, triggers, input);
    } catch (error) {
      throw new WorkspaceServerError("collection_trigger_enqueue_failed", 503, {
        collection_id: input.record.collection_id,
        record_id: input.record.id,
        cause: errorCode(error)
      });
    }
    const current = await this.tryGetIndex(context, roomId, recordRecordType, row.id);
    if (!current || current.version !== row.version) {
      throw new WorkspaceServerError("collection_trigger_recovery_conflict", 503, { record_id: input.record.id });
    }
    const currentPayload = indexPayload(current, "record");
    const { error: _error, recovery: _recovery, ...withoutRecovery } = currentPayload;
    await this.commands.putRecord(indexContext(context, "trigger-unblock"), {
      roomId,
      recordType: recordRecordType,
      id: row.id,
      expectedVersion: row.version,
      payload: indexPayloadValue({ ...(withoutRecovery as CollectionIndexPayload), state: "ready" }),
      searchText: recordText(input.record)
    });
    return { ...input.record, file_path: payload.file_path };
  }

  private async markBlocked(context: WorkspaceRequestContext, roomId: string, recordType: string, id: string, expectedVersion: number, error: string, recovery?: CollectionIndexPayload["recovery"]): Promise<void> {
    const current = await this.tryGetIndex(context, roomId, recordType, id);
    if (!current || current.version !== expectedVersion) return;
    const payload = current.payload as Record<string, unknown>;
    const { recovery: _previousRecovery, ...withoutRecovery } = payload;
    await this.commands.putRecord(indexContext(context, "mark-blocked"), {
      roomId,
      recordType,
      id,
      expectedVersion,
      payload: indexPayloadValue({ ...(withoutRecovery as unknown as CollectionIndexPayload), state: "blocked", error, ...(recovery ? { recovery } : {}) }),
      searchText: JSON.stringify(payload)
    });
  }
}

function parseCollectionSchemaSafe(value: unknown): CollectionSchema {
  try { return parseCollectionSchema(value); } catch (error) { throw new WorkspaceServerError(`collection_schema_invalid:${errorCode(error)}`, 422); }
}

function parseRecordSafe(value: unknown, schema: CollectionSchema): CollectionRecord {
  try { return parseCollectionRecord(value, schema); } catch (error) { throw new WorkspaceServerError(`collection_record_invalid:${errorCode(error)}`, 422); }
}

/**
 * PostgreSQL does not yet have the legacy file-transaction + durable job
 * commit. Reject before any record/file write instead of silently persisting
 * a Collection mutation whose enabled trigger cannot be delivered.
 */
export function assertPostgresCollectionTriggerDeliverySupported(
  schema: CollectionSchema,
  event: "record.created" | "record.patched",
  triggerEnqueuer?: PostgresCollectionTriggerEnqueuer
): void {
  if (collectionTriggersFor(schema, event).length > 0 && !triggerEnqueuer) {
    throw new WorkspaceServerError("collection_trigger_delivery_not_supported", 503, {
      collection_id: schema.id,
      event
    });
  }
}

function collectionTriggersFor(schema: CollectionSchema, event: "record.created" | "record.patched"): Array<Record<string, JsonValue>> {
  return schema.triggers.filter((trigger) => {
    if (trigger.enabled === false) return false;
    const triggerEvent = jsonString(trigger, "event") ?? jsonString(trigger, "on");
    return !triggerEvent || triggerEvent === event;
  });
}

function indexPayload(row: WorkspaceRecord, kind: CollectionIndexPayload["kind"]): CollectionIndexPayload {
  const payload = row.payload as Partial<CollectionIndexPayload>;
  const states: CollectionIndexPayload["state"][] = ["pending", "ready", "deleting", "deleted", "blocked"];
  if (payload.kind !== kind || typeof payload.collection_id !== "string" || typeof payload.file_path !== "string" || !states.includes(payload.state as CollectionIndexPayload["state"])) {
    throw new WorkspaceServerError("collection_index_invalid", 503);
  }
  return payload as unknown as CollectionIndexPayload;
}

function indexPayloadValue(payload: CollectionIndexPayload): Record<string, unknown> { return payload as unknown as Record<string, unknown>; }

function schemaText(schema: CollectionSchema): string { return `${schema.id} ${JSON.stringify(schema.labels)} ${JSON.stringify(schema.descriptions)} ${JSON.stringify(schema.fields)}`; }
function recordText(record: CollectionRecord): string { return `${record.collection_id} ${record.id} ${JSON.stringify(record.data)}`; }

function jsonString(value: Record<string, JsonValue>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] as string : undefined;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
}

function collectionDefinitionField(definition: Record<string, JsonValue>): string | undefined {
  const value = definition.field ?? definition.field_id ?? definition.id ?? definition.name;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectionDefinitionString(definition: Record<string, JsonValue>, key: string): string | undefined {
  const value = definition[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function collectionRefTargetId(value: JsonValue): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, JsonValue>;
  for (const key of ["id", "record_id", "target_id", "value"]) {
    const candidate = object[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function assertCollectionId(value: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new WorkspaceServerError("collection_id_invalid", 400);
}

function assertRecordId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new WorkspaceServerError("collection_record_id_invalid", 400);
}

function compoundId(collectionId: string, recordId: string): string {
  assertCollectionId(collectionId); assertRecordId(recordId);
  const value = `${collectionId}:${recordId}`;
  if (value.length > 128) throw new WorkspaceServerError("collection_record_id_invalid", 400);
  return value;
}

function indexContext(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  return { ...context, operationId: childOperationId(context.operationId, suffix), caller: undefined };
}

function fileContext(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  return { ...context, operationId: childOperationId(context.operationId, suffix), caller: undefined };
}

function childOperationId(parent: string, suffix: string): string {
  return `collection_${createHash("sha256").update(`${parent}:${suffix}`).digest("hex").slice(0, 48)}`;
}

function deterministicPatchId(operationId: string): string {
  return `collection_patch_${createHash("sha256").update(operationId).digest("hex").slice(0, 32)}`;
}

function deterministicPatchTimestamp(operationId: string): string {
  const digest = createHash("sha256").update(`collection_patch_time:${operationId}`).digest("hex");
  const milliseconds = Number.parseInt(digest.slice(0, 12), 16) % 86_400_000;
  return new Date(Date.UTC(2000, 0, 1) + milliseconds).toISOString();
}

function assertPendingOperation(payload: CollectionIndexPayload, context: WorkspaceRequestContext): void {
  if (payload.operation_id !== context.operationId) throw new WorkspaceServerError("collection_recovery_required", 503);
}

async function ensureCollectionFile(
  files: WorkspaceFileStore,
  context: WorkspaceRequestContext,
  roomId: string,
  filePath: string,
  content: Buffer,
  expectedVersion: number,
  kind: "schema" | "record"
): Promise<{ file: Awaited<ReturnType<WorkspaceFileStore["write"]>>["file"] }> {
  try {
    const existing = await files.read(context, { roomId, path: filePath });
    if (!existing.content.equals(content)) throw new WorkspaceServerError(`collection_${kind}_file_conflict`, 409);
    return { file: existing.file };
  } catch (error) {
    if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    const written = await files.write(fileContext(context, `${kind}-file`), { roomId, path: filePath, content, expectedVersion });
    return { file: written.file };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  return error instanceof Error ? error.message.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120) : "collection_operation_failed";
}

function collectionRenderSpec(schema: PostgresCollectionSchema, records: PostgresCollectionRecord[], requestedViewId?: string): SurfaceRenderSpec {
  const view = (schema.views ?? []).find((candidate) => typeof candidate.id === "string" && candidate.id === requestedViewId)
    ?? (schema.views ?? [])[0]
    ?? { id: `${schema.id}_table`, renderer: "collection_table", label: schema.labels.ja ?? schema.labels.en ?? schema.id };
  const recordData = records.map((record) => ({ id: record.id, ...record.data }));
  const refs: ResourceRef[] = records.map((record) => ({ kind: "collection_record", id: record.id, uri: record.file_path, label: `${record.collection_id}/${record.id}` }));
  return createSurfaceRenderSpec({
    kind: "custom_view", priority: "secondary", state: "ready", title: schema.labels.ja ?? schema.labels.en ?? schema.id,
    resource_refs: refs.length > 0 ? refs : [{ kind: "collection", id: schema.id, uri: `collections/${schema.id}`, label: schema.id }],
    props: {
      view_id: String(view.id), renderer: typeof view.renderer === "string" ? view.renderer : "collection_table", renderer_version: "1",
      view_state: { view_id: String(view.id), renderer: typeof view.renderer === "string" ? view.renderer : "collection_table", selected_record_id: null, search: "", sort: {}, filter: {}, group: null, selected_date: null },
      schema_ref: `collections/${schema.id}/schema.md`,
      actions: [...schema.actions, { id: "refresh", label: "更新", operation_kind: "collection.view.present" }],
      data: {
        collection_id: schema.id, records: recordData, schema_fields: schema.fields, view_config: view, view_options: schema.views ?? [],
        view_state: { view_id: String(view.id), renderer: typeof view.renderer === "string" ? view.renderer : "collection_table", selected_record_id: null, search: "", sort: {}, filter: {}, group: null, selected_date: null },
        linked_data: {}, counts: { total: recordData.length }, record_ids: recordData.map((record) => String(record.id))
      }
    },
    fallback: { kind: "collection", title: schema.id, message: "Open this Collection if the app renderer is unavailable.", props: { collection_id: schema.id, schema_id: schema.id, record_ids: recordData.map((record) => String(record.id)) } }
  });
}
