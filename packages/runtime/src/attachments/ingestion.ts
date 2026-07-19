import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { AttachmentIngestionRecordSchema, createId, nowIso, type AttachmentIngestionRecord, type JsonValue, type ResourceRef } from "@samurai-agent/core-schemas";

export interface AttachmentIngestionInput {
  filePath: string;
  fileName?: string;
  mimeType?: string;
  sessionId?: string;
  sourceRef?: ResourceRef;
  maxSourceBytes?: number;
  maxExtractedCharacters?: number;
  maxAttempts?: number;
  read?: (filePath: string) => Promise<Uint8Array>;
}

export async function ingestAttachment(input: AttachmentIngestionInput): Promise<AttachmentIngestionRecord> {
  const fileName = input.fileName ?? path.basename(input.filePath);
  const mediaType = attachmentMediaType(fileName, input.mimeType);
  const maxAttempts = input.maxAttempts ?? 3;
  let bytes: Uint8Array | undefined;
  let error: unknown;
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      bytes = await (input.read ?? (async (filePath) => readFile(filePath)))(input.filePath);
      break;
    } catch (caught) {
      error = caught;
    }
  }
  if (!bytes) throw new Error(`attachment_read_failed_after_${attempts}_attempts:${error instanceof Error ? error.message : String(error)}`);
  const maxSourceBytes = input.maxSourceBytes ?? 20 * 1024 * 1024;
  if (bytes.byteLength > maxSourceBytes) throw new Error(`attachment_source_too_large:${bytes.byteLength}:${maxSourceBytes}`);
  const extracted = extractAttachment(mediaType, Buffer.from(bytes));
  const limit = input.maxExtractedCharacters ?? 200_000;
  const truncated = extracted.text.length > limit;
  const text = truncated ? extracted.text.slice(0, limit) : extracted.text;
  const sourceHash = sha256(bytes);
  return AttachmentIngestionRecordSchema.parse({
    id: createId("attachment"),
    session_id: input.sessionId,
    source_ref: input.sourceRef ?? { kind: "attachment", id: sourceHash, uri: input.filePath, label: fileName },
    file_name: fileName,
    media_type: mediaType,
    mime_type: input.mimeType ?? defaultMimeType(mediaType),
    source_hash: sourceHash,
    source_bytes: bytes.byteLength,
    extracted_text: text,
    extracted_characters: text.length,
    truncated,
    attempts,
    status: "completed",
    trace: extracted.parts.map((part) => ({ part: part.name, characters: part.text.length, hash: sha256(Buffer.from(part.text)) })),
    metadata: extracted.metadata,
    created_at: nowIso()
  });
}

function extractAttachment(mediaType: AttachmentIngestionRecord["media_type"], bytes: Buffer): { text: string; parts: Array<{ name: string; text: string }>; metadata: Record<string, JsonValue> } {
  if (mediaType === "text") {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("attachment_text_invalid_utf8"); }
    return { text, parts: [{ name: "text", text }], metadata: { encoding: "utf-8" } };
  }
  if (mediaType === "image") {
    const dimensions = imageDimensions(bytes);
    return { text: "", parts: [], metadata: { ...dimensions, extraction: "metadata_only" } };
  }
  if (mediaType === "pdf") {
    const parts = extractPdfText(bytes);
    return { text: parts.map((part) => part.text).join("\n"), parts, metadata: { pages_or_streams: parts.length } };
  }
  const entries = unzipEntries(bytes);
  if (mediaType === "docx") {
    const xml = requiredZipText(entries, "word/document.xml");
    const text = xmlText(xml, /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
    return { text, parts: [{ name: "word/document.xml", text }], metadata: { entry_count: entries.size } };
  }
  if (mediaType === "pptx") {
    const slideNames = [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(naturalCompare);
    const parts = slideNames.map((name) => ({ name, text: xmlText(entries.get(name)!.toString("utf8"), /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g) }));
    return { text: parts.map((part) => part.text).join("\n"), parts, metadata: { slide_count: parts.length } };
  }
  const sharedXml = entries.get("xl/sharedStrings.xml")?.toString("utf8") ?? "";
  const sharedStrings = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => xmlText(match[1] ?? "", /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g));
  const sheetNames = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort(naturalCompare);
  const parts = sheetNames.map((name) => {
    const xml = entries.get(name)!.toString("utf8");
    const values = [...xml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((match) => {
      const attributes = match[1] ?? "";
      const body = match[2] ?? "";
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      return /\bt="s"/.test(attributes) ? sharedStrings[Number(raw)] ?? "" : decodeXml(raw);
    });
    return { name, text: values.join("\t") };
  });
  return { text: parts.map((part) => part.text).join("\n"), parts, metadata: { sheet_count: parts.length, shared_string_count: sharedStrings.length } };
}

function unzipEntries(bytes: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const compression = bytes.readUInt16LE(offset + 8);
    if (flags & 0x08) throw new Error("attachment_zip_data_descriptor_unsupported");
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const data = compression === 0 ? compressed : compression === 8 ? inflateRawSync(compressed) : (() => { throw new Error(`attachment_zip_compression_unsupported:${compression}`); })();
    entries.set(name, Buffer.from(data));
    offset = dataStart + compressedSize;
  }
  if (entries.size === 0) throw new Error("attachment_zip_invalid");
  return entries;
}

function extractPdfText(bytes: Buffer): Array<{ name: string; text: string }> {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("attachment_pdf_invalid");
  const source = bytes.toString("latin1");
  const parts: Array<{ name: string; text: string }> = [];
  let index = 0;
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let stream = Buffer.from(match[1] ?? "", "latin1");
    const dictionary = source.slice(Math.max(0, (match.index ?? 0) - 300), match.index);
    if (/\/FlateDecode/.test(dictionary)) stream = inflateRawSync(stream);
    const content = stream.toString("latin1");
    const strings = [...content.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(.*?)\]\s*TJ/gs)].flatMap((item) => {
      if (item[1] !== undefined) return [...item[1].matchAll(/\((?:\\.|[^\\)])*\)/g)].map((token) => decodePdfString(token[0].slice(1, -1)));
      const token = item[0].match(/^\((.*)\)\s*Tj$/s)?.[1];
      return token === undefined ? [] : [decodePdfString(token)];
    });
    const text = strings.join(" ").trim();
    if (text) parts.push({ name: `stream-${++index}`, text });
  }
  return parts;
}

function xmlText(xml: string, pattern: RegExp): string {
  return [...xml.matchAll(pattern)].map((match) => decodeXml(match[1] ?? "")).join(" ").replace(/\s+/g, " ").trim();
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function decodePdfString(value: string): string {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
  return value.replace(/\\([nrtbf()\\])/g, (_, token: string) => escapes[token] ?? token).replace(/\\([0-7]{1,3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function imageDimensions(bytes: Buffer): Record<string, JsonValue> {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return { format: "jpeg" };
  throw new Error("attachment_image_invalid");
}

function requiredZipText(entries: Map<string, Buffer>, name: string): string {
  const value = entries.get(name);
  if (!value) throw new Error(`attachment_zip_entry_missing:${name}`);
  return value.toString("utf8");
}

function attachmentMediaType(fileName: string, mimeType?: string): AttachmentIngestionRecord["media_type"] {
  const extension = path.extname(fileName).toLowerCase();
  if (mimeType?.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return "image";
  if (mimeType === "application/pdf" || extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".pptx") return "pptx";
  if (mimeType?.startsWith("text/") || [".txt", ".md", ".csv", ".json"].includes(extension)) return "text";
  throw new Error(`attachment_type_unsupported:${mimeType ?? extension}`);
}

function defaultMimeType(type: AttachmentIngestionRecord["media_type"]): string {
  return ({ image: "image/png", pdf: "application/pdf", text: "text/plain", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" })[type];
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
