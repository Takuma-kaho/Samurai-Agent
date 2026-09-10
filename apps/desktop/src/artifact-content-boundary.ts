import { createHash } from "node:crypto";

/** Keep raw Artifact responses below the Server's per-file limit. */
export const DESKTOP_ARTIFACT_MAX_CONTENT_BYTES = 8 * 1024 * 1024;

export interface DesktopArtifactRawContentHeaders {
  contentType?: string;
  contentLength?: string;
  contentEncoding?: string;
}

export interface DesktopArtifactRawContent {
  bytes: unknown;
  headers: DesktopArtifactRawContentHeaders;
}

export interface DesktopArtifactContentScope {
  workspaceId?: string;
  roomId: string;
  artifactId: string;
  revisionId?: string;
}

/**
 * Joins the JSON Artifact projection and the authenticated raw content
 * response.  Nothing from the raw endpoint is exposed until every relevant
 * identity, metadata, header, size, encoding, and hash check succeeds.
 */
export function verifyDesktopArtifactContentResponse(
  responseValue: unknown,
  rawValue: unknown,
  scope: DesktopArtifactContentScope
): Record<string, unknown> {
  const response = record(responseValue, "workspace_artifact_response_invalid");
  const raw = record(rawValue, "workspace_artifact_content_transport_invalid");
  const artifact = record(response.artifact, "workspace_artifact_response_invalid");
  const artifactMetadata = record(artifact.metadata, "workspace_artifact_metadata_invalid");
  const revision = response.revision === undefined
    ? undefined
    : record(response.revision, "workspace_artifact_revision_response_invalid");

  assertOptionalScope(response, scope);
  assertOptionalScope(artifact, scope);
  if (revision) assertOptionalScope(revision, scope);

  if (artifact.id !== scope.artifactId || response.artifact_id !== undefined && response.artifact_id !== scope.artifactId) {
    throw new Error("workspace_artifact_content_scope_invalid");
  }
  if (revision && revision.artifact_id !== scope.artifactId) {
    throw new Error("workspace_artifact_content_scope_invalid");
  }

  const currentRevisionId = optionalOpaqueId(artifactMetadata.current_revision_id, "workspace_artifact_metadata_invalid");
  if (revision) {
    const revisionId = requiredOpaqueId(revision.id, "workspace_artifact_revision_response_invalid");
    if (scope.revisionId && revisionId !== scope.revisionId) throw new Error("workspace_artifact_content_scope_invalid");
    if (!scope.revisionId && currentRevisionId && revisionId !== currentRevisionId) {
      throw new Error("workspace_artifact_content_scope_invalid");
    }
    if (response.revision_id !== undefined && response.revision_id !== revisionId) {
      throw new Error("workspace_artifact_content_scope_invalid");
    }
  } else if (scope.revisionId || response.revision_id !== undefined && response.revision_id !== currentRevisionId) {
    throw new Error("workspace_artifact_content_scope_invalid");
  }

  const responseMimeType = requiredMimeType(response.mime_type, "workspace_artifact_content_metadata_invalid");
  const responseEncoding = requiredEncoding(response.encoding, "workspace_artifact_content_metadata_invalid");
  if (typeof response.content !== "string") throw new Error("workspace_artifact_content_metadata_invalid");

  const artifactMimeType = requiredMimeTypeFromRecord(artifactMetadata, ["content_type", "mime_type"], "workspace_artifact_metadata_invalid");
  const artifactEncoding = requiredEncodingFromRecord(artifactMetadata, ["content_encoding", "encoding"], "workspace_artifact_metadata_invalid");
  const artifactByteSize = requiredByteSizeFromRecord(artifactMetadata, ["byte_size", "content_bytes"], "workspace_artifact_metadata_invalid");
  const artifactContentHash = requiredContentHashFromRecord(artifactMetadata, ["content_hash"], "workspace_artifact_metadata_invalid");

  if (revision) {
    const revisionMimeType = requiredMimeTypeFromRecord(revision, ["mime_type"], "workspace_artifact_revision_metadata_invalid");
    const revisionEncoding = requiredEncodingFromRecord(revision, ["encoding"], "workspace_artifact_revision_metadata_invalid");
    const revisionByteSize = requiredByteSizeFromRecord(revision, ["content_bytes", "byte_size"], "workspace_artifact_revision_metadata_invalid");
    const revisionContentHash = requiredContentHashFromRecord(revision, ["content_hash"], "workspace_artifact_revision_metadata_invalid");
    assertSameMetadata(responseMimeType, revisionMimeType, "workspace_artifact_content_metadata_invalid");
    assertSameMetadata(responseEncoding, revisionEncoding, "workspace_artifact_content_metadata_invalid");
    if (!scope.revisionId) {
      assertSameMetadata(artifactMimeType, revisionMimeType, "workspace_artifact_metadata_invalid");
      assertSameMetadata(artifactEncoding, revisionEncoding, "workspace_artifact_metadata_invalid");
      assertSameMetadata(artifactByteSize, revisionByteSize, "workspace_artifact_metadata_invalid");
      assertSameMetadata(artifactContentHash, revisionContentHash, "workspace_artifact_metadata_invalid");
    }
    verifyRawContent(raw, {
      mimeType: responseMimeType,
      encoding: responseEncoding,
      byteSize: revisionByteSize,
      contentHash: revisionContentHash,
      content: response.content,
      kind: artifact.kind
    });
  } else {
    assertSameMetadata(responseMimeType, artifactMimeType, "workspace_artifact_content_metadata_invalid");
    assertSameMetadata(responseEncoding, artifactEncoding, "workspace_artifact_content_metadata_invalid");
    verifyRawContent(raw, {
      mimeType: responseMimeType,
      encoding: responseEncoding,
      byteSize: artifactByteSize,
      contentHash: artifactContentHash,
      content: response.content,
      kind: artifact.kind
    });
  }

  if (response.content_bytes !== undefined) {
    const declaredBytes = byteArray(response.content_bytes, "workspace_artifact_content_metadata_invalid");
    const rawBytes = byteArray(raw.bytes, "workspace_artifact_content_transport_invalid");
    if (!sameBytes(declaredBytes, rawBytes)) throw new Error("workspace_artifact_content_metadata_mismatch");
  }
  const responseByteSize = optionalByteSize(response.byte_size, "workspace_artifact_content_metadata_invalid");
  if (responseByteSize !== undefined) {
    const rawBytes = byteArray(raw.bytes, "workspace_artifact_content_transport_invalid");
    if (responseByteSize !== rawBytes.length) throw new Error("workspace_artifact_content_size_mismatch");
  }
  const responseContentHash = optionalContentHash(response.content_hash, "workspace_artifact_content_metadata_invalid");
  if (responseContentHash !== undefined) {
    const rawBytes = byteArray(raw.bytes, "workspace_artifact_content_transport_invalid");
    if (responseContentHash !== sha256(rawBytes)) throw new Error("workspace_artifact_content_hash_mismatch");
  }

  return { ...response, content_bytes: byteArray(raw.bytes, "workspace_artifact_content_transport_invalid") };
}

function verifyRawContent(
  rawValue: Record<string, unknown>,
  expected: { mimeType: string; encoding: "utf8" | "binary"; byteSize: number; contentHash: string; content: string; kind: unknown }
): void {
  const bytes = byteArray(rawValue.bytes, "workspace_artifact_content_transport_invalid");
  const headers = record(rawValue.headers, "workspace_artifact_content_transport_invalid");
  const headerMimeType = requiredHeaderMimeType(headers.contentType);
  const headerEncoding = requiredEncoding(headers.contentEncoding, "workspace_artifact_content_transport_invalid");
  const headerByteSize = requiredHeaderByteSize(headers.contentLength);

  if (headerMimeType !== expected.mimeType) throw new Error("workspace_artifact_content_mime_mismatch");
  if (headerEncoding !== expected.encoding) throw new Error("workspace_artifact_content_encoding_mismatch");
  if (headerByteSize !== bytes.length || expected.byteSize !== bytes.length) {
    throw new Error("workspace_artifact_content_size_mismatch");
  }
  if (expected.contentHash !== sha256(bytes)) throw new Error("workspace_artifact_content_hash_mismatch");

  const binaryArtifact = expected.kind === "image" || expected.kind === "pdf";
  if (binaryArtifact && expected.encoding !== "binary") throw new Error("workspace_artifact_content_encoding_mismatch");
  if (expected.kind === "image" && !expected.mimeType.startsWith("image/")) throw new Error("workspace_artifact_content_mime_mismatch");
  if (expected.kind === "pdf" && expected.mimeType !== "application/pdf") throw new Error("workspace_artifact_content_mime_mismatch");

  if (expected.encoding === "binary") {
    if (bytes.length === 0) throw new Error("workspace_artifact_binary_content_empty");
    if (expected.content !== "") throw new Error("workspace_artifact_binary_content_text");
    return;
  }

  const decoded = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) throw new Error("workspace_artifact_content_utf8_invalid");
  if (decoded !== expected.content) throw new Error("workspace_artifact_content_text_mismatch");
}

function assertOptionalScope(recordValue: Record<string, unknown>, scope: DesktopArtifactContentScope): void {
  assertOptionalScopeField(recordValue, ["workspace_id", "workspaceId"], scope.workspaceId, "workspace_artifact_content_scope_invalid");
  assertOptionalScopeField(recordValue, ["room_id", "roomId"], scope.roomId, "workspace_artifact_content_scope_invalid");
}

function assertOptionalScopeField(recordValue: Record<string, unknown>, keys: readonly string[], expected: string | undefined, errorCode: string): void {
  if (expected === undefined) return;
  for (const key of keys) {
    if (recordValue[key] !== undefined && recordValue[key] !== expected) throw new Error(errorCode);
  }
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as Record<string, unknown>;
}

function requiredOpaqueId(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(errorCode);
  return value;
}

function optionalOpaqueId(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredOpaqueId(value, errorCode);
}

function requiredMimeType(value: unknown, errorCode: string): string {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim().toLowerCase();
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(normalized)) throw new Error(errorCode);
  return normalized;
}

function requiredMimeTypeFromRecord(recordValue: Record<string, unknown>, keys: readonly string[], errorCode: string): string {
  const values = keys.filter((key) => recordValue[key] !== undefined).map((key) => requiredMimeType(recordValue[key], errorCode));
  if (values.length === 0 || values.some((value) => value !== values[0])) throw new Error(errorCode);
  return values[0]!;
}

function requiredHeaderMimeType(value: unknown): string {
  if (typeof value !== "string") throw new Error("workspace_artifact_content_transport_invalid");
  const mimeType = value.split(";", 1)[0]?.trim();
  return requiredMimeType(mimeType, "workspace_artifact_content_transport_invalid");
}

function requiredEncoding(value: unknown, errorCode: string): "utf8" | "binary" {
  if (value !== "utf8" && value !== "binary") throw new Error(errorCode);
  return value;
}

function requiredEncodingFromRecord(recordValue: Record<string, unknown>, keys: readonly string[], errorCode: string): "utf8" | "binary" {
  const values = keys.filter((key) => recordValue[key] !== undefined).map((key) => requiredEncoding(recordValue[key], errorCode));
  if (values.length === 0 || values.some((value) => value !== values[0])) throw new Error(errorCode);
  return values[0]!;
}

function requiredByteSizeFromRecord(recordValue: Record<string, unknown>, keys: readonly string[], errorCode: string): number {
  const values = keys.filter((key) => recordValue[key] !== undefined).map((key) => requiredByteSize(recordValue[key], errorCode));
  if (values.length === 0 || values.some((value) => value !== values[0])) throw new Error(errorCode);
  return values[0]!;
}

function requiredByteSize(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) throw new Error(errorCode);
  return value;
}

function optionalByteSize(value: unknown, errorCode: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredByteSize(value, errorCode);
}

function requiredContentHashFromRecord(recordValue: Record<string, unknown>, keys: readonly string[], errorCode: string): string {
  const values = keys.filter((key) => recordValue[key] !== undefined).map((key) => requiredContentHash(recordValue[key], errorCode));
  if (values.length === 0 || values.some((value) => value !== values[0])) throw new Error(errorCode);
  return values[0]!;
}

function requiredContentHash(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(errorCode);
  return value.toLowerCase();
}

function optionalContentHash(value: unknown, errorCode: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredContentHash(value, errorCode);
}

function requiredHeaderByteSize(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error("workspace_artifact_content_transport_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) throw new Error("workspace_artifact_content_too_large");
  return parsed;
}

function byteArray(value: unknown, errorCode: string): number[] {
  if (!Array.isArray(value) || value.length > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) {
    if (Array.isArray(value) && value.length > DESKTOP_ARTIFACT_MAX_CONTENT_BYTES) throw new Error("workspace_artifact_content_too_large");
    throw new Error(errorCode);
  }
  const output = new Array<number>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) throw new Error(errorCode);
    output[index] = item;
  }
  return output;
}

function sha256(bytes: readonly number[]): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function sameBytes(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSameMetadata(left: string | number, right: string | number, errorCode: string): void {
  if (left !== right) throw new Error(errorCode);
}
