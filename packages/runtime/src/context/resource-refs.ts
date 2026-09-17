import { stableHash, type MemoryFrontmatter, type ResourceRef } from "@samurai-agent/core-schemas";

/**
 * The scope attached to a Completion resource is part of the execution
 * proof.  A plain ResourceRef intentionally has no authority semantics, so
 * Runtime keeps this additive type private to the context handoff boundary.
 */
export type RuntimeContextSourceScope =
  | { kind: "room"; room_id: string }
  | { kind: "agent"; agent_id: string };

export interface RuntimeContextResourceRef extends ResourceRef {
  kind: "knowledge" | "skill";
  /** Completion versions are immutable once selected for a Run. */
  version: string;
  /** The hash is checked by the Completion reader before this ref is made. */
  content_hash: string;
  /** The ref never carries Workspace scope. */
  source_scope: RuntimeContextSourceScope;
}

export interface RuntimeContextResourceRefInput {
  kind: "knowledge" | "skill";
  id: string;
  version: string | number;
  contentHash: string;
  sourceScope: RuntimeContextSourceScope;
  uri?: string;
  label?: string;
}

/**
 * Builds the only ref shape that can cross the Runtime context boundary for
 * Completion Knowledge/Skill.  URI and label are host-derived values; a
 * caller cannot use them to select a different resource.
 */
export function executionResourceRef(input: RuntimeContextResourceRefInput): RuntimeContextResourceRef {
  if (input.kind !== "knowledge" && input.kind !== "skill") throw new Error("runtime_context_resource_ref_invalid");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const version = typeof input.version === "string" || typeof input.version === "number" ? String(input.version).trim() : "";
  const contentHash = typeof input.contentHash === "string" ? input.contentHash.trim() : "";
  const uri = typeof input.uri === "string" ? input.uri.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!id || !version || !contentHash) throw new Error("runtime_context_resource_ref_invalid");
  if (!isRuntimeContextSourceScope(input.sourceScope)) {
    throw new Error("runtime_context_resource_scope_invalid");
  }
  return {
    kind: input.kind,
    id,
    version,
    content_hash: contentHash,
    uri: uri || `${input.kind}/${id}/v${version}`,
    ...(label ? { label } : {}),
    source_scope: input.sourceScope
  };
}

export function isRuntimeContextResourceRef(value: unknown): value is RuntimeContextResourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return (ref.kind === "knowledge" || ref.kind === "skill")
    && typeof ref.id === "string" && Boolean(ref.id.trim())
    && typeof ref.uri === "string" && Boolean(ref.uri.trim())
    && typeof ref.version === "string" && Boolean(ref.version.trim())
    && typeof ref.content_hash === "string" && Boolean(ref.content_hash.trim())
    && isRuntimeContextSourceScope(ref.source_scope);
}

export function isRuntimeContextSourceScope(value: unknown): value is RuntimeContextSourceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.kind === "room"
    ? typeof scope.room_id === "string" && Boolean(scope.room_id.trim())
    : scope.kind === "agent"
      ? typeof scope.agent_id === "string" && Boolean(scope.agent_id.trim())
      : false;
}

export function memoryRef(memory: Pick<MemoryFrontmatter, "id" | "state" | "topic"> & { file_path?: string }): ResourceRef {
  return {
    kind: "memory",
    id: memory.id,
    uri: memory.file_path ?? `memory/${memory.state}/${memory.id}.md`,
    label: memory.topic
  };
}

export function fileRef(path: string): ResourceRef {
  return {
    kind: "file",
    id: stableHash(path),
    uri: path,
    label: path
  };
}
