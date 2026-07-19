export interface SkillPackageSnapshot {
  id: string;
  title: string;
  description: string;
  markdown: string;
  support_files: Array<{ path: string; content: string }>;
}

export interface SkillConsolidationResult {
  primary_skill_id: string;
  markdown: string;
  support_files: Array<{ path: string; content: string }>;
  archive_skill_ids: string[];
  reason: string;
}

export interface SkillConsolidationRunner {
  consolidate(input: { group_key: string; packages: SkillPackageSnapshot[] }): Promise<SkillConsolidationResult | undefined>;
}

export interface SkillConsolidationCandidate {
  id: string;
  title: string;
  description: string;
  state: string;
  tags: string[];
  required_capabilities: string[];
  owner_pinned?: boolean;
}

export function buildSkillConsolidationGroups<T extends SkillConsolidationCandidate>(skills: T[]): Array<{ groupKey: string; suggestedTitle: string; reason: string; skills: T[] }> {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    if (skill.state === "archived" || skill.state === "pinned" || skill.owner_pinned) continue;
    const titleTerm = `${skill.title} ${skill.description}`.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,}/u)?.[0];
    const key = (skill.required_capabilities[0] ?? skill.tags[0] ?? titleTerm ?? "").trim().toLocaleLowerCase();
    if (key.length < 3) continue;
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([groupKey, group]) => ({
      groupKey,
      suggestedTitle: `${group[0]!.title} umbrella`,
      reason: "Similar Skills share a capability, tag, or title term.",
      skills: group.slice(0, 5)
    }));
}

export function skillConsolidationPrompt(input: { group_key: string; packages: SkillPackageSnapshot[] }): string {
  return [
    "Consolidate only these already narrowed, similar Skill packages.",
    "Preserve reusable procedures and required support-file content. Do not broaden scope beyond this group.",
    "Return JSON only: { primary_skill_id, markdown, support_files:[{path,content}], archive_skill_ids, reason }.",
    JSON.stringify(input)
  ].join("\n\n");
}

export function parseSkillConsolidationResult(text: string): SkillConsolidationResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate) as SkillConsolidationResult;
}
