const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const artifactKinds = new Set(["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"]);
const locales = new Set(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]);

export function workspaceArtifactListRequest(input: unknown): { roomId: string } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId") };
}

export function workspaceArtifactIdRequest(input: unknown): { roomId: string; artifactId: string } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId"), artifactId: requiredOpaque(value, "artifactId") };
}

export function workspaceArtifactCreateRequest(input: unknown): { operationId: string; body: Record<string, unknown> } {
  const value = object(input);
  const content = value.content;
  if (typeof content !== "string" && !isJsonValue(content)) throw new Error("content_invalid");
  const body: Record<string, unknown> = {
    room_id: requiredOpaque(value, "roomId"),
    title: requiredText(value, "title", 20_000),
    content
  };
  if (value.kind !== undefined) {
    if (typeof value.kind !== "string" || !artifactKinds.has(value.kind)) throw new Error("kind_invalid");
    body.kind = value.kind;
  }
  if (value.locale !== undefined) body.locale = requiredLocale(value.locale);
  if (value.sourceLocales !== undefined) {
    if (!Array.isArray(value.sourceLocales) || value.sourceLocales.length < 1 || value.sourceLocales.some((item) => typeof item !== "string" || !locales.has(item))) throw new Error("sourceLocales_invalid");
    body.source_locales = value.sourceLocales;
  }
  if (value.metadata !== undefined) body.metadata = requiredJsonObject(value.metadata, "metadata");
  return { operationId: requiredOpaque(value, "operationId"), body };
}

export function workspaceArtifactSurfaceOperationRequest(input: unknown): { roomId: string; operationId: string; body: Record<string, unknown> } {
  const value = object(input);
  const operation = requiredJsonObject(value.operation, "operation");
  if (typeof operation.id !== "string" || !opaqueIdPattern.test(operation.id) || operation.kind !== "artifact.request") throw new Error("artifact_surface_operation_invalid");
  return { roomId: requiredOpaque(value, "roomId"), operationId: operation.id, body: { room_id: requiredOpaque(value, "roomId"), operation } };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_artifact_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function requiredText(value: Record<string, unknown>, key: string, max: number): string {
  if (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > max) throw new Error(`${key}_invalid`);
  return (value[key] as string).trim();
}

function requiredLocale(value: unknown): string {
  if (typeof value !== "string" || !locales.has(value)) throw new Error("locale_invalid");
  return value;
}

function requiredJsonObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !isJsonObject(value) || JSON.stringify(value).length > 200_000) throw new Error(`${key}_invalid`);
  return value as Record<string, unknown>;
}

function isJsonObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
