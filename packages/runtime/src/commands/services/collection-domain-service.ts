import {
  type ActivityInboxItem,
  CollectionSchemaSchema,
  ResourceRefSchema,
  createId,
  nowIso,
  type AutomationJobRecord,
  type CollectionPatch,
  type CollectionRecord,
  type CollectionSchema,
  type JsonValue,
  type MessageEnvelope,
  type OperationRecord,
  type ResourceRef,
  type RollbackPoint,
  type SessionRecord
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { jsonValue } from "./json-value.js";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import type { CollectionReindexResult } from "@samurai-agent/workspace-store";
import type { ChatTurnResult } from "./conversation-domain-service.js";

type CollectionActionSession = SessionRecord;
interface CollectionActionChat extends ChatTurnResult {
  customView?: Record<string, JsonValue>;
}
interface CollectionPluginExecution { status: string; handler_id?: string; output?: JsonValue; error?: string }
type StoredCollectionRecord = Omit<CollectionRecord, "version"> & { version: number; file_path: string };
type CollectionActionResource = StoredCollectionRecord
  | CollectionReindexResult
  | { collection_id: string; action_id: string; action_kind: string; status: "completed"; backend_run_id: string; session_id: string; custom_view?: Record<string, JsonValue>; output: { backend_status: string; message_ids: string[]; custom_view?: Record<string, JsonValue> } }
  | { collection_id: string; action_id: string; action_kind: string; catalog_action_id: string; handler_id?: string; status: "completed"; output?: JsonValue };

export interface CollectionActionPort {
  getSession(id: string): Promise<CollectionActionSession | undefined>;
  ensureSession(): Promise<CollectionActionSession>;
  resolveRecordData(schema: StoredCollectionSchema, record: StoredCollectionRecord): Promise<Record<string, JsonValue> | undefined>;
  runInstruction(input: { session: CollectionActionSession; prompt: string; backendId?: string; metadata: Record<string, JsonValue>; customView: boolean }): Promise<CollectionActionChat>;
  runPlugin(input: { catalogActionId: string; payload: Record<string, JsonValue>; context: Record<string, JsonValue> }): Promise<CollectionPluginExecution>;
}

interface StoredCollectionSchema extends CollectionSchema { file_path: string }
interface CollectionWriteResult<T> { resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }

export interface CollectionMutationPort {
  getSchema(id: string): Promise<StoredCollectionSchema | undefined>;
  saveSchema(schema: CollectionSchema): Promise<StoredCollectionSchema>;
  updateSchema(schema: CollectionSchema): Promise<StoredCollectionSchema>;
  saveRecord(record: CollectionRecord): Promise<StoredCollectionRecord>;
  getRecord(collectionId: string, recordId: string): Promise<StoredCollectionRecord | undefined>;
  deleteRecord(collectionId: string, recordId: string): Promise<StoredCollectionRecord>;
  applyRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }): Promise<{
    before: StoredCollectionRecord; after: StoredCollectionRecord;
  }>;
  mapPatchError(error: unknown): Error;
  reindex(): Promise<CollectionReindexResult>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(content: string): MessageEnvelope;
  runMutation<T, Extra extends Record<string, unknown> = {}>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string } & Extra> }): Promise<CollectionWriteResult<T> & Extra>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  contract(id: "collection.schema.save" | "collection.reindex"): { id: string; proposed_effects: string[] };
  queueTrigger(input: { collectionId: string; recordId: string; event: "record.created" | "record.patched" }): Promise<void>;
}

export interface CollectionReadPort {
  getSchema(id: string): Promise<(CollectionSchema & { file_path: string }) | undefined>;
  listRecords(schema: CollectionSchema & { file_path: string }, input: { ids: string[]; fields: string[] }): Promise<{
    collection_id: string; count: number; items: Record<string, JsonValue>[]; linked_data: JsonValue; schema_fields: JsonValue;
  }>;
  schemaDocs(): JsonValue;
  presentView(input: { collectionId: string; viewId?: string }): Promise<{
    collection_id: string; view_id: string; schema: CollectionSchema & { file_path: string }; record_count: number; render_spec: SurfaceRenderSpec;
  }>;
}

export class CollectionDomainService {
  constructor(private readonly dependencies: {
    actions: CollectionActionPort;
    queries: CollectionReadPort;
    mutation: CollectionMutationPort;
    requestError: (code: "conflict" | "not_found" | "forbidden", message: string) => Error;
  }) {}

  getCollectionSchema(id: string) { return this.dependencies.queries.getSchema(id); }
  listCollectionRecords(schema: CollectionSchema & { file_path: string }, input: { ids: string[]; fields: string[] }) { return this.dependencies.queries.listRecords(schema, input); }
  presentCollectionView(input: { collectionId: string; viewId?: string }) { return this.dependencies.queries.presentView(input); }
  collectionQueryError(message: string) { return this.dependencies.requestError("not_found", message); }
  collectionMutationContract(id: "collection.schema.save" | "collection.reindex") { return this.dependencies.mutation.contract(id); }
  ensureCollectionMutationSession() { return this.dependencies.mutation.ensureSession(); }
  createCollectionMutationEnvelope(content: string) { return this.dependencies.mutation.createEnvelope(content); }
  runCollectionMutation<T, Extra extends Record<string, unknown> = {}>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string } & Extra> }) { return this.dependencies.mutation.runMutation<T, Extra>(input); }
  reindexCollectionStore() { return this.dependencies.mutation.reindex(); }
  getCollectionSchemaForMutation(id: string) { return this.dependencies.mutation.getSchema(id); }
  saveCollectionSchema(schema: CollectionSchema) { return this.dependencies.mutation.saveSchema(schema); }
  updateCollectionSchema(schema: CollectionSchema) { return this.dependencies.mutation.updateSchema(schema); }
  collectionSchemaRef(schema: StoredCollectionSchema) { return collectionSchemaRef(schema); }
  createCollectionRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.dependencies.mutation.createRollback(operation, refs, before, after); }
  saveCollectionRecord(record: CollectionRecord) { return this.dependencies.mutation.saveRecord(record); }
  collectionRecordRef(record: StoredCollectionRecord) { return collectionRecordRef(record); }
  queueCollectionTrigger(input: { collectionId: string; recordId: string; event: "record.created" | "record.patched" }) { return this.dependencies.mutation.queueTrigger(input); }
  applyCollectionRecordPatch(input: { collectionId: string; recordId: string; patch: CollectionPatch }) { return this.dependencies.mutation.applyRecordPatch(input); }
  mapCollectionPatchError(error: unknown) { return this.dependencies.mutation.mapPatchError(error); }
  collectionDeleteAllowed(schema: CollectionSchema, viewId?: string) { return collectionDeleteAllowed(schema, viewId); }
  getCollectionRecord(collectionId: string, recordId: string) { return this.dependencies.mutation.getRecord(collectionId, recordId); }
  deleteCollectionRecord(collectionId: string, recordId: string) { return this.dependencies.mutation.deleteRecord(collectionId, recordId); }
  collectionMutationError(code: "forbidden" | "not_found", message: string) { return this.dependencies.requestError(code, message); }

  runAction(payload: Record<string, JsonValue>) {
    return this.runActionInput({
      collectionId: optionalString(payload.collection_id), actionId: optionalString(payload.action_id),
      backendId: optionalString(payload.backend_id) || undefined, recordId: optionalString(payload.record_id) || undefined,
      sessionId: optionalString(payload.session_id) || undefined, payload: recordValue(payload.payload)
    });
  }

  async runActionInput(input: { collectionId: string; actionId: string; backendId?: string; recordId?: string; sessionId?: string; payload: Record<string, JsonValue> }): Promise<CollectionWriteResult<CollectionActionResource> & { chat?: CollectionActionChat; before?: StoredCollectionRecord }> {
    const schema = await this.dependencies.mutation.getSchema(input.collectionId);
    if (!schema) throw this.dependencies.requestError("not_found", `Collection schema not found: ${input.collectionId}`);
    const action = findAction(schema, input.actionId);
    if (!action) throw this.dependencies.requestError("not_found", `Collection action not found: ${input.collectionId}/${input.actionId}`);
    const kind = actionKind(action);
    const session = input.sessionId ? await this.dependencies.actions.getSession(input.sessionId) : await this.dependencies.actions.ensureSession();
    if (!session) throw this.dependencies.requestError("not_found", `Session not found: ${input.sessionId}`);
    const envelope = this.dependencies.mutation.createEnvelope(`Run collection action: ${input.collectionId}/${input.actionId}`);
    let patchBefore: StoredCollectionRecord | undefined;
    let createdRecord: StoredCollectionRecord | undefined;
    const result = await this.dependencies.mutation.runMutation<CollectionActionResource, { chat?: CollectionActionChat }>({
      session, envelope, operationName: "collection.action.run",
      proposedEffects: [`Run collection action ${input.collectionId}/${input.actionId}.`],
      execute: async (operation) => {
        if (kind === "patch_record" || kind === "patch") {
          const recordId = input.recordId ?? actionString(action, "record_id") ?? optionalString(input.payload.record_id);
          if (!recordId) throw this.dependencies.requestError("conflict", "collection_action_record_id_required");
          const changes = actionRecord(input.payload.changes) ?? actionRecord(action.changes);
          if (!changes) throw this.dependencies.requestError("conflict", "collection_action_changes_required");
          let patched;
          try {
            patched = await this.dependencies.mutation.applyRecordPatch({ collectionId: input.collectionId, recordId, patch: {
              id: createId("collection_patch"), record_id: recordId, changes, expected_version: positiveInteger(input.payload.expected_version),
              source_operation_id: operation.id, created_at: nowIso()
            }});
          } catch (error) { throw this.dependencies.mutation.mapPatchError(error); }
          patchBefore = patched.before;
          const ref = collectionRecordRef(patched.after);
          const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref], { record: jsonValue(patched.before) }, { record: jsonValue(patched.after) });
          return { resource: patched.after, ref, rollbackPoint, summary: `Ran collection action ${input.actionId} and patched ${input.collectionId}/${recordId}.` };
        }
        if (kind === "create_record" || kind === "create") {
          const recordId = (input.recordId ?? actionString(action, "record_id") ?? optionalString(input.payload.record_id)) || createId("collection_record");
          const data = actionRecord(input.payload.data) ?? actionRecord(action.data);
          if (!data) throw this.dependencies.requestError("conflict", "collection_action_data_required");
          const now = nowIso();
          createdRecord = await this.dependencies.mutation.saveRecord({ id: recordId, collection_id: input.collectionId, version: 1, data, resource_refs: [], created_at: now, updated_at: now });
          const ref = collectionRecordRef(createdRecord);
          const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref], {}, { collection_id: createdRecord.collection_id, record_id: createdRecord.id });
          return { resource: createdRecord, ref, rollbackPoint, summary: `Ran collection action ${input.actionId} and created ${input.collectionId}/${recordId}.` };
        }
        if (kind === "reindex" || kind === "reindex_collection") {
          const resource = await this.dependencies.mutation.reindex();
          return { resource, ref: { kind: "collection_index", id: "collections", uri: "collections", label: "Collection index" }, summary: `Ran collection action ${input.actionId} and reindexed collections.` };
        }
        if (isInstructionKind(kind)) {
          const recordId = input.recordId ?? actionString(action, "record_id") ?? optionalString(input.payload.record_id);
          const record = recordId ? await this.dependencies.mutation.getRecord(input.collectionId, recordId) : undefined;
          if (recordId && !record) throw this.dependencies.requestError("not_found", `Collection record not found: ${input.collectionId}/${recordId}`);
          const instruction = actionInstruction(action, input.payload);
          if (!instruction) throw this.dependencies.requestError("conflict", `collection_action_instruction_required:${input.actionId}`);
          const outputSurface = actionOutputSurface(action, input.payload);
          const chat = await this.dependencies.actions.runInstruction({ session, backendId: input.backendId,
            prompt: instructionPrompt({ collectionId: input.collectionId, actionId: input.actionId, instruction, record,
              resolvedRecordData: record ? await this.dependencies.actions.resolveRecordData(schema, record) : undefined,
              payload: input.payload, outputSurface }), customView: outputSurface === "custom_view",
            metadata: { collection_action_operation_id: operation.id, collection_id: input.collectionId,
              collection_action_id: input.actionId, collection_action_kind: kind, ...(recordId ? { collection_record_id: recordId } : {}) }
          });
          const actionChat = chat;
          const resource = { collection_id: input.collectionId, action_id: input.actionId, action_kind: kind, status: "completed" as const,
            backend_run_id: chat.backendRun.id, session_id: chat.session.id, ...(chat.customView ? { custom_view: chat.customView } : {}),
            output: { backend_status: chat.backendRun.status, message_ids: chat.messages.map((message) => message.id), ...(chat.customView ? { custom_view: chat.customView } : {}) } };
          return { resource, ref: actionExecutionRef(input.collectionId, input.actionId, operation.id), chat: actionChat, summary: `Ran collection instruction action ${input.collectionId}/${input.actionId}.` };
        }
        if (isPluginAction(action, kind)) {
          const catalogActionId = actionString(action, "catalog_action_id") ?? actionString(action, "action_catalog_id") ?? actionString(action, "plugin_action_id") ?? input.actionId;
          const pluginPayload: Record<string, JsonValue> = { ...input.payload, collection_id: input.collectionId, action_id: input.actionId };
          const pluginRecordId = input.recordId ?? optionalString(input.payload.record_id);
          if (pluginRecordId) pluginPayload.record_id = pluginRecordId;
          const execution = await this.dependencies.actions.runPlugin({ catalogActionId, payload: pluginPayload,
            context: { collection_id: input.collectionId, action_id: input.actionId, action_kind: kind, operation_id: operation.id } });
          if (execution.status !== "completed") throw this.dependencies.requestError("conflict", `collection_plugin_action_failed:${execution.error ?? "unknown"}`);
          const resource = { collection_id: input.collectionId, action_id: input.actionId, action_kind: kind,
            catalog_action_id: catalogActionId, handler_id: execution.handler_id, status: "completed" as const, output: execution.output };
          return { resource, ref: actionExecutionRef(input.collectionId, input.actionId, operation.id), summary: `Ran collection plugin action ${input.collectionId}/${input.actionId}.` };
        }
        throw this.dependencies.requestError("conflict", `collection_action_kind_unsupported:${kind}`);
      }
    });
    if (patchBefore) {
      const record = result.resource;
      if (!isStoredCollectionRecord(record)) throw new Error("collection_action_patch_result_invalid");
      await this.dependencies.mutation.queueTrigger({ collectionId: input.collectionId, recordId: record.id, event: "record.patched" });
      return { ...result, before: patchBefore };
    }
    if (createdRecord) await this.dependencies.mutation.queueTrigger({ collectionId: createdRecord.collection_id, recordId: createdRecord.id, event: "record.created" });
    return result;
  }

  async executeTriggerJob(job: AutomationJobRecord): Promise<string | undefined> {
    const target = triggerTarget(job.delivery_target);
    if (!target) return undefined;
    const schema = await this.dependencies.mutation.getSchema(target.collectionId);
    if (!schema || !findAction(schema, target.actionId)) return undefined;
    await this.runActionInput({ collectionId: target.collectionId, actionId: target.actionId, recordId: target.recordId,
      payload: { trigger_id: target.triggerId, event: target.event, action_kind: target.actionKind, automation_job_id: job.id } });
    return `Collection trigger ${target.triggerId} ran action ${target.collectionId}/${target.actionId}.`;
  }

  applyPatch(payload: Record<string, JsonValue>) {
    const collectionId = optionalString(payload.collection_id);
    const recordId = optionalString(payload.record_id);
    if (!collectionId || !recordId) throw this.dependencies.requestError("conflict", "domain_command_collection_patch_target_required");
    const expectedVersion = positiveInteger(payload.expected_version);
    if (expectedVersion === undefined) throw this.dependencies.requestError("conflict", "domain_command_collection_patch_expected_version_required");
    return this.applyPatchInput({ collectionId, recordId, patch: {
      id: optionalString(payload.patch_id) || optionalString(payload.id) || createId("collection_patch"),
      record_id: recordId, changes: recordValue(payload.changes), expected_version: expectedVersion,
      source_operation_id: optionalString(payload.source_operation_id) || createId("domain_command"), created_at: nowIso()
    }});
  }

  createRecord(payload: Record<string, JsonValue>) {
    const collectionId = optionalString(payload.collection_id);
    if (!collectionId) throw this.dependencies.requestError("conflict", "domain_command_collection_id_required");
    const now = nowIso();
    return this.createRecordInput({
      id: optionalString(payload.record_id) || optionalString(payload.id) || createId("collection_record"),
      collection_id: collectionId, version: 1, data: recordValue(payload.data),
      resource_refs: resourceRefs(payload.resource_refs), created_at: now, updated_at: now
    });
  }

  deleteRecord(payload: Record<string, JsonValue>) {
    const collectionId = optionalString(payload.collection_id);
    const recordId = optionalString(payload.record_id);
    if (!collectionId || !recordId) throw this.dependencies.requestError("conflict", "domain_command_collection_delete_target_required");
    return this.deleteRecordInput({ collectionId, recordId, viewId: optionalString(payload.view_id) || undefined });
  }

  reindex() { return this.reindexCollections(); }
  saveSchema(payload: Record<string, JsonValue>) { return this.saveSchemaInput(CollectionSchemaSchema.parse(payload)); }

  async saveSchemaInput(schema: CollectionSchema, context?: { session: SessionRecord; envelope: MessageEnvelope }) {
    const existing = await this.dependencies.mutation.getSchema(schema.id);
    const contract = this.dependencies.mutation.contract("collection.schema.save");
    const session = context?.session ?? await this.dependencies.mutation.ensureSession();
    const envelope = context?.envelope ?? this.dependencies.mutation.createEnvelope(`Save collection schema: ${schema.id}`);
    return this.dependencies.mutation.runMutation({
      session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
      targetResourceRefs: existing ? [collectionSchemaRef(existing)] : [],
      execute: async (operation) => {
        const saved = existing
          ? await this.dependencies.mutation.updateSchema(schema)
          : await this.dependencies.mutation.saveSchema(schema);
        const ref = collectionSchemaRef(saved);
        const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref],
          existing ? { collection_schema: jsonValue(existing) } : {},
          { collection_schema: jsonValue(saved) });
        return { resource: saved, ref, rollbackPoint, summary: `Saved collection schema ${saved.id}.` };
      }
    });
  }

  async reindexCollections(): Promise<CollectionWriteResult<CollectionReindexResult>> {
    const contract = this.dependencies.mutation.contract("collection.reindex");
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope("Reindex collections");
    return this.dependencies.mutation.runMutation({
      session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects,
      execute: async () => {
        const result = await this.dependencies.mutation.reindex();
        const ref = { kind: "collection_index", id: "collections", uri: "collections", label: "Collection index" };
        return { resource: result, ref,
          summary: `Reindexed ${result.schemas.indexed} collection schema(s) and ${result.records.indexed} record(s).` };
      }
    });
  }

  async createRecordInput(record: CollectionRecord) {
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`Create collection record: ${record.collection_id}/${record.id}`);
    const result = await this.dependencies.mutation.runMutation({
      session, envelope, operationName: "collection.record.create",
      proposedEffects: ["Create a collection record file and SQLite index row."],
      execute: async (operation) => {
        const saved = await this.dependencies.mutation.saveRecord(record);
        const ref = collectionRecordRef(saved);
        const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref], {},
          { collection_id: saved.collection_id, record_id: saved.id });
        return { resource: saved, ref, rollbackPoint, summary: `Created collection record ${saved.collection_id}/${saved.id}.` };
      }
    });
    await this.dependencies.mutation.queueTrigger({
      collectionId: result.resource.collection_id, recordId: result.resource.id, event: "record.created"
    });
    return result;
  }

  async applyPatchInput(input: { collectionId: string; recordId: string; patch: CollectionPatch }) {
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`Apply collection patch: ${input.collectionId}/${input.recordId}`);
    const result = await this.dependencies.mutation.runMutation({
      session, envelope, operationName: "collection.patch.apply",
      proposedEffects: ["Apply a collection patch to an existing local record."],
      execute: async (operation) => {
        const patch = { ...input.patch, source_operation_id: operation.id };
        let patched: { before: StoredCollectionRecord; after: StoredCollectionRecord };
        try {
          patched = await this.dependencies.mutation.applyRecordPatch({ ...input, patch });
        } catch (error) {
          throw this.dependencies.mutation.mapPatchError(error);
        }
        const ref = collectionRecordRef(patched.after);
        const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref],
          { record: jsonValue(patched.before) }, { record: jsonValue(patched.after) });
        return { resource: patched.after, before: patched.before, ref, rollbackPoint, summary: `Applied collection patch ${patch.id}.` };
      }
    });
    await this.dependencies.mutation.queueTrigger({
      collectionId: result.resource.collection_id, recordId: result.resource.id, event: "record.patched"
    });
    return result;
  }

  async deleteRecordInput(input: { collectionId: string; recordId: string; viewId?: string }) {
    const schema = await this.dependencies.mutation.getSchema(input.collectionId);
    if (!schema) throw this.dependencies.requestError("not_found", `Collection schema not found: ${input.collectionId}`);
    if (!collectionDeleteAllowed(schema, input.viewId)) throw this.dependencies.requestError("forbidden", "collection_record_delete_not_allowed");
    const record = await this.dependencies.mutation.getRecord(input.collectionId, input.recordId);
    if (!record) throw this.dependencies.requestError("not_found", `Collection record not found: ${input.collectionId}/${input.recordId}`);
    const session = await this.dependencies.mutation.ensureSession();
    const envelope = this.dependencies.mutation.createEnvelope(`Delete collection record: ${input.collectionId}/${input.recordId}`);
    return this.dependencies.mutation.runMutation({
      session, envelope, operationName: "collection.record.delete",
      proposedEffects: ["Delete a collection record file and SQLite index row."],
      execute: async (operation) => {
        const deleted = await this.dependencies.mutation.deleteRecord(input.collectionId, input.recordId);
        const ref = collectionRecordRef(deleted);
        const rollbackPoint = await this.dependencies.mutation.createRollback(operation, [ref],
          { record: jsonValue(record) }, {});
        return { resource: deleted, ref, rollbackPoint, summary: `Deleted collection record ${deleted.collection_id}/${deleted.id}.` };
      }
    });
  }

  async listRecords(payload: Record<string, JsonValue>) {
    const collectionId = optionalString(payload.collection_id);
    if (!collectionId) throw this.dependencies.requestError("conflict", "domain_query_collection_id_required");
    const schema = await this.requireSchema(collectionId);
    return { action: "getItems" as const, ...(await this.dependencies.queries.listRecords(schema, { ids: stringArray(payload.ids), fields: stringArray(payload.fields) })) };
  }

  schemaDocs() { return { action: "schemaDocs" as const, schema_docs: this.dependencies.queries.schemaDocs() }; }

  async getSchema(payload: Record<string, JsonValue>) {
    const schema = await this.requireSchema(optionalString(payload.collection_id) || optionalString(payload.slug) || optionalString(payload.id), "domain_query_collection_id_required");
    return { action: "getSchema" as const, collection_id: schema.id, schema };
  }

  presentView(payload: Record<string, JsonValue>) {
    const collectionId = optionalString(payload.collection_id);
    if (!collectionId) throw this.dependencies.requestError("conflict", "domain_command_collection_id_required");
    return this.dependencies.queries.presentView({
      collectionId,
      viewId: optionalString(payload.view_id) || undefined
    });
  }

  private async requireSchema(id: string, missingMessage?: string): Promise<CollectionSchema & { file_path: string }> {
    if (!id) throw this.dependencies.requestError("conflict", missingMessage ?? "domain_query_collection_id_required");
    const schema = await this.dependencies.queries.getSchema(id);
    if (!schema) throw this.dependencies.requestError("not_found", `Collection schema not found: ${id}`);
    return schema;
  }
}

function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function positiveInteger(value: JsonValue | undefined): number | undefined { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined; }
function stringArray(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function resourceRefs(value: JsonValue | undefined): CollectionRecord["resource_refs"] {
  const parsed = z.array(ResourceRefSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
function collectionSchemaRef(schema: StoredCollectionSchema) {
  return { kind: "collection_schema", id: schema.id, uri: schema.file_path, version: schema.version, label: schema.labels.en ?? schema.id };
}
function collectionRecordRef(record: StoredCollectionRecord) {
  return { kind: "collection_record", id: record.id, uri: record.file_path, version: String(record.version), label: record.id };
}

function isStoredCollectionRecord(value: CollectionActionResource): value is StoredCollectionRecord {
  return "id" in value && "collection_id" in value && "file_path" in value && typeof value.version === "number";
}
function collectionDeleteAllowed(schema: CollectionSchema, viewId?: string): boolean {
  const permissions = schema.permissions as Record<string, unknown>;
  if (permissions.delete === false) return false;
  const view = (schema.views ?? []).find((item) => item.id === viewId) ?? (schema.views ?? [])[0];
  return view?.allow_delete !== false;
}

function findAction(schema: CollectionSchema, actionId: string): Record<string, JsonValue> | undefined {
  return schema.actions.find((action) => (actionString(action, "id") ?? actionString(action, "name") ?? actionString(action, "action_id")) === actionId);
}
function actionKind(action: Record<string, JsonValue>): string { return actionString(action, "kind") ?? actionString(action, "type") ?? "custom_instruction"; }
function actionString(action: Record<string, JsonValue>, key: string): string | undefined {
  const value = action[key]; return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function actionRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function isInstructionKind(kind: string): boolean { return ["custom_instruction", "instruction", "backend_instruction", "chat"].includes(kind); }
function actionInstruction(action: Record<string, JsonValue>, payload: Record<string, JsonValue>): string | undefined {
  return (actionString(action, "instruction") ?? actionString(action, "target_instruction") ?? actionString(action, "prompt") ?? optionalString(payload.instruction)) || undefined;
}
function actionOutputSurface(action: Record<string, JsonValue>, payload: Record<string, JsonValue>): string | undefined {
  return (actionString(action, "output_surface") ?? actionString(action, "surface") ?? optionalString(payload.output_surface)) || undefined;
}
function isPluginAction(action: Record<string, JsonValue>, kind: string): boolean {
  const target = actionString(action, "implementation_target") ?? actionString(action, "target") ?? (["plugin", "plugin_action"].includes(kind) ? "plugin" : "runtime");
  return target === "plugin" || target === "external" || kind === "plugin" || kind === "plugin_action";
}
function actionExecutionRef(collectionId: string, actionId: string, operationId: string) {
  return { kind: "collection_action", id: `${collectionId}/${actionId}/${operationId}`, uri: `collections/${collectionId}/actions/${actionId}`, label: `${collectionId}/${actionId}` };
}
function instructionPrompt(input: { collectionId: string; actionId: string; instruction: string; record?: StoredCollectionRecord; resolvedRecordData?: Record<string, JsonValue>; payload: Record<string, JsonValue>; outputSurface?: string }): string {
  return [
    `Run Collection action ${input.collectionId}/${input.actionId}.`, `Instruction:\n${input.instruction}`,
    input.outputSurface === "custom_view" ? "Return a JSON object with custom_view.html for the generated Workspace UI. Example: {\"custom_view\":{\"title\":\"...\",\"html\":\"<main>...</main>\",\"actions\":[]}}" : "",
    input.record ? `Record:\n${JSON.stringify({ id: input.record.id, collection_id: input.record.collection_id, data: input.resolvedRecordData ?? input.record.data }, null, 2)}` : "",
    Object.keys(input.payload).length ? `Payload:\n${JSON.stringify(input.payload, null, 2)}` : ""
  ].filter(Boolean).join("\n\n");
}

function triggerTarget(value: Record<string, JsonValue>): { collectionId: string; recordId: string; actionId: string; triggerId: string; event: string; actionKind: string } | undefined {
  if (optionalString(value.channel) !== "collection_trigger") return undefined;
  const collectionId = optionalString(value.collection_id), recordId = optionalString(value.record_id), actionId = optionalString(value.action_id);
  if (!collectionId || !recordId || !actionId) return undefined;
  return { collectionId, recordId, actionId, triggerId: optionalString(value.trigger_id) || actionId,
    event: optionalString(value.event) || "record.created", actionKind: optionalString(value.action_kind) || "custom_instruction" };
}
