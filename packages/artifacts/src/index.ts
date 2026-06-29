import {
  type ArtifactRecord,
  type JsonValue,
  type OperationRecord,
  type SupportedLocale,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";
import { createHash } from "node:crypto";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export type ArtifactKind = ArtifactRecord["kind"];
export interface ArtifactBinaryPayload {
  bytes: Uint8Array;
  mime_type: string;
  extension?: string;
  preview?: string;
}

export type ArtifactPayload = string | Record<string, unknown> | unknown[] | ArtifactBinaryPayload;

export interface CreateArtifactDraftInput {
  store: WorkspaceStore;
  operation: OperationRecord;
  title: string;
  content: ArtifactPayload;
  kind?: ArtifactKind;
  locale: SupportedLocale;
  sourceLocales: SupportedLocale[];
  createdBy: string;
  metadata?: Record<string, JsonValue>;
}

export async function createArtifactDraft(input: CreateArtifactDraftInput): Promise<ArtifactRecord> {
  const now = nowIso();
  const id = createId("artifact");
  const kind = input.kind ?? "markdown";
  const binaryPayload = isArtifactBinaryPayload(input.content) ? input.content : undefined;
  const content = binaryPayload ? undefined : serializeArtifactContent(kind, input.content);
  const relativePath = binaryPayload
    ? await input.store.writeArtifactContent(id, binaryPayload.bytes, { extension: artifactExtension(kind, binaryPayload.mime_type, binaryPayload.extension) })
    : await input.store.writeArtifactContent(id, content ?? "");
  const metadata: Record<string, JsonValue> = {
    ...input.metadata,
    preview: binaryPayload ? binaryPayload.preview ?? "" : createArtifactPreview(content ?? ""),
    word_count: !binaryPayload && (kind === "markdown" || kind === "document" || kind === "generated_report" || kind === "note")
      ? (content ?? "").trim().split(/\s+/).filter(Boolean).length
      : 0,
    content_type: binaryPayload?.mime_type ?? artifactContentType(kind),
    status: "draft",
    byte_size: binaryPayload?.bytes.byteLength ?? Buffer.byteLength(content ?? "", "utf8"),
    content_hash: binaryPayload ? hashBytes(binaryPayload.bytes) : hashText(content ?? "")
  };
  if (binaryPayload) {
    metadata.binary = true;
  } else if (typeof input.content !== "string") {
    metadata.structured_payload = input.content as JsonValue;
  }

  const record: ArtifactRecord = {
    id,
    title: input.title,
    kind,
    locale: input.locale,
    source_locales: input.sourceLocales,
    file_ref: {
      kind: "artifact",
      id,
      uri: relativePath,
      version: now,
      label: input.title
    },
    metadata,
    source_operation_id: input.operation.id,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now
  };

  return input.store.saveArtifactMetadata(record);
}

function serializeArtifactContent(kind: ArtifactKind, content: ArtifactPayload): string {
  if (isArtifactBinaryPayload(content)) {
    throw new Error("binary_artifact_payload_requires_binary_writer");
  }
  if (typeof content === "string") {
    return content;
  }
  if (kind === "table" || kind === "chart" || kind === "structured_draft") {
    return `${JSON.stringify(content, null, 2)}\n`;
  }
  return `${JSON.stringify({ kind, content }, null, 2)}\n`;
}

function artifactContentType(kind: ArtifactKind): string {
  if (kind === "table" || kind === "chart" || kind === "structured_draft") {
    return "application/json";
  }
  if (kind === "pdf") {
    return "application/pdf";
  }
  if (kind === "image") {
    return "image/*";
  }
  return "text/markdown";
}

function artifactExtension(kind: ArtifactKind, mimeType: string, explicitExtension?: string): string {
  const normalized = explicitExtension?.trim().replace(/^\./, "").toLowerCase();
  if (normalized && /^[a-z0-9]+$/.test(normalized)) {
    return normalized;
  }
  if (mimeType === "application/pdf" || kind === "pdf") {
    return "pdf";
  }
  if (mimeType === "image/png") {
    return "png";
  }
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/svg+xml") {
    return "svg";
  }
  if (kind === "image") {
    return "img";
  }
  return "bin";
}

function isArtifactBinaryPayload(value: ArtifactPayload): value is ArtifactBinaryPayload {
  return typeof value === "object" && value !== null && "bytes" in value && value.bytes instanceof Uint8Array && typeof value.mime_type === "string";
}

function hashText(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createArtifactPreview(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}
