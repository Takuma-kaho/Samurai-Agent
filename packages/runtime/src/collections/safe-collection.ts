import { CollectionSchemaSchema, type CollectionRecord, type CollectionSchema, type JsonValue } from "@samurai-agent/core-schemas";

export type CollectionMutationSource = "human" | "agent" | "generated_surface";

export type CollectionMigrationOperation =
  | { kind: "rename"; from: string; to: string }
  | { kind: "add_default"; field: string; value: JsonValue }
  | { kind: "convert"; field: string; to: "string" | "number" | "boolean" }
  | { kind: "split"; field: string; targets: string[]; separator: string }
  | { kind: "merge"; fields: string[]; target: string; separator: string }
  | { kind: "repair_ref"; field: string; replacements: Record<string, string> };

export interface CollectionMigrationStep {
  id: string;
  from_version: string;
  to_version: string;
  migrate?: (data: Record<string, JsonValue>) => Record<string, JsonValue>;
  operations?: CollectionMigrationOperation[];
}

export interface CollectionMigrationResult {
  schema: CollectionSchema;
  records: CollectionRecord[];
  source: CollectionMutationSource;
  applied_step_ids: string[];
}

export function migrateCollectionSnapshot(input: {
  currentSchema: CollectionSchema;
  nextSchema: CollectionSchema;
  records: CollectionRecord[];
  steps: CollectionMigrationStep[];
  source: CollectionMutationSource;
}): CollectionMigrationResult {
  const current = validateExecutableCollectionSchema(input.currentSchema);
  const next = validateExecutableCollectionSchema(input.nextSchema);
  if (current.id !== next.id) throw new Error("collection_migration_id_mismatch");
  const route = migrationRoute(current.version, next.version, input.steps);
  const migrated = input.records.map((record) => {
    if (record.collection_id !== current.id) throw new Error(`collection_migration_record_mismatch:${record.id}`);
    const data = route.reduce((value, step) => applyMigrationStep(structuredClone(value), step), structuredClone(record.data));
    return { ...record, data };
  });
  // Validate the whole snapshot before the caller commits any schema or record.
  for (const record of migrated) validateRecordAgainstSchema(record, next);
  return { schema: next, records: migrated, source: input.source, applied_step_ids: route.map((step) => step.id) };
}

export function applyMigrationStep(data: Record<string, JsonValue>, step: CollectionMigrationStep): Record<string, JsonValue> {
  if (!step.migrate && !step.operations?.length) throw new Error(`collection_migration_step_empty:${step.id}`);
  let value = step.migrate ? step.migrate(structuredClone(data)) : structuredClone(data);
  for (const operation of step.operations ?? []) {
    if (operation.kind === "rename") {
      if (Object.hasOwn(value, operation.from)) { value[operation.to] = value[operation.from]!; delete value[operation.from]; }
    } else if (operation.kind === "add_default") {
      if (value[operation.field] === undefined) value[operation.field] = structuredClone(operation.value);
    } else if (operation.kind === "convert") {
      const current = value[operation.field];
      if (current === undefined || current === null) continue;
      if (operation.to === "string") value[operation.field] = String(current);
      if (operation.to === "number") { const converted = Number(current); if (!Number.isFinite(converted)) throw new Error(`collection_migration_convert_failed:${operation.field}:number`); value[operation.field] = converted; }
      if (operation.to === "boolean") { if (current === true || current === "true" || current === 1) value[operation.field] = true; else if (current === false || current === "false" || current === 0) value[operation.field] = false; else throw new Error(`collection_migration_convert_failed:${operation.field}:boolean`); }
    } else if (operation.kind === "split") {
      const parts = String(value[operation.field] ?? "").split(operation.separator);
      operation.targets.forEach((target, index) => { value[target] = parts[index]?.trim() ?? ""; });
      delete value[operation.field];
    } else if (operation.kind === "merge") {
      value[operation.target] = operation.fields.map((field) => String(value[field] ?? "")).join(operation.separator);
      operation.fields.forEach((field) => { if (field !== operation.target) delete value[field]; });
    } else {
      const current = value[operation.field];
      if (typeof current === "string" && operation.replacements[current]) value[operation.field] = operation.replacements[current];
      if (Array.isArray(current)) value[operation.field] = current.map((entry) => typeof entry === "string" ? operation.replacements[entry] ?? entry : entry);
    }
  }
  return value;
}

export function validateExecutableCollectionSchema(input: CollectionSchema): CollectionSchema {
  const schema = CollectionSchemaSchema.parse(input);
  assertUniqueDefinitions(schema.actions, "action");
  assertUniqueDefinitions(schema.triggers, "trigger");
  const actionIds = new Set(schema.actions.map((item, index) => definitionId(item, `action_${index + 1}`)));
  for (const [index, trigger] of schema.triggers.entries()) {
    const actionId = definitionString(trigger, "action_id") ?? definitionString(trigger, "action");
    if (!actionId || !actionIds.has(actionId)) throw new Error(`collection_trigger_action_missing:${definitionId(trigger, `trigger_${index + 1}`)}`);
  }
  assertNoActionCycle(schema.actions);
  return schema;
}

export class CollectionTriggerExecutor {
  private readonly completed = new Map<string, unknown>();
  private readonly active = new Set<string>();

  async execute<T>(input: {
    collectionId: string;
    recordId: string;
    recordVersion: number;
    triggerId: string;
    actionId: string;
    run: () => Promise<T>;
  }): Promise<{ status: "completed" | "duplicate"; result: T }> {
    const key = [input.collectionId, input.recordId, input.recordVersion, input.triggerId, input.actionId].join(":");
    if (this.active.has(key)) throw new Error(`collection_trigger_cycle:${key}`);
    if (this.completed.has(key)) return { status: "duplicate", result: this.completed.get(key) as T };
    this.active.add(key);
    try {
      const result = await input.run();
      this.completed.set(key, result);
      return { status: "completed", result };
    } finally {
      this.active.delete(key);
    }
  }
}

function migrationRoute(from: string, to: string, steps: CollectionMigrationStep[]): CollectionMigrationStep[] {
  if (from === to) return [];
  const ids = new Set<string>();
  const byFrom = new Map<string, CollectionMigrationStep>();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`collection_migration_duplicate_step:${step.id}`);
    ids.add(step.id);
    if (byFrom.has(step.from_version)) throw new Error(`collection_migration_ambiguous:${step.from_version}`);
    byFrom.set(step.from_version, step);
  }
  const route: CollectionMigrationStep[] = [];
  const visited = new Set<string>();
  let version = from;
  while (version !== to) {
    if (visited.has(version)) throw new Error(`collection_migration_cycle:${version}`);
    visited.add(version);
    const step = byFrom.get(version);
    if (!step) throw new Error(`collection_migration_path_missing:${version}:${to}`);
    route.push(step);
    version = step.to_version;
  }
  return route;
}

function validateRecordAgainstSchema(record: CollectionRecord, schema: CollectionSchema): void {
  const data = record.data;
  const fields = schema.fields.map((item, index) => ({ item, id: definitionId(item, `field_${index + 1}`) }));
  const allowed = new Set(fields.map(({ id }) => id));
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`collection_field_unknown:${key}`);
  for (const { item, id } of fields) {
    if (item.required === true && (data[id] === undefined || data[id] === null || data[id] === "")) throw new Error(`collection_field_required:${id}`);
  }
}

function assertUniqueDefinitions(items: Array<Record<string, JsonValue>>, kind: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const id = definitionId(item, `${kind}_${index + 1}`);
    if (seen.has(id)) throw new Error(`collection_${kind}_duplicate:${id}`);
    seen.add(id);
  });
}

function assertNoActionCycle(actions: Array<Record<string, JsonValue>>): void {
  const graph = new Map(actions.map((item, index) => [definitionId(item, `action_${index + 1}`), definitionStringArray(item, "next_actions")]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`collection_action_cycle:${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) {
      if (!graph.has(next)) throw new Error(`collection_action_target_missing:${id}:${next}`);
      visit(next);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function definitionId(item: Record<string, JsonValue>, fallback: string): string {
  return definitionString(item, "id") ?? definitionString(item, "name") ?? fallback;
}
function definitionString(item: Record<string, JsonValue>, key: string): string | undefined {
  return typeof item[key] === "string" && item[key].trim() ? item[key] : undefined;
}
function definitionStringArray(item: Record<string, JsonValue>, key: string): string[] {
  const value = item[key];
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : [];
}
