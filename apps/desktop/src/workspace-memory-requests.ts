const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workspaceMemoryListRequest(input: unknown): { roomId: string; includeArchived: boolean } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId"), includeArchived: value.includeArchived === true };
}

export function workspaceMemoryIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "memoryId");
}

export function workspaceMemorySearchRequest(input: unknown): { roomId: string; query: string; limit?: number } {
  const value = object(input);
  if (typeof value.query !== "string" || !value.query.trim() || value.query.length > 2_000) throw new Error("query_invalid");
  return { roomId: requiredOpaque(value, "roomId"), query: value.query.trim(), ...(value.limit === undefined ? {} : { limit: integer(value, "limit", 1, 100) }) };
}

export function workspaceMemoryArchiveRequest(input: unknown): { memoryId: string; operationId: string; reason: string } {
  const value = object(input);
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4_000) throw new Error("reason_invalid");
  return { memoryId: requiredOpaque(value, "memoryId"), operationId: requiredOpaque(value, "operationId"), reason: value.reason.trim() };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_memory_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function integer(value: Record<string, unknown>, key: string, min: number, max: number): number {
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) throw new Error(`${key}_invalid`);
  return value[key] as number;
}
