import {
  createId,
  nowIso,
  stableHash,
  type LearningEvidenceState,
  type LearningResourceVersionRecord,
  type LearningUsageState,
  type UsageScopeRef
} from "@samurai-agent/core-schemas";

export type VersionedLearningResourceKind = "memory" | "wiki" | "skill";

export interface LearningResourceVersionDomainServiceDependencies {
  getVersion(input: { resourceKind: VersionedLearningResourceKind; resourceId: string; version: string }): Promise<LearningResourceVersionRecord | undefined>;
  getCurrentVersion(input: { resourceKind: VersionedLearningResourceKind; resourceId: string }): Promise<LearningResourceVersionRecord | undefined>;
  listVersions(input: { resourceKind: VersionedLearningResourceKind; resourceId: string }): Promise<LearningResourceVersionRecord[]>;
  readHistoricalVersion(input: { resourceKind: VersionedLearningResourceKind; resourceId: string; version: string }): Promise<string | undefined>;
  readCurrentDocument(input: { resourceKind: VersionedLearningResourceKind; resourceId: string }): Promise<string | undefined>;
  readCurrentContent(input: { resourceKind: VersionedLearningResourceKind; resourceId: string }): Promise<string | undefined>;
  getCurrentResource(input: { resourceKind: VersionedLearningResourceKind; resourceId: string }): Promise<{
    file_path: string;
    version?: string;
    content_hash?: string;
    source_run_ids?: string[];
    usage_scope?: UsageScopeRef;
    evidence_state?: LearningEvidenceState;
    usage_state?: LearningUsageState;
    pinned?: boolean;
  } | undefined>;
  writeCurrentResource(input: {
    resourceKind: VersionedLearningResourceKind;
    resourceId: string;
    content: string;
    version: string;
    contentHash: string;
    usageScope?: UsageScopeRef;
    evidenceState?: LearningEvidenceState;
    usageState?: LearningUsageState;
    pinned?: boolean;
    archive?: boolean;
  }): Promise<{ file_path: string; content_hash: string } | undefined>;
  restoreCurrentDocument(input: { resourceKind: VersionedLearningResourceKind; resourceId: string; markdown: string; version: string }): Promise<{ file_path: string; content_hash: string } | undefined>;
  saveVersion(input: { record: LearningResourceVersionRecord; previousContent?: string }): Promise<LearningResourceVersionRecord>;
  requestError(code: "not_found" | "conflict", message: string): Error;
}

/** Restores exactly one historical Resource document as a new immutable Version. */
export class LearningResourceVersionDomainService {
  constructor(private readonly dependencies: LearningResourceVersionDomainServiceDependencies) {}

  async restore(input: {
    resourceKind: VersionedLearningResourceKind;
    resourceId: string;
    targetVersion: string;
    reason?: string;
  }): Promise<{ resource_version: LearningResourceVersionRecord }> {
    const target = await this.dependencies.getVersion({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      version: input.targetVersion
    });
    if (!target) throw this.dependencies.requestError("not_found", "learning_resource_version_not_found");
    if (target.is_current) throw this.dependencies.requestError("conflict", "learning_resource_version_already_current");
    const [current, historicalDocument, currentDocument, versions] = await Promise.all([
      this.dependencies.getCurrentVersion({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.readHistoricalVersion({ resourceKind: input.resourceKind, resourceId: input.resourceId, version: input.targetVersion }),
      this.dependencies.readCurrentDocument({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.listVersions({ resourceKind: input.resourceKind, resourceId: input.resourceId })
    ]);
    if (!current || !currentDocument) throw this.dependencies.requestError("conflict", "learning_resource_current_version_required");
    if (!historicalDocument) throw this.dependencies.requestError("conflict", "learning_resource_version_content_missing");
    const nextVersion = nextLearningResourceVersion(versions);
    const restored = await this.dependencies.restoreCurrentDocument({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      markdown: historicalDocument,
      version: nextVersion
    });
    if (!restored) throw this.dependencies.requestError("not_found", "learning_resource_restore_target_not_found");
    const record: LearningResourceVersionRecord = {
      id: createId("learning_version"),
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      version: nextVersion,
      parent_version: current.version,
      file_path: restored.file_path,
      content_hash: restored.content_hash,
      change_reason: input.reason?.trim() || "user_requested_restore",
      source_run_ids: target.source_run_ids,
      actor: "user_restore",
      is_current: true,
      restored_from_version: target.version,
      created_at: nowIso()
    };
    try {
      await this.dependencies.saveVersion({ record, previousContent: currentDocument });
    } catch (error) {
      await this.dependencies.restoreCurrentDocument({
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        markdown: currentDocument,
        version: current.version
      }).catch(() => undefined);
      throw error;
    }
    return { resource_version: record };
  }

  /**
   * The only Core 05 edit path.  It changes a human-readable current document,
   * then records the displaced document as immutable Resource-local history.
   */
  async update(input: {
    resourceKind: VersionedLearningResourceKind;
    resourceId: string;
    changeReason: string;
    content?: string;
    usageScope?: UsageScopeRef;
    evidenceState?: LearningEvidenceState;
    usageState?: LearningUsageState;
    pinned?: boolean;
  }): Promise<{ resource_version: LearningResourceVersionRecord }> {
    const [currentResource, currentDocument, currentContent, existingCurrent, existingVersions] = await Promise.all([
      this.dependencies.getCurrentResource({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.readCurrentDocument({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.readCurrentContent({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.getCurrentVersion({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.listVersions({ resourceKind: input.resourceKind, resourceId: input.resourceId })
    ]);
    if (!currentResource || !currentDocument || currentContent === undefined) {
      throw this.dependencies.requestError("not_found", "learning_resource_update_target_not_found");
    }

    const current = existingCurrent ?? await this.createUpdateBaseline({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      resource: currentResource,
      content: currentContent
    });
    const versions = existingCurrent ? existingVersions : [...existingVersions, current];
    const nextVersion = nextLearningResourceVersion(versions);
    const nextContent = input.content ?? currentContent;
    const effectiveUsageScope = input.usageScope ?? currentResource.usage_scope;
    const written = await this.dependencies.writeCurrentResource({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      content: nextContent,
      version: nextVersion,
      contentHash: stableHash(nextContent),
      ...(effectiveUsageScope === undefined ? {} : { usageScope: effectiveUsageScope }),
      evidenceState: input.evidenceState ?? currentResource.evidence_state ?? "inferred",
      usageState: input.usageState ?? currentResource.usage_state ?? "limited",
      pinned: input.pinned ?? currentResource.pinned ?? false
    });
    if (!written) throw this.dependencies.requestError("not_found", "learning_resource_update_target_not_found");
    const record: LearningResourceVersionRecord = {
      id: createId("learning_version"),
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      version: nextVersion,
      parent_version: current.version,
      file_path: written.file_path,
      content_hash: written.content_hash,
      change_reason: input.changeReason,
      source_run_ids: current.source_run_ids,
      actor: "user_edit",
      is_current: true,
      created_at: nowIso()
    };
    try {
      await this.dependencies.saveVersion({ record, previousContent: currentDocument });
    } catch (error) {
      await this.dependencies.restoreCurrentDocument({
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        markdown: currentDocument,
        version: current.version
      }).catch(() => undefined);
      throw error;
    }
    return { resource_version: record };
  }

  /** Archive is a Versioned Curator mutation, never a direct filesystem transition. */
  async archive(input: {
    resourceKind: VersionedLearningResourceKind;
    resourceId: string;
    changeReason: string;
  }): Promise<{ resource_version: LearningResourceVersionRecord }> {
    const [currentResource, currentDocument, currentContent, existingCurrent, existingVersions] = await Promise.all([
      this.dependencies.getCurrentResource({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.readCurrentDocument({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.readCurrentContent({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.getCurrentVersion({ resourceKind: input.resourceKind, resourceId: input.resourceId }),
      this.dependencies.listVersions({ resourceKind: input.resourceKind, resourceId: input.resourceId })
    ]);
    if (!currentResource || !currentDocument || currentContent === undefined) {
      throw this.dependencies.requestError("not_found", "learning_resource_archive_target_not_found");
    }
    if (currentResource.pinned) {
      throw this.dependencies.requestError("conflict", "learning_resource_archive_pinned");
    }
    const current = existingCurrent ?? await this.createUpdateBaseline({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      resource: currentResource,
      content: currentContent
    });
    const versions = existingCurrent ? existingVersions : [...existingVersions, current];
    const nextVersion = nextLearningResourceVersion(versions);
    const written = await this.dependencies.writeCurrentResource({
      resourceKind: input.resourceKind,
      resourceId: input.resourceId,
      content: currentContent,
      version: nextVersion,
      contentHash: stableHash(currentContent),
      ...(currentResource.usage_scope === undefined ? {} : { usageScope: currentResource.usage_scope }),
      evidenceState: currentResource.evidence_state ?? "inferred",
      usageState: "dormant",
      pinned: false,
      archive: true
    });
    if (!written) throw this.dependencies.requestError("not_found", "learning_resource_archive_target_not_found");
    const record: LearningResourceVersionRecord = {
      id: createId("learning_version"),
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      version: nextVersion,
      parent_version: current.version,
      file_path: written.file_path,
      content_hash: written.content_hash,
      change_reason: input.changeReason,
      source_run_ids: current.source_run_ids,
      actor: "curator",
      is_current: true,
      created_at: nowIso()
    };
    try {
      await this.dependencies.saveVersion({ record, previousContent: currentDocument });
    } catch (error) {
      await this.dependencies.restoreCurrentDocument({
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        markdown: currentDocument,
        version: current.version
      }).catch(() => undefined);
      throw error;
    }
    return { resource_version: record };
  }

  private async createUpdateBaseline(input: {
    resourceKind: VersionedLearningResourceKind;
    resourceId: string;
    resource: {
      file_path: string;
      version?: string;
      content_hash?: string;
      source_run_ids?: string[];
      usage_scope?: UsageScopeRef;
      evidence_state?: LearningEvidenceState;
      usage_state?: LearningUsageState;
      pinned?: boolean;
    };
    content: string;
  }): Promise<LearningResourceVersionRecord> {
    const baseline: LearningResourceVersionRecord = {
      id: createId("learning_version"),
      resource_kind: input.resourceKind,
      resource_id: input.resourceId,
      version: input.resource.version ?? "0",
      file_path: input.resource.file_path,
      content_hash: input.resource.content_hash ?? stableHash(input.content),
      change_reason: "existing_resource_first_version",
      source_run_ids: input.resource.source_run_ids ?? [],
      actor: "legacy_update_baseline",
      is_current: true,
      created_at: nowIso()
    };
    return this.dependencies.saveVersion({ record: baseline });
  }
}

function nextLearningResourceVersion(versions: LearningResourceVersionRecord[]): string {
  const numericVersions = versions
    .map((entry) => Number(entry.version))
    .filter((value) => Number.isSafeInteger(value) && value >= 0);
  return String((numericVersions.length ? Math.max(...numericVersions) : 0) + 1);
}
