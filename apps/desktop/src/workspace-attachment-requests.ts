const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const attachmentPathPattern = /^attachments\/[A-Za-z0-9._-]{1,220}$/;
const maxAttachmentBase64Length = Math.ceil((8 * 1024 * 1024) / 3) * 4;

export type WorkspaceAttachmentRequest = {
  roomId: string;
  filePath: string;
  operationId: string;
  body: {
    room_id: string;
    content_base64: string;
    expected_version: number;
  };
};

export function workspaceAttachmentRequest(input: unknown): WorkspaceAttachmentRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_attachment_request_invalid");
  const value = input as Record<string, unknown>;
  const roomId = requiredOpaque(value, "roomId");
  const filePath = value.path;
  if (typeof filePath !== "string" || !attachmentPathPattern.test(filePath)) throw new Error("path_invalid");
  const operationId = requiredOpaque(value, "operationId");
  const contentBase64 = value.contentBase64;
  if (typeof contentBase64 !== "string" || contentBase64.length > maxAttachmentBase64Length || contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) {
    throw new Error("contentBase64_invalid");
  }
  const expectedVersion = value.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("expectedVersion_invalid");
  return {
    roomId,
    filePath,
    operationId,
    body: { room_id: roomId, content_base64: contentBase64, expected_version: expectedVersion }
  };
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !opaqueIdPattern.test(candidate)) throw new Error(`${key}_invalid`);
  return candidate;
}
