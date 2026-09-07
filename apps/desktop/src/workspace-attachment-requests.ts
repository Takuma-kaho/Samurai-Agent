const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const attachmentPathPattern = /^attachments\/[A-Za-z0-9._-]{1,220}$/;
const maxAttachmentBase64Length = Math.ceil((8 * 1024 * 1024) / 3) * 4;

export type WorkspaceAttachmentRequest = {
  roomId: string;
  filePath: string;
  operationId: string;
  target?: {
    connectionId: string;
    workspaceId: string;
  };
  body: {
    room_id: string;
    content_base64: string;
    expected_version: number;
  };
};

export type WorkspaceAttachmentUploadResult = {
  file: {
    path: string;
    version: number;
    sha256: string;
    size: number;
  };
  resource_ref: WorkspaceAttachmentResourceRef;
  replayed?: boolean;
};

export type WorkspaceAttachmentResourceRef = {
  kind: "file";
  id: string;
  uri: string;
  version: string;
  label?: string;
};

/**
 * Normalize the only ResourceRef accepted by Room Work attachments.
 *
 * The renderer must never be able to turn a malformed or unversioned
 * reference into a request.  Keep this check at the preload boundary as well
 * as in the browser bridge so a stale/hostile renderer cannot silently drop a
 * selected file and send a different request.
 */
export function workspaceAttachmentResourceRef(input: unknown): WorkspaceAttachmentResourceRef {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_attachment_ref_invalid");
  const value = input as Record<string, unknown>;
  const allowedKeys = new Set(["kind", "id", "uri", "version", "label"]);
  const uri = safeWorkspaceFilePath(value.uri);
  const label = value.label === undefined ? uri : safeWorkspaceFileLabel(value.label);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))
    || value.kind !== "file"
    || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
    || !uri
    || typeof value.version !== "string" || !/^[1-9][0-9]*$/.test(value.version)
    || !label) {
    throw new Error("workspace_attachment_ref_invalid");
  }
  return {
    kind: "file",
    id: value.id,
    uri,
    version: value.version,
    label
  };
}

/**
 * Accept only a self-consistent response from the Workspace file endpoint.
 * The hash, URI, and version are repeated in the file metadata and the
 * ResourceRef; mismatches indicate a boundary bug and must be rejected.
 */
export function workspaceAttachmentUploadResult(input: unknown): WorkspaceAttachmentUploadResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_attachment_response_invalid");
  const value = input as Record<string, unknown>;
  const file = value.file && typeof value.file === "object" && !Array.isArray(value.file) ? value.file as Record<string, unknown> : {};
  const filePath = safeWorkspaceFilePath(file.path);
  const sha256 = typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256) ? file.sha256 : undefined;
  const version = typeof file.version === "number" && Number.isSafeInteger(file.version) && file.version > 0 ? file.version : undefined;
  const size = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 8 * 1024 * 1024 ? file.size : undefined;
  let resourceRef: WorkspaceAttachmentResourceRef;
  try {
    resourceRef = workspaceAttachmentResourceRef(value.resource_ref);
  } catch {
    throw new Error("workspace_attachment_response_invalid");
  }
  if (!filePath || !sha256 || version === undefined || size === undefined
    || resourceRef.id !== sha256 || resourceRef.uri !== filePath || resourceRef.version !== String(version)) {
    throw new Error("workspace_attachment_response_invalid");
  }
  return {
    file: { path: filePath, version, sha256, size },
    resource_ref: resourceRef,
    ...(value.replayed === true ? { replayed: true } : {})
  };
}

export function workspaceAttachmentRequest(input: unknown): WorkspaceAttachmentRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_attachment_request_invalid");
  const value = input as Record<string, unknown>;
  const roomId = requiredOpaque(value, "roomId");
  const filePath = value.path;
  if (typeof filePath !== "string" || !attachmentPathPattern.test(filePath)) throw new Error("path_invalid");
  const operationId = requiredOpaque(value, "operationId");
  const targetValue = value.target;
  const target = targetValue && typeof targetValue === "object" && !Array.isArray(targetValue)
    ? {
      connectionId: requiredOpaque(targetValue as Record<string, unknown>, "target.connectionId"),
      workspaceId: requiredOpaque(targetValue as Record<string, unknown>, "target.workspaceId")
    }
    : undefined;
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
    ...(target ? { target } : {}),
    body: { room_id: roomId, content_base64: contentBase64, expected_version: expectedVersion }
  };
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !opaqueIdPattern.test(candidate)) throw new Error(`${key}_invalid`);
  return candidate;
}

function safeWorkspaceFilePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 4_096 || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.includes("\0") || normalized.includes("//")
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return normalized;
}

function safeWorkspaceFileLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 4_096 ? normalized : undefined;
}
