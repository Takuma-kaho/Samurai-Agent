import { SkillFrontmatterSchema, type SkillFrontmatter } from "@samurai-agent/core-schemas";

export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  required_capabilities: string[];
  file_path?: string;
  frontmatter: SkillFrontmatter;
}

export function buildSkillIndexEntry(frontmatter: SkillFrontmatter): SkillIndexEntry {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    tags: frontmatter.tags,
    state: frontmatter.state,
    required_capabilities: frontmatter.required_capabilities,
    frontmatter
  };
}

export function renderSkillMarkdown(frontmatter: SkillFrontmatter, content: string): string {
  const parsed = SkillFrontmatterSchema.parse(frontmatter);
  return ["---", JSON.stringify(parsed, null, 2), "---", content.trim(), ""].join("\n");
}

export function parseSkillMarkdown(markdown: string): { frontmatter: SkillFrontmatter; content: string } {
  if (!markdown.startsWith("---\n")) {
    throw new Error("skill_frontmatter_missing");
  }

  const end = markdown.indexOf("\n---", 4);
  if (end === -1) {
    throw new Error("skill_frontmatter_unclosed");
  }

  const rawFrontmatter = markdown.slice(4, end).trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  const content = contentStart === -1 ? "" : markdown.slice(contentStart + 1).trim();
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawFrontmatter);
  } catch (error) {
    throw new Error(`skill_frontmatter_invalid_json:${error instanceof Error ? error.message : "unknown"}`);
  }

  return {
    frontmatter: SkillFrontmatterSchema.parse(parsedJson),
    content
  };
}

export function buildSkillIndexEntryFromMarkdown(markdown: string, filePath?: string): SkillIndexEntry {
  const { frontmatter } = parseSkillMarkdown(markdown);
  return {
    ...buildSkillIndexEntry(frontmatter),
    file_path: filePath
  };
}
