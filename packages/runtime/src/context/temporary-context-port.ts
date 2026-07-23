import type { ResourceRef } from "@samurai-agent/core-schemas";
import type { TemporaryContextAttachment } from "@samurai-agent/agent-backends";

export interface TemporaryContextPort {
  resolve(ref: ResourceRef): Promise<TemporaryContextAttachment | undefined> | TemporaryContextAttachment | undefined;
  conflict(message: string): Error;
}

export async function resolveTemporaryContext(
  port: TemporaryContextPort,
  attachments: ResourceRef[] = [],
  explicitItems: TemporaryContextAttachment[] = []
): Promise<TemporaryContextAttachment[]> {
  const explicitById = new Map(explicitItems.map((item) => [item.id, item]));
  const refs = attachments.filter((ref) => ref.kind === "temporary_context");
  if (refs.length === 0) return explicitItems;
  const resolved: TemporaryContextAttachment[] = [];
  for (const ref of refs) {
    const explicit = explicitById.get(ref.id);
    if (explicit) {
      resolved.push(explicit);
      continue;
    }
    const item = await port.resolve(ref);
    if (item) resolved.push(item);
  }
  if (resolved.length !== refs.length) throw port.conflict("temporary_context_unavailable");
  return resolved;
}
