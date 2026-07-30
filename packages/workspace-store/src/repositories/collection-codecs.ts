import { CollectionRecordSchema, CollectionSchemaSchema, createId, nowIso, type AutomationJobRecord, type CollectionPatch, type CollectionRecord, type CollectionSchema, type JsonValue, type ResourceRef } from "@samurai-agent/core-schemas";
import type { CollectionRecordWithFilePath, CollectionResolvedEmbed, CollectionMissingRef, CollectionResolvedRef, CollectionTriggerEffect, CollectionTriggerJobSummary, CollectionTriggerState } from "../workspace-store-contracts";

export function parseCollectionSchemaLocal(value: unknown): CollectionSchema {
  const schema = CollectionSchemaSchema.parse(value);
  const seen = new Set<string>();
  for (const field of schema.fields) {
    const id = collectionFieldId(field);
    if (!id) {
      throw new Error("collection_field_id_required");
    }
    if (seen.has(id)) {
      throw new Error(`collection_field_duplicate:${id}`);
    }
    seen.add(id);
  }
  validateCollectionViewRenderersLocal(schema);
  return schema;
}

const supportedCollectionViewRenderersLocal = new Set([
  "collection_table",
  "collection_gallery",
  "calendar_view",
  "collection_kanban"
]);

const legacyCollectionViewRenderersLocal = new Set([
  "collection_dashboard",
  "task_list"
]);

export function validateCollectionViewRenderersLocal(schema: CollectionSchema): void {
  for (const view of schema.views ?? []) {
    const renderer = typeof view.renderer === "string" ? view.renderer.trim() : "";
    if (!renderer) {
      continue;
    }
    if (supportedCollectionViewRenderersLocal.has(renderer)) {
      continue;
    }
    if (legacyCollectionViewRenderersLocal.has(renderer)) {
      continue;
    }
    throw new Error(`collection_view_renderer_unsupported:${renderer}`);
  }
}

export function parseCollectionRecordLocal(value: unknown, schema: CollectionSchema): CollectionRecord & { version: number } {
  const record = CollectionRecordSchema.parse(value);
  if (record.collection_id !== schema.id) {
    throw new Error("collection_record_collection_id_mismatch");
  }
  const data = stripCollectionDerivedFieldsLocal(record.data, schema);
  rejectUnknownCollectionFields(data, schema);
  validateCollectionRequiredFields(data, schema);
  validateCollectionFieldValues(data, schema);
  return { ...record, data };
}

export function applyCollectionPatchLocal(record: CollectionRecord, patch: CollectionPatch, schema: CollectionSchema): CollectionRecord & { version: number } {
  if (patch.record_id !== record.id) {
    throw new Error("collection_patch_record_id_mismatch");
  }
  rejectUnknownCollectionFields(patch.changes, schema);
  const data = {
    ...stripCollectionDerivedFieldsLocal(record.data, schema),
    ...patch.changes
  };
  rejectUnknownCollectionFields(data, schema);
  validateCollectionRequiredFields(data, schema);
  validateCollectionFieldValues(data, schema);
  return {
    ...record,
    version: (record.version ?? 1) + 1,
    data,
    updated_at: patch.created_at
  };
}

export function rejectUnknownCollectionFields(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  const allowed = new Set([
    ...schema.fields.map(collectionFieldId),
    ...schema.refs.map(collectionDefinitionField),
    ...schema.embeds.map(collectionDefinitionField)
  ].filter((id): id is string => Boolean(id)));
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      throw new Error(`collection_unknown_field:${key}`);
    }
  }
}

export function validateCollectionRequiredFields(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  for (const field of schema.fields) {
    if (field.required !== true) {
      continue;
    }
    const id = collectionFieldId(field);
    if (!id) {
      continue;
    }
    if (collectionRequiredValueMissing(data[id])) {
      throw new Error(`collection_required_field:${id}`);
    }
  }
}

export function validateCollectionFieldValues(data: Record<string, JsonValue>, schema: CollectionSchema): void {
  for (const field of schema.fields) {
    const id = collectionFieldId(field);
    if (!id || !(id in data)) {
      continue;
    }
    const value = data[id];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const type = collectionDefinitionString(field, "type") ?? "string";
    if (!collectionFieldValueMatchesType(value, field, type)) {
      throw new Error(`collection_field_type:${id}:${type}`);
    }
    if (type === "enum") {
      const values = collectionDefinitionStringArray(field, "enum_values");
      if (values.length > 0 && (typeof value !== "string" || !values.includes(value))) {
        throw new Error(`collection_enum_value:${id}`);
      }
    }
  }
}

export function collectionFieldValueMatchesType(value: JsonValue, field: Record<string, JsonValue>, type: string): boolean {
  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (type === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (type === "boolean") {
    return typeof value === "boolean";
  }
  if (type === "date") {
    return typeof value === "string" && collectionDateStringValid(value);
  }
  if (type === "datetime") {
    return typeof value === "string" && collectionDateTimeStringValid(value);
  }
  if (type === "enum" || type === "ref") {
    return typeof value === "string";
  }
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "json") {
    return true;
  }
  if (["string", "text", "markdown", "url", "email", "image"].includes(type)) {
    return typeof value === "string";
  }
  const enumValues = collectionDefinitionStringArray(field, "enum_values");
  if (enumValues.length > 0) {
    return typeof value === "string" && enumValues.includes(value);
  }
  return true;
}

export function collectionDateStringValid(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function collectionDateTimeStringValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}[tT\s]\d{2}:\d{2}/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

export function collectionRequiredValueMissing(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length === 0;
  }
  return false;
}

export function collectionFieldId(field: Record<string, JsonValue>): string | undefined {
  const value = field.id ?? field.name;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function stripCollectionDerivedFieldsLocal(data: Record<string, JsonValue>, schema: CollectionSchema): Record<string, JsonValue> {
  const derived = new Set(schema.derived_fields.map(collectionFieldId).filter((id): id is string => Boolean(id)));
  if (derived.size === 0) {
    return data;
  }
  const next = { ...data };
  for (const id of derived) {
    delete next[id];
  }
  return next;
}

export function evaluateCollectionDerivedField(field: Record<string, JsonValue>, data: Record<string, JsonValue>): JsonValue {
  const expression = collectionDefinitionString(field, "expression");
  if (expression) {
    const separatorIndex = expression.indexOf(":");
    const operator = separatorIndex === -1 ? expression : expression.slice(0, separatorIndex);
    const args = separatorIndex === -1 ? "" : expression.slice(separatorIndex + 1);
    const fields = args.split(",").map((item) => item.trim()).filter(Boolean);
    if (operator === "concat") {
      const joiner = collectionDefinitionString(field, "join") ?? " ";
      return fields.map((name) => jsonValueToDisplay(data[name])).filter(Boolean).join(joiner);
    }
    if (operator === "length") {
      const value = data[fields[0] ?? ""];
      return typeof value === "string" || Array.isArray(value) ? value.length : 0;
    }
    if (operator === "sum") {
      return fields.reduce((total, name) => total + (typeof data[name] === "number" ? data[name] as number : 0), 0);
    }
    if (operator === "count") {
      const value = data[fields[0] ?? ""];
      return Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
    }
    if (operator === "copy") {
      return data[fields[0] ?? ""] ?? null;
    }
  }
  const from = field.from;
  if (Array.isArray(from)) {
    const joiner = collectionDefinitionString(field, "join") ?? " ";
    return from
      .filter((item): item is string => typeof item === "string")
      .map((name) => jsonValueToDisplay(data[name]))
      .filter(Boolean)
      .join(joiner);
  }
  if ("value" in field) {
    return field.value ?? null;
  }
  return null;
}

export function collectionDefinitionField(definition: Record<string, JsonValue>): string | undefined {
  return collectionDefinitionString(definition, "field")
    ?? collectionDefinitionString(definition, "field_id")
    ?? collectionFieldId(definition);
}

export function collectionDefinitionString(definition: Record<string, JsonValue>, key: string): string | undefined {
  const value = definition[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function collectionDefinitionStringArray(definition: Record<string, JsonValue>, key: string): string[] {
  const value = definition[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function collectionDefinitionBoolean(definition: Record<string, JsonValue>, key: string): boolean {
  return definition[key] === true;
}

export function collectionRefTargetId(value: JsonValue): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = value.id;
    if (typeof id === "string" && id.trim()) {
      return id;
    }
  }
  return undefined;
}

export function jsonValueToDisplay(value: JsonValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function collectionRecordRefLocal(record: CollectionRecordWithFilePath | CollectionRecord): ResourceRef {
  return {
    kind: "collection_record",
    id: record.id,
    uri: "file_path" in record ? record.file_path : `collections/${record.collection_id}/records/${record.id}.json`,
    label: `${record.collection_id}/${record.id}`
  };
}

export function collectionTriggerEffect(
  trigger: Record<string, JsonValue>,
  index: number,
  event: CollectionTriggerEffect["event"],
  recordRef: ResourceRef
): CollectionTriggerEffect {
  const triggerEvent = collectionDefinitionString(trigger, "event") ?? collectionDefinitionString(trigger, "on");
  const enabled = trigger.enabled !== false;
  const actionId = collectionDefinitionString(trigger, "action_id")
    ?? collectionDefinitionString(trigger, "action")
    ?? collectionDefinitionString(trigger, "name")
    ?? `trigger_${index + 1}`;
  const actionKind = collectionDefinitionString(trigger, "kind") ?? collectionDefinitionString(trigger, "type") ?? "custom_instruction";
  const matches = enabled && (!triggerEvent || triggerEvent === event);
  return {
    id: collectionDefinitionString(trigger, "id") ?? `trigger_${index + 1}`,
    event,
    action_id: actionId,
    action_kind: actionKind,
    status: matches ? "queued" : "ignored",
    reason: matches ? undefined : enabled ? `event_mismatch:${triggerEvent ?? "any"}` : "trigger_disabled",
    record_ref: recordRef
  };
}

export function collectionSchemaHasAction(schema: CollectionSchema, actionId: string): boolean {
  return schema.actions.some((action) => {
    const id = collectionDefinitionString(action, "id")
      ?? collectionDefinitionString(action, "action_id")
      ?? collectionDefinitionString(action, "name");
    return id === actionId;
  });
}

export function collectionTriggerStateStatus(input: {
  enabled: boolean;
  actionExists: boolean;
  pendingJobCount: number;
  lastJob?: AutomationJobRecord;
}): CollectionTriggerState["status"] {
  if (!input.enabled) {
    return "disabled";
  }
  if (!input.actionExists) {
    return "action_missing";
  }
  if (input.lastJob?.last_error) {
    return "failed";
  }
  if (input.pendingJobCount > 0) {
    return "queued";
  }
  if (input.lastJob?.last_run_at) {
    return "completed";
  }
  return "idle";
}

export function collectionTriggerJobSummary(job: AutomationJobRecord): CollectionTriggerJobSummary {
  return {
    id: job.id,
    status: job.status,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    retry_after_at: job.retry_after_at,
    failure_count: job.failure_count ?? 0,
    last_error: job.last_error,
    updated_at: job.updated_at
  };
}

export function isAutomationJobDue(job: AutomationJobRecord, now: string): boolean {
  return job.status === "enabled" &&
    (!job.next_run_at || job.next_run_at <= now) &&
    (!job.retry_after_at || job.retry_after_at <= now) &&
    (!job.locked_until || job.locked_until <= now) &&
    (job.failure_count ?? 0) < (job.max_attempts ?? 3);
}

export function countAutomationJobs(jobs: AutomationJobRecord[], key: "status" | "kind"): Record<string, number> {
  return jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job[key]] = (counts[job[key]] ?? 0) + 1;
    return counts;
  }, {});
}

export function countBy<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
