import { describe, expect, it } from "vitest";
import type { BackendRunRecord, SessionRecord } from "@samurai-agent/core-schemas";
import { bindOperationDefinitions, DomainOperationRegistry, jsonSchemaFor, operationDefinitions, type DomainOperationPorts } from "./index.js";
import { domainOperationIds } from "./generated/operation-index.generated.js";
import { completeSample, sample } from "../../../scripts/fixtures/domain-commands-gate.js";
import gatewayMcpConfigSave from "./operations/gateway/mcp_config/save.operation.js";
import gatewayInboundRoute from "./operations/gateway/inbound/route.operation.js";

describe("Domain Operation strict gate coverage", () => {
  it("loads the complete 167-operation strict gate with unique handlers", () => {
    const ids = operationDefinitions.map((definition) => definition.id);
    expect(operationDefinitions).toHaveLength(167);
    expect(new Set(ids).size).toBe(ids.length);
    expect(operationDefinitions.every((definition) => definition.input && definition.output && typeof definition.createHandler === "function")).toBe(true);
    expect(Object.keys(domainOperationIds)).toHaveLength(operationDefinitions.length);
    expect(new Set(Object.keys(domainOperationIds)).size).toBe(operationDefinitions.length);
    expect(new Set(Object.values(domainOperationIds)).size).toBe(operationDefinitions.length);
  });

  it("accepts the real gateway MCP save payload at the operation boundary", () => {
    const timestamp = "2026-07-16T00:00:00.000Z";
    const result = gatewayMcpConfigSave.input.safeParse({
      id: "gateway_mcp_test",
      server_name: "test-server",
      transport: "stdio",
      enabled: true,
      allowed_tools: ["read_resource"],
      secret_refs: [],
      metadata: {},
      stdio: {
        command: "test-mcp-server",
        args: ["--stdio"],
        env: {},
        secret_env: {},
        secret_files: [],
        framing: "json_lines",
        initialize: true
      }
    });

    expect(result.success).toBe(true);
  });

  it("requires the real gateway inbound fields and rejects unrelated envelope fields", () => {
    expect(gatewayInboundRoute.input.safeParse({
      channel: "webhook",
      source_identity: "source-1",
      body: "hello"
    }).success).toBe(true);
    expect(gatewayInboundRoute.input.safeParse({
      channel: "webhook",
      content: "hello",
      action_id: "unrelated"
    }).success).toBe(false);
  });

  it("preserves nested validation as invalid_input and does not record an interaction", async () => {
    let interactionWrites = 0;
    const ports = new Proxy({}, {
      get: (_target, operationId) => new Proxy({}, {
        get: (_operation, method) => (...args: unknown[]) => {
          if (String(method) === "resolveGeneratedSurfaceAction") {
            throw { code: "validation", message: "inner_validation" };
          }
          if (String(method) === "saveGeneratedSurfaceInteraction") {
            interactionWrites += 1;
          }
          return undefined;
        }
      })
    }) as DomainOperationPorts;
    const registry = new DomainOperationRegistry(ports);

    await expect(registry.execute({ inputSource: "generated_surface", correlationId: "correlation-fixture" } as never, "generated_surface.action.run", {
      surface_id: "surface-fixture",
      revision_id: "revision-fixture",
      action_id: "create"
    })).rejects.toMatchObject({
      code: "invalid_input",
      message: "domain_operation_handler_failed:generated_surface.action.run:validation",
      handlerCause: { code: "validation", message: "inner_validation" }
    });
    expect(interactionWrites).toBe(0);
  });

  it("executes every real operation handler through only its operation-specific Port", async () => {
    const outputs = new Map(operationDefinitions.map((definition) => [
      definition.id,
      sample(jsonSchemaFor(definition.output, `${definition.id}.output`))
    ]));
    const portCalls = new Map<string, string[]>();
    let reflectionSuggestionType: "memory" | "skill" | "knowledge_wiki" = "memory";
    let generatedActionAllowed = true;
    let memoryArchiveChanged = true;
    let automationJobKind = "daily_digest";
    let automationJobSchedule = "daily";
    let rollbackScenario: "valid" | "missing" | "irreversible" | "expired" | "missing_path" | "invalid_content" | "root" | "delete" = "valid";
    let externalDispatchScenario: "dispatched" | "dry_run" | "failed" | "detailed" = "dispatched";
    let externalClaimScenario: "claimed" | "outcome_unknown" | "dispatched" | "conflict" = "claimed";
    let externalClaimLookupStatus: "approved" | "outcome_unknown" | "dispatched" = "approved";
    let externalSendLookupCount = 0;
    let externalDispatchThrows = false;
    let externalDispatchOutcomeUnknown = false;
    let evaluationScenario: "normal" | "existing" | "missing_run" | "no_skills" = "normal";
    let memoryArchiveScenario: "normal" | "session_missing" | "memory_missing" | "not_in_session" | "invalid_actor" | "archive_missing" | "archive_failure" = "normal";
    let memoryArchiveUpdateThrows = false;
    let automationRequeueMissing = false;
    let clientEventDeliverMissing = false;
    let collectionDeleteScenario: "normal" | "schema_missing" | "forbidden" | "record_missing" | "delete_failure" = "normal";
    let filePatchConflict = false;
    let gatewayPairingsExpired = false;
    let generatedSurfaceStateMissing = false;
    let graphContentScenario: "valid" | "invalid" = "valid";
    let pluginStatusScenario: "normal" | "missing" | "previous_missing" | "set_failure" | "save_failure" | "restore_failure" = "normal";
    let pluginSetCallCount = 0;
    let messagePresentationUpdateMissing = false;
    let reflectionSessionMissing = false;
    let reflectionBackendScenario: "normal" | "missing" | "mismatch" = "normal";
    let reflectionMessagesPresent = false;
    let reflectionSuggestionStatus: "proposed" | "applied" = "proposed";
    let skillPatchScenario: "normal" | "missing" | "patch_failure" | "save_missing" = "normal";
    let skillProjectScenario: "normal" | "missing" | "not_candidate" | "session_scope" = "normal";
    let skillSupportFilesPresent = false;
    let wikiPatchScenario: "normal" | "missing" | "update_failure" | "update_missing" = "normal";
    let activityHistoryDelayMs = 0;
    let activityHistoryBusyWaitMs = 0;
    let abortDuringActivityReadController: AbortController | undefined;
    const reflectionSessionId = "reflection-session";
    const operationPorts = new Proxy({}, {
      get: (_target, operationId) => new Proxy({}, {
        get: (_ports, method) => (...args: unknown[]) => {
          const id = String(operationId);
          const name = String(method);
          portCalls.set(id, [...(portCalls.get(id) ?? []), name]);
          if (/Error$|NotFound$|Conflict$/.test(name)) return new Error(name);
          if ([
            "createRoom", "patchRoom", "listRooms", "viewRoom",
            "createAgent", "patchAgent", "bindAgentBackend", "listAgents", "viewAgent",
            "addWorkspaceMember", "changeWorkspaceMemberRole", "removeWorkspaceMember",
            "setAgentRoomCreatePermission", "setRoomAgentPermissions", "removeRoomAgent", "addRoomMember",
            "listRoomParticipants", "changeRoomMemberRole", "removeRoomMember",
            "recoverOwnerlessRoom", "shareResource", "revokeResourceShare"
          ].includes(name)) return outputs.get(id);
          if (name === "getReflectionSession") return reflectionSessionMissing ? undefined : fixtureSession(String(args[0]));
          if (name === "getReflectionBackendRun") {
            if (reflectionBackendScenario === "missing") return undefined;
            return fixtureBackendRun(String(args[0]), reflectionBackendScenario === "mismatch" ? "other-session" : reflectionSessionId);
          }
          if (name === "getExternalSend") return {
            id: "external.send.dispatch-fixture",
            channel: "webhook",
            status: (++externalSendLookupCount > 1 ? externalClaimLookupStatus : externalClaimScenario === "outcome_unknown" ? "outcome_unknown" : externalClaimScenario === "dispatched" ? "dispatched" : "approved"),
            target: { url: "https://example.test/hook" },
            title: "External send fixture",
            body: "fixture",
            created_at: "2026-07-16T00:00:00.000Z",
            updated_at: "2026-07-16T00:00:00.000Z"
          };
          if (name === "claimDispatch") return externalClaimScenario === "claimed" ? { record: args[0] ? {
            id: "external.send.dispatch-fixture",
            channel: "webhook",
            status: "approved",
            target: { url: "https://example.test/hook" },
            title: "External send fixture",
            body: "fixture",
            created_at: "2026-07-16T00:00:00.000Z",
            updated_at: "2026-07-16T00:00:00.000Z"
          } : undefined, claim_token: "external-send-claim-fixture" } : undefined;
          if (name === "settleDispatch") return (args[0] as { record: unknown }).record;
          if (name === "markOutcomeUnknown") return { id: "external.send.dispatch-fixture", status: "outcome_unknown", channel: "webhook", target: {}, title: "External send fixture", body: "fixture", created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z" };
          if (name === "getWorkItemObjective") return { ...fixtureRecord(String(args[0])), room_id: "coverage-room" };
          if (name === "listCollectionRecords") return { collection_id: "sample", count: 0, items: [], linked_data: {}, schema_fields: {} };
          if (name === "getActivityHistory") {
            abortDuringActivityReadController?.abort();
            abortDuringActivityReadController = undefined;
            if (activityHistoryBusyWaitMs > 0) {
              const end = Date.now() + activityHistoryBusyWaitMs;
              while (Date.now() < end) { /* exercise the synchronous deadline race */ }
            }
            if (activityHistoryDelayMs > 0) return new Promise((resolve) => setTimeout(() => resolve(undefined), activityHistoryDelayMs));
            return undefined;
          }
          if (name === "getResourceVersion") return outputs.get(id);
          if (name === "getWorkspaceContext") return outputs.get(id);
          if (name === "copyResource" || name === "moveResource" || name === "promoteResource" || name === "redactResource") return outputs.get(id);
          if (name === "listReflectionSuggestions") return [{ id: "sample", reflection_run_id: "sample", suggestion_type: reflectionSuggestionType, status: reflectionSuggestionStatus, title: "fixture", content: "fixture", source_refs: [], confidence: 0.5, created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z" }];
          if (name === "getReflectionSuggestion") return { id: "sample", reflection_run_id: "sample", suggestion_type: reflectionSuggestionType, status: reflectionSuggestionStatus, title: "fixture", content: "fixture", source_refs: [], confidence: 0.5, created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z" };
          if (name === "listReflectionMessages") return reflectionMessagesPresent ? [{ role: "user" }, { role: "agent" }] : [];
          if (name === "transferRoomOwnership" || name === "transferWorkspaceOwnership") {
            const output = outputs.get(id) as { previous_owner?: unknown; owner?: unknown };
            return { previousOwner: output.previous_owner, owner: output.owner };
          }
          if (name === "listEvaluationBackendRuns") return [
            { id: "run-before", session_id: "sample", input_message_id: "input-before", backend_id: "fixture", backend_kind: "samurai_native", status: "completed", started_at: "2026-07-14T00:00:00.000Z", completed_at: "2026-07-14T00:01:00.000Z", input_summary: "before", metadata: {} },
            { id: "run-used", session_id: "sample", input_message_id: "input-used", backend_id: "fixture", backend_kind: "samurai_native", status: "completed", started_at: "2026-07-15T00:00:00.000Z", completed_at: "2026-07-15T00:01:00.000Z", input_summary: "used", metadata: {} }
          ];
          if (name === "listLearningResourceUses") return [{ id: "use", run_id: evaluationScenario === "missing_run" ? "run-missing" : "run-used", session_id: "sample", resource_kind: "skill", resource_id: "skill-fixture", resource_version: "1", stage: "selected", metadata: {}, created_at: "2026-07-15T00:00:00.000Z" }];
          if (name === "listExistingLearningEvaluations") return evaluationScenario === "existing"
            ? [{ learning_resource_ref: { id: "skill-fixture" }, learning_resource_version: "1", compared_run_ids: ["run-used"] }]
            : [];
          if (name === "listEvaluationSkills") return evaluationScenario === "no_skills" ? [] : [{ id: "skill-fixture", title: "Fixture", description: "Fixture", tags: [], allowed_scopes: ["skill"], required_capabilities: [], owner_pinned: false, state: "project", file_path: "skills/skill-fixture/SKILL.md", frontmatter: { id: "skill-fixture", state: "project", title: "Fixture", description: "Fixture", tags: [], provenance: "owner", trust_level: "owner_approved", allowed_scopes: ["skill"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, last_reviewed_at: "2026-07-16T00:00:00.000Z", owner_pinned: false } }];
          if (name === "expireGatewayPairings") {
            return gatewayPairingsExpired ? [fixtureGatewayPairing()] : [];
          }
          if (name === "expireClientEvents") return [];
          if (name === "reindexCollectionStore") return { schemas: { indexed: 0 }, records: { indexed: 0 } };
          if (name === "listSkillSupportFiles") return skillSupportFilesPresent ? [{ path: "sample", file_path: "skills/sample/sample", content: "fixture" }] : [];
          if (name.startsWith("list") && name !== "listWorkspaceFiles" && name !== "listMemoryForSession") return [];
          if (/Now$/.test(name)) return "2026-07-16T00:00:00.000Z";
          if (/Fingerprint$/.test(name)) return "fixture-fingerprint";
          if (name === "currentTimeMillis") return 1_752_624_000_000;
          if (name.startsWith("create") && name.endsWith("Id")) return `${id}-fixture`;
          if (name.endsWith("Contract")) return { id, proposed_effects: [] };
          if (name === "getAutomationJob" || name === "acquireAutomationJobLock") return {
            ...fixtureRecord(id),
            kind: automationJobKind,
            title: "fixture",
            target_instruction: "fixture",
            schedule: automationJobSchedule,
            status: "enabled",
            delivery_target: { room_id: "coverage-room" }
          };
          if (name === "getArtifact" && id.startsWith("graph.")) return { ...fixtureRecord(id), kind: "graph", locale: "en", source_locales: ["en"] };
          if (name === "getArtifact" && id === "image.edit") return { ...fixtureRecord(id), kind: "image", locale: "en", source_locales: ["en"] };
          if (name === "getRollbackPoint") {
            if (rollbackScenario === "missing") return undefined;
            return {
              id: "sample",
              reversible: rollbackScenario !== "irreversible",
              expires_at: rollbackScenario === "expired" ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
              before_snapshot: {
                ...(rollbackScenario !== "missing_path" ? { path: rollbackScenario === "root" ? "." : "sample.txt" } : {}),
                content: rollbackScenario === "invalid_content" ? 42 : rollbackScenario === "delete" ? null : "fixture"
              }
            };
          }
          if (name === "getCollectionSchemaForMutation") {
            if (collectionDeleteScenario === "schema_missing") return undefined;
            return {
              id: "sample", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], permissions: {}, file_path: "collections/sample/schema.json"
            };
          }
          if (name === "getCollectionSchema" || name === "saveCollectionSchema" || name === "updateCollectionSchema") return {
            id: "sample", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], permissions: {}, file_path: "collections/sample/schema.json"
          };
          if (name === "collectionDeleteAllowed") return collectionDeleteScenario !== "forbidden";
          if (name === "getCollectionRecord") return collectionDeleteScenario === "record_missing" ? undefined : fixtureRecord(id);
          if (name === "deleteCollectionRecord") {
            if (collectionDeleteScenario === "delete_failure") throw new Error("fixture_collection_delete_failed");
            return fixtureRecord(id);
          }
          if (name === "extractBrowserPage") return outputs.get(id);
          if (name === "readBrowserPage") return (outputs.get("browser.navigate") as { resource?: unknown } | undefined)?.resource
            ?? { url: "https://example.com/", title: "Fixture", html: "<p>fixture</p>", text: "fixture", adapter: "fetch" };
          if (name === "interactWithBrowser") return (outputs.get(id) as { resource?: unknown } | undefined)?.resource
            ?? { adapterId: "fixture", url: "https://example.com/", title: "Fixture", text: "fixture" };
          if (name === "captureBrowserScreenshot") return { adapterId: "fixture", bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", width: 1, height: 1 };
          if (name === "stableBrowserHash") return "fixture-hash";
          if (name === "resolveBrowserWorkspacePath") return { absolutePath: "/tmp/fixture", relativePath: "browser/fixture.txt" };
          if (name === "browserBytesToBase64") return "AQID";
          if (name === "listWorkspaceFiles" || name === "readWorkspaceFile" || name === "inspectWorkspaceFile") return {
            resource: { path: "sample", content: "fixture", entries: [], metadata: {}, provenance: {} }
          };
          if (name === "getMessagePresentation") return (outputs.get(id) as { presentation?: unknown } | undefined)?.presentation
            ?? (outputs.get("message.presentation.update") as { presentation?: unknown } | undefined)?.presentation;
          if (name === "updateMessagePresentationViewState") return messagePresentationUpdateMissing ? undefined : (outputs.get(id) as { presentation?: unknown } | undefined)?.presentation
            ?? (outputs.get("message.presentation.update") as { presentation?: unknown } | undefined)?.presentation;
          if (name === "presentCollectionView" && id === "message.presentation.update") return { render_spec: (outputs.get(id) as { render_spec?: unknown } | undefined)?.render_spec
            ?? (outputs.get("message.presentation.update") as { render_spec?: unknown } | undefined)?.render_spec };
          if (name === "applyPresentationViewState") return args[0];
          if (name === "presentationViewStateFromSpec") return {};
          if (name === "applySettingsPatch") return outputs.get(id);
          if (name === "findPluginStatus") {
            if (pluginStatusScenario === "missing") return undefined;
            return (outputs.get(id) as { plugin?: unknown } | undefined)?.plugin
              ?? { manifest_id: "plugin-fixture", version: "1.0.0" };
          }
          if (name === "getPluginEnabled") return pluginStatusScenario === "previous_missing" ? undefined : true;
          if (name === "setPluginEnabled") {
            pluginSetCallCount += 1;
            if (pluginStatusScenario === "set_failure") return false;
            if (pluginStatusScenario === "restore_failure") return pluginSetCallCount === 1;
            return true;
          }
          if (name === "savePluginState") {
            if (pluginStatusScenario === "save_failure" || pluginStatusScenario === "restore_failure") throw new Error("fixture_plugin_save_failed");
            return (outputs.get(id) as { state?: unknown } | undefined)?.state
              ?? { manifest_id: "plugin-fixture", enabled: true, version: "1.0.0", updated_at: "2026-07-16T00:00:00.000Z" };
          }
          if (name === "executeReflectionWorkflow") return outputs.get(id);
          if (name === "getGeneratedSurface") return (outputs.get("generated_surface.create") as { definition?: unknown } | undefined)?.definition
            ?? (outputs.get("generated_surface.revise") as { definition?: unknown } | undefined)?.definition
            ?? (outputs.get("generated_surface.export") as { surface?: unknown } | undefined)?.surface;
          if (name === "resolveGeneratedSurfaceAction") {
            if (!generatedActionAllowed) throw new Error("generated_surface_action_disallowed");
            const surface = ((outputs.get(id) as { surface?: Record<string, unknown> })?.surface
              ?? (outputs.get("generated_surface.action.run") as { surface?: Record<string, unknown> })?.surface
              ?? {});
            const manifest = surface.capability_manifest && typeof surface.capability_manifest === "object" ? surface.capability_manifest : {};
            const resolvedSurface = { ...surface, id: "sample", session_id: "sample", current_revision_id: "sample", actions: [{ id: "sample", label: "fixture", command_id: "artifact.create", input_schema: {}, payload_template: {} }], capability_manifest: { ...manifest, allowed_domain_commands: generatedActionAllowed ? ["artifact.create"] : [] } };
            return { surface: resolvedSurface, revisionId: "sample", action: resolvedSurface.actions[0] };
          }
          if (name === "getGeneratedSurfaceRevision") return (outputs.get(id) as { revision?: unknown } | undefined)?.revision
            ?? (outputs.get("generated_surface.export") as { revision?: unknown } | undefined)?.revision;
          if (name === "readGeneratedSurfaceBundle") return (outputs.get(id) as { bundle?: unknown } | undefined)?.bundle
            ?? (outputs.get("generated_surface.export") as { bundle?: unknown } | undefined)?.bundle;
          if (name === "buildGeneratedSurfaceRevision") return outputs.get(id);
          if (name === "saveGeneratedSurfaceRevision") return { definition: (args[0] as Record<string, unknown>).definition, revision: (args[0] as Record<string, unknown>).revision };
          if (name === "updateGeneratedSurfaceState") return generatedSurfaceStateMissing ? undefined : outputs.get(id);
          if (name === "createAutomationRun" || name === "updateAutomationRun" || name === "saveAutomationJobRecord") return args[0];
          if ([
            "saveSessionlessAutomationJob", "setSessionlessAutomationJobStatus", "runSessionlessAutomationJob",
            "managerResumeSessionlessAutomationJob", "managerStopSessionlessAutomationJob",
            "reauthorizeSessionlessAutomationJob", "rebindSessionlessAutomationJobAuthority",
            "createExternalAppConnection", "updateExternalAppConnectionScope", "revokeExternalAppConnection"
          ].includes(name)) return outputs.get(id);
          if (name === "releaseAutomationJobLock") return outputs.get(id);
          if (name === "requeueAutomationJob") return automationRequeueMissing ? undefined : outputs.get(id);
          if (name === "deliverClientEvent") return clientEventDeliverMissing ? undefined : outputs.get(id);
          if (/^(acknowledge|deliver|fail|save)ClientEvent$/.test(name)) return outputs.get(id);
          if ([
            "reindexSessionSearch", "saveClientEvent", "transitionObjective", "saveObjective", "searchCollections",
            "saveGeneratedSurfaceInteraction", "saveWorkItem", "searchWiki", "searchSessions", "searchSkills",
            "resumeCurator", "pruneLearningSnapshots", "pauseCurator", "searchMemory", "extractBrowserPage",
            "applyBackgroundReviewMutations", "recordAppliedLearningResourceUse", "restoreLearningResourceVersion", "updateLearningResourceVersion",
            "runCurator", "repairWorkspace", "restoreWorkspaceBackup", "createCuratorSnapshot", "createWorkspaceBackup",
            "listCuratorSnapshots", "restoreCuratorSnapshot", "presentCollectionView", "viewSkill", "inspectWorkspaceFile", "readCollectionSchemaDocs",
            "readWorkspaceFile", "runChatTurn", "listWorkspaceFiles", "recordSkillUsage", "cancelSkillOptimization",
            "rollbackSkillOptimization", "rejectSkillOptimization", "startSkillOptimization", "applySkillLifecycle",
            "promoteSkillOptimization", "saveGatewayMcpConfig", "saveGatewayPairingPolicy", "saveGatewayRoutingPolicy",
            "routeGatewayInbound", "expireGatewayConcurrencyLocks", "repairGatewayState", "deleteGatewaySandbox",
            "recreateGatewaySandbox", "syncGatewaySandbox", "saveGatewayPairing", "requireGatewayPairing",
            "executeMcpCall", "executeSandboxExec", "saveResourceTranslation"
          ].includes(name)) return outputs.get(id);
          if (name === "createSession" || name === "createFollowUpWorkItem" || name === "steerWorkItem") return outputs.get(id);
          if (name === "exportArtifactPdf") return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), adapterId: "fixture" };
          if (name === "createArtifactRevision") return { artifact: fixtureRecord(id), revision: fixtureRecord(id) };
          if (name.startsWith("create") && name.endsWith("Rollback")) return fixtureRollback(id);
          if (name === "applyCollectionRecordPatch") return { before: {}, after: {} };
          if (name === "decodeImageBase64" || name === "readBrowserWorkspaceBytes") return new Uint8Array([1, 2, 3]);
          if (name === "readFileTextIfExists") return filePatchConflict ? "different" : "sample";
          if (name === "readSkillMarkdown") {
            if (skillProjectScenario === "missing") return undefined;
            return fixtureSkillMarkdown(skillProjectScenario === "not_candidate" ? "project" : "candidate", skillProjectScenario === "session_scope");
          }
          if (name === "readArtifactContent" && id.startsWith("graph.")) return graphContentScenario === "invalid" ? "not-json" : "{\"version\":\"1\",\"nodes\":[],\"edges\":[]}";
          if (name === "resolveFilePath") return { absolutePath: "/tmp/sample", relativePath: "sample" };
          if (name === "resolveRollbackPath") return rollbackScenario === "root"
            ? { absolutePath: "/tmp", relativePath: "." }
            : { absolutePath: "/tmp/sample.txt", relativePath: "sample.txt" };
          if (name === "dispatchExternalSend") {
            if (externalDispatchThrows) throw new Error("fixture_dispatch_failed");
            if (externalDispatchOutcomeUnknown) return { dispatched: false, adapter: "fixture", dry_run: false, message: "outcome unknown", outcome_unknown: true };
            if (externalDispatchScenario === "dry_run") return { dispatched: false, adapter: "fixture", dry_run: true, message: "dry run" };
            if (externalDispatchScenario === "failed") return { dispatched: false, adapter: "fixture", dry_run: false, message: "failed" };
            if (externalDispatchScenario === "detailed") return { dispatched: true, adapter: "fixture", transport: "https", status: 202, dry_run: false, message: "sent" };
            return { dispatched: true, adapter: "fixture", dry_run: false, message: "sent" };
          }
          if (name.endsWith("TranslationSource")) return { content: "fixture", ref: fixtureRecord(id).resource_ref, source_locale: "en" };
          if (name === "hashTranslationContent") return "fixture-hash";
          if (name === "saveTranslationAutomationJob") return outputs.get(id);
          if (name === "requestHumanChange") return outputs.get(id);
          if (name.startsWith("read") || name.startsWith("load")) return "fixture";
          if (name === "runScheduledMemoryReview") return (outputs.get(id) as { memoryReviewTrace?: unknown }).memoryReviewTrace;
          if (name === "reindexAutomationWiki") return { active: 1, total: 1 };
          if (name === "runAutomationCurator" || name === "runAutomationMemoryReview") return { suggestions: [] };
          if (name === "runAutomationEvaluation") return { learningEvaluations: [] };
          if (name === "runAutomationTranslation") return { backendRunId: "fixture-run", source_ref: fixtureRecord(id).resource_ref, target_locale: "en" };
          if (name === "runAutomationCollectionTrigger") return "fixture";
          if (name === "runAutomationInstruction") return { backendRunId: "fixture-run", summary: "fixture" };
          if (name === "actualLearningUses") return args[0] ?? [];
          if (name === "createEvaluationSuggestions") return [];
          if (name === "createEvaluationReport") return (outputs.get(id) as { evaluationReport?: unknown } | undefined)?.evaluationReport
            ?? { id: "evaluation-report-fixture", run_scores: [] };
          if (name === "nextEvaluationRunAt") return "2026-07-17T00:00:00.000Z";
          if (name === "evaluateLearningEffect") {
            const value = args[0] as { id: string; resource_ref: Record<string, unknown>; resource_version?: string; task_class: string; before: Array<{ run_id: string }>; after: Array<{ run_id: string }>; evidence_refs: unknown[]; created_at: string };
            return { id: value.id, learning_resource_ref: value.resource_ref, learning_resource_version: value.resource_version, task_class: value.task_class, compared_run_ids: [...value.before, ...value.after].map((item) => item.run_id), before_metrics: {}, after_metrics: {}, effect_estimate: 0, confidence: 0.5, assessment: "neutral", evidence_refs: value.evidence_refs, evaluator: "fixture", created_at: value.created_at };
          }
          if (name === "createEvaluationReflectionRun" || name === "updateEvaluationReflectionRun") return args[0];
          if (name === "getMemorySession") {
            if (memoryArchiveScenario === "session_missing") return undefined;
            return fixtureSession("memory-session");
          }
          if (name === "getMemoryForArchive") {
            if (memoryArchiveScenario === "memory_missing") return undefined;
            return (outputs.get(id) as { memory?: unknown } | undefined)?.memory ?? fixtureRecord(id);
          }
          if (name === "listMemoryForSession") {
            if (memoryArchiveScenario === "not_in_session") return [];
            return [{ ...fixtureRecord(id), id: "sample" }];
          }
          if (name === "archiveMemoryRecord") {
            if (memoryArchiveScenario === "archive_missing") return undefined;
            if (memoryArchiveScenario === "archive_failure") throw new Error("fixture_archive_failed");
            const output = outputs.get(id) as { memory: Record<string, unknown>; content: string; warning?: string };
            const { file_path, ...frontmatter } = output.memory;
            return { before: { frontmatter, file_path }, after: { frontmatter, file_path }, content: output.content, changed: memoryArchiveChanged, warning: output.warning };
          }
          if (name === "rebuildMemoryActivity") return (outputs.get(id) as { activity?: unknown[] }).activity ?? [];
          if (name === "memoryResourceRef") return fixtureRecord(id).resource_ref;
          if (name === "memoryArchiveCapabilityId") return "memory";
          if (name === "createReflectionMemoryTarget" || name === "createReflectionSkillTarget" || name === "createReflectionWikiTarget") return { resource: fixtureRecord(id), ref: fixtureRecord(id).resource_ref };
          if (name === "runGeneratedSurfaceMutation") {
            const mutation = args[0] as {
              execute: (operation: Record<string, unknown>) => Promise<Record<string, unknown>>;
            };
            const operation = fixtureRecord(id);
            return Promise.resolve(mutation.execute(operation)).then((result) => ({ ...result, operation, activity: [] }));
          }
          if (name === "getSkillForMutation") return skillPatchScenario === "missing" ? undefined : fixtureRecord(id);
          if (name === "patchSkillRecord") {
            if (skillPatchScenario === "patch_failure") throw new Error("fixture_skill_patch_failed");
            if (skillPatchScenario === "save_missing") return undefined;
            return fixtureRecord(id);
          }
          if (name === "getWikiPage") return wikiPatchScenario === "missing" ? undefined : fixtureRecord(id);
          if (name === "updateWikiPage") {
            if (wikiPatchScenario === "update_failure") throw new Error("fixture_wiki_update_failed");
            if (wikiPatchScenario === "update_missing") return undefined;
          }
          if (name === "updateMemoryArchiveOperation" && memoryArchiveUpdateThrows) return Promise.reject(new Error("fixture_memory_archive_update_failed"));
          if ((name.startsWith("save") || name.startsWith("update")) && args[0] && typeof args[0] === "object") return args[0];
          if (name.startsWith("run") && args[0] && typeof args[0] === "object" && "execute" in args[0] && typeof args[0].execute === "function") {
            return Promise.resolve(args[0].execute(fixtureRecord(id))).then(() => outputs.get(id));
          }
          if (name.startsWith("execute") || name.startsWith("run") || name.startsWith("present")) {
            return name.startsWith("execute")
              ? { ok: true, value: outputs.get(id) }
              : outputs.get(id);
          }
          if (/Allowed$|^is|^validate|^set|^write|^remove|^emit|^queue|^reindex|^rebuild|^acknowledge|^release|^sync/.test(name)) return true;
          return fixtureRecord(id);
        }
      })
    }) as DomainOperationPorts;
    const bindings = bindOperationDefinitions(operationPorts);
    const executionCases = new Map<string, { input: unknown; context: { inputSource: string; workspaceId: string; actorId: string; correlationId: string; idempotencyKey?: string } }>();

    for (const binding of bindings) {
      const { definition } = binding;
      const generatedInput = sample(jsonSchemaFor(definition.input, `${definition.id}.input`));
      const input = definition.input.parse(definition.id === "resource.translation_job.save"
        ? { ...(generatedInput as Record<string, unknown>), source_ref: { kind: "artifact", id: "sample", uri: "artifacts/sample.md" } }
          : definition.id === "skill.optimization.rollback"
            ? { ...(generatedInput as Record<string, unknown>), promotion_id: "sample" }
          : definition.id === "agent.patch"
            ? { ...(generatedInput as Record<string, unknown>), name: "sample" }
          : definition.id === "learning.resource.version.update"
            ? { ...(generatedInput as Record<string, unknown>), content: "fixture content" }
          : generatedInput);
      const context = {
        inputSource: definition.sources[0]!,
        workspaceId: "workspace",
        actorId: definition.id === "memory.archive" ? "paired_contact" : "actor",
        roomId: "coverage-room",
        participant: { kind: "human" as const, participantId: "human:owner" },
        correlationId: `coverage-${definition.id}`,
        ...(definition.id === "chat.turn.run" ? { idempotencyKey: "coverage-chat-turn", sessionId: "coverage-chat-session" } : {}),
        ...(definition.id === "generated_surface.create" || definition.id === "generated_surface.revise" || definition.id === "generated_surface.interaction.record" || definition.id === "generated_surface.state"
          ? { sessionId: "surface-session", runId: "surface-run" }
          : definition.id === "learning.background_review.apply"
            ? { sessionId: "reflection-session", roomId: "reflection-room", participant: { kind: "human" as const, participantId: "human:owner" } }
            : definition.id === "evaluation.run" || definition.id === "reflection.suggestion.apply"
              ? { sessionId: "reflection-session" }
            : definition.id === "learning.resource.usage.record"
              ? { runId: "learning-resource-run" }
            : definition.id === "memory.archive"
              ? { sessionId: "memory-session" }
            : definition.id === "memory.session.create"
                ? { sessionId: "memory-session" }
              : definition.id === "reflection.run"
              ? { sessionId: reflectionSessionId }
              : definition.id === "memory.search" || definition.id === "wiki.search" || definition.id === "skill.search" || definition.id === "skill.usage.record" || definition.id === "skill.view"
                ? { runId: "skill-run" }
          : {})
      };
      executionCases.set(definition.id, { input, context });
      if (definition.id === "memory.session.create") {
        await expect(binding.execute(context, input)).rejects.toThrow("memorySessionScopeWriteDisabledError");
        for (const inputSource of definition.sources.slice(1)) {
          await expect(binding.execute({ ...context, inputSource, correlationId: `coverage-${definition.id}-${inputSource}` }, input))
            .rejects.toThrow("memorySessionScopeWriteDisabledError");
        }
        continue;
      }
      await binding.execute(context, input);
      for (const inputSource of definition.sources.slice(1)) {
        await binding.execute({ ...context, inputSource, correlationId: `coverage-${definition.id}-${inputSource}` }, input);
      }
      const generatedCompleteInput = completeSample(jsonSchemaFor(definition.input, `${definition.id}.input.complete`));
      const completeInput = definition.input.safeParse(definition.id === "resource.translation_job.save"
        ? { ...(generatedCompleteInput as Record<string, unknown>), source_ref: { kind: "artifact", id: "sample", uri: "artifacts/sample.md" } }
        : generatedCompleteInput);
      if (completeInput.success) {
        await binding.execute({ ...context, correlationId: `coverage-${definition.id}-complete` }, completeInput.data);
      }
      for (const [variantIndex, variant] of topLevelVariants(jsonSchemaFor(definition.input, `${definition.id}.input.variants`))) {
        const parsedVariant = definition.input.safeParse(variant);
        if (!parsedVariant.success) continue;
        try {
          await binding.execute({ ...context, correlationId: `coverage-${definition.id}-variant-${variantIndex}` }, parsedVariant.data);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }
      const count = portCalls.get(definition.id)?.length ?? 0;
      if (count === 0 && definition.id !== "presentation.plan") throw new Error(`${definition.id} did not call its Port`);
    }

    expect(bindings).toHaveLength(167);
    expect(portCalls.size).toBe(166);

    for (const operationId of ["artifact.create", "chat.turn.run"] as const) {
      const binding = bindings.find((candidate) => candidate.definition.id === operationId)!;
      const fixture = executionCases.get(operationId)!;
      await binding.execute({ ...fixture.context, surfaceOperation: { id: "surface-operation-fixture", kind: "form.submit" } } as never, fixture.input);
    }

    const gatewayMcpBinding = bindings.find((binding) => binding.definition.id === "gateway.mcp_config.save")!;
    const gatewayContext = executionCases.get("gateway.mcp_config.save")!.context;
    await gatewayMcpBinding.execute(gatewayContext as never, gatewayMcpConfigSave.input.parse({
      server_name: "fixture",
      transport: "stdio",
      stdio: {
        command: "fixture",
        args: [],
        env: {},
        secret_env: {},
        secret_files: [{ secret_ref_id: "secret-fixture", filename: "token", env: "TOKEN", mode: 0o600 }],
        framing: "json_lines",
        initialize: true
      }
    }));
    await gatewayMcpBinding.execute(gatewayContext as never, gatewayMcpConfigSave.input.parse({
      server_name: "fixture",
      transport: "http",
      http: { endpoint_url: "https://example.com/mcp", headers: {}, secret_headers: {} }
    }));

    const generatedCreateBinding = bindings.find((binding) => binding.definition.id === "generated_surface.create")!;
    const generatedCreateFixture = executionCases.get("generated_surface.create")!;
    const generatedCreateBundleValue = (generatedCreateFixture.input as { bundle: Record<string, unknown> }).bundle;
    const generatedCreateBundle = "custom_view" in generatedCreateBundleValue
      ? generatedCreateBundleValue.custom_view as Record<string, unknown>
      : generatedCreateBundleValue;
    const generatedBundleWithAsset = {
      ...generatedCreateBundle,
      assets: [{ path: "assets/fixture.svg", content: "<svg />", encoding: "utf8", mime_type: "image/svg+xml" }]
    };
    await generatedCreateBinding.execute(generatedCreateFixture.context as never, {
      ...(generatedCreateFixture.input as Record<string, unknown>),
      bundle: generatedBundleWithAsset
    });
    await generatedCreateBinding.execute(generatedCreateFixture.context as never, {
      ...(generatedCreateFixture.input as Record<string, unknown>),
      bundle: { custom_view: generatedBundleWithAsset }
    });
    await expect(generatedCreateBinding.execute({ ...generatedCreateFixture.context, sessionId: undefined } as never, generatedCreateFixture.input)).resolves.toMatchObject({ ok: true });

    const generatedReviseBinding = bindings.find((binding) => binding.definition.id === "generated_surface.revise")!;
    const generatedReviseFixture = executionCases.get("generated_surface.revise")!;
    const generatedReviseBundleValue = (generatedReviseFixture.input as { bundle: Record<string, unknown> }).bundle;
    const generatedReviseBundle = "custom_view" in generatedReviseBundleValue
      ? generatedReviseBundleValue.custom_view as Record<string, unknown>
      : generatedReviseBundleValue;
    const generatedReviseBundleWithAsset = {
      ...generatedReviseBundle,
      assets: [{ path: "assets/fixture.svg", content: "<svg />", encoding: "utf8", mime_type: "image/svg+xml" }]
    };
    await generatedReviseBinding.execute(generatedReviseFixture.context as never, {
      ...(generatedReviseFixture.input as Record<string, unknown>),
      bundle: { custom_view: generatedReviseBundleWithAsset }
    });
    await expect(generatedReviseBinding.execute({ ...generatedReviseFixture.context, sessionId: undefined } as never, generatedReviseFixture.input)).resolves.toMatchObject({ ok: true });

    const graphCreateBinding = bindings.find((binding) => binding.definition.id === "graph.create")!;
    const graphCreateFixture = executionCases.get("graph.create")!;
    await graphCreateBinding.execute({ ...graphCreateFixture.context, sessionId: "graph-session" } as never, graphCreateFixture.input);
    await expect(graphCreateBinding.execute({ ...graphCreateFixture.context, sessionId: undefined } as never, graphCreateFixture.input)).resolves.toMatchObject({ ok: true });

    const graphPatchBinding = bindings.find((binding) => binding.definition.id === "graph.patch")!;
    const graphPatchFixture = executionCases.get("graph.patch")!;
    graphContentScenario = "invalid";
    await expect(graphPatchBinding.execute(graphPatchFixture.context as never, graphPatchFixture.input)).rejects.toBeInstanceOf(Error);
    graphContentScenario = "valid";
    const graphPatchInput = { ...(graphPatchFixture.input as Record<string, unknown>), document: undefined };
    await graphPatchBinding.execute(graphPatchFixture.context as never, {
      ...graphPatchInput,
      nodes: [{ id: "node-fixture", label: "Fixture node" }],
      edges: [{ id: "edge-fixture", source: "node-fixture", target: "node-fixture" }],
      delete_node_ids: ["missing-node"],
      delete_edge_ids: ["missing-edge"]
    });

    const sandboxBinding = bindings.find((binding) => binding.definition.id === "sandbox.exec")!;
    const sandboxFixture = executionCases.get("sandbox.exec")!;
    await sandboxBinding.execute(sandboxFixture.context as never, {
      ...(sandboxFixture.input as Record<string, unknown>),
      secret_files: [{ secret_ref_id: "secret-fixture", filename: "token", env: "TOKEN", mode: 0o600 }]
    });

    const reflectionBinding = bindings.find((binding) => binding.definition.id === "reflection.suggestion.apply")!;
    const reflectionFixture = executionCases.get("reflection.suggestion.apply")!;
    for (reflectionSuggestionType of ["skill", "knowledge_wiki"]) {
      await reflectionBinding.execute(reflectionFixture.context as never, reflectionFixture.input);
    }
    reflectionSuggestionType = "memory";
    reflectionSuggestionType = "skill_patch" as never;
    await expect(reflectionBinding.execute(reflectionFixture.context as never, reflectionFixture.input)).rejects.toBeInstanceOf(Error);
    reflectionSuggestionType = "memory";

    const reflectionRunBinding = bindings.find((binding) => binding.definition.id === "reflection.run")!;
    const reflectionRunFixture = executionCases.get("reflection.run")!;
    reflectionSessionMissing = true;
    await expect(reflectionRunBinding.execute(reflectionRunFixture.context as never, reflectionRunFixture.input)).rejects.toBeInstanceOf(Error);
    reflectionSessionMissing = false;
    for (const scenario of ["missing", "mismatch"] as const) {
      reflectionBackendScenario = scenario;
      await expect(reflectionRunBinding.execute(reflectionRunFixture.context as never, { source_run_id: "source-run-fixture" })).rejects.toBeInstanceOf(Error);
    }
    reflectionBackendScenario = "normal";
    reflectionMessagesPresent = true;
    await reflectionRunBinding.execute(reflectionRunFixture.context as never, { source_run_id: "source-run-fixture" });
    reflectionMessagesPresent = false;
    reflectionSuggestionStatus = "applied";
    await expect(reflectionBinding.execute(reflectionFixture.context as never, reflectionFixture.input)).rejects.toBeInstanceOf(Error);
    reflectionSuggestionStatus = "proposed";

    const memoryArchiveBinding = bindings.find((binding) => binding.definition.id === "memory.archive")!;
    const memoryArchiveFixture = executionCases.get("memory.archive")!;
    memoryArchiveChanged = false;
    await memoryArchiveBinding.execute(memoryArchiveFixture.context as never, memoryArchiveFixture.input);
    memoryArchiveChanged = true;
    for (const scenario of ["session_missing", "memory_missing", "not_in_session", "archive_missing", "archive_failure"] as const) {
      memoryArchiveScenario = scenario;
      await expect(memoryArchiveBinding.execute(memoryArchiveFixture.context as never, memoryArchiveFixture.input)).rejects.toBeInstanceOf(Error);
    }
    memoryArchiveScenario = "archive_failure";
    memoryArchiveUpdateThrows = true;
    await expect(memoryArchiveBinding.execute(memoryArchiveFixture.context as never, memoryArchiveFixture.input)).rejects.toBeInstanceOf(Error);
    memoryArchiveUpdateThrows = false;
    memoryArchiveScenario = "invalid_actor";
    await expect(memoryArchiveBinding.execute({ ...memoryArchiveFixture.context, actorId: "invalid-actor" } as never, memoryArchiveFixture.input)).rejects.toBeInstanceOf(Error);
    memoryArchiveScenario = "normal";

    const automationRequeueBinding = bindings.find((binding) => binding.definition.id === "automation.job.requeue")!;
    const automationRequeueFixture = executionCases.get("automation.job.requeue")!;
    automationRequeueMissing = true;
    await expect(automationRequeueBinding.execute(automationRequeueFixture.context as never, automationRequeueFixture.input)).rejects.toBeInstanceOf(Error);
    automationRequeueMissing = false;

    const automationRunBinding = bindings.find((binding) => binding.definition.id === "automation.job.run")!;
    const automationRunFixture = executionCases.get("automation.job.run")!;
    for (automationJobKind of ["wiki_reindex", "skill_curator", "memory_review", "learning_evaluation", "resource_translation", "custom_instruction", "daily_digest"]) {
      await automationRunBinding.execute(automationRunFixture.context as never, automationRunFixture.input);
    }
    automationJobKind = "daily_digest";
    for (automationJobSchedule of ["once", "weekly", "hourly", "every 2 hours"]) {
      await automationRunBinding.execute(automationRunFixture.context as never, automationRunFixture.input);
    }
    automationJobSchedule = "daily";

    const rollbackBinding = bindings.find((binding) => binding.definition.id === "rollback.restore")!;
    const rollbackFixture = executionCases.get("rollback.restore")!;
    for (rollbackScenario of ["missing", "irreversible", "expired", "missing_path", "invalid_content", "root"]) {
      await expect(rollbackBinding.execute(rollbackFixture.context as never, rollbackFixture.input)).rejects.toBeInstanceOf(Error);
    }
    rollbackScenario = "delete";
    await rollbackBinding.execute(rollbackFixture.context as never, rollbackFixture.input);
    rollbackScenario = "valid";

    const externalDispatchBinding = bindings.find((binding) => binding.definition.id === "external.send.dispatch")!;
    const externalDispatchFixture = executionCases.get("external.send.dispatch")!;
    for (externalDispatchScenario of ["dry_run", "failed", "detailed"]) {
      externalSendLookupCount = 0;
      await externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input);
    }
    externalDispatchScenario = "dispatched";
    externalClaimScenario = "outcome_unknown";
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_outcome_unknown");
    externalClaimScenario = "dispatched";
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_already_dispatched");
    externalClaimScenario = "conflict";
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_dispatch_claim_conflict");
    externalClaimScenario = "conflict";
    externalClaimLookupStatus = "outcome_unknown";
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_outcome_unknown");
    externalClaimLookupStatus = "dispatched";
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_already_dispatched");
    externalClaimScenario = "claimed";
    externalClaimLookupStatus = "approved";
    externalDispatchOutcomeUnknown = true;
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).resolves.toMatchObject({ ok: true });
    externalDispatchOutcomeUnknown = false;
    externalDispatchOutcomeUnknown = false;
    externalDispatchThrows = true;
    externalSendLookupCount = 0;
    await expect(externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input)).rejects.toThrow("external_send_outcome_unknown");
    externalDispatchThrows = false;

    const clientEventDeliverBinding = bindings.find((binding) => binding.definition.id === "client.event.deliver")!;
    const clientEventDeliverFixture = executionCases.get("client.event.deliver")!;
    clientEventDeliverMissing = true;
    await expect(clientEventDeliverBinding.execute(clientEventDeliverFixture.context as never, clientEventDeliverFixture.input)).rejects.toBeInstanceOf(Error);
    clientEventDeliverMissing = false;

    const collectionDeleteBinding = bindings.find((binding) => binding.definition.id === "collection.record.delete")!;
    const collectionDeleteFixture = executionCases.get("collection.record.delete")!;
    for (const scenario of ["schema_missing", "forbidden", "record_missing"] as const) {
      collectionDeleteScenario = scenario;
      await expect(collectionDeleteBinding.execute(collectionDeleteFixture.context as never, collectionDeleteFixture.input)).rejects.toBeInstanceOf(Error);
    }
    collectionDeleteScenario = "delete_failure";
    await expect(collectionDeleteBinding.execute(collectionDeleteFixture.context as never, collectionDeleteFixture.input)).rejects.toBeInstanceOf(Error);
    collectionDeleteScenario = "normal";

    const filePatchBinding = bindings.find((binding) => binding.definition.id === "file.patch")!;
    const filePatchFixture = executionCases.get("file.patch")!;
    filePatchConflict = true;
    await expect(filePatchBinding.execute(filePatchFixture.context as never, filePatchFixture.input)).rejects.toBeInstanceOf(Error);
    filePatchConflict = false;

    const gatewayPairingExpireBinding = bindings.find((binding) => binding.definition.id === "gateway.pairing.expire")!;
    const gatewayPairingExpireFixture = executionCases.get("gateway.pairing.expire")!;
    gatewayPairingsExpired = true;
    await expect(gatewayPairingExpireBinding.execute(gatewayPairingExpireFixture.context as never, gatewayPairingExpireFixture.input)).resolves.toMatchObject({ ok: true, value: [expect.any(Object)] });
    gatewayPairingsExpired = false;

    const evaluationBinding = bindings.find((binding) => binding.definition.id === "evaluation.run")!;
    const evaluationFixture = executionCases.get("evaluation.run")!;
    for (evaluationScenario of ["existing", "missing_run", "no_skills"]) {
      await evaluationBinding.execute(evaluationFixture.context as never, evaluationFixture.input);
    }
    evaluationScenario = "normal";

    const translationBinding = bindings.find((binding) => binding.definition.id === "resource.translation_job.save")!;
    const translationFixture = executionCases.get("resource.translation_job.save")!;
    for (const kind of ["memory", "wiki", "skill", "collection_record"] as const) {
      const ref = { kind, id: "sample", uri: `${kind}/sample` };
      await translationBinding.execute(translationFixture.context as never, { ...(translationFixture.input as Record<string, unknown>), source_ref: ref });
    }

    const skillPatchBinding = bindings.find((binding) => binding.definition.id === "skill.patch")!;
    const skillPatchFixture = executionCases.get("skill.patch")!;
    for (const scenario of ["missing", "patch_failure", "save_missing"] as const) {
      skillPatchScenario = scenario;
      await expect(skillPatchBinding.execute(skillPatchFixture.context as never, skillPatchFixture.input)).rejects.toBeInstanceOf(Error);
    }
    skillPatchScenario = "normal";

    const skillProjectBinding = bindings.find((binding) => binding.definition.id === "skill.project.save")!;
    const skillProjectFixture = executionCases.get("skill.project.save")!;
    for (const scenario of ["missing", "not_candidate", "session_scope"] as const) {
      skillProjectScenario = scenario;
      await expect(skillProjectBinding.execute(skillProjectFixture.context as never, skillProjectFixture.input)).rejects.toBeInstanceOf(Error);
    }
    skillProjectScenario = "normal";

    const skillSupportBinding = bindings.find((binding) => binding.definition.id === "skill.support_file.save")!;
    const skillSupportFixture = executionCases.get("skill.support_file.save")!;
    skillSupportFilesPresent = true;
    await skillSupportBinding.execute(skillSupportFixture.context as never, skillSupportFixture.input);
    skillSupportFilesPresent = false;

    const messagePresentationBinding = bindings.find((binding) => binding.definition.id === "message.presentation.update")!;
    const messagePresentationFixture = executionCases.get("message.presentation.update")!;
    messagePresentationUpdateMissing = true;
    await expect(messagePresentationBinding.execute(messagePresentationFixture.context as never, messagePresentationFixture.input)).rejects.toBeInstanceOf(Error);
    messagePresentationUpdateMissing = false;

    const wikiPatchBinding = bindings.find((binding) => binding.definition.id === "wiki.patch")!;
    const wikiPatchFixture = executionCases.get("wiki.patch")!;
    for (const scenario of ["missing", "update_failure", "update_missing"] as const) {
      wikiPatchScenario = scenario;
      await expect(wikiPatchBinding.execute(wikiPatchFixture.context as never, wikiPatchFixture.input)).rejects.toBeInstanceOf(Error);
    }
    wikiPatchScenario = "normal";

    const contextBoundaryCases: Array<[string, Record<string, unknown>]> = [
      ["chat.turn.run", { idempotencyKey: undefined }],
      ["evaluation.run", { sessionId: undefined }],
      ["learning.background_review.apply", { roomId: undefined }],
      ["learning.resource.usage.record", { runId: undefined }],
      ["memory.archive", { sessionId: undefined }],
      ["reflection.run", { sessionId: undefined }],
      ["reflection.suggestion.apply", { sessionId: undefined }],
      ["resource.translation_job.save", { roomId: undefined }],
      ["skill.view", { runId: undefined }],
      ["skill.usage.record", { runId: undefined }],
      ["generated_surface.state", { sessionId: undefined }]
    ];
    for (const [operationId, override] of contextBoundaryCases) {
      const fixture = executionCases.get(operationId)!;
      const binding = bindings.find((candidate) => candidate.definition.id === operationId)!;
      await expect(binding.execute({ ...fixture.context, ...override } as never, fixture.input)).rejects.toBeInstanceOf(Error);
    }
    const workItemFixture = executionCases.get("work_item.create")!;
    const workItemBinding = bindings.find((candidate) => candidate.definition.id === "work_item.create")!;
    await expect(workItemBinding.execute({ ...workItemFixture.context, roomId: "different-room" } as never, workItemFixture.input)).rejects.toThrow("objective_room_access_denied");
    const candidateFixture = executionCases.get("skill.candidate.create")!;
    const candidateBinding = bindings.find((candidate) => candidate.definition.id === "skill.candidate.create")!;
    await expect(candidateBinding.execute(candidateFixture.context as never, {
      ...(candidateFixture.input as Record<string, unknown>),
      usage_scope: { kind: "session", session_id: "session-fixture" }
    })).rejects.toThrow("skillMutationConflict");

    const registry = new DomainOperationRegistry(operationPorts);
    const activityFixture = executionCases.get("activity.history.list")!;
    const activityInput = { activity_id: "activity-fixture" };
    const activityContext = { ...activityFixture.context, inputSource: "runtime_api" as const };
    const synchronousAbortController = new AbortController();
    abortDuringActivityReadController = synchronousAbortController;
    await expect(registry.execute({ ...activityContext, signal: synchronousAbortController.signal } as never, "activity.history.list", activityInput)).rejects.toMatchObject({ code: "outcome_unknown" });
    activityHistoryDelayMs = 50;
    const abortController = new AbortController();
    const abortedExecution = registry.execute({ ...activityContext, signal: abortController.signal } as never, "activity.history.list", activityInput);
    setTimeout(() => abortController.abort(), 1);
    await expect(abortedExecution).rejects.toMatchObject({ code: "outcome_unknown" });
    activityHistoryDelayMs = 0;
    activityHistoryBusyWaitMs = 25;
    await expect(registry.execute({ ...activityContext, deadlineAt: Date.now() + 5 } as never, "activity.history.list", activityInput)).rejects.toMatchObject({ code: "outcome_unknown" });
    activityHistoryBusyWaitMs = 0;
    await registry.execute({ ...activityContext } as never, "activity.history.list", {
      principal_id: "principal-fixture",
      source_kind: "host",
      source_id: "source-fixture",
      status: "completed",
      created_after: "2026-01-01T00:00:00.000Z",
      created_before: "2026-01-02T00:00:00.000Z",
      limit: 10,
      offset: 1
    });

    const generatedActionBinding = bindings.find((binding) => binding.definition.id === "generated_surface.action.run")!;
    const generatedActionFixture = executionCases.get("generated_surface.action.run")!;
    generatedActionAllowed = false;
    await expect(generatedActionBinding.execute(generatedActionFixture.context as never, generatedActionFixture.input)).rejects.toBeInstanceOf(Error);
    generatedActionAllowed = true;

    const generatedSurfaceStateBinding = bindings.find((binding) => binding.definition.id === "generated_surface.state")!;
    const generatedSurfaceStateFixture = executionCases.get("generated_surface.state")!;
    generatedSurfaceStateMissing = true;
    await expect(generatedSurfaceStateBinding.execute(generatedSurfaceStateFixture.context as never, generatedSurfaceStateFixture.input)).rejects.toBeInstanceOf(Error);
    generatedSurfaceStateMissing = false;

    const pluginStatusBinding = bindings.find((binding) => binding.definition.id === "plugin.status.set")!;
    const pluginStatusFixture = executionCases.get("plugin.status.set")!;
    for (const scenario of ["missing", "previous_missing", "set_failure", "save_failure", "restore_failure"] as const) {
      pluginStatusScenario = scenario;
      pluginSetCallCount = 0;
      await expect(pluginStatusBinding.execute(pluginStatusFixture.context as never, pluginStatusFixture.input)).rejects.toBeInstanceOf(Error);
    }
    pluginStatusScenario = "normal";
    pluginSetCallCount = 0;

    const artifactBinding = bindings.find((binding) => binding.definition.id === "artifact.create")!;
    const artifactFixture = executionCases.get("artifact.create")!;
    const missingArtifactSessionPorts = new Proxy(operationPorts, {
      get: (target, operationId) => String(operationId) !== "artifact.create" ? Reflect.get(target, operationId) : new Proxy(Reflect.get(target, operationId) as object, {
        get: (operationTarget, method) => String(method) === "getArtifactSession" ? () => undefined : Reflect.get(operationTarget, method)
      })
    }) as DomainOperationPorts;
    const missingArtifactSessionBinding = bindOperationDefinitions(missingArtifactSessionPorts).find((binding) => binding.definition.id === artifactBinding.definition.id)!;
    await expect(missingArtifactSessionBinding.execute({ ...artifactFixture.context, inputSource: "provider_tool_call" } as never, { ...(artifactFixture.input as Record<string, unknown>), session_id: "sample" })).rejects.toBeInstanceOf(Error);

    let guardedFailures = 0;
    for (const { definition } of bindings) {
      const fixture = executionCases.get(definition.id)!;
      const dependencyMethods = [...new Set(portCalls.get(definition.id) ?? [])].filter((name) => /^(get|read|load|find|require|acquire|run|apply)/.test(name));
      for (const missingMethod of dependencyMethods) {
        const failingPorts = new Proxy(operationPorts, {
          get: (target, operationId) => String(operationId) !== definition.id
            ? Reflect.get(target, operationId)
            : new Proxy(Reflect.get(target, operationId) as object, {
              get: (operationTarget, method) => String(method) === missingMethod
                ? (/^(run|apply)/.test(missingMethod) ? () => { throw new Error(`fixture_${missingMethod}_failed`); } : () => undefined)
                : Reflect.get(operationTarget, method)
            })
        }) as DomainOperationPorts;
        const failingBinding = bindOperationDefinitions(failingPorts).find((binding) => binding.definition.id === definition.id)!;
        for (const inputSource of definition.sources) {
          try {
            await failingBinding.execute({ ...fixture.context, inputSource } as never, fixture.input);
          } catch {
            guardedFailures += 1;
            break;
          }
        }
      }
    }
    expect(guardedFailures).toBeGreaterThan(0);
  });
});

function fixtureRecord(id: string): Record<string, unknown> {
  const timestamp = "2026-07-16T00:00:00.000Z";
  const ref = { kind: "artifact", id: `${id}-resource`, uri: `artifacts/${id}.md` };
  return {
    id: `${id}-fixture`,
    artifact_id: "sample",
    revision_id: "sample",
    objective_id: "sample",
    run_id: "sample",
    session_id: `${id}-session`,
    title: id,
    content: "fixture",
    body: "fixture",
    kind: "markdown",
    status: "completed",
    ui_locale: "en",
    output_locale: "en",
    input_locale: "en",
    created_at: timestamp,
    updated_at: timestamp,
    started_at: timestamp,
    completed_at: timestamp,
    file_ref: ref,
    resource_ref: ref,
    operation: { id: `${id}-operation` },
    activity: [],
    metadata: {}
  };
}

function fixtureSession(id: string): SessionRecord {
  const timestamp = "2026-07-16T00:00:00.000Z";
  return {
    id,
    session_key: id,
    room_id: "room-fixture",
    title: "Fixture session",
    ui_locale: "en",
    output_locale: "en",
    created_at: timestamp,
    updated_at: timestamp
  };
}

function fixtureBackendRun(id: string, sessionId: string): BackendRunRecord {
  const timestamp = "2026-07-16T00:00:00.000Z";
  return {
    id,
    session_id: sessionId,
    agent_id: "agent-fixture",
    input_message_id: "input-fixture",
    backend_id: "backend-fixture",
    backend_kind: "samurai_native",
    status: "completed",
    started_at: timestamp,
    completed_at: timestamp,
    input_summary: "fixture",
    metadata: {}
  };
}

function fixtureGatewayPairing() {
  const timestamp = "2026-07-16T00:00:00.000Z";
  return {
    id: "gateway-pairing-fixture",
    channel: "slack",
    source_identity: "workspace:T123/user:U456",
    source_label: "Fixture source",
    status: "expired",
    session_key: "slack:T123:U456",
    metadata: {},
    requested_at: timestamp,
    expires_at: timestamp,
    resolved_at: timestamp,
    updated_at: timestamp
  };
}

function fixtureSkillMarkdown(state: "candidate" | "project" = "candidate", sessionScope = false): string {
  return `---\n${JSON.stringify({
    id: "sample", state, title: "Fixture skill", description: "Fixture skill.", tags: ["fixture"],
    provenance: "generated_local", trust_level: "generated_local", allowed_scopes: ["skill"],
    required_capabilities: ["proposal_workspace"], schedule_policy: {}, secret_policy: {},
    ...(sessionScope ? { usage_scope: { kind: "session", session_id: "session-fixture" } } : {}),
    last_reviewed_at: "2026-07-16T00:00:00.000Z", owner_pinned: false
  }, null, 2)}\n---\n# Fixture\n`;
}

function fixtureRollback(id: string): Record<string, unknown> {
  return {
    id: `${id}-rollback`, operation_id: `${id}-operation`, affected_resources: [fixtureRecord(id).resource_ref],
    before_snapshot: {}, after_snapshot: {}, reversible: true, irreversible_effects: [],
    expires_at: "2099-01-01T00:00:00.000Z", created_at: "2026-07-16T00:00:00.000Z"
  };
}

function topLevelVariants(schema: Record<string, unknown>): Array<[number, unknown]> {
  const base = sample(schema) as Record<string, unknown>;
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, Record<string, unknown>>
    : {};
  const variants: unknown[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (Array.isArray(property.enum)) {
      for (const value of property.enum) variants.push({ ...base, [key]: value });
    } else if (property.type === "boolean") {
      variants.push({ ...base, [key]: true }, { ...base, [key]: false });
    }
  }
  return variants.map((variant, index) => [index, variant]);
}
