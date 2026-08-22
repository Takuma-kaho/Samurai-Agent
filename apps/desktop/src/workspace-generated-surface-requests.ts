const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workspaceGeneratedSurfaceRoomRequest(input: unknown): { roomId: string; surfaceId: string } {
  const value = object(input);
  return { roomId: requiredOpaque(value, "roomId"), surfaceId: requiredOpaque(value, "surfaceId") };
}

export function workspaceGeneratedSurfaceBundleRequest(input: unknown): { roomId: string; surfaceId: string; revisionId: string } {
  const value = object(input);
  return {
    roomId: requiredOpaque(value, "roomId"),
    surfaceId: requiredOpaque(value, "surfaceId"),
    revisionId: requiredOpaque(value, "revisionId")
  };
}

export function workspaceGeneratedSurfaceActionRequest(input: unknown): {
  roomId: string;
  surfaceId: string;
  actionId: string;
  operationId: string;
  body: Record<string, unknown>;
} {
  const value = object(input);
  const roomId = requiredOpaque(value, "roomId");
  const surfaceId = requiredOpaque(value, "surfaceId");
  const actionId = requiredOpaque(value, "actionId");
  const operationId = requiredOpaque(value, "operationId");
  const body: Record<string, unknown> = { room_id: roomId };
  for (const [key, outputKey] of [["revisionId", "revision_id"], ["interactionId", "interaction_id"], ["messageId", "message_id"]] as const) {
    if (value[key] !== undefined) body[outputKey] = requiredOpaque(value, key);
  }
  if (value.actionPayload !== undefined) body.action_payload = requiredJsonObject(value.actionPayload, "actionPayload");
  return { roomId, surfaceId, actionId, operationId, body };
}

export function workspaceGeneratedSurfaceStateRequest(input: unknown): {
  roomId: string;
  surfaceId: string;
  operationId: string;
  action: "pin" | "unpin" | "archive";
  body: Record<string, unknown>;
} {
  const value = object(input);
  const action = value.action;
  if (action !== "pin" && action !== "unpin" && action !== "archive") throw new Error("action_invalid");
  const roomId = requiredOpaque(value, "roomId");
  const surfaceId = requiredOpaque(value, "surfaceId");
  const operationId = requiredOpaque(value, "operationId");
  return {
    roomId,
    surfaceId,
    operationId,
    action,
    body: {
      room_id: roomId,
      action,
      ...(value.interactionId === undefined ? {} : { interaction_id: requiredOpaque(value, "interactionId") }),
      ...(value.messageId === undefined ? {} : { message_id: requiredOpaque(value, "messageId") })
    }
  };
}

export function workspaceGeneratedSurfaceExportRequest(input: unknown): {
  roomId: string;
  surfaceId: string;
  revisionId?: string;
  format: "html" | "zip";
} {
  const value = object(input);
  const format = value.format;
  if (format !== "html" && format !== "zip") throw new Error("format_invalid");
  return {
    roomId: requiredOpaque(value, "roomId"),
    surfaceId: requiredOpaque(value, "surfaceId"),
    ...(value.revisionId === undefined ? {} : { revisionId: requiredOpaque(value, "revisionId") }),
    format
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_generated_surface_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function requiredJsonObject(value: unknown, key: string): Record<string, unknown> {
  if (!isJsonObject(value) || JSON.stringify(value).length > 200_000) throw new Error(`${key}_invalid`);
  return value as Record<string, unknown>;
}

function isJsonObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
