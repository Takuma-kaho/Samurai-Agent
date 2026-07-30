import { createHash, randomUUID } from "node:crypto";
import type { LearningResourceUseRecord } from "@samurai-agent/core-schemas";

export interface ProgressiveSkillStorePort {
  searchSkills(query: string, limit: number, options: { states: Array<"candidate" | "project" | "active" | "stale" | "archived" | "pinned"> }): Promise<Array<{ id: string; title: string; description: string; tags: string[]; required_capabilities: string[] }>>;
  readSkillMarkdown(skillId: string): Promise<string | undefined>;
  readSkillSupportFile(input: { skillId: string; path: string }): Promise<{ path: string; content: string } | undefined>;
  recordSkillUsage(input: { skillId: string; runId?: string; usedAt?: string }): Promise<unknown>;
  recordLearningResourceUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord>;
}

export class ProgressiveSkillDisclosure {
  private readonly selected = new Set<string>(); private readonly bodyLoaded = new Set<string>(); private readonly used = new Set<string>();
  constructor(private readonly store: ProgressiveSkillStorePort, private readonly input: { runId: string; sessionId: string; backendCapabilities: string[] }) {}

  async list(query: string) {
    const available = new Set(this.input.backendCapabilities); const skills = await this.store.searchSkills(query, 20, { states: ["project"] });
    const selected = skills.filter((skill) => skill.required_capabilities.every((capability) => available.has(capability)));
    for (const skill of selected) { this.selected.add(skill.id); await this.trace(skill.id, "selected", undefined, { title: skill.title }); }
    return selected.map(({ id, title, description, tags, required_capabilities }) => ({ id, title, description, tags, required_capabilities }));
  }

  async loadBody(skillId: string): Promise<string> {
    if (!this.selected.has(skillId)) throw new Error(`skill_body_before_selection:${skillId}`);
    const markdown = await this.store.readSkillMarkdown(skillId); if (!markdown) throw new Error(`skill_not_found:${skillId}`);
    this.bodyLoaded.add(skillId); await this.trace(skillId, "body_loaded", markdown); return markdown;
  }

  async loadSupport(skillId: string, supportPath: string): Promise<string> {
    if (!this.bodyLoaded.has(skillId)) throw new Error(`skill_support_before_body:${skillId}`);
    const file = await this.store.readSkillSupportFile({ skillId, path: supportPath }); if (!file) throw new Error(`skill_support_not_found:${skillId}:${supportPath}`);
    await this.trace(skillId, "support_loaded", file.content, { path: file.path }); return file.content;
  }

  async markUsed(skillId: string): Promise<void> { if (!this.bodyLoaded.has(skillId)) throw new Error(`skill_use_before_body:${skillId}`); if (this.used.has(skillId)) return; this.used.add(skillId); await this.store.recordSkillUsage({ skillId, runId: this.input.runId }); }
  unusedSelectedSkillIds(): string[] { return [...this.selected].filter((id) => !this.used.has(id)).sort(); }

  private async trace(resourceId: string, stage: LearningResourceUseRecord["stage"], content?: string, metadata: Record<string, unknown> = {}) {
    await this.store.recordLearningResourceUse({ id: `resource_use_${randomUUID()}`, run_id: this.input.runId, session_id: this.input.sessionId, resource_kind: stage === "support_loaded" ? "skill_support" : "skill", resource_id: resourceId, content_hash: content ? createHash("sha256").update(content).digest("hex") : undefined, stage, metadata, created_at: new Date().toISOString() });
  }
}
