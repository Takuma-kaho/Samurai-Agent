/**
 * A shard: hand-reviewed Handler contracts for artifact, browser, collection,
 * generated-surface, graph, rollback, workspace, and file operations.
 *
 * This file is intentionally written independently of Handler source.  The
 * matrix executes these cases against narrow Ports and treats every listed
 * call (method, arguments, order, and count) as the reviewed contract.
 */

export type HandlerArgExpectation =
  | { readonly $handler_matrix: "function" };

export interface AHandlerCallExpectation {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface AHandlerNestedBranch {
  /** JSON path inside the public DTO, after Input.parse. */
  readonly path: readonly string[];
  /** Frozen static-catalog anyOf/oneOf branch index. */
  readonly branch: number;
  /** Human-readable branch identity; checked against the parsed DTO. */
  readonly label: string;
}

export interface AHandlerCaseExpectation {
  readonly id: string;
  readonly input: Record<string, unknown>;
  /** Explicit control-flow branches owned by the concrete Handler. */
  readonly branches: readonly string[];
  /** Optional trusted context overrides for a Handler branch. */
  readonly context?: { readonly sessionId?: string; readonly runId?: string; readonly envelopeId?: string };
  /** Explicit metadata is required for non-trivial nested union branches. */
  readonly nestedBranches?: readonly AHandlerNestedBranch[];
  readonly calls: readonly AHandlerCallExpectation[];
}

export interface AHandlerExpectation {
  readonly requiredBranches: readonly string[];
  readonly cases: readonly AHandlerCaseExpectation[];
}

export const fn = { $handler_matrix: "function" } as const;
export const call = (method: string, ...args: unknown[]): AHandlerCallExpectation => ({ method, args });

const now = "2026-07-17T00:00:00.000Z";
const localeValues = ["en", "ja", "zh", "ko", "es", "pt-BR", "fr", "de"] as const;
const artifactKinds = ["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"] as const;
const editorSources = ["chat", "surface", "provider", "image_provider", "restore", "system"] as const;
const interactionKinds = ["opened", "action", "corrected", "regenerated", "pinned", "unpinned", "dismissed"] as const;
const interactionCommandResult = (index: number): unknown => index % 3 === 0
  ? "fixture-result"
  : index % 3 === 1
    ? ["fixture-result"]
    : { status: "completed" };
const graphDocument = { version: "1", nodes: [], edges: [] };
const artifactRef = { kind: "artifact", id: "artifact_fixture", uri: "artifacts/artifact_fixture.md", label: "Fixture artifact" };
const fileRef = { kind: "file", id: "workspace/fixture.txt", uri: "workspace/fixture.txt", label: "workspace/fixture.txt" };
const session = { id: "session_fixture", session_key: "session_fixture", title: "Fixture session", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now };
const operation = { id: "operation_fixture", session_id: "session_fixture", capability_id: "fixture", operation: "fixture", actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "test", input_hash: "fixture_hash", target_resource_refs: [], proposed_effects: [], status: "completed", created_at: now, updated_at: now };
const artifact = { id: "artifact_fixture", title: "Fixture artifact", kind: "markdown", locale: "en", source_locales: ["en"], file_ref: artifactRef, metadata: { current_revision_id: "revision_fixture" }, source_operation_id: "operation_fixture", created_by: "fixture", created_at: now, updated_at: now };
const graphArtifactRef = { kind: "artifact", id: "graph_fixture", uri: "artifacts/graph_fixture.json", label: "Fixture graph" };
const graphArtifact = { ...artifact, id: "graph_fixture", title: "Fixture graph", kind: "graph", file_ref: graphArtifactRef };
const revisionRef = { kind: "artifact_revision", id: "revision_fixture", uri: "artifacts/artifact_fixture/revisions/revision_fixture", label: "Fixture revision" };
const revision = { id: "revision_fixture", artifact_id: "artifact_fixture", revision: 1, parent_revision_id: "base_fixture", source_ref: artifactRef, file_ref: revisionRef, blob_ref: { kind: "file", id: "blobs/revision_fixture", uri: "blobs/revision_fixture", label: "Fixture blob" }, content_hash: "fixture_hash", content_bytes: 8, created_at: now };
const collectionSchema = { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}, file_path: "collections/collection_fixture/schema.json" };
const collectionRecord = { id: "record_fixture", collection_id: "collection_fixture", version: 1, data: { title: "Fixture" }, resource_refs: [artifactRef], created_at: now, updated_at: now, file_path: "collections/collection_fixture/records/record_fixture.json" };
const collectionRecordRef = { kind: "collection_record", id: "collection_fixture:record_fixture", uri: collectionRecord.file_path, label: "Fixture record" };
const collectionSchemaRef = { kind: "collection_schema", id: "collection_fixture", uri: collectionSchema.file_path, label: "Fixture collection" };
const envelope = { id: "envelope_fixture", source: "web", actor_identity: "owner", session_key: "session_fixture", user_intent: "Fixture intent", attachments: [], input_locale: "en", output_locale: "en", metadata: {}, received_at: now };
const rollbackPoint = { id: "rollback_fixture", operation_id: "operation_fixture", affected_resources: [artifactRef], before_snapshot: {}, after_snapshot: {}, reversible: true, irreversible_effects: [], created_at: now, expires_at: "2099-01-01T00:00:00.000Z" };
const browserFileRef = (relativePath: string) => ({ kind: "file", id: relativePath, uri: relativePath, label: relativePath });

const surfaceBundle = {
  title: "Fixture surface",
  html: "<main>fixture</main>",
  css: "main{}",
  script: "",
  actions: [{ id: "action_fixture", label: "Create", command_id: "artifact.create", input_schema: {}, payload_template: { approved: true }, requires_confirmation: false }],
  input_data_schema: {},
  assets: [{ path: "assets/fixture.txt", content: "fixture", encoding: "utf8", mime_type: "text/plain" }]
};
const generatedSurfaceAction = surfaceBundle.actions[0]!;
const surface = { id: "surface_fixture", state: "ephemeral", session_id: "session_fixture", title: "Fixture surface", input_data_schema: {}, actions: [generatedSurfaceAction], capability_manifest: { allowed_domain_commands: ["artifact.create"], network_access: "none", workspace_write: "domain_commands_only" }, source_refs: [], content_hash: "surface_hash", current_revision_id: "surface_revision_fixture", current_revision: 1, preview_url: "surfaces/surface_fixture", fallback_chain: ["built_in_surface"], created_at: now, updated_at: now };
const surfaceRevision = { id: "surface_revision_fixture", surface_id: "surface_fixture", revision: 1, prompt_fingerprint: "surface_hash", knowledge_refs: [], skill_refs: [], html_ref: { kind: "file", id: "surfaces/surface_fixture/index.html", uri: "surfaces/surface_fixture/index.html", label: "Fixture HTML" }, asset_refs: [], bundle_hash: "surface_hash", validation_report: { valid: true, issues: [], html_bytes: 20, css_bytes: 6, script_bytes: 0, action_count: 1, csp: "default-src 'none'" }, created_at: now };

const surfaceRequest = (expectedLifetime: "message" | "session" | "pinned", fallback: "built_in_surface" | "artifact" | "text") => ({
  user_intent: "Show fixture",
  source_resource_refs: [],
  allowed_domain_commands: ["artifact.create"],
  selected_knowledge_refs: [],
  selected_skill_refs: [],
  client_capabilities: {},
  expected_lifetime: expectedLifetime,
  fallback_chain: [fallback]
});
const persistedSurfaceRequest = (expectedLifetime: "message" | "session" | "pinned", fallback: "built_in_surface" | "artifact" | "text") => ({
  id: "surface_request_fixture",
  session_id: "session_fixture",
  domain_operation_id: "operation_fixture",
  ...surfaceRequest(expectedLifetime, fallback),
  created_at: now
});

const mutation = (operationName: string, proposedEffects: readonly string[], extra: Record<string, unknown> = {}) => ({
  session,
  envelope,
  operationName,
  proposedEffects,
  execute: fn,
  ...extra
});

const contextMutation = (operationName: string, inputSummary: string, proposedEffects: readonly string[], extra: Record<string, unknown> = {}) => ({
  trustedContext: {
    inputSource: "runtime_api",
    workspaceId: "handler-matrix-workspace",
    actorId: "handler-matrix-actor",
    correlationId: "handler-matrix",
    sessionId: "session_fixture",
    runId: "run_fixture"
  },
  operationName,
  inputSummary,
  proposedEffects,
  execute: fn,
  ...extra
});
const generatedSurfaceCreateMutation = contextMutation(
  "generated_surface.create",
  "Create generated surface: Fixture surface",
  ["Validate and persist a versioned Generated Surface bundle."]
);
const generatedSurfaceReviseMutation = contextMutation(
  "generated_surface.revise",
  "Revise generated surface: Fixture surface",
  ["Create a new immutable Generated Surface revision."],
  { targetResourceRefs: [{ kind: "generated_surface", id: "surface_fixture", uri: "surfaces/surface_fixture", label: "Fixture surface" }] }
);

/**
 * Each case deliberately includes enough DTO examples to cover every frozen
 * top-level field, required key, enum value, and union branch.  The executable
 * matrix derives the expected sets only from the frozen schema catalog and
 * mechanically rejects a non-zero missing set.
 */
export const aHandlerExpectations = {
  "artifact.create": {
    requiredBranches: ["kind:graph", "kind:non_graph"],
    cases: artifactKinds.map((kind, index) => {
      const inputLocale = localeValues[index % localeValues.length];
      const outputLocale = localeValues[(index + 1) % localeValues.length];
      return {
        id: `kind-${kind}`,
        input: { content: kind === "graph" ? JSON.stringify(graphDocument) : `Fixture ${kind}`, title: `Fixture ${kind}`, kind, input_locale: inputLocale, output_locale: outputLocale, metadata: { fixture: kind } },
        branches: [kind === "graph" ? "kind:graph" : "kind:non_graph"],
        calls: [
          ...(kind === "graph" ? [call("validateGraphArtifactContent", kind === "graph" ? JSON.stringify(graphDocument) : `Fixture ${kind}`)] : []),
          call("artifactDefaultLocales"),
          call("artifactContract", "artifact.create"),
          call("runArtifactMutation", contextMutation("artifact.create", `Create artifact: Fixture ${kind}`, ["Create a local workspace artifact draft."])),
          call("createArtifactDraft", { operation, title: `Fixture ${kind}`, content: kind === "graph" ? JSON.stringify(graphDocument) : `Fixture ${kind}`, kind, locale: outputLocale, sourceLocales: [inputLocale], createdBy: "handler-matrix-actor", metadata: { fixture: kind } }),
          call("createArtifactRollback", operation, [artifactRef], {}, { artifact_id: "artifact_fixture" })
        ]
      };
    })
  },
  "artifact.export_pdf": {
    requiredBranches: ["pdf:valid"],
    cases: [{
      id: "valid-source",
      input: { artifact_id: "artifact_fixture" },
      branches: ["pdf:valid"],
      calls: [
        call("getArtifact", "artifact_fixture"), call("readArtifactContent", "artifact_fixture"),
        call("exportArtifactPdf", { title: "Fixture artifact", content: "fixture content", source: artifact }), call("artifactContract", "artifact.export_pdf"),
        call("runArtifactMutation", contextMutation("artifact.export_pdf", "Export PDF: Fixture artifact", ["Create a PDF Artifact from the selected source Artifact."], { targetResourceRefs: [artifactRef] })),
        call("createArtifactDraft", { operation, title: "Fixture artifact.pdf", content: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), mime_type: "application/pdf", extension: "pdf", preview: "Fixture artifact" }, kind: "pdf", locale: "en", sourceLocales: ["en"], createdBy: "handler-matrix-actor", metadata: { source_artifact_id: "artifact_fixture", source_revision_id: "revision_fixture", export_adapter_id: "fixture_adapter" } }),
        call("createArtifactRollback", operation, [artifactRef, artifactRef], {}, { artifact_id: "artifact_fixture", source_artifact_id: "artifact_fixture" })
      ]
    }]
  },
  "artifact.repair": {
    requiredBranches: ["repair:performed"],
    cases: [{
      id: "repair",
      input: { artifact_id: "artifact_fixture" },
      branches: ["repair:performed"],
      calls: [call("artifactContract", "artifact.repair"), call("getArtifact", "artifact_fixture"), call("runArtifactMutation", contextMutation("artifact.repair", "Repair artifact source: Fixture artifact", ["Restore a missing Artifact revision file from its verified content blob."], { targetResourceRefs: [artifactRef] })), call("repairArtifactRevisionSource", "artifact_fixture")]
    }]
  },
  "artifact.restore_revision": {
    requiredBranches: ["revision:explicit-options"],
    cases: [{
      id: "all-fields",
      input: { artifact_id: "artifact_fixture", revision_id: "revision_fixture", base_revision_id: "base_fixture", change_summary: "Restore fixture revision", expected_revision: 3 },
      branches: ["revision:explicit-options"],
      calls: [
        call("artifactContract", "artifact.restore_revision"), call("getArtifact", "artifact_fixture"), call("getArtifactRevision", "revision_fixture"), call("readArtifactRevisionContent", "revision_fixture"),
        call("runArtifactMutation", contextMutation("artifact.restore_revision", "Restore artifact revision: Fixture artifact", ["Create a new current Artifact revision from an earlier revision."], { targetResourceRefs: [artifactRef, revisionRef] })),
        call("createArtifactRevision", { artifactId: "artifact_fixture", content: new Uint8Array([1, 2, 3]), baseRevisionId: "base_fixture", expectedRevision: 3, editorSource: "restore", changeSummary: "Restore fixture revision", provenance: { restored_from_revision_id: "revision_fixture" } }),
        call("createArtifactRollback", operation, [artifactRef, revisionRef], { artifact }, { artifact })
      ]
    }]
  },
  "artifact.revise": {
    requiredBranches: editorSources.map((value) => `editor_source:${value}`),
    cases: editorSources.map((editor_source, index) => ({
      id: `editor-${editor_source}`,
      input: { artifact_id: "artifact_fixture", content: `Revised ${editor_source}`, base_revision_id: "base_fixture", change_summary: `Update ${editor_source}`, editor_source, extension: "md", expected_revision: 3, provenance: { editor_source } },
      branches: [`editor_source:${editor_source}`],
      calls: [
        call("getArtifact", "artifact_fixture"), call("artifactContract", "artifact.revise"),
        call("runArtifactMutation", contextMutation("artifact.revise", "Revise artifact: Fixture artifact", ["Create an immutable Artifact revision and update its current pointer."], { targetResourceRefs: [artifactRef] })),
        call("createArtifactRevision", { artifactId: "artifact_fixture", content: `Revised ${editor_source}`, producerRunId: "run_fixture", extension: "md", baseRevisionId: "base_fixture", expectedRevision: 3, editorSource: editor_source, changeSummary: `Update ${editor_source}`, provenance: { editor_source } }),
        call("createArtifactRollback", operation, [artifactRef, revisionRef], { artifact }, { artifact })
      ]
    }))
  },
  "browser.download_to_workspace": {
    requiredBranches: ["output_path:explicit", "output_path:default"],
    cases: [
      { id: "explicit-path", input: { url: "https://example.com/page", output_path: "browser/fixture.txt" }, branches: ["output_path:explicit"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.download_to_workspace: https://example.com/page"), call("runBrowserMutation", mutation("browser.download_to_workspace", ["browser.download_to_workspace https://example.com/page without mutating external state."])), call("readBrowserPage", "https://example.com/page"), call("resolveBrowserWorkspacePath", "browser/fixture.txt"), call("ensureBrowserWorkspaceParent", "/tmp/handler-matrix/browser/fixture.txt"), call("readBrowserWorkspaceText", "/tmp/handler-matrix/browser/fixture.txt"), call("writeBrowserWorkspaceFile", "/tmp/handler-matrix/browser/fixture.txt", "Fixture browser text"), call("createBrowserRollback", operation, [browserFileRef("browser/fixture.txt")], { path: "browser/fixture.txt", content: "before fixture" }, { path: "browser/fixture.txt", content: "Fixture browser text" })] },
      { id: "default-path", input: { url: "https://example.com/default" }, branches: ["output_path:default"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.download_to_workspace: https://example.com/default"), call("runBrowserMutation", mutation("browser.download_to_workspace", ["browser.download_to_workspace https://example.com/default without mutating external state."])), call("readBrowserPage", "https://example.com/default"), call("stableBrowserHash", "https://example.com/default"), call("resolveBrowserWorkspacePath", "browser/browser_hash.txt"), call("ensureBrowserWorkspaceParent", "/tmp/handler-matrix/browser/browser_hash.txt"), call("readBrowserWorkspaceText", "/tmp/handler-matrix/browser/browser_hash.txt"), call("writeBrowserWorkspaceFile", "/tmp/handler-matrix/browser/browser_hash.txt", "Fixture browser text"), call("createBrowserRollback", operation, [browserFileRef("browser/browser_hash.txt")], { path: "browser/browser_hash.txt", content: "before fixture" }, { path: "browser/browser_hash.txt", content: "Fixture browser text" })] }
    ]
  },
  "browser.screenshot": {
    requiredBranches: ["output_path:explicit", "output_path:default", "mime:png", "mime:jpeg"],
    cases: [
      { id: "png-explicit", input: { url: "https://example.com/page", output_path: "browser/fixture.png" }, branches: ["output_path:explicit", "mime:png"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.screenshot: https://example.com/page"), call("runBrowserMutation", mutation("browser.screenshot", ["browser.screenshot https://example.com/page without mutating external state."])), call("captureBrowserScreenshot", "https://example.com/page"), call("resolveBrowserWorkspacePath", "browser/fixture.png"), call("ensureBrowserWorkspaceParent", "/tmp/handler-matrix/browser/fixture.png"), call("readBrowserWorkspaceBytes", "/tmp/handler-matrix/browser/fixture.png"), call("writeBrowserWorkspaceFile", "/tmp/handler-matrix/browser/fixture.png", new Uint8Array([1, 2, 3])), call("browserBytesToBase64", new Uint8Array([1])), call("stableBrowserHash", new Uint8Array([1, 2, 3])), call("createBrowserRollback", operation, [browserFileRef("browser/fixture.png")], { path: "browser/fixture.png", content: "AQ==" }, { path: "browser/fixture.png", content_hash: "browser_hash" })] },
      { id: "jpeg-default", input: { url: "https://example.com/default" }, branches: ["output_path:default", "mime:jpeg"], calls: [call("ensureBrowserSession"), call("createBrowserEnvelope", session, "browser.screenshot: https://example.com/default"), call("runBrowserMutation", mutation("browser.screenshot", ["browser.screenshot https://example.com/default without mutating external state."])), call("captureBrowserScreenshot", "https://example.com/default"), call("stableBrowserHash", "https://example.com/default"), call("resolveBrowserWorkspacePath", "browser/browser_hash.jpg"), call("ensureBrowserWorkspaceParent", "/tmp/handler-matrix/browser/browser_hash.jpg"), call("readBrowserWorkspaceBytes", "/tmp/handler-matrix/browser/browser_hash.jpg"), call("writeBrowserWorkspaceFile", "/tmp/handler-matrix/browser/browser_hash.jpg", new Uint8Array([1, 2, 3])), call("browserBytesToBase64", new Uint8Array([1])), call("stableBrowserHash", new Uint8Array([1, 2, 3])), call("createBrowserRollback", operation, [browserFileRef("browser/browser_hash.jpg")], { path: "browser/browser_hash.jpg", content: "AQ==" }, { path: "browser/browser_hash.jpg", content_hash: "browser_hash" })] }
    ]
  },
  "collection.patch.apply": {
    requiredBranches: ["patch:explicit-id-and-version"],
    cases: [{ id: "all-fields", input: { collection_id: "collection_fixture", record_id: "record_fixture", changes: { status: "done" }, expected_version: 2, patch_id: "patch_fixture" }, branches: ["patch:explicit-id-and-version"], calls: [call("runCollectionMutation", contextMutation("collection.patch.apply", "Apply collection patch: collection_fixture/record_fixture", ["Apply a collection patch to an existing local record."])), call("applyCollectionRecordPatch", { collectionId: "collection_fixture", recordId: "record_fixture", patch: { id: "patch_fixture", record_id: "record_fixture", changes: { status: "done" }, expected_version: 2, source_operation_id: "operation_fixture", created_at: "$generated:time" } }), call("collectionRecordRef", collectionRecord), call("createCollectionRollback", operation, [collectionRecordRef], { record: collectionRecord }, { record: collectionRecord }), call("queueCollectionTrigger", { collectionId: "collection_fixture", recordId: "record_fixture", event: "record.patched" })] }]
  },
  "collection.record.create": {
    requiredBranches: ["record:explicit-id-and-refs"],
    cases: [{ id: "all-fields", input: { collection_id: "collection_fixture", record_id: "record_fixture", data: { title: "Fixture" }, resource_refs: [artifactRef] }, branches: ["record:explicit-id-and-refs"], calls: [call("runCollectionMutation", contextMutation("collection.record.create", "Create collection record: collection_fixture/record_fixture", ["Create a collection record file and SQLite index row."])), call("saveCollectionRecord", { id: "record_fixture", collection_id: "collection_fixture", version: 1, data: { title: "Fixture" }, resource_refs: [artifactRef], created_at: "$generated:time", updated_at: "$generated:time" }), call("collectionRecordRef", collectionRecord), call("createCollectionRollback", operation, [collectionRecordRef], {}, { collection_id: "collection_fixture", record_id: "record_fixture" }), call("queueCollectionTrigger", { collectionId: "collection_fixture", recordId: "record_fixture", event: "record.created" })] }]
  },
  "collection.record.delete": {
    requiredBranches: ["view_id:explicit", "view_id:omitted", "expected_version:explicit"],
    cases: [
      { id: "explicit-view", input: { collection_id: "collection_fixture", record_id: "record_fixture", view_id: "view_fixture" }, branches: ["view_id:explicit"], calls: [call("getCollectionSchemaForMutation", "collection_fixture"), call("collectionDeleteAllowed", collectionSchema, "view_fixture"), call("getCollectionRecord", "collection_fixture", "record_fixture"), call("runCollectionMutation", contextMutation("collection.record.delete", "Delete collection record: collection_fixture/record_fixture", ["Delete a collection record file and SQLite index row."])), call("deleteCollectionRecord", "collection_fixture", "record_fixture", undefined), call("collectionRecordRef", collectionRecord), call("createCollectionRollback", operation, [collectionRecordRef], { record: collectionRecord }, {})] },
      { id: "omitted-view", input: { collection_id: "collection_fixture", record_id: "record_fixture" }, branches: ["view_id:omitted"], calls: [call("getCollectionSchemaForMutation", "collection_fixture"), call("collectionDeleteAllowed", collectionSchema, undefined), call("getCollectionRecord", "collection_fixture", "record_fixture"), call("runCollectionMutation", contextMutation("collection.record.delete", "Delete collection record: collection_fixture/record_fixture", ["Delete a collection record file and SQLite index row."])), call("deleteCollectionRecord", "collection_fixture", "record_fixture", undefined), call("collectionRecordRef", collectionRecord), call("createCollectionRollback", operation, [collectionRecordRef], { record: collectionRecord }, {})] },
      { id: "expected-version", input: { collection_id: "collection_fixture", record_id: "record_fixture", expected_version: 2 }, branches: ["expected_version:explicit", "view_id:omitted"], calls: [call("getCollectionSchemaForMutation", "collection_fixture"), call("collectionDeleteAllowed", collectionSchema, undefined), call("getCollectionRecord", "collection_fixture", "record_fixture"), call("runCollectionMutation", contextMutation("collection.record.delete", "Delete collection record: collection_fixture/record_fixture", ["Delete a collection record file and SQLite index row."])), call("deleteCollectionRecord", "collection_fixture", "record_fixture", 2), call("collectionRecordRef", collectionRecord), call("createCollectionRollback", operation, [collectionRecordRef], { record: collectionRecord }, {})] }
    ]
  },
  "collection.reindex": {
    requiredBranches: ["reindex:all"],
    cases: [{ id: "empty-input", input: {}, branches: ["reindex:all"], calls: [call("collectionMutationContract", "collection.reindex"), call("runCollectionMutation", contextMutation("collection.reindex", "Reindex collections", ["Refresh Collection SQLite indexes from schema and record files."], { evidenceKind: "derived_repair" })), call("reindexCollectionStore")] }]
  },
  "collection.schema.save": {
    requiredBranches: ["schema:create", "schema:update"],
    cases: [
      { id: "create-all-fields", input: { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {} }, branches: ["schema:create"], calls: [call("getCollectionSchemaForMutation", "collection_fixture"), call("collectionMutationContract", "collection.schema.save"), call("runCollectionMutation", contextMutation("collection.schema.save", "Save collection schema: collection_fixture", ["Create a Collection schema file, renderer view definitions, and SQLite index row."], { targetResourceRefs: [] })), call("saveCollectionSchema", { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {} }), call("collectionSchemaRef", collectionSchema), call("createCollectionRollback", operation, [collectionSchemaRef], {}, { collection_schema: collectionSchema })] },
      { id: "update-all-fields", input: { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {}, expected_resource_version: 1 }, branches: ["schema:update"], calls: [call("getCollectionSchemaForMutation", "collection_fixture"), call("collectionMutationContract", "collection.schema.save"), call("collectionSchemaRef", collectionSchema), call("runCollectionMutation", contextMutation("collection.schema.save", "Save collection schema: collection_fixture", ["Create a Collection schema file, renderer view definitions, and SQLite index row."], { targetResourceRefs: [collectionSchemaRef] })), call("updateCollectionSchema", { id: "collection_fixture", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], views: [], permissions: {} }, 1), call("collectionSchemaRef", collectionSchema), call("createCollectionRollback", operation, [collectionSchemaRef], { collection_schema: collectionSchema }, { collection_schema: collectionSchema })] }
    ]
  },
  "collection.records.list": {
    requiredBranches: ["filters:provided", "filters:default"],
    cases: [
      { id: "filters-provided", input: { collection_id: "collection_fixture", ids: ["record_fixture"], fields: ["title"] }, branches: ["filters:provided"], calls: [call("getCollectionSchema", "collection_fixture"), call("listCollectionRecords", collectionSchema, { ids: ["record_fixture"], fields: ["title"] })] },
      { id: "filters-default", input: { collection_id: "collection_fixture" }, branches: ["filters:default"], calls: [call("getCollectionSchema", "collection_fixture"), call("listCollectionRecords", collectionSchema, { ids: [], fields: [] })] }
    ]
  },
  "collection.schema.docs": { requiredBranches: ["docs:read"], cases: [{ id: "empty-input", input: {}, branches: ["docs:read"], calls: [call("readCollectionSchemaDocs")] }] },
  "collection.schema.get": { requiredBranches: ["schema:found"], cases: [{ id: "found", input: { collection_id: "collection_fixture" }, branches: ["schema:found"], calls: [call("getCollectionSchema", "collection_fixture")] }] },
  "collection.view.present": {
    requiredBranches: ["view:explicit", "view:default"],
    cases: [
      { id: "explicit", input: { collection_id: "collection_fixture", view_id: "view_fixture" }, branches: ["view:explicit"], calls: [call("presentCollectionView", { collectionId: "collection_fixture", viewId: "view_fixture" })] },
      { id: "default", input: { collection_id: "collection_fixture" }, branches: ["view:default"], calls: [call("presentCollectionView", { collectionId: "collection_fixture", viewId: undefined })] }
    ]
  },
  "generated_surface.action.run": {
    requiredBranches: ["revision:explicit", "action:declared"],
    cases: [{ id: "all-fields", input: { surface_id: "surface_fixture", revision_id: "surface_revision_fixture", action_id: "action_fixture" }, branches: ["revision:explicit", "action:declared"], calls: [call("resolveGeneratedSurfaceAction", { surfaceId: "surface_fixture", revisionId: "surface_revision_fixture", actionId: "action_fixture" })] }]
  },
  "generated_surface.create": {
    requiredBranches: ["bundle:direct", "bundle:custom_view", "lifetime:message", "lifetime:session", "lifetime:pinned"],
    cases: [
      { id: "direct-message", input: { bundle: surfaceBundle, request: surfaceRequest("message", "built_in_surface") }, branches: ["bundle:direct", "lifetime:message"], nestedBranches: [{ path: ["bundle"], branch: 0, label: "direct" }], calls: [call("runGeneratedSurfaceMutation", generatedSurfaceCreateMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("message", "built_in_surface"), bundle: surfaceBundle, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] },
      { id: "custom-session", input: { bundle: { custom_view: surfaceBundle }, request: surfaceRequest("session", "artifact") }, branches: ["bundle:custom_view", "lifetime:session"], nestedBranches: [{ path: ["bundle"], branch: 1, label: "custom_view" }], calls: [call("runGeneratedSurfaceMutation", generatedSurfaceCreateMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("session", "artifact"), bundle: surfaceBundle, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] },
      { id: "direct-pinned", input: { bundle: surfaceBundle, request: surfaceRequest("pinned", "text") }, branches: ["bundle:direct", "lifetime:pinned"], nestedBranches: [{ path: ["bundle"], branch: 0, label: "direct" }], calls: [call("runGeneratedSurfaceMutation", generatedSurfaceCreateMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("pinned", "text"), bundle: surfaceBundle, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] }
    ]
  },
  "generated_surface.interaction.record": {
    requiredBranches: interactionKinds.map((kind) => `kind:${kind}`),
    cases: interactionKinds.map((kind, index) => {
      const commandResult = interactionCommandResult(index);
      return {
        id: `kind-${kind}`,
        input: {
          surface_id: "surface_fixture",
          kind,
          interaction_id: `interaction_${kind}`,
          command_result: commandResult,
          ...(index === 0 ? { command_id: "artifact.create", message_id: "message_fixture", revision_id: "surface_revision_fixture", user_feedback: "Fixture feedback" } : {})
        },
        branches: [`kind:${kind}`],
        calls: [
          call("getGeneratedSurface", "surface_fixture"),
          call("saveGeneratedSurfaceInteraction", {
            id: `interaction_${kind}`,
            kind,
            session_id: "session_fixture",
            ...(index === 0 ? { message_id: "message_fixture" } : {}),
            surface_id: "surface_fixture",
            revision_id: "surface_revision_fixture",
            command_id: index === 0 ? "artifact.create" : undefined,
            command_result: commandResult,
            user_feedback: index === 0 ? "Fixture feedback" : undefined,
            created_at: "$generated:time"
          })
        ]
      };
    })
  },
  "generated_surface.revise": {
    requiredBranches: ["bundle:direct", "bundle:custom_view", "lifetime:message", "lifetime:session", "lifetime:pinned"],
    cases: [
      { id: "direct-message", input: { surface_id: "surface_fixture", bundle: surfaceBundle, request: surfaceRequest("message", "built_in_surface") }, branches: ["bundle:direct", "lifetime:message"], nestedBranches: [{ path: ["bundle"], branch: 0, label: "direct" }], calls: [call("getGeneratedSurface", "surface_fixture"), call("runGeneratedSurfaceMutation", generatedSurfaceReviseMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("message", "built_in_surface"), bundle: surfaceBundle, existing: surface, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] },
      { id: "custom-session", input: { surface_id: "surface_fixture", bundle: { custom_view: surfaceBundle }, request: surfaceRequest("session", "artifact") }, branches: ["bundle:custom_view", "lifetime:session"], nestedBranches: [{ path: ["bundle"], branch: 1, label: "custom_view" }], calls: [call("getGeneratedSurface", "surface_fixture"), call("runGeneratedSurfaceMutation", generatedSurfaceReviseMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("session", "artifact"), bundle: surfaceBundle, existing: surface, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] },
      { id: "direct-pinned", input: { surface_id: "surface_fixture", bundle: surfaceBundle, request: surfaceRequest("pinned", "text") }, branches: ["bundle:direct", "lifetime:pinned"], nestedBranches: [{ path: ["bundle"], branch: 0, label: "direct" }], calls: [call("getGeneratedSurface", "surface_fixture"), call("runGeneratedSurfaceMutation", generatedSurfaceReviseMutation), call("createGeneratedSurfaceRequestId"), call("generatedSurfaceNow"), call("generatedSurfaceFingerprint", "Show fixture"), call("buildGeneratedSurfaceRevision", { request: persistedSurfaceRequest("pinned", "text"), bundle: surfaceBundle, existing: surface, producerRunId: "run_fixture", promptFingerprint: "surface_hash" }), call("saveGeneratedSurfaceRevision", { definition: surface, revision: surfaceRevision, html: "<main>fixture</main>", css: "main{}", script: "", assets: surfaceBundle.assets })] }
    ]
  },
  "generated_surface.state": {
    requiredBranches: ["action:pin", "action:unpin", "action:archive"],
    cases: [
      { id: "pin", input: { surface_id: "surface_fixture", action: "pin", interaction_id: "interaction_pin", message_id: "message_fixture" }, branches: ["action:pin"], calls: [call("updateGeneratedSurfaceState", "surface_fixture", "pinned"), call("saveGeneratedSurfaceInteraction", { id: "interaction_pin", kind: "pinned", session_id: "session_fixture", message_id: "message_fixture", surface_id: "surface_fixture", revision_id: "surface_revision_fixture", created_at: "$generated:time" })] },
      { id: "unpin", input: { surface_id: "surface_fixture", action: "unpin", interaction_id: "interaction_unpin" }, branches: ["action:unpin"], calls: [call("updateGeneratedSurfaceState", "surface_fixture", "ephemeral"), call("saveGeneratedSurfaceInteraction", { id: "interaction_unpin", kind: "unpinned", session_id: "session_fixture", surface_id: "surface_fixture", revision_id: "surface_revision_fixture", created_at: "$generated:time" })] },
      { id: "archive", input: { surface_id: "surface_fixture", action: "archive", interaction_id: "interaction_archive" }, branches: ["action:archive"], calls: [call("updateGeneratedSurfaceState", "surface_fixture", "archived"), call("saveGeneratedSurfaceInteraction", { id: "interaction_archive", kind: "dismissed", session_id: "session_fixture", surface_id: "surface_fixture", revision_id: "surface_revision_fixture", created_at: "$generated:time" })] }
    ]
  },
  "generated_surface.export": {
    requiredBranches: ["format:html", "format:zip", "revision:explicit", "revision:current"],
    cases: [
      { id: "html-current", input: { surface_id: "surface_fixture", format: "html" }, branches: ["format:html", "revision:current"], calls: [call("getGeneratedSurface", "surface_fixture"), call("getGeneratedSurfaceRevision", "surface_revision_fixture"), call("readGeneratedSurfaceBundle", "surface_revision_fixture")] },
      { id: "zip-explicit", input: { surface_id: "surface_fixture", revision_id: "surface_revision_fixture", format: "zip" }, branches: ["format:zip", "revision:explicit"], calls: [call("getGeneratedSurface", "surface_fixture"), call("getGeneratedSurfaceRevision", "surface_revision_fixture"), call("readGeneratedSurfaceBundle", "surface_revision_fixture")] }
    ]
  },
  "graph.create": {
    requiredBranches: localeValues.map((value) => `input_locale:${value}`),
    cases: localeValues.map((input_locale, index) => {
      const output_locale = localeValues[(index + 1) % localeValues.length];
      const ui_locale = localeValues[(index + 2) % localeValues.length];
      return { id: `locale-${input_locale}`, input: { content: JSON.stringify(graphDocument), title: `Graph ${input_locale}`, input_locale, output_locale, ui_locale, metadata: { locale: input_locale } }, branches: [`input_locale:${input_locale}`], calls: [call("validateGraphArtifactContent", JSON.stringify(graphDocument)), call("artifactDefaultLocales"), call("artifactContract", "graph.create"), call("runArtifactMutation", contextMutation("graph.create", `Create graph: Graph ${input_locale}`, ["Create a validated graph Artifact in the Workspace."])), call("createArtifactDraft", { operation, title: `Graph ${input_locale}`, content: JSON.stringify(graphDocument), kind: "graph", locale: output_locale, sourceLocales: [input_locale], createdBy: "handler-matrix-actor", metadata: { locale: input_locale } }), call("createArtifactRollback", operation, [artifactRef], {}, { artifact_id: "artifact_fixture" })] };
    })
  },
  "graph.patch": {
    requiredBranches: editorSources.map((value) => `editor_source:${value}`),
    cases: editorSources.map((editor_source) => ({ id: `editor-${editor_source}`, input: { artifact_id: "graph_fixture", base_revision_id: "base_fixture", change_summary: `Patch ${editor_source}`, delete_edge_ids: [], delete_node_ids: [], document: graphDocument, edges: [], editor_source, nodes: [], provenance: { editor_source } }, branches: [`editor_source:${editor_source}`], calls: [call("getArtifact", "graph_fixture"), call("readArtifactContent", "graph_fixture"), call("artifactContract", "graph.patch"), call("runArtifactMutation", contextMutation("graph.patch", "Edit graph: Fixture graph", ["Create a new graph Artifact revision from validated node and edge edits."], { targetResourceRefs: [graphArtifactRef] })), call("createArtifactRevision", { artifactId: "graph_fixture", content: "{\n  \"version\": \"1\",\n  \"nodes\": [],\n  \"edges\": []\n}\n", extension: "json", baseRevisionId: "base_fixture", editorSource: editor_source, changeSummary: `Patch ${editor_source}`, provenance: { editor_source } }), call("createArtifactRollback", operation, [graphArtifactRef, revisionRef], { artifact: graphArtifact }, { artifact: graphArtifact })] }))
  },
  "rollback.restore": {
    requiredBranches: ["snapshot:written", "snapshot:deleted"],
    cases: [
      { id: "written", input: { rollback_point_id: "rollback_written" }, branches: ["snapshot:written"], calls: [call("getRollbackPoint", "rollback_written"), call("currentTimeMillis"), call("resolveRollbackPath", "workspace/fixture.txt"), call("rollbackFileRef", "workspace/fixture.txt"), call("runRollbackMutation", contextMutation("rollback.restore", "rollback.restore: rollback_written", ["Restore rollback point rollback_written for workspace/fixture.txt."], { targetResourceRefs: [fileRef] })), call("readRollbackFile", "/tmp/handler-matrix/workspace/fixture.txt"), call("ensureRollbackParent", "/tmp/handler-matrix/workspace/fixture.txt"), call("writeRollbackFile", "/tmp/handler-matrix/workspace/fixture.txt", "fixture"), call("createRestoreRollback", operation, [fileRef], { path: "workspace/fixture.txt", content: "before fixture" }, { path: "workspace/fixture.txt", content: "fixture" })] },
      { id: "deleted", input: { rollback_point_id: "rollback_deleted" }, branches: ["snapshot:deleted"], calls: [call("getRollbackPoint", "rollback_deleted"), call("currentTimeMillis"), call("resolveRollbackPath", "workspace/fixture.txt"), call("rollbackFileRef", "workspace/fixture.txt"), call("runRollbackMutation", contextMutation("rollback.restore", "rollback.restore: rollback_deleted", ["Restore rollback point rollback_deleted for workspace/fixture.txt."], { targetResourceRefs: [fileRef] })), call("readRollbackFile", "/tmp/handler-matrix/workspace/fixture.txt"), call("removeRollbackFile", "/tmp/handler-matrix/workspace/fixture.txt"), call("createRestoreRollback", operation, [fileRef], { path: "workspace/fixture.txt", content: "before fixture" }, { path: "workspace/fixture.txt", content: null })] }
    ]
  },
  "workspace.backup.create": { requiredBranches: ["backup:create"], cases: [{ id: "empty-input", input: {}, branches: ["backup:create"], calls: [call("createWorkspaceBackup")] }] },
  "workspace.backup.restore": { requiredBranches: ["backup:restore"], cases: [{ id: "backup", input: { backup_id: "backup_fixture" }, branches: ["backup:restore"], calls: [call("restoreWorkspaceBackup", { backupId: "backup_fixture" })] }] },
  "workspace.repair": {
    requiredBranches: ["dry_run:true", "dry_run:false"],
    cases: [
      { id: "dry-run", input: { dry_run: true }, branches: ["dry_run:true"], calls: [call("repairWorkspace", { dryRun: true })] },
      { id: "repair", input: { dry_run: false }, branches: ["dry_run:false"], calls: [call("repairWorkspace", { dryRun: false })] }
    ]
  },
  "file.patch": {
    requiredBranches: ["collection:managed", "collection:unmanaged"],
    cases: [
      { id: "managed", input: { path: "workspace/fixture.txt", search: "before", replace: "after" }, branches: ["collection:managed"], calls: [call("resolveFilePath", "workspace/fixture.txt"), call("runFileMutation", contextMutation("file.patch", "file.patch: workspace/fixture.txt", ["file.patch workspace/fixture.txt inside the workspace."], { targetResourceRefs: [fileRef] })), call("readFileTextIfExists", "/tmp/handler-matrix/workspace/fixture.txt"), call("ensureFileParent", "/tmp/handler-matrix/workspace/fixture.txt"), call("writeFileText", "/tmp/handler-matrix/workspace/fixture.txt", "after fixture"), call("isManagedCollectionPath", "workspace/fixture.txt"), call("reindexManagedCollections"), call("createFileRollback", operation, [fileRef], { path: "workspace/fixture.txt", content: "before fixture" }, { path: "workspace/fixture.txt", content: "after fixture" })] },
      { id: "unmanaged", input: { path: "notes/fixture.txt", search: "before", replace: "after" }, branches: ["collection:unmanaged"], calls: [call("resolveFilePath", "notes/fixture.txt"), call("runFileMutation", contextMutation("file.patch", "file.patch: notes/fixture.txt", ["file.patch notes/fixture.txt inside the workspace."], { targetResourceRefs: [browserFileRef("notes/fixture.txt")] })), call("readFileTextIfExists", "/tmp/handler-matrix/notes/fixture.txt"), call("ensureFileParent", "/tmp/handler-matrix/notes/fixture.txt"), call("writeFileText", "/tmp/handler-matrix/notes/fixture.txt", "after fixture"), call("isManagedCollectionPath", "notes/fixture.txt"), call("createFileRollback", operation, [browserFileRef("notes/fixture.txt")], { path: "notes/fixture.txt", content: "before fixture" }, { path: "notes/fixture.txt", content: "after fixture" })] }
    ]
  },
  "file.write": {
    requiredBranches: ["collection:managed", "collection:unmanaged"],
    cases: [
      { id: "managed", input: { path: "workspace/fixture.txt", content: "written fixture" }, branches: ["collection:managed"], calls: [call("resolveFilePath", "workspace/fixture.txt"), call("runFileMutation", contextMutation("file.write", "file.write: workspace/fixture.txt", ["file.write workspace/fixture.txt inside the workspace."], { targetResourceRefs: [fileRef] })), call("readFileTextIfExists", "/tmp/handler-matrix/workspace/fixture.txt"), call("ensureFileParent", "/tmp/handler-matrix/workspace/fixture.txt"), call("writeFileText", "/tmp/handler-matrix/workspace/fixture.txt", "written fixture"), call("isManagedCollectionPath", "workspace/fixture.txt"), call("reindexManagedCollections"), call("createFileRollback", operation, [fileRef], { path: "workspace/fixture.txt", content: "before fixture" }, { path: "workspace/fixture.txt", content: "written fixture" })] },
      { id: "unmanaged", input: { path: "notes/fixture.txt", content: "written fixture" }, branches: ["collection:unmanaged"], calls: [call("resolveFilePath", "notes/fixture.txt"), call("runFileMutation", contextMutation("file.write", "file.write: notes/fixture.txt", ["file.write notes/fixture.txt inside the workspace."], { targetResourceRefs: [browserFileRef("notes/fixture.txt")] })), call("readFileTextIfExists", "/tmp/handler-matrix/notes/fixture.txt"), call("ensureFileParent", "/tmp/handler-matrix/notes/fixture.txt"), call("writeFileText", "/tmp/handler-matrix/notes/fixture.txt", "written fixture"), call("isManagedCollectionPath", "notes/fixture.txt"), call("createFileRollback", operation, [browserFileRef("notes/fixture.txt")], { path: "notes/fixture.txt", content: "before fixture" }, { path: "notes/fixture.txt", content: "written fixture" })] }
    ]
  }
} as const satisfies Record<string, AHandlerExpectation>;

export const aHandlerOperationIds = Object.keys(aHandlerExpectations).sort();
export const aHandlerOperationCount = aHandlerOperationIds.length;
export const aHandlerCaseCount = Object.values(aHandlerExpectations).reduce((count, expectation) => count + expectation.cases.length, 0);
