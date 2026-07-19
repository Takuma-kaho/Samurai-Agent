export interface MemoryCuratorInput {
  id: string;
  topic: string;
  state: string;
  confidence: number;
  updated_at: string;
  content: string;
}

export interface MemoryCuratorDecision {
  kind: "keep" | "review" | "merge" | "stale";
  resource_ids: string[];
  reason: string;
}

export function curateMemory(resources: MemoryCuratorInput[], policy: { now?: string; archive_after_days?: number } = {}): MemoryCuratorDecision[] {
  const decisions: MemoryCuratorDecision[] = [];
  const groups = new Map<string, MemoryCuratorInput[]>();
  for (const resource of resources.filter((item) => item.state !== "archived")) {
    const key = resource.topic.trim().toLocaleLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), resource]);
    if (resource.confidence < 0.5) decisions.push({ kind: "review", resource_ids: [resource.id], reason: "low_confidence" });
    const ageDays = policy.now ? (Date.parse(policy.now) - Date.parse(resource.updated_at)) / 86_400_000 : 0;
    if (policy.archive_after_days && Number.isFinite(ageDays) && ageDays >= policy.archive_after_days && resource.state !== "sensitive") {
      decisions.push({ kind: "stale", resource_ids: [resource.id], reason: "old_fact_archive_candidate" });
    }
  }
  for (const group of groups.values()) {
    if (group.length > 1) decisions.push({ kind: "merge", resource_ids: group.map((item) => item.id), reason: "duplicate_topic" });
  }
  return decisions;
}
