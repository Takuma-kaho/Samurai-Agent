/**
 * C shard: hand-reviewed Handler cases for Learning, Skill, Wiki, and Work.
 *
 * This file is deliberately independent of the production Handler source.
 * A case names every public input it exercises, its control-flow branch, and
 * the complete ordered Port-call contract.  The executable C matrix owns the
 * corresponding concrete narrow Port fixtures.
 */
export interface CHandlerCallExpectation {
  method: string;
  args: unknown[];
}

export interface CHandlerCaseExpectation {
  id: string;
  input: Record<string, unknown>;
  /** Explicit handler-control branches reached by this case. */
  branches: readonly string[];
  /** Optional trusted context overrides for a distinct Handler branch. */
  context?: { sessionId?: string; runId?: string; envelopeId?: string };
  calls: readonly CHandlerCallExpectation[];
}

export interface CHandlerExpectation {
  /** Every control-flow branch in the concrete Handler must appear here. */
  requiredBranches: readonly string[];
  cases: readonly CHandlerCaseExpectation[];
}

const now = "2026-07-17T00:00:00.000Z";
const provenance = { kind: "user_authored", summary: "fixture provenance", verified: true };
const resourceRef = { kind: "artifact", id: "artifact_fixture", uri: "artifacts/fixture.md", label: "Fixture artifact" };
const memoryFixture = {
  id: "memory_fixture", state: "session", topic: "fixture-memory", source: "fixture", source_locale: "en", content_locale: "en",
  source_kind: "owner_instruction", instruction_authority: "owner", confidence: 1, created_by: "fixture", created_at: now, updated_at: now,
  related_memories: [], conflicts_with: [], sensitive_level: "none", source_refs: [resourceRef], provenance
};
const memoryFile = { ...memoryFixture, file_path: "memory/memory_fixture.md" };
const archivedMemoryFile = { ...memoryFile, state: "archived" };
const memoryArchiveRef = { kind: "memory", id: "memory_fixture", uri: "memory/memory_fixture.md", label: "fixture-memory" };
const expectedMemoryArchiveOperation = (status: "created" | "completed") => ({
  id: "$generated:operation-id", session_id: "session_fixture", capability_id: "memory", operation: "memory.archive", actor_identity: "owner",
  instruction_source: "owner_instruction", instruction_authority: "owner", channel: "web", input_hash: "$generated:input-hash", input_ref: memoryArchiveRef,
  target_resource_refs: [memoryArchiveRef], proposed_effects: ["Archive a session-linked memory so it no longer appears in normal memory views."], status,
  created_at: "$generated:time", updated_at: "$generated:time", ...(status === "completed" ? { result_ref: memoryArchiveRef } : {})
});
const sessionFixture = { id: "session_fixture", session_key: "session_fixture", title: "Fixture session", ui_locale: "en", output_locale: "ja", created_at: now, updated_at: now };
const envelopeFixture = { id: "envelope_fixture", source: "web", actor_identity: "owner", session_key: "session_fixture", user_intent: "Fixture intent", attachments: [], input_locale: "en", output_locale: "ja", metadata: {}, received_at: now };
const fixtureOperation = { id: "operation_fixture", session_id: "session_fixture", capability_id: "fixture", operation: "fixture.operation", actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "test", input_hash: "fixture_hash", target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now };
const presentationRenderSpec = { kind: "collection", collection_id: "collection_fixture", view_id: "view_explicit", title: "Fixture collection", columns: [], rows: [] };
const reflectionMessages = [
  { id: "message_user", session_id: "session_fixture", role: "user", content: "Fixture user request", input_locale: "en", output_locale: "ja", created_at: now },
  { id: "message_agent", session_id: "session_fixture", role: "agent", content: "Fixture agent answer", input_locale: "en", output_locale: "ja", created_at: now }
];
const reflectionBackendRunFixture = {
  id: "run_fixture", session_id: "session_fixture", agent_id: "agent_fixture", input_message_id: "message_user",
  backend_id: "backend_fixture", backend_kind: "samurai_native", status: "completed", started_at: now, completed_at: now,
  input_summary: "Fixture user request", metadata: {}
};
const storedSkillFixture = {
  id: "skill_fixture", title: "Fixture Skill", description: "Fixture skill description", tags: ["fixture"], state: "project", allowed_scopes: ["workspace"], required_capabilities: [], owner_pinned: false,
  frontmatter: { id: "skill_fixture", state: "project", title: "Fixture Skill", description: "Fixture skill description", tags: ["fixture"], provenance: "fixture", trust_level: "user_authored", allowed_scopes: ["workspace"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, owner_pinned: false, source_refs: [resourceRef], provenance_detail: provenance },
  file_path: "skills/skill_fixture.md"
};
const generatedSkillFixture = (state: "candidate" | "project", title = "Fixture Skill") => ({
  ...storedSkillFixture,
  id: "$generated:skill-id",
  title,
  state,
  frontmatter: { ...storedSkillFixture.frontmatter, id: "$generated:skill-id", title, state }
});
const patchedSkillFixture = { ...storedSkillFixture, title: "Updated Skill", description: "Updated description", tags: ["updated"], frontmatter: { ...storedSkillFixture.frontmatter, title: "Updated Skill", description: "Updated description", tags: ["updated"] } };
const storedWikiFixture = { id: "wiki_fixture", slug: "fixture-wiki", title: "Fixture Wiki", state: "proposed", content_locale: "en", tags: ["fixture"], source_refs: [resourceRef], provenance, created_at: now, updated_at: now, file_path: "wiki/fixture-wiki.md" };
const wikiRefFixture = { kind: "wiki", id: "wiki_fixture", uri: "wiki/fixture-wiki.md", label: "Fixture Wiki" };
const wikiStateCalls = (operationName: "wiki.accept" | "wiki.archive" | "wiki.reject", state: "active" | "archived" | "rejected", prefix: string, proposedEffect: string) => [
  { method: "getWikiPage", args: ["wiki_fixture"] },
  { method: "ensureWikiSession", args: [] },
  { method: "createWikiEnvelope", args: [`${prefix}: Fixture Wiki`] },
  { method: "runWikiMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName, proposedEffects: [proposedEffect], targetResourceRefs: [wikiRefFixture], execute: "$function" }] },
  { method: "setWikiPageState", args: ["wiki_fixture", state] },
  { method: "createWikiRollback", args: [fixtureOperation, [wikiRefFixture], { wiki: storedWikiFixture }, { wiki: { ...storedWikiFixture, state } }] }
];
const patchedWikiFixture = { ...storedWikiFixture, title: "Updated Wiki", tags: ["updated"] };
const reflectionSuggestionFixture = (kind: "memory" | "knowledge_wiki" | "skill") => ({ id: `suggestion_${kind === "knowledge_wiki" ? "wiki" : kind}`, reflection_run_id: "reflection_fixture", suggestion_type: kind, status: "proposed", title: "Fixture suggestion", content: "Fixture suggestion content", source_refs: [resourceRef], confidence: 0.8, created_at: now, updated_at: now });

// Calls are filled by the executable matrix alongside each narrow Port
// implementation. Keeping them in this frozen declaration makes a Handler
// change require a conscious test review rather than silently following code.
export const cHandlerExpectations = {
  "curator.run": {
    requiredBranches: ["idle_gate:omitted", "idle_gate:present"],
    cases: [
      { id: "idle-gate-omitted", input: {}, branches: ["idle_gate:omitted"], calls: [{ method: "runCurator", args: [{}] }] },
      { id: "idle-gate-enabled", input: { respect_idle_gate: true }, branches: ["idle_gate:present"], calls: [{ method: "runCurator", args: [{ respectIdleGate: true }] }] },
      { id: "reason-driven-resource", input: { reason: "refutation", resource_kind: "memory", resource_id: "memory_fixture" }, branches: ["idle_gate:omitted"], calls: [{ method: "runCurator", args: [{ reason: "refutation", resourceKind: "memory", resourceId: "memory_fixture" }] }] }
    ]
  },
  "evaluation.run": {
    requiredBranches: [],
    cases: [{
      id: "source-run", input: { source_run_id: "run_fixture" }, branches: [], calls: [{ method: "runAppliedEvaluation", args: [{ sourceRunId: "run_fixture", sessionId: "session_fixture" }] }]
    }]
  },
  "memory.archive": {
    requiredBranches: ["archive:session-linked-memory"],
    cases: [{
      id: "session-linked-memory", input: { memory_id: "memory_fixture" }, branches: ["archive:session-linked-memory"], calls: [
        { method: "getMemorySession", args: ["session_fixture"] },
        { method: "getMemoryForArchive", args: ["memory_fixture"] },
        { method: "listMemoryForSession", args: ["session_fixture"] },
        { method: "memoryResourceRef", args: [memoryFile] },
        { method: "memoryArchiveCapabilityId", args: [] },
        { method: "saveMemoryArchiveOperation", args: [expectedMemoryArchiveOperation("created")] },
        { method: "emitMemoryArchiveOperation", args: [expectedMemoryArchiveOperation("created")] },
        { method: "archiveMemoryRecord", args: ["memory_fixture"] },
        { method: "memoryResourceRef", args: [archivedMemoryFile] },
        { method: "createMemoryArchiveRollback", args: [expectedMemoryArchiveOperation("created"), [memoryArchiveRef], { memory: { frontmatter: memoryFixture, file_path: "memory/memory_fixture.md" } }, { memory: { frontmatter: { ...memoryFixture, state: "archived" }, file_path: "memory/memory_fixture.md" } }] },
        { method: "updateMemoryArchiveOperation", args: [expectedMemoryArchiveOperation("completed")] },
        { method: "rebuildMemoryActivity", args: [] }
      ]
    }]
  },
  "memory.session.create": {
    requiredBranches: ["session:existing", "session:create"],
    cases: [
      {
        id: "existing-session-all-fields",
        input: { content: "Remember this session detail.", input_locale: "en", output_locale: "ja", ui_locale: "en", title: "Session memory", metadata: { source: "fixture" } },
        branches: ["session:existing"],
        calls: [
          { method: "getMemorySession", args: ["session_fixture"] },
          { method: "createMemoryEnvelope", args: [{ session: sessionFixture, content: "Remember this session detail.", inputLocale: "en", outputLocale: "ja", metadata: { source: "fixture" }, envelopeId: "envelope_fixture" }] },
          { method: "runMemoryMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "memory.session.create", proposedEffects: ["Keep the current user intent in session memory."], execute: "$function" }] },
          { method: "writeSessionMemory", args: [envelopeFixture, "Remember this session detail."] },
          { method: "memoryResourceRef", args: [memoryFixture] },
          { method: "createMemoryRollback", args: [fixtureOperation, [memoryArchiveRef], { memory_id: "memory_fixture" }] },
          { method: "emitMemoryCandidate", args: [memoryFixture] }
        ]
      },
      {
        id: "create-session-defaults",
        input: { content: "Create a session for this memory.", metadata: {} },
        branches: ["session:create"],
        context: { sessionId: undefined, envelopeId: undefined },
        calls: [
          { method: "createMemorySession", args: [{ title: undefined, ui_locale: undefined, output_locale: undefined }] },
          { method: "createMemoryEnvelope", args: [{ session: sessionFixture, content: "Create a session for this memory.", inputLocale: "en", outputLocale: "ja", metadata: {}, envelopeId: undefined }] },
          { method: "runMemoryMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "memory.session.create", proposedEffects: ["Keep the current user intent in session memory."], execute: "$function" }] },
          { method: "writeSessionMemory", args: [envelopeFixture, "Create a session for this memory."] },
          { method: "memoryResourceRef", args: [memoryFixture] },
          { method: "createMemoryRollback", args: [fixtureOperation, [memoryArchiveRef], { memory_id: "memory_fixture" }] },
          { method: "emitMemoryCandidate", args: [memoryFixture] }
        ]
      }
    ]
  },
  "memory.topic.create": {
    requiredBranches: ["topic:explicit-kind"],
    cases: [{
      id: "explicit-kind-all-fields", input: { content: "Remember this preference.", input_locale: "en", output_locale: "ja", topic_kind: "preference", metadata: { source: "fixture" } }, branches: ["topic:explicit-kind"], calls: [
        { method: "getMemorySession", args: ["session_fixture"] },
        { method: "createMemoryEnvelope", args: [{ session: sessionFixture, content: "Remember this preference.", inputLocale: "en", outputLocale: "ja", metadata: { source: "fixture" }, envelopeId: "envelope_fixture" }] },
        { method: "runMemoryMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "memory.topic.create", proposedEffects: ["Create a visible topic memory candidate."], execute: "$function" }] },
        { method: "writeTopicMemory", args: [envelopeFixture, "preference", "Remember this preference."] },
        { method: "memoryResourceRef", args: [{ ...memoryFixture, state: "topic" }] },
        { method: "createMemoryRollback", args: [fixtureOperation, [memoryArchiveRef], { memory_id: "memory_fixture" }] },
        { method: "emitMemoryCandidate", args: [{ ...memoryFixture, state: "topic" }] }
      ]
    }]
  },
  "message.presentation.update": {
    requiredBranches: ["view_id:explicit", "view_id:fallback"],
    cases: [
      {
        id: "explicit-view-id", input: { presentation_id: "presentation_fixture", view_state: { view_id: "view_explicit", page: 2 } }, branches: ["view_id:explicit"], calls: [
          { method: "getMessagePresentation", args: ["presentation_fixture"] },
          { method: "presentCollectionView", args: [{ collectionId: "collection_fixture", viewId: "view_explicit" }] },
          { method: "applyPresentationViewState", args: [presentationRenderSpec, { view_id: "view_explicit", page: 2 }] },
          { method: "presentationViewStateFromSpec", args: [{ ...presentationRenderSpec, view_state: { view_id: "view_explicit", page: 2 } }] },
          { method: "updateMessagePresentationViewState", args: [{ id: "presentation_fixture", viewState: { view_id: "view_explicit", page: 2 } }] }
        ]
      },
      {
        id: "fallback-to-stored-view", input: { presentation_id: "presentation_fixture", view_state: { page: 3 } }, branches: ["view_id:fallback"], calls: [
          { method: "getMessagePresentation", args: ["presentation_fixture"] },
          { method: "presentCollectionView", args: [{ collectionId: "collection_fixture", viewId: "view_stored" }] },
          { method: "applyPresentationViewState", args: [presentationRenderSpec, { page: 3 }] },
          { method: "presentationViewStateFromSpec", args: [{ ...presentationRenderSpec, view_state: { page: 3 } }] },
          { method: "updateMessagePresentationViewState", args: [{ id: "presentation_fixture", viewState: { page: 3 } }] }
        ]
      }
    ]
  },
  "objective.create": {
    requiredBranches: ["objective:explicit-identifiers-and-budgets", "objective:generated-identifiers-and-default-title"],
    cases: [
      {
        id: "all-public-fields",
        input: { objective_id: "objective_explicit", title: "Explicit objective", objective: "Finish the fixture", completion_criteria: ["all checks pass"], token_budget: 1000, time_budget_ms: 60_000, max_attempts: 5 },
        branches: ["objective:explicit-identifiers-and-budgets"],
        calls: [{ method: "saveObjective", args: [{ id: "objective_explicit", session_id: "session_fixture", title: "Explicit objective", objective: "Finish the fixture", completion_criteria: ["all checks pass"], status: "active", token_budget: 1000, time_budget_ms: 60_000, max_attempts: 5, created_at: "$generated:time", updated_at: "$generated:time" }] }]
      },
      {
        id: "generated-defaults",
        input: { objective: "Create a durable objective with a generated title.", completion_criteria: ["saved"] },
        branches: ["objective:generated-identifiers-and-default-title"],
        calls: [{ method: "saveObjective", args: [{ id: "$generated:objective-id", session_id: "session_fixture", title: "Create a durable objective with a generated title.", objective: "Create a durable objective with a generated title.", completion_criteria: ["saved"], status: "active", token_budget: undefined, time_budget_ms: undefined, max_attempts: undefined, created_at: "$generated:time", updated_at: "$generated:time" }] }]
      }
    ]
  },
  "presentation.plan": {
    requiredBranches: ["requested_kind:built_in_surface", "requested_kind:generated_surface"],
    cases: [
      { id: "built-in", input: { requested_kind: "built_in_surface" }, branches: ["requested_kind:built_in_surface"], calls: [] },
      { id: "generated", input: { requested_kind: "generated_surface" }, branches: ["requested_kind:generated_surface"], calls: [] }
    ]
  },
  "reflection.run": {
    requiredBranches: ["source_run:session", "source_run:backend"],
    cases: [
      {
        id: "session-scope", input: {}, branches: ["source_run:session"], calls: [
          { method: "getReflectionSession", args: ["session_fixture"] },
          { method: "listReflectionMessages", args: ["session_fixture"] },
          { method: "listReflectionToolRuns", args: [undefined] },
          { method: "listReflectionWorkspaceChanges", args: ["session_fixture"] },
          { method: "listReflectionBackendEvents", args: [{ sessionId: "session_fixture" }] },
          { method: "loadReflectionArtifacts", args: [{ sessionId: "session_fixture", sourceRunId: undefined, workspaceChanges: [] }] },
          { method: "executeReflectionWorkflow", args: [{ kind: "manual", session: sessionFixture, userMessage: reflectionMessages[0], agentMessage: reflectionMessages[1], backendEvents: [], workspaceChanges: [], toolRuns: [], transcriptMessages: reflectionMessages, artifacts: [] }] }
        ]
      },
      {
        id: "backend-run-scope", input: { source_run_id: "run_fixture" }, branches: ["source_run:backend"], calls: [
          { method: "getReflectionSession", args: ["session_fixture"] },
          { method: "getReflectionBackendRun", args: ["run_fixture"] },
          { method: "listReflectionMessages", args: ["session_fixture"] },
          { method: "listReflectionToolRuns", args: ["run_fixture"] },
          { method: "listReflectionWorkspaceChanges", args: ["session_fixture"] },
          { method: "listReflectionBackendEvents", args: [{ runId: "run_fixture" }] },
          { method: "loadReflectionArtifacts", args: [{ sessionId: "session_fixture", sourceRunId: "run_fixture", workspaceChanges: [] }] },
          { method: "executeReflectionWorkflow", args: [{ kind: "manual", session: sessionFixture, sourceRunId: "run_fixture", backendRun: reflectionBackendRunFixture, userMessage: reflectionMessages[0], agentMessage: reflectionMessages[1], backendEvents: [], workspaceChanges: [], toolRuns: [], transcriptMessages: reflectionMessages, artifacts: [] }] }
        ]
      }
    ]
  },
  "reflection.suggestion.apply": {
    requiredBranches: ["suggestion:memory", "suggestion:knowledge_wiki", "suggestion:skill"],
    cases: [
      {
        id: "memory", input: { suggestion_id: "suggestion_memory" }, branches: ["suggestion:memory"], calls: [
          { method: "getReflectionSuggestion", args: ["session_fixture", "suggestion_memory"] },
          { method: "ensureReflectionMutationSession", args: [] },
          { method: "createReflectionMutationEnvelope", args: ["Apply reflection suggestion: Fixture suggestion"] },
          { method: "runReflectionSuggestionMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "reflection.suggestion.apply", proposedEffects: ["Apply memory reflection suggestion."], targetResourceRefs: [resourceRef], execute: "$function" }] },
          { method: "reflectionNow", args: [] },
          { method: "createReflectionMemoryTarget", args: [{ title: "Fixture suggestion", content: "Fixture suggestion content", envelope: envelopeFixture }] },
          { method: "createReflectionTargetRollback", args: [fixtureOperation, [memoryArchiveRef], { memory: memoryFixture }] },
          { method: "updateReflectionSuggestion", args: [{ ...reflectionSuggestionFixture("memory"), status: "applied" }] }
        ]
      },
      {
        id: "wiki", input: { suggestion_id: "suggestion_wiki" }, branches: ["suggestion:knowledge_wiki"], calls: [
          { method: "getReflectionSuggestion", args: ["session_fixture", "suggestion_wiki"] },
          { method: "ensureReflectionMutationSession", args: [] },
          { method: "createReflectionMutationEnvelope", args: ["Apply reflection suggestion: Fixture suggestion"] },
          { method: "runReflectionSuggestionMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "reflection.suggestion.apply", proposedEffects: ["Apply knowledge_wiki reflection suggestion."], targetResourceRefs: [resourceRef], execute: "$function" }] },
          { method: "reflectionNow", args: [] },
          { method: "createReflectionWikiTarget", args: [{ title: "Fixture suggestion", content: "Fixture suggestion content", sourceRefs: [resourceRef] }] },
          { method: "updateReflectionSuggestion", args: [{ ...reflectionSuggestionFixture("knowledge_wiki"), status: "applied", target_ref: { kind: "wiki", id: "wiki_fixture", uri: "wiki/fixture-wiki.md", label: "Fixture Wiki" } }] }
        ]
      },
      {
        id: "skill", input: { suggestion_id: "suggestion_skill" }, branches: ["suggestion:skill"], calls: [
          { method: "getReflectionSuggestion", args: ["session_fixture", "suggestion_skill"] },
          { method: "ensureReflectionMutationSession", args: [] },
          { method: "createReflectionMutationEnvelope", args: ["Apply reflection suggestion: Fixture suggestion"] },
          { method: "runReflectionSuggestionMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "reflection.suggestion.apply", proposedEffects: ["Apply skill reflection suggestion."], targetResourceRefs: [resourceRef], execute: "$function" }] },
          { method: "reflectionNow", args: [] },
          { method: "createReflectionSkillTarget", args: [{ title: "Fixture suggestion", content: "Fixture suggestion content", sourceRefs: [resourceRef] }] },
          { method: "updateReflectionSuggestion", args: [{ ...reflectionSuggestionFixture("skill"), status: "applied", target_ref: { kind: "skill", id: "skill_fixture", uri: "skills/skill_fixture.md", label: "Fixture Skill" } }] }
        ]
      }
    ]
  },
  "resource.translation_job.save": {
    requiredBranches: ["source:artifact", "source:memory", "source:wiki", "source:skill", "source:collection_record", "schedule:default"],
    cases: [
      {
        id: "artifact-all-options",
        input: { source_ref: resourceRef, source_locale: "en", target_locale: "ja", title: "Translate artifact", schedule: "daily", enabled: true, next_run_at: now, max_attempts: 4 },
        branches: ["source:artifact"],
        calls: [
          { method: "loadArtifactTranslationSource", args: ["artifact_fixture"] },
          { method: "hashTranslationContent", args: ["Source body for artifact"] },
          { method: "saveTranslationAutomationJob", args: [{ title: "Translate artifact", kind: "resource_translation", schedule: "daily", target_instruction: "Translate artifact/artifact_fixture from ja to ja.", delivery_target: { channel: "resource_translation", source_ref: resourceRef, source_locale: "ja", target_locale: "ja", original_hash: "hash_translation_fixture", source_label: "Fixture artifact", room_id: "room_fixture" }, enabled: true, next_run_at: now, max_attempts: 4 }] }
        ]
      },
      {
        id: "memory", input: { source_ref: { kind: "memory", id: "memory_fixture", uri: "memory/fixture.md" }, target_locale: "en" }, branches: ["source:memory", "schedule:default"], calls: [
          { method: "loadMemoryTranslationSource", args: ["memory_fixture"] },
          { method: "hashTranslationContent", args: ["Source body for memory"] },
          { method: "saveTranslationAutomationJob", args: [{ title: "Translate memory/memory_fixture to en", kind: "resource_translation", schedule: "once", target_instruction: "Translate memory/memory_fixture from ja to en.", delivery_target: { channel: "resource_translation", source_ref: { kind: "memory", id: "memory_fixture", uri: "memory/fixture.md" }, source_locale: "ja", target_locale: "en", original_hash: "hash_translation_fixture", source_label: "memory_fixture", room_id: "room_fixture" }, enabled: undefined, next_run_at: undefined, max_attempts: undefined }] }
        ]
      },
      {
        id: "wiki", input: { source_ref: { kind: "wiki", id: "wiki_fixture", uri: "wiki/fixture.md" }, target_locale: "en" }, branches: ["source:wiki"], calls: [
          { method: "loadWikiTranslationSource", args: ["wiki_fixture"] },
          { method: "hashTranslationContent", args: ["Source body for wiki"] },
          { method: "saveTranslationAutomationJob", args: [{ title: "Translate wiki/wiki_fixture to en", kind: "resource_translation", schedule: "once", target_instruction: "Translate wiki/wiki_fixture from en to en.", delivery_target: { channel: "resource_translation", source_ref: { kind: "wiki", id: "wiki_fixture", uri: "wiki/fixture.md" }, source_locale: "en", target_locale: "en", original_hash: "hash_translation_fixture", source_label: "wiki_fixture", room_id: "room_fixture" }, enabled: undefined, next_run_at: undefined, max_attempts: undefined }] }
        ]
      },
      {
        id: "skill", input: { source_ref: { kind: "skill", id: "skill_fixture", uri: "skills/fixture.md" }, target_locale: "en" }, branches: ["source:skill"], calls: [
          { method: "loadSkillTranslationSource", args: ["skill_fixture"] },
          { method: "stripTranslationSkillFrontmatter", args: ["---\n{}\n---\nSkill body"] },
          { method: "hashTranslationContent", args: ["Skill body"] },
          { method: "saveTranslationAutomationJob", args: [{ title: "Translate skill/skill_fixture to en", kind: "resource_translation", schedule: "once", target_instruction: "Translate skill/skill_fixture from en to en.", delivery_target: { channel: "resource_translation", source_ref: { kind: "skill", id: "skill_fixture", uri: "skills/fixture.md" }, source_locale: "en", target_locale: "en", original_hash: "hash_translation_fixture", source_label: "skill_fixture", room_id: "room_fixture" }, enabled: undefined, next_run_at: undefined, max_attempts: undefined }] }
        ]
      },
      {
        id: "collection-record", input: { source_ref: { kind: "collection_record", id: "collection:record", uri: "collections/fixture/records/record.json" }, target_locale: "en" }, branches: ["source:collection_record"], calls: [
          { method: "loadCollectionRecordTranslationSource", args: [{ kind: "collection_record", id: "collection:record", uri: "collections/fixture/records/record.json" }] },
          { method: "hashTranslationContent", args: ["Source body for collection_record"] },
          { method: "saveTranslationAutomationJob", args: [{ title: "Translate collection_record/collection:record to en", kind: "resource_translation", schedule: "once", target_instruction: "Translate collection_record/collection:record from ja to en.", delivery_target: { channel: "resource_translation", source_ref: { kind: "collection_record", id: "collection:record", uri: "collections/fixture/records/record.json" }, source_locale: "ja", target_locale: "en", original_hash: "hash_translation_fixture", source_label: "collection:record", room_id: "room_fixture" }, enabled: undefined, next_run_at: undefined, max_attempts: undefined }] }
        ]
      }
    ]
  },
  "resource.translation.save": {
    requiredBranches: ["translation:save"],
    cases: [
      { id: "all-public-fields", input: { id: "translation_fixture", source_ref: resourceRef, source_locale: "en", target_locale: "ja", status: "verified", original_hash: "hash_fixture", translated_text: "翻訳済み", provenance, created_at: now, updated_at: now }, branches: ["translation:save"], calls: [{ method: "saveResourceTranslation", args: [{ id: "translation_fixture", sourceRef: resourceRef, sourceLocale: "en", targetLocale: "ja", status: "verified", originalHash: "hash_fixture", translatedText: "翻訳済み", provenance, createdAt: now, updatedAt: now }] }] },
      { id: "draft", input: { id: "translation_draft", source_ref: resourceRef, source_locale: "en", target_locale: "ja", status: "draft", original_hash: "hash_draft", translated_text: "下書き", created_at: now, updated_at: now }, branches: ["translation:save"], calls: [{ method: "saveResourceTranslation", args: [{ id: "translation_draft", sourceRef: resourceRef, sourceLocale: "en", targetLocale: "ja", status: "draft", originalHash: "hash_draft", translatedText: "下書き", provenance: undefined, createdAt: now, updatedAt: now }] }] },
      { id: "missing", input: { id: "translation_missing", source_ref: resourceRef, source_locale: "en", target_locale: "ja", status: "missing", original_hash: "hash_missing", translated_text: "", created_at: now, updated_at: now }, branches: ["translation:save"], calls: [{ method: "saveResourceTranslation", args: [{ id: "translation_missing", sourceRef: resourceRef, sourceLocale: "en", targetLocale: "ja", status: "missing", originalHash: "hash_missing", translatedText: "", provenance: undefined, createdAt: now, updatedAt: now }] }] }
    ]
  },
  "skill.candidate.create": {
    requiredBranches: ["candidate:create"],
    cases: [{
      id: "all-public-fields", input: { title: "Candidate Skill", content: "# Candidate\nUse this procedure.", description: "Candidate description", tags: ["fixture"], required_capabilities: ["filesystem"], source_refs: [resourceRef], provenance_detail: provenance, usage_scope: { kind: "room", room_id: "room_fixture" } }, branches: ["candidate:create"], calls: [
        { method: "skillMutationContract", args: ["skill.candidate.create"] },
        { method: "ensureSkillMutationSession", args: [] },
        { method: "createSkillMutationEnvelope", args: ["Create skill candidate: Candidate Skill"] },
        { method: "runSkillMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "skill.candidate.create", proposedEffects: ["Fixture effect for skill.candidate.create"], execute: "$function" }] },
        { method: "saveSkillMarkdown", args: [{ state: "candidate", skillId: "$generated:skill-id", markdown: "$generated:skill-markdown" }] },
        { method: "skillResourceRef", args: [generatedSkillFixture("candidate")] },
        { method: "createSkillRollback", args: [fixtureOperation, [{ kind: "skill", id: "$generated:skill-id", uri: "skills/skill_fixture.md", label: "Fixture Skill" }], {}, { skill_id: "$generated:skill-id" }] }
      ]
    }]
  },
  "skill.lifecycle.apply": {
    requiredBranches: ["action:mark_stale", "action:archive", "action:reactivate"],
    cases: [
      { id: "mark-stale", input: { skill_id: "skill_fixture", action: "mark_stale" }, branches: ["action:mark_stale"], calls: [{ method: "applySkillLifecycle", args: [{ skillId: "skill_fixture", action: "mark_stale" }] }] },
      { id: "archive", input: { skill_id: "skill_fixture", action: "archive" }, branches: ["action:archive"], calls: [{ method: "applySkillLifecycle", args: [{ skillId: "skill_fixture", action: "archive" }] }] },
      { id: "reactivate", input: { skill_id: "skill_fixture", action: "reactivate" }, branches: ["action:reactivate"], calls: [{ method: "applySkillLifecycle", args: [{ skillId: "skill_fixture", action: "reactivate" }] }] }
    ]
  },
  "skill.optimization.start": {
    requiredBranches: ["examples:omitted", "examples:provided", "session:trusted"],
    cases: [
      { id: "defaults", input: { skill_id: "skill_fixture" }, branches: ["examples:omitted", "session:trusted"], calls: [{ method: "startSkillOptimization", args: [{ skillId: "skill_fixture", sessionId: "session_fixture" }] }] },
      { id: "all-options", input: { skill_id: "skill_fixture", objective: "Improve reliability", golden_examples: [{ prompt: "p", expected: "e" }], synthetic_examples: [{ prompt: "s", expected: "e" }] }, branches: ["examples:provided", "session:trusted"], calls: [{ method: "startSkillOptimization", args: [{ skillId: "skill_fixture", sessionId: "session_fixture", objective: "Improve reliability", goldenExamples: [{ prompt: "p", expected: "e" }], syntheticExamples: [{ prompt: "s", expected: "e" }] }] }] }
    ]
  },
  "skill.optimization.cancel": {
    requiredBranches: ["optimization:cancel"],
    cases: [{ id: "run", input: { optimization_run_id: "optimization_run_fixture" }, branches: ["optimization:cancel"], calls: [{ method: "cancelSkillOptimization", args: [{ optimizationRunId: "optimization_run_fixture" }] }] }]
  },
  "skill.optimization.promote": {
    requiredBranches: ["optimization:promote"],
    cases: [{ id: "candidate", input: { optimization_run_id: "optimization_run_fixture", candidate_id: "candidate_fixture" }, branches: ["optimization:promote"], calls: [{ method: "promoteSkillOptimization", args: [{ optimizationRunId: "optimization_run_fixture", candidateId: "candidate_fixture" }] }] }]
  },
  "skill.optimization.reject": {
    requiredBranches: ["optimization:reject"],
    cases: [{ id: "candidate", input: { optimization_run_id: "optimization_run_fixture", candidate_id: "candidate_fixture" }, branches: ["optimization:reject"], calls: [{ method: "rejectSkillOptimization", args: [{ optimizationRunId: "optimization_run_fixture", candidateId: "candidate_fixture" }] }] }]
  },
  "skill.optimization.rollback": {
    requiredBranches: ["rollback:promotion", "rollback:snapshot", "rollback:both"],
    cases: [
      { id: "promotion-only", input: { promotion_id: "promotion_fixture" }, branches: ["rollback:promotion"], calls: [{ method: "rollbackSkillOptimization", args: [{ promotionId: "promotion_fixture" }] }] },
      { id: "snapshot-only", input: { snapshot_id: "snapshot_fixture" }, branches: ["rollback:snapshot"], calls: [{ method: "rollbackSkillOptimization", args: [{ snapshotId: "snapshot_fixture" }] }] },
      { id: "both", input: { promotion_id: "promotion_fixture", snapshot_id: "snapshot_fixture" }, branches: ["rollback:both"], calls: [{ method: "rollbackSkillOptimization", args: [{ promotionId: "promotion_fixture", snapshotId: "snapshot_fixture" }] }] }
    ]
  },
  "skill.patch": {
    requiredBranches: ["patch:all-fields"],
    cases: [{
      id: "all-public-fields", input: { skill_id: "skill_fixture", title: "Updated Skill", description: "Updated description", tags: ["updated"], content: "# Updated\nBody" }, branches: ["patch:all-fields"], calls: [
        { method: "getSkillForMutation", args: ["skill_fixture"] },
        { method: "readSkillMarkdown", args: ["skill_fixture"] },
        { method: "skillMutationContract", args: ["skill.patch"] },
        { method: "ensureSkillMutationSession", args: [] },
        { method: "createSkillMutationEnvelope", args: ["Edit Skill: Fixture Skill"] },
        { method: "skillResourceRef", args: [storedSkillFixture] },
        { method: "runSkillMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "skill.patch", proposedEffects: ["Fixture effect for skill.patch"], targetResourceRefs: [{ kind: "skill", id: "skill_fixture", uri: "skills/skill_fixture.md", label: "Fixture Skill" }], execute: "$function" }] },
        { method: "patchSkillRecord", args: [{ id: "skill_fixture", title: "Updated Skill", description: "Updated description", tags: ["updated"], content: "# Updated\nBody" }] },
        { method: "skillResourceRef", args: [patchedSkillFixture] },
        { method: "createSkillRollback", args: [fixtureOperation, [{ kind: "skill", id: "skill_fixture", uri: "skills/skill_fixture.md", label: "Updated Skill" }], { skill: storedSkillFixture, markdown: "# Old skill body" }, { skill: patchedSkillFixture }] }
      ]
    }]
  },
  "skill.project.save": {
    requiredBranches: ["candidate:project-save"],
    cases: [{
      id: "candidate", input: { candidate_id: "candidate_fixture" }, branches: ["candidate:project-save"], calls: [
        { method: "readSkillMarkdown", args: ["candidate_fixture"] },
        { method: "skillMutationContract", args: ["skill.project.save"] },
        { method: "ensureSkillMutationSession", args: [] },
        { method: "createSkillMutationEnvelope", args: ["Save project skill from candidate: candidate_fixture"] },
        { method: "runSkillMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "skill.project.save", proposedEffects: ["Fixture effect for skill.project.save"], execute: "$function" }] },
        { method: "saveSkillMarkdown", args: [{ state: "project", skillId: "$generated:skill-id", markdown: "$generated:skill-markdown" }] },
        { method: "skillResourceRef", args: [generatedSkillFixture("project", "Candidate Skill")] },
        { method: "createSkillRollback", args: [fixtureOperation, [{ kind: "skill", id: "$generated:skill-id", uri: "skills/skill_fixture.md", label: "Candidate Skill" }], {}, { skill_id: "$generated:skill-id", candidate_id: "candidate_fixture" }] }
      ]
    }]
  },
  "skill.support_file.save": {
    requiredBranches: ["support-file:save"],
    cases: [{
      id: "all-public-fields", input: { skill_id: "skill_fixture", path: "references/guide.md", content: "Support content" }, branches: ["support-file:save"], calls: [
        { method: "getSkillForMutation", args: ["skill_fixture"] },
        { method: "listSkillSupportFiles", args: ["skill_fixture"] },
        { method: "skillMutationContract", args: ["skill.support_file.save"] },
        { method: "ensureSkillMutationSession", args: [] },
        { method: "createSkillMutationEnvelope", args: ["Save Skill support file: Fixture Skill/references/guide.md"] },
        { method: "skillResourceRef", args: [storedSkillFixture] },
        { method: "runSkillMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "skill.support_file.save", proposedEffects: ["Fixture effect for skill.support_file.save"], targetResourceRefs: [{ kind: "skill", id: "skill_fixture", uri: "skills/skill_fixture.md", label: "Fixture Skill" }], execute: "$function" }] },
        { method: "writeSkillSupportFile", args: [{ skillId: "skill_fixture", path: "references/guide.md", content: "Support content" }] },
        { method: "createSkillRollback", args: [fixtureOperation, [{ kind: "skill_support", id: "skill_fixture:references/guide.md", uri: "skills/skill_fixture/references/guide.md", label: "references/guide.md" }], { path: "skills/skill_fixture/references/guide.md", content: "Old support content" }, { path: "skills/skill_fixture/references/guide.md", content: "Support content" }] }
      ]
    }]
  },
  "skill.view": {
    requiredBranches: ["path:body", "path:support"],
    cases: [
      { id: "body", input: { skill_id: "skill_fixture" }, branches: ["path:body"], calls: [{ method: "viewSkill", args: [{ skillId: "skill_fixture", runId: "run_fixture" }] }] },
      { id: "support-file", input: { skill_id: "skill_fixture", path: "references/guide.md" }, branches: ["path:support"], calls: [{ method: "viewSkill", args: [{ skillId: "skill_fixture", runId: "run_fixture", path: "references/guide.md" }] }] }
    ]
  },
  "wiki.accept": {
    requiredBranches: ["state:active"],
    cases: [{ id: "active", input: { wiki_id: "wiki_fixture" }, branches: ["state:active"], calls: wikiStateCalls("wiki.accept", "active", "Accepted wiki page", "Accept a wiki proposal for active retrieval.") }]
  },
  "wiki.archive": {
    requiredBranches: ["state:archived"],
    cases: [{ id: "archived", input: { wiki_id: "wiki_fixture" }, branches: ["state:archived"], calls: wikiStateCalls("wiki.archive", "archived", "Archived wiki page", "Archive a wiki page without deleting its markdown.") }]
  },
  "wiki.patch": {
    requiredBranches: ["patch:all-fields"],
    cases: [{
      id: "all-public-fields", input: { wiki_id: "wiki_fixture", title: "Updated Wiki", content: "Updated wiki content", tags: ["updated"], content_locale: "en", source_refs: [resourceRef], provenance }, branches: ["patch:all-fields"], calls: [
        { method: "getWikiPage", args: ["wiki_fixture"] },
        { method: "readWikiContent", args: ["wiki_fixture"] },
        { method: "ensureWikiSession", args: [] },
        { method: "createWikiEnvelope", args: ["Patch wiki page: Fixture Wiki"] },
        { method: "runWikiMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "wiki.patch", proposedEffects: ["Edit wiki page frontmatter or markdown content."], execute: "$function" }] },
        { method: "updateWikiPage", args: [{ id: "wiki_fixture", title: "Updated Wiki", content: "Updated wiki content", tags: ["updated"], content_locale: "en", source_refs: [resourceRef], provenance }] },
        { method: "createWikiRollback", args: [fixtureOperation, [{ kind: "wiki", id: "wiki_fixture", uri: "wiki/fixture-wiki.md", label: "Updated Wiki" }], { wiki: storedWikiFixture, content: "Old wiki content" }, { wiki: patchedWikiFixture, content: "Updated wiki content" }] }
      ]
    }]
  },
  "wiki.proposal.create": {
    requiredBranches: ["proposal:all-fields"],
    cases: [{
      id: "all-public-fields", input: { title: "Wiki Proposal", content: "Proposal content", slug: "wiki-proposal", tags: ["fixture"], source_refs: [resourceRef], content_locale: "en", provenance }, branches: ["proposal:all-fields"], calls: [
        { method: "ensureWikiSession", args: [] },
        { method: "createWikiEnvelope", args: ["Create wiki proposal: Wiki Proposal"] },
        { method: "runWikiMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "wiki.proposal.create", proposedEffects: ["Create a proposed wiki markdown page."], execute: "$function" }] },
        { method: "saveWikiPage", args: [{ id: "$generated:wiki-id", slug: "wiki-proposal", title: "Wiki Proposal", state: "proposed", content_locale: "en", tags: ["fixture"], source_refs: [resourceRef], provenance, created_at: "$generated:time", updated_at: "$generated:time" }, "Proposal content"] },
        { method: "createWikiRollback", args: [fixtureOperation, [{ kind: "wiki", id: "$generated:wiki-id", uri: "wiki/wiki-proposal.md", label: "Wiki Proposal" }], {}, { wiki_id: "$generated:wiki-id" }] }
      ]
    }]
  },
  "wiki.reindex": {
    requiredBranches: ["reindex:all-pages"],
    cases: [{ id: "empty-input", input: {}, branches: ["reindex:all-pages"], calls: [
      { method: "ensureWikiSession", args: [] },
      { method: "createWikiEnvelope", args: ["Reindex wiki pages"] },
      { method: "runWikiMutation", args: [{ session: sessionFixture, envelope: envelopeFixture, operationName: "wiki.reindex", proposedEffects: ["Refresh the SQLite wiki index from markdown files."], execute: "$function" }] },
      { method: "reindexWikiPages", args: [] }
    ] }]
  },
  "wiki.reject": {
    requiredBranches: ["state:rejected"],
    cases: [{ id: "rejected", input: { wiki_id: "wiki_fixture" }, branches: ["state:rejected"], calls: wikiStateCalls("wiki.reject", "rejected", "Rejected wiki page", "Reject a wiki proposal without deleting its markdown.") }]
  },
  "work_item.create": {
    requiredBranches: ["work-item:explicit-values", "work-item:generated-defaults"],
    cases: [
      {
        id: "all-public-fields", input: { objective_id: "objective_fixture", work_item_id: "work_item_explicit", parent_work_item_id: "parent_fixture", instruction: "Execute the fixture work", priority: 4, max_attempts: 5, work_idempotency_key: "work-key" }, branches: ["work-item:explicit-values"], calls: [
          { method: "getWorkItemObjective", args: ["objective_fixture"] },
          { method: "saveWorkItem", args: [{ id: "work_item_explicit", objective_id: "objective_fixture", parent_work_item_id: "parent_fixture", instruction: "Execute the fixture work", status: "ready", priority: 4, attempt: 0, max_attempts: 5, idempotency_key: "work-key", created_at: "$generated:time", updated_at: "$generated:time" }] }
        ]
      },
      {
        id: "generated-defaults", input: { objective_id: "objective_fixture", instruction: "Use generated work defaults" }, branches: ["work-item:generated-defaults"], calls: [
          { method: "getWorkItemObjective", args: ["objective_fixture"] },
          { method: "saveWorkItem", args: [{ id: "$generated:work-item-id", objective_id: "objective_fixture", parent_work_item_id: undefined, instruction: "Use generated work defaults", status: "ready", priority: 0, attempt: 0, max_attempts: 3, idempotency_key: "$generated:work-idempotency-key", created_at: "$generated:time", updated_at: "$generated:time" }] }
        ]
      }
    ]
  }
} as const satisfies Record<string, CHandlerExpectation>;

export const cHandlerOperationIds = Object.keys(cHandlerExpectations).sort();
export const cHandlerOperationCount = cHandlerOperationIds.length;
export const cHandlerCaseCount = Object.values(cHandlerExpectations).reduce((count, expectation) => count + expectation.cases.length, 0);
