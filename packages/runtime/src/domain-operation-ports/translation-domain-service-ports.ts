import type { DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "../domain-operation-services.js";

type Ports = Pick<DomainOperationPorts, "resource.translation.save" | "resource.translation_job.save">;

export function createTranslationDomainServicePorts(services: Pick<RuntimeDomainServices, "translationDomainService">): Ports {
  return {
    "resource.translation.save": {
      saveResourceTranslation: (request) => services.translationDomainService.saveTranslation({
        id: request.id,
        source_ref: request.sourceRef,
        source_locale: request.sourceLocale,
        target_locale: request.targetLocale,
        status: request.status,
        original_hash: request.originalHash,
        translated_text: request.translatedText,
        ...(request.provenance === undefined ? {} : { provenance: request.provenance }),
        created_at: request.createdAt,
        updated_at: request.updatedAt
      })
    },
    "resource.translation_job.save": {
      loadArtifactTranslationSource: (id) => services.translationDomainService.loadArtifactSource(id),
      loadMemoryTranslationSource: (id) => services.translationDomainService.loadMemorySource(id),
      loadWikiTranslationSource: (id) => services.translationDomainService.loadWikiSource(id),
      loadSkillTranslationSource: (id) => services.translationDomainService.loadSkillSource(id),
      loadCollectionRecordTranslationSource: (ref) => services.translationDomainService.loadCollectionRecordSource(ref),
      stripTranslationSkillFrontmatter: (content) => services.translationDomainService.stripSkillFrontmatter(content),
      hashTranslationContent: (content) => services.translationDomainService.hashContent(content),
      saveTranslationAutomationJob: (input) => services.translationDomainService.saveAutomationJob(input),
      translationSourceNotFoundError: (ref) => services.translationDomainService.translationSourceNotFoundError(ref)
    }
  };
}
