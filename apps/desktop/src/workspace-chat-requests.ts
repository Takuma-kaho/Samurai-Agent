const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const supportedLocales = new Set(["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"]);

export type WorkspaceChatSessionRequest = {
  roomId: string;
  operationId: string;
  body: {
    room_id: string;
    title?: string;
    ui_locale?: string;
    output_locale?: string;
    attachments?: Array<Record<string, string>>;
  };
};

export type WorkspaceChatTurnRequest = {
  sessionId: string;
  idempotencyKey: string;
  body: {
    content: string;
    agent_id?: string;
    backend_id?: string;
    input_locale?: string;
    output_locale?: string;
    metadata?: Record<string, unknown>;
    temporary_context?: Array<Record<string, unknown>>;
  };
};

export function workspaceChatSessionIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "sessionId");
}

export function workspaceChatSessionRequest(input: unknown): WorkspaceChatSessionRequest {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  const operationId = requiredOpaque(value, "operationId");
  const title = optionalText(value, "title", 240);
  const uiLocale = optionalLocale(value, "uiLocale");
  const outputLocale = optionalLocale(value, "outputLocale");
  return {
    roomId,
    operationId,
    body: {
      room_id: roomId,
      ...(title ? { title } : {}),
      ...(uiLocale ? { ui_locale: uiLocale } : {}),
      ...(outputLocale ? { output_locale: outputLocale } : {})
    }
  };
}

export function workspaceChatTurnRequest(input: unknown): WorkspaceChatTurnRequest {
  const value = object(input);
  const sessionId = requiredOpaque(value, "sessionId");
  const idempotencyKey = requiredOpaque(value, "idempotencyKey");
  const content = requiredText(value, "content", 200_000);
  const agentId = optionalOpaque(value, "agentId");
  const backendId = optionalOpaque(value, "backendId");
  const inputLocale = optionalLocale(value, "inputLocale");
  const outputLocale = optionalLocale(value, "outputLocale");
  const metadata = optionalJsonObject(value, "metadata");
  const attachments = optionalAttachments(value, "attachments");
  const temporaryContext = optionalTemporaryContext(value, "temporaryContext");
  return {
    sessionId,
    idempotencyKey,
    body: {
      content,
      ...(agentId ? { agent_id: agentId } : {}),
      ...(backendId ? { backend_id: backendId } : {}),
      ...(inputLocale ? { input_locale: inputLocale } : {}),
      ...(outputLocale ? { output_locale: outputLocale } : {}),
      ...(metadata ? { metadata } : {}),
      ...(attachments ? { attachments } : {}),
      ...(temporaryContext ? { temporary_context: temporaryContext } : {})
    }
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_chat_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !opaqueIdPattern.test(candidate)) throw new Error(`${key}_invalid`);
  return candidate;
}

function optionalOpaque(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredOpaque(value, key);
}

function requiredText(value: Record<string, unknown>, key: string, maxLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > maxLength) throw new Error(`${key}_invalid`);
  return candidate.trim();
}

function optionalText(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredText(value, key, maxLength);
}

function optionalLocale(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  if (typeof value[key] !== "string" || !supportedLocales.has(value[key])) throw new Error(`${key}_invalid`);
  return value[key];
}

function optionalJsonObject(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  if (value[key] === undefined || value[key] === null) return undefined;
  const candidate = value[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !isJsonObject(candidate)) {
    throw new Error(`${key}_invalid`);
  }
  const encoded = JSON.stringify(candidate);
  if (encoded.length > 200_000) throw new Error(`${key}_too_large`);
  return candidate as Record<string, unknown>;
}

function optionalAttachments(value: Record<string, unknown>, key: string): Array<Record<string, string>> | undefined {
  if (value[key] === undefined || value[key] === null) return undefined;
  if (!Array.isArray(value[key]) || value[key].length > 32) throw new Error(`${key}_invalid`);
  const attachments = value[key].map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${key}_invalid`);
    const record = item as Record<string, unknown>;
    const kind = requiredResourceText(record, "kind");
    const id = requiredResourceText(record, "id");
    const uri = requiredResourceText(record, "uri");
    const label = optionalResourceText(record, "label");
    const version = optionalResourceText(record, "version");
    return {
      kind,
      id,
      uri,
      ...(label ? { label } : {}),
      ...(version ? { version } : {})
    };
  });
  return attachments;
}

function optionalTemporaryContext(value: Record<string, unknown>, key: string): Array<Record<string, unknown>> | undefined {
  if (value[key] === undefined || value[key] === null) return undefined;
  if (!Array.isArray(value[key]) || value[key].length > 4) throw new Error(`${key}_invalid`);
  return value[key].map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${key}_invalid`);
    const record = item as Record<string, unknown>;
    const id = requiredOpaque(record, "id");
    if (record.kind !== "desktop_screenshot") throw new Error(`${key}_kind_invalid`);
    const dataUrl = requiredTemporaryContextText(record, "dataUrl", 12_000_000);
    if (!dataUrl.startsWith("data:image/png;base64,")) throw new Error(`${key}_dataUrl_invalid`);
    const label = optionalTemporaryContextText(record, "label", 240);
    const sourceName = optionalTemporaryContextText(record, "sourceName", 160);
    const mimeType = record.mimeType === undefined ? "image/png" : requiredTemporaryContextText(record, "mimeType", 80);
    if (mimeType !== "image/png") throw new Error(`${key}_mimeType_invalid`);
    const createdAt = requiredTemporaryContextText(record, "createdAt", 80);
    const expiresAt = requiredTemporaryContextText(record, "expiresAt", 80);
    if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(expiresAt))) throw new Error(`${key}_timestamps_invalid`);
    const metadata = optionalJsonObject(record, "metadata");
    return {
      id,
      kind: "desktop_screenshot",
      ...(label ? { label } : {}),
      ...(sourceName ? { source_name: sourceName } : {}),
      mime_type: "image/png",
      data_url: dataUrl,
      created_at: createdAt,
      expires_at: expiresAt,
      ...(metadata ? { metadata } : {})
    };
  });
}

function requiredTemporaryContextText(value: Record<string, unknown>, key: string, maxLength: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > maxLength) throw new Error(`temporary_context_${key}_invalid`);
  return candidate.trim();
}

function optionalTemporaryContextText(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredTemporaryContextText(value, key, maxLength);
}

function requiredResourceText(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.length > 2_000) throw new Error(`attachments_${key}_invalid`);
  return candidate.trim();
}

function optionalResourceText(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredResourceText(value, key);
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
