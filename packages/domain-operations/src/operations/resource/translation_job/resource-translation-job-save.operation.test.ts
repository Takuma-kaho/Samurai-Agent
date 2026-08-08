import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../../definition/index.js";
import resourceTranslationJobSave from "./save.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", roomId: "room_test", correlationId: "correlation_test" };
const sourceRef = { kind: "artifact", id: "artifact_1", uri: "artifacts/source.md", label: "Source" } as const;

describe("resource.translation_job.save handler", () => {
  it("builds the automation job from the loaded source", async () => {
    const saveTranslationAutomationJob = vi.fn(async () => ({}) as never);
    const handler = resourceTranslationJobSave.createHandler({
      loadArtifactTranslationSource: async () => ({ ref: sourceRef, source_locale: "ja", content: "body" }),
      loadMemoryTranslationSource: async () => undefined, loadWikiTranslationSource: async () => undefined,
      loadSkillTranslationSource: async () => undefined, loadCollectionRecordTranslationSource: async () => undefined,
      stripTranslationSkillFrontmatter: (content) => content, hashTranslationContent: () => "hash_1",
      saveTranslationAutomationJob,
      translationSourceNotFoundError: () => new Error("not_found")
    });

    await handler.execute(context, resourceTranslationJobSave.input.parse({ source_ref: sourceRef, target_locale: "en", schedule: " daily ", enabled: true }));

    expect(saveTranslationAutomationJob).toHaveBeenCalledWith({
      title: "Translate artifact/artifact_1 to en",
      kind: "resource_translation",
      schedule: "daily",
      target_instruction: "Translate artifact/artifact_1 from ja to en.",
      delivery_target: { channel: "resource_translation", source_ref: sourceRef, source_locale: "ja", target_locale: "en", original_hash: "hash_1", source_label: "Source", room_id: "room_test" },
      enabled: true,
      next_run_at: undefined,
      max_attempts: undefined
    });
  });

  it("rejects a missing source before saving", async () => {
    const saveTranslationAutomationJob = vi.fn();
    const handler = resourceTranslationJobSave.createHandler({
      loadArtifactTranslationSource: async () => undefined, loadMemoryTranslationSource: async () => undefined,
      loadWikiTranslationSource: async () => undefined, loadSkillTranslationSource: async () => undefined,
      loadCollectionRecordTranslationSource: async () => undefined,
      stripTranslationSkillFrontmatter: (content) => content, hashTranslationContent: () => "hash_1",
      saveTranslationAutomationJob,
      translationSourceNotFoundError: () => new Error("translation_source_not_found")
    });

    await expect(handler.execute(context, resourceTranslationJobSave.input.parse({ source_ref: sourceRef, target_locale: "en" }))).rejects.toThrow("translation_source_not_found");
    expect(saveTranslationAutomationJob).not.toHaveBeenCalled();
  });
});
