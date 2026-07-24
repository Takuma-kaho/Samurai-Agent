import { stableHash, type MemoryFrontmatter, type ResourceRef } from "@samurai-agent/core-schemas";

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
