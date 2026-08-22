import {
  createId,
  nowIso,
  stableHash,
  type ActivityContextRef,
  type LearningBackgroundReviewMutation,
  type LearningResourceVersionRecord,
  type MemoryFrontmatter,
  type ReflectionRunRecord,
  type ReflectionSuggestionRecord,
  type ResourceRef,
  type SessionRecord,
  type SkillFrontmatter,
  type UsageScopeRef,
  type WikiFrontmatter
} from "@samurai-agent/core-schemas";
import { buildMemoryFrontmatter } from "@samurai-agent/memory";
import type { RuntimeWorkspacePort } from "../../composition/runtime-workspace-ports";

/** A deliberately small Workspace Store port for validated Background Review writes. */
export type Core05BackgroundReviewMutationPort = Pick<RuntimeWorkspacePort,
  | "getReflectionRun"
  | "getSession"
  | "saveMemory"
  | "getMemory"
  | "readMemoryContent"
  | "readMemoryMarkdown"
  | "patchMemoryLearningMetadata"
  | "saveWikiPage"
  | "getWiki"
  | "readWikiContent"
  | "readWikiMarkdown"
  | "patchWikiLearningMetadata"
  | "saveSkillMarkdown"
  | "getSkill"
  | "readSkillMarkdown"
  | "patchSkillLearningMetadata"
  | "getCurrentLearningResourceVersion"
  | "saveLearningResourceVersion"
  | "saveReflectionSuggestion"
  | "saveBackgroundReviewChange"
  | "ensureResourceAccessBoundary"
>;

type LearningResourceKind = "memory" | "wiki" | "skill";

export class Core05BackgroundReviewMutationDomainService {
  constructor(private readonly store: Core05BackgroundReviewMutationPort) {}

  /** All model-proposed writes reach the Workspace only through this Domain service. */
  async apply(input: {
    reflectionRunId: string;
    sessionId: string;
    roomId: string;
    /** The human requester owns any newly written Room resource. */
    ownerParticipantId: string;
    /** The initiating Agent or human is preserved as the actual creator. */
    creatorParticipantId: string;
    mutations: LearningBackgroundReviewMutation[];
  }): Promise<{ suggestions: ReflectionSuggestionRecord[] }> {
    const [reflectionRun, session] = await Promise.all([
      this.store.getReflectionRun(input.reflectionRunId),
      this.store.getSession(input.sessionId)
    ]);
    if (!reflectionRun || reflectionRun.kind !== "background_review" || reflectionRun.status !== "started") {
      throw new Error("background_review_mutation_run_invalid");
    }
    if (!session || reflectionRun.session_id !== session.id || !session.room_id || session.room_id !== input.roomId
      || !reflectionRun.activity_context || reflectionRun.activity_context.room_id !== input.roomId || !reflectionRun.source_run_id) {
      throw new Error("background_review_mutation_context_invalid");
    }
    return {
      suggestions: await this.applyMutations(reflectionRun, session, input.mutations, {
        roomId: input.roomId,
        ownerParticipantId: input.ownerParticipantId,
        creatorParticipantId: input.creatorParticipantId
      })
    };
  }

  /** Evaluation may only limit the exact current Version that its evidence refuted. */
  async markRefuted(input: {
    resourceKind: LearningResourceKind;
    resourceId: string;
    expectedVersion: string;
    activityContext: ActivityContextRef;
    sourceRunId: string;
    reason: string;
    evidenceRefs: ResourceRef[];
    ownership?: { roomId: string; ownerParticipantId: string; creatorParticipantId: string };
  }): Promise<ResourceRef | undefined> {
    const currentVersion = input.resourceKind === "memory"
      ? (await this.store.getMemory(input.resourceId))?.version
      : input.resourceKind === "wiki"
        ? (await this.store.getWiki(input.resourceId))?.version
        : (await this.store.getSkill(input.resourceId))?.frontmatter.version;
    if (!currentVersion || currentVersion !== input.expectedVersion) return undefined;
    return this.appendEvidenceVersion({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      activity: input.activityContext,
      reason: input.reason,
      evidenceRefs: input.evidenceRefs,
      ownership: input.ownership,
      sourceRunIds: [input.sourceRunId],
      evidenceState: "conflict",
      usageState: "limited"
    });
  }

  private async applyMutations(
    reflectionRun: ReflectionRunRecord,
    session: SessionRecord,
    mutations: LearningBackgroundReviewMutation[],
    ownership: { roomId: string; ownerParticipantId: string; creatorParticipantId: string }
  ): Promise<ReflectionSuggestionRecord[]> {
    const activity = reflectionRun.activity_context;
    if (!activity) throw new Error("background_review_activity_context_required");
    const sourceRunId = reflectionRun.source_run_id;
    if (!sourceRunId) throw new Error("background_review_source_run_required");
    const suggestions: ReflectionSuggestionRecord[] = [];
    for (const mutation of mutations) {
      const mutationSourceRunIds = sourceRunIds(sourceRunId, mutation.evidence_refs);
      let targetRef: ResourceRef | undefined;
      let status: ReflectionSuggestionRecord["status"] = "applied";
      let title: string = mutation.kind;
      if (mutation.kind === "memory_create") {
        const contentHash = stableHash(mutation.content);
        const memory = await this.store.saveMemory({
          ...buildMemoryFrontmatter({
            state: "topic",
            topic: mutation.topic,
            source: sourceRunId,
            sourceLocale: session.output_locale,
            contentLocale: session.output_locale,
            sourceKind: mutation.evidence_state === "direct_confirmed" ? "owner_instruction" : "agent_reasoning",
            instructionAuthority: "background_review",
            usageScope: { kind: "room", room_id: activity.room_id }
          }),
          confidence: mutation.evidence_state === "direct_confirmed" ? 0.95 : 0.5,
          source_refs: mutation.evidence_refs,
          provenance: { kind: "generated_local", summary: `Background Review ${reflectionRun.id}: ${mutation.reason}`, verified: mutation.evidence_state === "direct_confirmed" },
          evidence_state: mutation.evidence_state,
          usage_state: mutation.usage_state,
          origin_activity_context: activity,
          source_run_ids: mutationSourceRunIds,
          version: "1",
          content_hash: contentHash,
          pinned: false
        }, mutation.content);
        const stored = await this.store.getMemory(memory.id);
        if (!stored) throw new Error(`background_review_resource_not_found:memory:${memory.id}`);
        await this.ensureRoomBoundary("memory", stored.id, stored.created_at, ownership);
        await this.recordNewVersion({ resourceKind: "memory", resourceId: stored.id, version: "1", filePath: stored.file_path, contentHash, reason: mutation.reason, sourceRunIds: mutationSourceRunIds });
        targetRef = memoryRef(stored);
        title = stored.topic;
      } else if (mutation.kind === "experience_rule_create") {
        const now = nowIso();
        const content = [
          mutation.summary,
          "",
          "## Conditions",
          ...mutation.conditions.map((condition) => `- ${condition}`),
          "",
          "## Recommended action",
          mutation.recommended_action,
          "",
          "## Predicted result",
          mutation.predicted_result
        ].join("\n");
        const contentHash = stableHash(content);
        const id = createId("wiki");
        const wiki = await this.store.saveWikiPage({
          id,
          slug: `${slugify(mutation.title)}-${stableHash(id).slice(0, 6)}`,
          title: mutation.title,
          state: "active",
          content_locale: session.output_locale,
          tags: ["experience-rule"],
          source_refs: mutation.evidence_refs,
          provenance: { kind: "generated_local", summary: `Background Review ${reflectionRun.id}: ${mutation.reason}`, verified: mutation.evidence_state === "direct_confirmed" },
          usage_scope: { kind: "room", room_id: activity.room_id },
          knowledge_kind: "experience_rule",
          experience_rule: {
            summary: mutation.summary,
            conditions: mutation.conditions,
            recommended_action: mutation.recommended_action,
            predicted_result: mutation.predicted_result,
            creation_reason: mutation.reason,
            counterexamples: [],
            exclusion_conditions: [],
            verification_history: []
          },
          evidence_state: mutation.evidence_state,
          usage_state: mutation.usage_state,
          origin_activity_context: activity,
          source_run_ids: mutationSourceRunIds,
          version: "1",
          content_hash: contentHash,
          pinned: false,
          created_at: now,
          updated_at: now
        }, content);
        await this.ensureRoomBoundary("wiki", wiki.id, wiki.created_at, ownership);
        await this.recordNewVersion({ resourceKind: "wiki", resourceId: wiki.id, version: "1", filePath: wiki.file_path, contentHash, reason: mutation.reason, sourceRunIds: mutationSourceRunIds });
        targetRef = wikiRef(wiki);
        title = wiki.title;
      } else if (mutation.kind === "skill_candidate_create") {
        const now = nowIso();
        const id = createId("skill");
        const contentHash = stableHash(mutation.content);
        const frontmatter: SkillFrontmatter = {
          id,
          state: "candidate",
          title: mutation.title,
          description: mutation.description,
          tags: ["learning-candidate"],
          provenance: "background_review",
          trust_level: "generated_local",
          allowed_scopes: ["workspace"],
          required_capabilities: [],
          schedule_policy: {},
          secret_policy: {},
          owner_pinned: false,
          usage_scope: { kind: "room", room_id: activity.room_id },
          source_refs: mutation.evidence_refs,
          provenance_detail: { kind: "generated_local", summary: `Background Review ${reflectionRun.id}: ${mutation.reason}`, verified: false },
          evidence_state: "inferred",
          usage_state: "limited",
          origin_activity_context: activity,
          source_run_ids: mutationSourceRunIds,
          version: "1",
          content_hash: contentHash,
          pinned: false,
          created_at: now,
          updated_at: now
        };
        const skill = await this.store.saveSkillMarkdown({
          state: "candidate",
          skillId: id,
          markdown: ["---", JSON.stringify(frontmatter, null, 2), "---", mutation.content.trim(), ""].join("\n")
        });
        await this.ensureRoomBoundary("skill", skill.id, skill.frontmatter.created_at, ownership);
        await this.recordNewVersion({ resourceKind: "skill", resourceId: skill.id, version: "1", filePath: skill.file_path, contentHash, reason: mutation.reason, sourceRunIds: mutationSourceRunIds });
        targetRef = skillRef(skill);
        title = skill.title;
      } else if (mutation.kind === "resource_evidence_append") {
        targetRef = await this.appendEvidenceVersion({
          resourceKind: mutation.resource_kind,
          resourceId: mutation.resource_id,
          activity,
          sourceRunIds: mutationSourceRunIds,
          reason: mutation.reason,
          evidenceRefs: mutation.evidence_refs,
          ownership
        });
      } else {
        status = "proposed";
        title = mutation.kind === "skill_patch_candidate" ? "Skill patch candidate" : "Resource replacement candidate";
        targetRef = await this.resourceRef(mutation.kind === "skill_patch_candidate" ? "skill" : mutation.resource_kind, mutation.resource_id);
      }
      const now = nowIso();
      const suggestion: ReflectionSuggestionRecord = {
        id: createId("reflection_suggestion"),
        reflection_run_id: reflectionRun.id,
        suggestion_type: suggestionType(mutation),
        status,
        title,
        content: mutation.reason,
        ...(targetRef ? { target_ref: targetRef } : {}),
        source_refs: mutation.evidence_refs,
        confidence: mutation.kind === "experience_rule_create" && mutation.evidence_state === "direct_confirmed" ? 0.95 : 0.6,
        created_at: now,
        updated_at: now
      };
      if (targetRef) {
        // Record the resource before the suggestion. If a later write fails,
        // the Room-scoped compensation snapshot can identify the new resource
        // even though the review did not reach its final bookkeeping step.
        await this.store.saveBackgroundReviewChange({
          id: createId("background_review_change"),
          origin: "background_review",
          source_run_id: sourceRunId,
          source_session_id: session.id,
          activity_context: activity,
          review_run_id: reflectionRun.id,
          mutation_kind: changeKind(mutation),
          resource_ref: targetRef,
          after_version: stableHash({ target: targetRef, mutation: mutation.kind, reason: mutation.reason }),
          reason_summary: mutation.reason,
          evidence_refs: mutation.evidence_refs,
          created_at: now
        });
      }
      await this.store.saveReflectionSuggestion(suggestion);
      suggestions.push(suggestion);
    }
    return suggestions;
  }

  private async appendEvidenceVersion(input: {
    resourceKind: LearningResourceKind;
    resourceId: string;
    activity: ActivityContextRef;
    sourceRunIds: string[];
    reason: string;
    evidenceRefs: ResourceRef[];
    ownership?: { roomId: string; ownerParticipantId: string; creatorParticipantId: string };
    evidenceState?: "conflict";
    usageState?: "limited";
  }): Promise<ResourceRef | undefined> {
    await this.assertSameRoomScope(input.resourceKind, input.resourceId, input.activity);
    if (input.resourceKind === "memory") {
      const [current, body, before] = await Promise.all([
        this.store.getMemory(input.resourceId),
        this.store.readMemoryContent(input.resourceId),
        this.store.readMemoryMarkdown(input.resourceId)
      ]);
      if (!current || body === undefined || before === undefined) return undefined;
      const currentVersion = await this.ensureCurrentVersion("memory", current.id, current.file_path, stableHash(body), current.version, input.reason, current.source_run_ids ?? []);
      const version = nextVersion(currentVersion.version);
      const updated = await this.store.patchMemoryLearningMetadata({
        id: current.id,
        metadata: {
          source_run_ids: uniqueStrings([...(current.source_run_ids ?? []), ...input.sourceRunIds]),
          source_refs: uniqueRefs([...(current.source_refs ?? []), ...input.evidenceRefs]),
          version,
          content_hash: stableHash(body),
          ...(input.evidenceState ? { evidence_state: input.evidenceState } : {}),
          ...(input.usageState ? { usage_state: input.usageState } : {})
        }
      });
      if (!updated) return undefined;
      if (input.ownership) await this.ensureRoomBoundary("memory", updated.id, updated.created_at, input.ownership);
      await this.store.saveLearningResourceVersion({
        record: versionRecord("memory", updated.id, version, currentVersion.version, updated.file_path, stableHash(body), input.reason, input.sourceRunIds),
        previousContent: before
      });
      return memoryRef(updated);
    }
    if (input.resourceKind === "wiki") {
      const [current, body, before] = await Promise.all([
        this.store.getWiki(input.resourceId),
        this.store.readWikiContent(input.resourceId),
        this.store.readWikiMarkdown(input.resourceId)
      ]);
      if (!current || body === undefined || before === undefined) return undefined;
      const currentVersion = await this.ensureCurrentVersion("wiki", current.id, current.file_path, stableHash(body), current.version, input.reason, current.source_run_ids ?? []);
      const version = nextVersion(currentVersion.version);
      const updated = await this.store.patchWikiLearningMetadata({
        id: current.id,
        metadata: {
          source_run_ids: uniqueStrings([...(current.source_run_ids ?? []), ...input.sourceRunIds]),
          source_refs: uniqueRefs([...current.source_refs, ...input.evidenceRefs]),
          version,
          content_hash: stableHash(body),
          ...(input.evidenceState ? { evidence_state: input.evidenceState } : {}),
          ...(input.usageState ? { usage_state: input.usageState } : {})
        }
      });
      if (!updated) return undefined;
      if (input.ownership) await this.ensureRoomBoundary("wiki", updated.id, updated.created_at, input.ownership);
      await this.store.saveLearningResourceVersion({
        record: versionRecord("wiki", updated.id, version, currentVersion.version, updated.file_path, stableHash(body), input.reason, input.sourceRunIds),
        previousContent: before
      });
      return wikiRef(updated);
    }
    const [current, markdown] = await Promise.all([
      this.store.getSkill(input.resourceId),
      this.store.readSkillMarkdown(input.resourceId)
    ]);
    if (!current || !markdown) return undefined;
    const bodyHash = stableHash(skillBody(markdown));
    const currentVersion = await this.ensureCurrentVersion("skill", current.id, current.file_path, bodyHash, current.frontmatter.version, input.reason, current.frontmatter.source_run_ids ?? []);
    const version = nextVersion(currentVersion.version);
    const updated = await this.store.patchSkillLearningMetadata({
      id: current.id,
      metadata: {
        source_run_ids: uniqueStrings([...(current.frontmatter.source_run_ids ?? []), ...input.sourceRunIds]),
        source_refs: uniqueRefs([...(current.frontmatter.source_refs ?? []), ...input.evidenceRefs]),
        version,
        content_hash: bodyHash,
        ...(input.evidenceState ? { evidence_state: input.evidenceState } : {}),
        ...(input.usageState ? { usage_state: input.usageState } : {})
      }
    });
    if (!updated) return undefined;
    if (input.ownership) await this.ensureRoomBoundary("skill", updated.id, updated.frontmatter.created_at, input.ownership);
    await this.store.saveLearningResourceVersion({
      record: versionRecord("skill", updated.id, version, currentVersion.version, updated.file_path, bodyHash, input.reason, input.sourceRunIds),
      previousContent: markdown
    });
    return skillRef(updated);
  }

  private async ensureCurrentVersion(
    resourceKind: LearningResourceKind,
    resourceId: string,
    filePath: string,
    contentHash: string,
    declaredVersion: string | undefined,
    reason: string,
    sourceRunIds: string[]
  ): Promise<LearningResourceVersionRecord> {
    const current = await this.store.getCurrentLearningResourceVersion({ resourceKind, resourceId });
    if (current) return current;
    const version = declaredVersion ?? "legacy";
    await this.recordNewVersion({ resourceKind, resourceId, version, filePath, contentHash, reason, sourceRunIds });
    const created = await this.store.getCurrentLearningResourceVersion({ resourceKind, resourceId });
    if (!created) throw new Error("learning_resource_version_missing_after_create");
    return created;
  }

  /**
   * A Background Review creates or edits a real Room resource, so it records
   * the immutable Room origin in the same write path.  It never derives this
   * from UsageScope: that field remains a narrower use rule, not permission.
   */
  private async ensureRoomBoundary(
    resourceKind: LearningResourceKind,
    resourceId: string,
    resourceCreatedAt: string | undefined,
    ownership: { roomId: string; ownerParticipantId: string; creatorParticipantId: string }
  ): Promise<void> {
    await this.store.ensureResourceAccessBoundary({
      resourceKind,
      resourceId,
      sourceRoomId: ownership.roomId,
      ownerParticipantId: ownership.ownerParticipantId,
      creatorParticipantId: ownership.creatorParticipantId,
      ...(resourceCreatedAt ? { resourceCreatedAt } : {}),
      actorId: ownership.ownerParticipantId
    });
  }

  private async recordNewVersion(input: {
    resourceKind: LearningResourceKind;
    resourceId: string;
    version: string;
    filePath: string;
    contentHash: string;
    reason: string;
    sourceRunIds: string[];
  }): Promise<void> {
    await this.store.saveLearningResourceVersion({
      record: {
        id: createId("learning_version"),
        resource_kind: input.resourceKind,
        resource_id: input.resourceId,
        version: input.version,
        file_path: input.filePath,
        content_hash: input.contentHash,
        change_reason: input.reason,
        source_run_ids: input.sourceRunIds,
        actor: "background_review",
        is_current: true,
        created_at: nowIso()
      }
    });
  }

  private async assertSameRoomScope(kind: LearningResourceKind, resourceId: string, activity: ActivityContextRef): Promise<void> {
    const scope = kind === "memory"
      ? (await this.store.getMemory(resourceId))?.usage_scope
      : kind === "wiki"
        ? (await this.store.getWiki(resourceId))?.usage_scope
        : (await this.store.getSkill(resourceId))?.frontmatter.usage_scope;
    if (!scope || scope.kind !== "room" || scope.room_id !== activity.room_id) {
      throw new Error(`background_review_scope_violation:${kind}:${resourceId}`);
    }
  }

  private async resourceRef(kind: LearningResourceKind, resourceId: string): Promise<ResourceRef | undefined> {
    if (kind === "memory") {
      const resource = await this.store.getMemory(resourceId);
      return resource ? memoryRef(resource) : undefined;
    }
    if (kind === "wiki") {
      const resource = await this.store.getWiki(resourceId);
      return resource ? wikiRef(resource) : undefined;
    }
    const resource = await this.store.getSkill(resourceId);
    return resource ? skillRef(resource) : undefined;
  }
}

function memoryRef(memory: MemoryFrontmatter & { file_path: string }): ResourceRef {
  return { kind: "memory", id: memory.id, uri: memory.file_path, label: memory.topic };
}

function wikiRef(wiki: WikiFrontmatter & { file_path: string }): ResourceRef {
  return { kind: "knowledge_wiki", id: wiki.id, uri: wiki.file_path, label: wiki.title };
}

function skillRef(skill: { id: string; title: string; file_path: string }): ResourceRef {
  return { kind: "skill", id: skill.id, uri: skill.file_path, label: skill.title };
}

function versionRecord(kind: LearningResourceKind, id: string, version: string, parent: string, filePath: string, hash: string, reason: string, sourceRunIds: string[]): LearningResourceVersionRecord {
  return {
    id: createId("learning_version"),
    resource_kind: kind,
    resource_id: id,
    version,
    parent_version: parent,
    file_path: filePath,
    content_hash: hash,
    change_reason: reason,
    source_run_ids: sourceRunIds,
    actor: "background_review",
    is_current: true,
    created_at: nowIso()
  };
}

function suggestionType(mutation: LearningBackgroundReviewMutation): ReflectionSuggestionRecord["suggestion_type"] {
  if (mutation.kind === "experience_rule_create") return "knowledge_wiki";
  if (mutation.kind === "skill_candidate_create") return "skill";
  if (mutation.kind === "skill_patch_candidate") return "skill_patch";
  if (mutation.kind === "resource_evidence_append" || mutation.kind === "resource_replacement_candidate") {
    return mutation.resource_kind === "wiki" ? "knowledge_wiki" : mutation.resource_kind === "skill" ? "skill_patch" : "memory_patch";
  }
  return "memory";
}

function changeKind(mutation: LearningBackgroundReviewMutation): "memory_add" | "memory_replace" | "skill_create" | "skill_patch" | "wiki_create" | "wiki_patch" {
  if (mutation.kind === "memory_create") return "memory_add";
  if (mutation.kind === "experience_rule_create") return "wiki_create";
  if (mutation.kind === "skill_candidate_create") return "skill_create";
  if (mutation.kind === "skill_patch_candidate") return "skill_patch";
  if (mutation.resource_kind === "wiki") return "wiki_patch";
  if (mutation.resource_kind === "skill") return "skill_patch";
  return "memory_replace";
}

function nextVersion(version: string): string {
  const numeric = Number(version);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric + 1) : "1";
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)));
}

function uniqueRefs(values: ResourceRef[]): ResourceRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.kind}:${value.id}:${value.uri}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRunIds(primary: string, evidenceRefs: ResourceRef[]): string[] {
  return uniqueStrings([primary, ...evidenceRefs.filter((ref) => ref.kind === "backend_run").map((ref) => ref.id)]);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "experience-rule";
}

function skillBody(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown.trim();
  const contentStart = markdown.indexOf("\n", end + 4);
  return (contentStart === -1 ? "" : markdown.slice(contentStart + 1)).trim();
}
