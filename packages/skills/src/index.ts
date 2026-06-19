import type { SkillFrontmatter } from "@samurai-agent/core-schemas";

export interface SkillIndexEntry {
  id: string;
  title: string;
  description: string;
  tags: string[];
  state: SkillFrontmatter["state"];
  required_capabilities: string[];
}

export function buildSkillIndexEntry(frontmatter: SkillFrontmatter): SkillIndexEntry {
  return {
    id: frontmatter.id,
    title: frontmatter.title,
    description: frontmatter.description,
    tags: frontmatter.tags,
    state: frontmatter.state,
    required_capabilities: frontmatter.required_capabilities
  };
}
