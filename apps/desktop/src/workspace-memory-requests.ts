import { workspaceTargetRequest, type WorkspaceTargetRequest } from "./workspace-room-requests.js";

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workspaceMemoryListRequest(input: unknown): { roomId: string; includeArchived: boolean; target?: WorkspaceTargetRequest } {
  const value = object(input);
  const target = workspaceTargetRequest(value.target);
  return { roomId: requiredOpaque(value, "roomId"), includeArchived: value.includeArchived === true, ...(target ? { target } : {}) };
}

export function workspaceMemoryIdRequest(input: unknown): { memoryId: string; target?: WorkspaceTargetRequest } {
  const value = object(input);
  const target = workspaceTargetRequest(value.target);
  return { memoryId: requiredOpaque(value, "memoryId"), ...(target ? { target } : {}) };
}

export function workspaceMemorySearchRequest(input: unknown): { roomId: string; query: string; limit?: number; target?: WorkspaceTargetRequest } {
  const value = object(input);
  if (typeof value.query !== "string" || !value.query.trim() || value.query.length > 2_000) throw new Error("query_invalid");
  const target = workspaceTargetRequest(value.target);
  return { roomId: requiredOpaque(value, "roomId"), query: value.query.trim(), ...(value.limit === undefined ? {} : { limit: integer(value, "limit", 1, 100) }), ...(target ? { target } : {}) };
}

export function workspaceMemoryArchiveRequest(input: unknown): { memoryId: string; operationId: string; reason: string; target?: WorkspaceTargetRequest } {
  const value = object(input);
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 4_000) throw new Error("reason_invalid");
  const target = workspaceTargetRequest(value.target);
  return { memoryId: requiredOpaque(value, "memoryId"), operationId: requiredOpaque(value, "operationId"), reason: value.reason.trim(), ...(target ? { target } : {}) };
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
