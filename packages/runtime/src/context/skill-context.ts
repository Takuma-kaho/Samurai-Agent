import {
  type ContextPreview,
  type ResourceRef,
  type SkillFrontmatter
} from "@samurai-agent/core-schemas";

export interface SkillContextSkill {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  allowed_scopes: SkillFrontmatter["allowed_scopes"];
  required_capabilities: string[];
  owner_pinned: boolean;
  frontmatter: Pick<SkillFrontmatter, "allowed_scopes" | "owner_pinned">;
  file_path: string;
}

export interface SkillSupportFile {
  skill_id: string;
  path: string;
  file_path: string;
  content: string;
}

export interface SkillContextEnvironment {
  runtime: "local_workspace";
  platform: string;
  availableCapabilities: string[];
  supportedScopes: ReadonlySet<SkillFrontmatter["allowed_scopes"][number]>;
}

export type SkillDisclosureLevel = "catalog" | "body" | "support";
export type RuntimeSkillSelection = NonNullable<ContextPreview["selected_skills"][number]["selection"]>;

export function skillRef(skill: Pick<SkillContextSkill, "id" | "title" | "file_path">): ResourceRef {
  return {
    kind: "skill",
    id: skill.id,
    uri: skill.file_path,
    label: skill.title
  };
}

export function skillSupportFileRef(file: SkillSupportFile): ResourceRef {
  return {
    kind: "skill_support_file",
    id: `${file.skill_id}:${file.path}`,
    uri: file.file_path,
    label: file.path
  };
}

export function selectRuntimeSkills(input: {
  candidates: SkillContextSkill[];
  query: string;
  limit: number;
  environment: SkillContextEnvironment;
}): {
  selected: Array<{ skill: SkillContextSkill; selection: RuntimeSkillSelection }>;
  report: ContextPreview["skill_selection_report"];
} {
  const availableCapabilitySet = new Set(input.environment.availableCapabilities);
  const terms = skillQueryTerms(input.query);
  const evaluated = input.candidates.map((skill) => {
    const selection = evaluateSkillSelection(skill, terms, availableCapabilitySet, input.environment.supportedScopes);
    const excludedReason = selection.missing_capabilities.length
      ? "missing_capability" as const
      : selection.unsupported_scopes.length
        ? "scope_unsupported" as const
        : undefined;
    return { skill, selection, excludedReason };
  });
  const selected = evaluated
    .filter((item) => !item.excludedReason)
    .sort((left, right) => right.selection.score - left.selection.score || left.skill.title.localeCompare(right.skill.title))
    .slice(0, input.limit)
    .map(({ skill, selection }) => ({ skill, selection }));
  return {
    selected,
    report: {
      query: input.query,
      candidate_count: input.candidates.length,
      selected_count: selected.length,
      selected_skill_ids: selected.map((item) => item.skill.id),
      available_capabilities: input.environment.availableCapabilities,
      environment: {
        runtime: input.environment.runtime,
        platform: input.environment.platform
      },
      excluded: evaluated
        .filter((item) => Boolean(item.excludedReason))
        .map((item) => ({
          id: item.skill.id,
          title: item.skill.title,
          reason: item.excludedReason!,
          missing_capabilities: item.selection.missing_capabilities,
          unsupported_scopes: item.selection.unsupported_scopes
        }))
    }
  };
}

function evaluateSkillSelection(
  skill: SkillContextSkill,
  terms: string[],
  availableCapabilities: Set<string>,
  supportedScopes: ReadonlySet<SkillFrontmatter["allowed_scopes"][number]>
): RuntimeSkillSelection {
  const allowedScopes = skillAllowedScopes(skill);
  const ownerPinned = skillOwnerPinned(skill);
  const catalog = normalizeSkillSearchText([
    skill.title,
    skill.description,
    skill.tags.join(" "),
    skill.required_capabilities.join(" "),
    allowedScopes.join(" ")
  ].join(" "));
  const matchedTerms = terms.filter((term) => catalog.includes(term));
  const matchedCapabilities = skill.required_capabilities.filter((capability) => availableCapabilities.has(capability));
  const missingCapabilities = skill.required_capabilities.filter((capability) => !availableCapabilities.has(capability));
  const unsupportedScopes = allowedScopes.filter((scope) => !supportedScopes.has(scope));
  const reasons: string[] = [];
  if (matchedTerms.length) reasons.push(`Matched query terms: ${matchedTerms.join(", ")}.`);
  if (matchedCapabilities.length) reasons.push(`Required capabilities available: ${matchedCapabilities.join(", ")}.`);
  if (missingCapabilities.length) reasons.push(`Missing capabilities: ${missingCapabilities.join(", ")}.`);
  if (unsupportedScopes.length) reasons.push(`Unsupported scopes: ${unsupportedScopes.join(", ")}.`);
  if (ownerPinned) reasons.push("Owner pinned skill.");
  if (!reasons.length) reasons.push("Skill catalog matched the query.");
  return {
    score: matchedTerms.length * 10 + matchedCapabilities.length * 6 + (ownerPinned ? 4 : 0) + stateSelectionBoost(skill.state),
    matched_terms: matchedTerms,
    matched_capabilities: matchedCapabilities,
    missing_capabilities: missingCapabilities,
    unsupported_scopes: unsupportedScopes,
    reasons
  };
}

export function skillAllowedScopes(skill: SkillContextSkill): SkillFrontmatter["allowed_scopes"] {
  return Array.isArray(skill.allowed_scopes) ? skill.allowed_scopes : skill.frontmatter.allowed_scopes;
}

function skillOwnerPinned(skill: SkillContextSkill): boolean {
  return Boolean(skill.owner_pinned ?? skill.frontmatter.owner_pinned);
}

function stateSelectionBoost(state: SkillContextSkill["state"]): number {
  if (state === "pinned" || state === "active") return 5;
  if (state === "project") return 3;
  return 0;
}

export function decideSkillDisclosureLevel(input: {
  skill: SkillContextSkill;
  index: number;
  query: string;
  content: string;
  matchedSupportFiles: SkillSupportFile[];
}): SkillDisclosureLevel {
  void input;
  return "catalog";
}

export function selectSkillSupportFiles(files: SkillSupportFile[], query: string): SkillSupportFile[] {
  const terms = skillQueryTerms(query);
  const wantsSupport = wantsSkillSupportDisclosure(query);
  const scored = files
    .map((file) => ({ file, score: scoreSkillSupportFile(file, terms, wantsSupport) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));
  return scored.slice(0, 5).map((entry) => entry.file);
}

export function describeSkillSelection(
  level: SkillDisclosureLevel,
  index: number,
  supportFiles: Array<Pick<SkillSupportFile, "path">>,
  usage?: { use_count: number; last_used_at?: string },
  selection?: RuntimeSkillSelection
): string {
  const usageNote = usage ? ` Usage: ${usage.use_count} prior run(s)${usage.last_used_at ? `, last used ${usage.last_used_at}` : ""}.` : "";
  const selectionNote = selection?.reasons.length ? ` ${selection.reasons.join(" ")}` : "";
  if (level === "support") return `Matched support files: ${supportFiles.map((file) => file.path).join(", ")}.${selectionNote}${usageNote}`.trim();
  if (level === "body") return `${index === 0 ? "Top skill match; body disclosed." : "Skill body matched the request."}${selectionNote}${usageNote}`.trim();
  return `Catalog match only; body and support files stay undisclosed until needed.${selectionNote}${usageNote}`.trim();
}

function scoreSkillSupportFile(file: SkillSupportFile, terms: string[], wantsSupport: boolean): number {
  const pathText = normalizeSkillSearchText(file.path);
  const contentText = normalizeSkillSearchText(file.content);
  let score = wantsSupport && isKnownSkillSupportPath(pathText) ? 2 : 0;
  for (const term of terms) {
    if (pathText.includes(term)) score += 8;
    if (contentText.includes(term)) score += 3;
  }
  return score;
}

function wantsSkillSupportDisclosure(query: string): boolean {
  const normalized = normalizeSkillSearchText(query);
  return ["reference", "references", "template", "templates", "script", "scripts", "asset", "assets", "support", "style", "example", "examples", "補助", "資料", "詳細", "詳しく", "手順", "例", "使い方", "スタイル"].some((hint) => normalized.includes(hint));
}

function isKnownSkillSupportPath(pathText: string): boolean {
  return ["references/", "templates/", "scripts/", "assets/", "examples/"].some((prefix) => pathText.startsWith(prefix));
}

export function skillQueryTerms(query: string): string[] {
  return normalizeSkillSearchText(query).split(/\s+/).map((term) => term.trim()).filter((term) => term.length > 0);
}

export function normalizeSkillSearchText(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}
