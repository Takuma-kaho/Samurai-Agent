import { describe, expect, it } from "vitest";
import { nowIso, type SkillFrontmatter } from "@samurai-agent/core-schemas";
import { buildSkillIndexEntry, parseSkillMarkdown, renderSkillMarkdown } from "./index";

function frontmatter(): SkillFrontmatter {
  return {
    id: "skill_test",
    state: "candidate",
    title: "Test skill",
    description: "A local skill candidate.",
    tags: ["test"],
    provenance: "generated_local",
    trust_level: "generated_local",
    allowed_scopes: ["skill"],
    required_capabilities: ["proposal_workspace"],
    schedule_policy: {},
    secret_policy: {},
    last_reviewed_at: nowIso(),
    owner_pinned: false
  };
}

describe("skills", () => {
  it("renders and parses JSON frontmatter roundtrip", () => {
    const markdown = renderSkillMarkdown(frontmatter(), "# Body");
    const parsed = parseSkillMarkdown(markdown);

    expect(parsed.frontmatter.title).toBe("Test skill");
    expect(parsed.content).toBe("# Body");
  });

  it("rejects broken frontmatter", () => {
    expect(() => parseSkillMarkdown("---\n{broken\n---\nbody")).toThrow("skill_frontmatter_invalid_json");
  });

  it("builds index entries from frontmatter", () => {
    const entry = buildSkillIndexEntry(frontmatter());

    expect(entry).toMatchObject({
      id: "skill_test",
      title: "Test skill",
      state: "candidate",
      required_capabilities: ["proposal_workspace"]
    });
  });
});
