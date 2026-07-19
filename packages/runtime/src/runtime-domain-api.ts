import { domainOperationIdFor } from "@samurai-agent/domain-operations";
import { stableHash, type JsonValue } from "@samurai-agent/core-schemas";

type RuntimeDomainActorIdentity = "owner" | "owner_scheduled" | "paired_contact";
export interface RuntimeDomainTrustedContext {
  sessionId?: string;
  runId?: string;
  actorIdentity?: RuntimeDomainActorIdentity;
  correlationId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface RuntimeDomainApiDispatcher {
  command(input: { command_id: string; idempotency_key?: string; input_source?: "runtime_api" | "automation"; payload?: unknown }, trusted?: RuntimeDomainTrustedContext): Promise<{ result: unknown }>;
  query(input: { query_id: string; payload?: unknown }, trusted?: RuntimeDomainTrustedContext): Promise<{ result: unknown }>;
}

/** Runtime API composition owns operation selection and transport envelopes. */
export class RuntimeDomainApi {
  constructor(private readonly dispatcher: RuntimeDomainApiDispatcher) {}

  async archiveMemory(input: { memoryId: string; sessionId: string }): Promise<unknown> {
    const result = await this.dispatcher.command({
      command_id: domainOperationIdFor("memoryArchive"),
      idempotency_key: "memory_archive_request",
      payload: { memory_id: input.memoryId }
    }, { sessionId: input.sessionId });
    return result.result;
  }

  async viewSkill(input: { skillId: string; runId: string; path?: string }): Promise<unknown> {
    const result = await this.dispatcher.query({
      query_id: domainOperationIdFor("skillView"),
      payload: { skill_id: input.skillId, ...(input.path === undefined ? {} : { path: input.path }) }
    }, { runId: input.runId });
    return result.result;
  }

  async recordSkillUsage(input: { skillId: string; runId: string; resourceId: string; contentHash: string; stage: string; metadata: Record<string, JsonValue> }): Promise<unknown> {
    const result = await this.dispatcher.command({
      command_id: domainOperationIdFor("skillUsageRecord"),
      idempotency_key: "skill_usage_request",
      payload: {
        skill_id: input.skillId,
        resource_id: input.resourceId,
        content_hash: input.contentHash,
        stage: input.stage,
        metadata: input.metadata
      }
    }, { runId: input.runId });
    return result.result;
  }

  async restoreRollbackPoint(id: string): Promise<unknown> {
    const result = await this.dispatcher.command({
      command_id: domainOperationIdFor("rollbackRestore"),
      idempotency_key: `rollback.restore:${id}`,
      payload: { rollback_point_id: id }
    });
    return result.result;
  }

  async saveAutomationJob(input: unknown): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("automationJobSave"), idempotency_key: "automation_job_save_request", payload: input });
    return result.result;
  }

  async applyReflectionSuggestion(input: { suggestionId: string }): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("reflectionSuggestionApply"), idempotency_key: "reflection_apply_request", payload: { suggestion_id: input.suggestionId } });
    return result.result;
  }

  async createSkillCandidate(input: unknown): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("skillCandidateCreate"), idempotency_key: "skill_candidate_create", payload: input });
    return result.result;
  }

  async saveSkillProject(input: { candidateId: string }): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("skillProjectSave"), idempotency_key: "skill_project_save", payload: { candidate_id: input.candidateId } });
    return result.result;
  }

  async saveSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("skillSupportFileSave"), idempotency_key: "skill_support_file_save", payload: { skill_id: input.skillId, path: input.path, content: input.content } });
    return result.result;
  }

  async createWikiProposal(input: unknown): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("wikiProposalCreate"), idempotency_key: `wiki_create:${stableHash(input)}`, payload: input });
    return result.result;
  }

  async wikiAction(action: "accept" | "reject" | "archive", id: string): Promise<unknown> {
    const operation = action === "accept" ? "wikiAccept" : action === "reject" ? "wikiReject" : "wikiArchive";
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor(operation), idempotency_key: `wiki_${action}`, payload: { wiki_id: id } });
    return result.result;
  }

  async patchWikiPage(input: { id: string; [key: string]: unknown }): Promise<unknown> {
    const { id, ...patch } = input;
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("wikiPatch"), idempotency_key: "wikiPatch", payload: { wiki_id: id, ...patch } });
    return result.result;
  }

  async reindexWiki(): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("wikiReindex"), idempotency_key: "wiki_reindex", payload: {} });
    return result.result;
  }

  async reindexCollections(): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("collectionReindex"), idempotency_key: "collection_reindex_request", payload: {} });
    return result.result;
  }

  async createCollectionRecord(record: { collection_id: string; id: string; data: unknown; resource_refs: unknown }): Promise<unknown> {
    const payload = { collection_id: record.collection_id, record_id: record.id, data: record.data, resource_refs: record.resource_refs };
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("collectionRecordCreate"), idempotency_key: `collection_record_create_request:${stableHash(payload)}`, payload });
    return result.result;
  }

  async applyCollectionPatch(input: { collectionId: string; recordId: string; patch: { id: string; changes: unknown; expected_version?: number } }): Promise<unknown> {
    const idempotencyKey = `collection_patch_apply:${stableHash({ collection_id: input.collectionId, record_id: input.recordId, patch_id: input.patch.id })}`;
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("collectionPatchApply"), idempotency_key: idempotencyKey, payload: { collection_id: input.collectionId, record_id: input.recordId, patch_id: input.patch.id, changes: input.patch.changes, ...(input.patch.expected_version === undefined ? {} : { expected_version: input.patch.expected_version }) } });
    return result.result;
  }

  async deleteCollectionRecord(input: { collectionId: string; recordId: string; viewId?: string }): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("collectionRecordDelete"), idempotency_key: "collection_record_delete_request", payload: { collection_id: input.collectionId, record_id: input.recordId, ...(input.viewId === undefined ? {} : { view_id: input.viewId }) } });
    return result.result;
  }

  async runCollectionAction(input: unknown): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("collectionActionRun"), idempotency_key: `collection_action_run_request:${stableHash(input)}`, payload: input });
    return result.result;
  }

  async runMemoryReviewAutomation(): Promise<unknown> {
    const result = await this.dispatcher.command({ command_id: domainOperationIdFor("automationMemoryReviewRun"), input_source: "automation", idempotency_key: "automation_memory_review_request", payload: {} });
    return result.result;
  }
}
