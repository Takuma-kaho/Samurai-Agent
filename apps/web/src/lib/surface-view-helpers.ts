import type { ArtifactRecord, JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

export type CanvasMode = "preview" | "edit" | "app";

export function surfaceValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function defaultCanvasMode(spec: SurfaceRenderSpec): CanvasMode {
  if (spec.kind === "form" || spec.kind === "table" || spec.kind === "collection_record") return "edit";
  if (spec.kind === "chart" || spec.kind === "custom_view") return "app";
  return "preview";
}

export function isArtifactPreviewable(artifact: ArtifactRecord): boolean {
  return ["markdown", "document", "note", "generated_report", "pdf", "image"].includes(artifact.kind);
}

export function artifactContentUrl(artifact: ArtifactRecord): string {
  return `/api/artifacts/${encodeURIComponent(artifact.id)}/content`;
}

export function artifactContentType(artifact: ArtifactRecord): string {
  const contentType = artifact.metadata.content_type;
  if (typeof contentType === "string") return contentType;
  if (artifact.kind === "pdf") return "application/pdf";
  if (artifact.kind === "image") return "image/*";
  return "text/markdown";
}

export function isPdfArtifact(artifact: ArtifactRecord): boolean {
  return artifact.kind === "pdf" || artifactContentType(artifact) === "application/pdf";
}

export function isImageArtifact(artifact: ArtifactRecord): boolean {
  return artifact.kind === "image" || artifactContentType(artifact).startsWith("image/");
}

export function markdownPreviewHtml(content: string): string {
  return content.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return "";
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]?.length ?? 2;
      return `<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`;
    }
    if (/^[-*]\s+/m.test(trimmed)) {
      const items = trimmed.split("\n")
        .filter((line) => /^[-*]\s+/.test(line))
        .map((line) => `<li>${inlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`)
        .join("");
      return `<ul>${items}</ul>`;
    }
    return `<p>${inlineMarkdown(trimmed).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

export function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function surfaceRowKey(row: Record<string, unknown>, rowIndex: number): string {
  return typeof row.id === "string" ? row.id : `row_${rowIndex}`;
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) return objectToJsonRecord(value);
  return String(value ?? "");
}

export function objectToJsonRecord(record: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, toJsonValue(value)]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
