import { describe, expect, it } from "vitest";
import {
  decideSkillDisclosureLevel,
  selectRuntimeSkills,
  selectSkillSupportFiles,
  type SkillContextEnvironment,
  type SkillContextSkill,
  type SkillSupportFile
} from "./skill-context.js";
import { selectCollectionNotes } from "./collection-context.js";

const environment: SkillContextEnvironment = {
  runtime: "local_workspace",
  platform: "test",
  availableCapabilities: ["deploy"],
  supportedScopes: new Set(["workspace"])
};

function skill(input: Partial<SkillContextSkill> & Pick<SkillContextSkill, "id" | "title">): SkillContextSkill {
  const allowedScopes = input.allowed_scopes ?? ["workspace"];
  return {
    id: input.id,
    title: input.title,
    description: input.description ?? "deploy helper",
    tags: input.tags ?? ["deploy"],
    state: input.state ?? "active",
    allowed_scopes: allowedScopes,
    required_capabilities: input.required_capabilities ?? ["deploy"],
    owner_pinned: input.owner_pinned ?? false,
    frontmatter: { allowed_scopes: allowedScopes, owner_pinned: input.owner_pinned ?? false },
    file_path: input.file_path ?? `skills/${input.id}.md`
  };
}

describe("skill context selection", () => {
  it("excludes missing capabilities and unsupported scopes, ranks pinned skills, and reports environment", () => {
    const result = selectRuntimeSkills({
      query: "deploy script",
      limit: 1,
      environment,
      candidates: [
        skill({ id: "regular", title: "Deploy Helper" }),
        skill({ id: "pinned", title: "Deploy Script", state: "pinned", owner_pinned: true }),
        skill({ id: "missing", title: "Deploy Missing", required_capabilities: ["missing"] }),
        skill({ id: "scope", title: "Deploy External", allowed_scopes: ["external_channel"] })
      ]
    });

    expect(result.selected.map((entry) => entry.skill.id)).toEqual(["pinned"]);
    expect(result.report.environment).toEqual({ runtime: "local_workspace", platform: "test" });
    expect(result.report.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "missing", reason: "missing_capability" }),
      expect.objectContaining({ id: "scope", reason: "scope_unsupported" })
    ]));
  });

  it("keeps catalog disclosure and ranks support files with a five-file limit", () => {
    const selectedSkill = skill({ id: "selected", title: "Deploy Script" });
    expect(decideSkillDisclosureLevel({ skill: selectedSkill, index: 0, query: "deploy", content: "body", matchedSupportFiles: [] })).toBe("catalog");

    const files: SkillSupportFile[] = Array.from({ length: 6 }, (_, index) => ({
      skill_id: "selected",
      path: `references/deploy-${index}.md`,
      file_path: `skills/selected/references/deploy-${index}.md`,
      content: "deploy reference"
    }));
    expect(selectSkillSupportFiles(files, "deploy reference")).toHaveLength(5);
    expect(selectSkillSupportFiles(files, "deploy reference")[0]?.path).toBe("references/deploy-0.md");
  });

  it("matches collection notes and truncates context text", () => {
    const notes = Array.from({ length: 6 }, (_, index) => ({
      collection_id: "deployments",
      file_path: `notes/deploy-${index}.md`,
      content: `deploy ${"x".repeat(4100)}`,
      role: "context_only" as const
    }));
    const selected = selectCollectionNotes(notes, "deploy");
    expect(selected).toHaveLength(5);
    expect(selected[0]?.content.endsWith("\n[truncated]")).toBe(true);
  });
});
