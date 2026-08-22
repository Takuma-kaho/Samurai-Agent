const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workspaceCollectionRoomRequest(input: unknown): { roomId: string } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId") };
}

export function workspaceCollectionSchemaSaveRequest(input: unknown): {
  roomId: string;
  operationId: string;
  expectedVersion?: number;
  schema: Record<string, unknown>;
} {
  const value = object(input);
  const schema = requiredJsonObject(value, "schema");
  return {
    roomId: requiredOpaque(value, "roomId"),
    operationId: requiredOpaque(value, "operationId"),
    ...(value.expectedVersion === undefined ? {} : { expectedVersion: requiredInteger(value, "expectedVersion", 0) }),
    schema
  };
}

export function workspaceCollectionIdRequest(input: unknown): { roomId: string; collectionId: string } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId"), collectionId: requiredOpaque(value, "collectionId") };
}

export function workspaceCollectionRecordCreateRequest(input: unknown): {
  roomId: string;
  collectionId: string;
  operationId: string;
  body: { room_id: string; record_id: string; data: Record<string, unknown> };
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  return {
    roomId,
    collectionId: requiredOpaque(value, "collectionId"),
    operationId: requiredOpaque(value, "operationId"),
    body: { room_id: roomId, record_id: requiredOpaque(value, "recordId"), data: requiredJsonObject(value, "data") }
  };
}

export function workspaceCollectionRecordPatchRequest(input: unknown): {
  roomId: string;
  collectionId: string;
  recordId: string;
  operationId: string;
  body: { room_id: string; patch_id?: string; changes: Record<string, unknown>; expected_version?: number };
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  const patchId = optionalOpaque(value, "patchId");
  return {
    roomId,
    collectionId: requiredOpaque(value, "collectionId"),
    recordId: requiredOpaque(value, "recordId"),
    operationId: requiredOpaque(value, "operationId"),
    body: {
      room_id: roomId,
      ...(patchId ? { patch_id: patchId } : {}),
      changes: requiredJsonObject(value, "changes"),
      ...(value.expectedVersion === undefined ? {} : { expected_version: requiredInteger(value, "expectedVersion", 1) })
    }
  };
}

export function workspaceCollectionRecordDeleteRequest(input: unknown): {
  roomId: string;
  collectionId: string;
  recordId: string;
  operationId: string;
  body: { room_id: string; expected_version: number };
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  return {
    roomId,
    collectionId: requiredOpaque(value, "collectionId"),
    recordId: requiredOpaque(value, "recordId"),
    operationId: requiredOpaque(value, "operationId"),
    body: { room_id: roomId, expected_version: requiredInteger(value, "expectedVersion", 1) }
  };
}

export function workspaceCollectionSurfaceOperationRequest(input: unknown): {
  roomId: string;
  operationId: string;
  body: { room_id: string; operation: Record<string, unknown> };
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  const operation = requiredJsonObject(value, "operation");
  const operationId = requiredOpaque(operation, "id");
  const kind = operation.kind;
  if (typeof kind !== "string" || ![
    "collection.view.present",
    "collection.record.create",
    "collection.record.patch",
    "collection.record.delete",
    "collection.action.run"
  ].includes(kind)) throw new Error("collection_surface_operation_kind_invalid");
  requiredOpaque(operation, "collection_id");
  if (kind === "collection.record.create") {
    requiredOpaque(operation, "record_id");
    requiredJsonObject(operation, "data");
  } else if (kind === "collection.record.patch") {
    requiredOpaque(operation, "record_id");
    requiredJsonObject(operation, "changes");
    if (operation.patch_id !== undefined) requiredOpaque(operation, "patch_id");
    if (operation.expected_version !== undefined) requiredInteger(operation, "expected_version", 1);
  } else if (kind === "collection.record.delete") {
    requiredOpaque(operation, "record_id");
    requiredInteger(operation, "expected_version", 1);
  } else if (kind === "collection.action.run") {
    requiredOpaque(operation, "action_id");
    if (operation.record_id !== undefined) requiredOpaque(operation, "record_id");
    if (operation.payload !== undefined) requiredJsonObject(operation, "payload");
  }
  return { roomId, operationId, body: { room_id: roomId, operation } };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_collection_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function optionalOpaque(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredOpaque(value, key);
}

function requiredInteger(value: Record<string, unknown>, key: string, min: number): number {
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < min) throw new Error(`${key}_invalid`);
  return value[key] as number;
}

function requiredJsonObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (!isJsonObject(candidate) || JSON.stringify(candidate).length > 200_000) throw new Error(`${key}_invalid`);
  return candidate as Record<string, unknown>;
}

function isJsonObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
