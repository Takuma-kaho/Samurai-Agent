import type { ArtifactRecord } from "@samurai-agent/core-schemas";

export function artifactContentTypeFromMetadata(artifact: ArtifactRecord): string {
  const contentType = artifact.metadata.content_type;
  return typeof contentType === "string" ? contentType : "text/markdown";
}

export function isTextArtifactContentType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json" || contentType === "application/markdown";
}

export function safeArtifactExtension(extension: string): string {
  const normalized = extension.trim().replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized)) {
    throw new Error("artifact_extension_invalid");
  }
  return normalized;
}


