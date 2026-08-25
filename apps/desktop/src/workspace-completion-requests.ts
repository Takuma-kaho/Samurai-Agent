const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const knowledgeKinds = new Set(["fact", "decision", "explanation", "experience_rule"]);
const supportedLocales = new Set(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]);

export type WorkspaceCompletionScope =
  | { scopeKind: "workspace"; roomId?: never }
  | { scopeKind: "room"; roomId: string };

export type WorkspaceCompletionResourceKind = "knowledge" | "skill";

export function workspaceCompletionResourceListRequest(input: unknown): WorkspaceCompletionScope & {
  kind?: WorkspaceCompletionResourceKind;
  includeArchived?: boolean;
} {
  const value = object(input);
  const scope = scopeRequest(value);
  const kind = value.kind === undefined ? undefined : resourceKind(value.kind);
  return {
    ...scope,
    ...(kind ? { kind } : {}),
    ...(value.includeArchived === true ? { includeArchived: true } : {})
  };
}

export function workspaceCompletionResourceIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "resourceId");
}

export function workspaceCompletionSearchRequest(input: unknown): { roomId: string; query: string; limit?: number } {
  const value = object(input);
  return {
    roomId: requiredOpaque(value, "roomId"),
    query: requiredText(value, "query", 2_000),
    ...(value.limit === undefined ? {} : { limit: requiredInteger(value, "limit", 1, 100) })
  };
}

export function workspaceWikiListRequest(input: unknown): { roomId: string; includeArchived: boolean } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId"), includeArchived: value.includeArchived === true };
}

export function workspaceWikiQueryRequest(input: unknown): { roomId: string; query?: string } {
  const value = object(input);
  const query = optionalText(value, "query", 2_000);
  return { roomId: requiredOpaque(value, "roomId"), ...(query ? { query } : {}) };
}

export function workspaceWikiIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "wikiId");
}

export function workspaceWikiCreateRequest(input: unknown): {
  operationId: string;
  body: { room_id: string; title: string; content: string; slug?: string; tags?: string[]; content_locale?: string; knowledge_kind?: "fact" | "decision" | "explanation" | "experience_rule"; reason: string };
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  const title = requiredText(value, "title", 20_000);
  const content = requiredText(value, "content", 200_000);
  const slug = optionalText(value, "slug", 160);
  const tags = optionalStringArray(value, "tags");
  const locale = optionalLocale(value, "contentLocale");
  const knowledgeKind = value.knowledgeKind === undefined ? undefined : requiredKnowledgeKind(value.knowledgeKind);
  return {
    operationId: requiredOpaque(value, "operationId"),
    body: {
      room_id: roomId, title, content,
      ...(slug ? { slug } : {}), ...(tags ? { tags } : {}), ...(locale ? { content_locale: locale } : {}),
      ...(knowledgeKind ? { knowledge_kind: knowledgeKind } : {}), reason: requiredText(value, "reason", 4_000)
    }
  };
}

export function workspaceWikiPatchRequest(input: unknown): {
  wikiId: string;
  operationId: string;
  body: { title?: string; content?: string; tags?: string[]; content_locale?: string; reason: string };
} {
  const value = object(input);
  const title = optionalText(value, "title", 20_000);
  const content = optionalText(value, "content", 200_000);
  const tags = optionalStringArray(value, "tags");
  const locale = optionalLocale(value, "contentLocale");
  if (!title && !content && !tags && !locale) throw new Error("wiki_patch_empty");
  return {
    wikiId: requiredOpaque(value, "wikiId"), operationId: requiredOpaque(value, "operationId"),
    body: { ...(title ? { title } : {}), ...(content ? { content } : {}), ...(tags ? { tags } : {}), ...(locale ? { content_locale: locale } : {}), reason: requiredText(value, "reason", 4_000) }
  };
}

export function workspaceWikiStateRequest(input: unknown): { wikiId: string; operationId: string; reason: string } {
  const value = object(input);
  return { wikiId: requiredOpaque(value, "wikiId"), operationId: requiredOpaque(value, "operationId"), reason: requiredText(value, "reason", 4_000) };
}

export function workspaceCompletionResourceCreateRequest(input: unknown): {
  operationId: string;
  body: {
    scope_kind: "workspace" | "room";
    room_id?: string;
    kind: WorkspaceCompletionResourceKind;
    knowledge_kind?: "fact" | "decision" | "explanation" | "experience_rule";
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    reason: string;
  };
} {
  const value = object(input);
  const scope = scopeRequest(value);
  const kind = resourceKind(value.kind);
  const knowledgeKind = kind === "knowledge" ? requiredKnowledgeKind(value.knowledgeKind) : undefined;
  return {
    operationId: requiredOpaque(value, "operationId"),
    body: {
      scope_kind: scope.scopeKind,
      ...(scope.scopeKind === "room" ? { room_id: scope.roomId } : {}),
      kind,
      ...(knowledgeKind ? { knowledge_kind: knowledgeKind } : {}),
      title: requiredText(value, "title", 20_000),
      content: requiredText(value, "content", 200_000),
      metadata: optionalJsonObject(value, "metadata") ?? {},
      reason: requiredText(value, "reason", 4_000)
    }
  };
}

export function workspaceCompletionResourceUpdateRequest(input: unknown): {
  resourceId: string;
  operationId: string;
  body: ReturnType<typeof workspaceCompletionResourceCreateRequest>["body"] & { expected_version: number };
} {
  const created = workspaceCompletionResourceCreateRequest(input);
  return {
    resourceId: workspaceCompletionResourceIdRequest(input),
    operationId: created.operationId,
    body: { ...created.body, expected_version: requiredInteger(object(input), "expectedVersion", 1, Number.MAX_SAFE_INTEGER) }
  };
}

export function workspaceCompletionResourceStateRequest(input: unknown, action: "fixed" | "archive"): {
  resourceId: string;
  operationId: string;
  body: { fixed?: boolean; archived?: boolean; expected_version: number; reason: string };
} {
  const value = object(input);
  return {
    resourceId: workspaceCompletionResourceIdRequest(value),
    operationId: requiredOpaque(value, "operationId"),
    body: {
      ...(action === "fixed" ? { fixed: requiredBoolean(value, "fixed") } : { archived: requiredBoolean(value, "archived") }),
      expected_version: requiredInteger(value, "expectedVersion", 1, Number.MAX_SAFE_INTEGER),
      reason: requiredText(value, "reason", 4_000)
    }
  };
}

function scopeRequest(value: Record<string, unknown>): WorkspaceCompletionScope {
  if (value.scopeKind === "workspace") return { scopeKind: "workspace" };
  if (value.scopeKind === "room") return { scopeKind: "room", roomId: requiredOpaque(value, "roomId") };
  throw new Error("scopeKind_invalid");
}

function resourceKind(value: unknown): WorkspaceCompletionResourceKind {
  if (value === "knowledge" || value === "skill") return value;
  throw new Error("kind_invalid");
}

function requiredKnowledgeKind(value: unknown): "fact" | "decision" | "explanation" | "experience_rule" {
  if (typeof value === "string" && knowledgeKinds.has(value)) return value as "fact" | "decision" | "explanation" | "experience_rule";
  throw new Error("knowledgeKind_invalid");
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_completion_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return (value[key] as string).trim();
}

function requiredText(value: Record<string, unknown>, key: string, max: number): string {
  if (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > max) throw new Error(`${key}_invalid`);
  return (value[key] as string).trim();
}

function optionalText(value: Record<string, unknown>, key: string, max: number): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredText(value, key, max);
}

function optionalLocale(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  if (typeof value[key] !== "string" || !supportedLocales.has(value[key])) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`${key}_invalid`);
  return value[key] as boolean;
}

function requiredInteger(value: Record<string, unknown>, key: string, min: number, max: number): number {
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) throw new Error(`${key}_invalid`);
  return value[key] as number;
}

function optionalJsonObject(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (value[key] === undefined || value[key] === null) return undefined;
  if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]) || !isJsonObject(value[key])) throw new Error(`${key}_invalid`);
  if (JSON.stringify(value[key]).length > 200_000) throw new Error(`${key}_too_large`);
  return value[key] as Record<string, unknown>;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  if (value[key] === undefined || value[key] === null) return undefined;
  if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some((item) => typeof item !== "string" || !(item as string).trim())) throw new Error(`${key}_invalid`);
  return (value[key] as string[]).map((item) => item.trim());
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
