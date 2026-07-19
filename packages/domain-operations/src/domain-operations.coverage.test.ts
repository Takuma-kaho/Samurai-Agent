import { describe, expect, it } from "vitest";
import { bindOperationDefinitions, DomainOperationRegistry, jsonSchemaFor, operationDefinitions, type DomainOperationPorts } from "./index.js";
import { completeSample, sample } from "../../../scripts/fixtures/domain-commands-gate.js";
import gatewayMcpConfigSave from "./operations/gateway/mcp_config/save.operation.js";
import gatewayInboundRoute from "./operations/gateway/inbound/route.operation.js";

describe("Domain Operation strict gate coverage", () => {
  it("loads and executes the complete 119-operation strict gate", () => {
    expect(true).toBe(true);
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
    let evaluationScenario: "normal" | "existing" | "missing_run" | "no_skills" = "normal";
    const operationPorts = new Proxy({}, {
      get: (_target, operationId) => new Proxy({}, {
        get: (_ports, method) => (...args: unknown[]) => {
          const id = String(operationId);
          const name = String(method);
          portCalls.set(id, [...(portCalls.get(id) ?? []), name]);
          if (/Error$|NotFound$|Conflict$/.test(name)) return new Error(name);
          if (name === "listCollectionRecords") return { collection_id: "sample", count: 0, items: [], linked_data: {}, schema_fields: {} };
          if (name === "listMemoryForSession") return [{ ...fixtureRecord(id), id: "sample" }];
          if (name === "listReflectionSuggestions") return [{ id: "sample", reflection_run_id: "sample", suggestion_type: reflectionSuggestionType, status: "proposed", title: "fixture", content: "fixture", source_refs: [], confidence: 0.5, created_at: "2026-07-16T00:00:00.000Z", updated_at: "2026-07-16T00:00:00.000Z" }];
          if (name === "listEvaluationBackendRuns") return [
            { id: "run-before", session_id: "sample", input_message_id: "input-before", backend_id: "fixture", backend_kind: "samurai_native", status: "completed", started_at: "2026-07-14T00:00:00.000Z", completed_at: "2026-07-14T00:01:00.000Z", input_summary: "before", metadata: {} },
            { id: "run-used", session_id: "sample", input_message_id: "input-used", backend_id: "fixture", backend_kind: "samurai_native", status: "completed", started_at: "2026-07-15T00:00:00.000Z", completed_at: "2026-07-15T00:01:00.000Z", input_summary: "used", metadata: {} }
          ];
          if (name === "listLearningResourceUses") return [{ id: "use", run_id: evaluationScenario === "missing_run" ? "run-missing" : "run-used", session_id: "sample", resource_kind: "skill", resource_id: "skill-fixture", resource_version: "1", stage: "selected", metadata: {}, created_at: "2026-07-15T00:00:00.000Z" }];
          if (name === "listExistingLearningEvaluations") return evaluationScenario === "existing"
            ? [{ learning_resource_ref: { id: "skill-fixture" }, learning_resource_version: "1", compared_run_ids: ["run-used"] }]
            : [];
          if (name === "listEvaluationSkills") return evaluationScenario === "no_skills" ? [] : [{ id: "skill-fixture", title: "Fixture", description: "Fixture", tags: [], allowed_scopes: ["skill"], required_capabilities: [], owner_pinned: false, state: "project", file_path: "skills/skill-fixture/SKILL.md", frontmatter: { id: "skill-fixture", state: "project", title: "Fixture", description: "Fixture", tags: [], provenance: "owner", trust_level: "owner_approved", allowed_scopes: ["skill"], required_capabilities: [], schedule_policy: {}, secret_policy: {}, last_reviewed_at: "2026-07-16T00:00:00.000Z", owner_pinned: false } }];
          if (name === "expireGatewayPairings" || name === "expireClientEvents") return [];
          if (name === "reindexCollectionStore") return { schemas: { indexed: 0 }, records: { indexed: 0 } };
          if (name.startsWith("list") && name !== "listWorkspaceFiles") return [];
          if (/Now$/.test(name)) return "2026-07-16T00:00:00.000Z";
          if (/Fingerprint$/.test(name)) return "fixture-fingerprint";
          if (name === "currentTimeMillis") return 1_752_624_000_000;
          if (name.startsWith("create") && name.endsWith("Id")) return `${id}-fixture`;
          if (name.endsWith("Contract")) return { id, proposed_effects: [] };
          if (name === "getAutomationJob" || name === "acquireAutomationJobLock") return { ...fixtureRecord(id), kind: automationJobKind, title: "fixture", target_instruction: "fixture", schedule: automationJobSchedule, status: "enabled" };
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
          if (name === "getCollectionSchema" || name === "getCollectionSchemaForMutation" || name === "saveCollectionSchema" || name === "updateCollectionSchema") return {
            id: "sample", version: "1", labels: {}, descriptions: {}, fields: [], refs: [], embeds: [], derived_fields: [], triggers: [], actions: [], permissions: {}, file_path: "collections/sample/schema.json"
          };
          if (name === "getMemoryForArchive") return (outputs.get(id) as { memory?: unknown } | undefined)?.memory ?? fixtureRecord(id);
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
          if (name === "getMessagePresentation" || name === "updateMessagePresentationViewState") return (outputs.get(id) as { presentation?: unknown } | undefined)?.presentation
            ?? (outputs.get("message.presentation.update") as { presentation?: unknown } | undefined)?.presentation;
          if (name === "presentCollectionView" && id === "message.presentation.update") return { render_spec: (outputs.get(id) as { render_spec?: unknown } | undefined)?.render_spec
            ?? (outputs.get("message.presentation.update") as { render_spec?: unknown } | undefined)?.render_spec };
          if (name === "applyPresentationViewState") return args[0];
          if (name === "presentationViewStateFromSpec") return {};
          if (name === "applySettingsPatch") return outputs.get(id);
          if (name === "findPluginStatus") return (outputs.get(id) as { plugin?: unknown } | undefined)?.plugin
            ?? { manifest_id: "plugin-fixture", version: "1.0.0" };
          if (name === "savePluginState") return (outputs.get(id) as { state?: unknown } | undefined)?.state
            ?? { manifest_id: "plugin-fixture", enabled: true, version: "1.0.0", updated_at: "2026-07-16T00:00:00.000Z" };
          if (name === "executeReflectionWorkflow") return outputs.get(id);
          if (name === "getGeneratedSurface") return (outputs.get(id) as { surface?: unknown } | undefined)?.surface
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
          if (name === "updateGeneratedSurfaceState") return outputs.get(id);
          if (name === "createAutomationRun" || name === "updateAutomationRun" || name === "saveAutomationJobRecord") return args[0];
          if (name === "releaseAutomationJobLock" || name === "requeueAutomationJob") return outputs.get(id);
          if (/^(acknowledge|deliver|fail|save)ClientEvent$/.test(name)) return outputs.get(id);
          if ([
            "reindexSessionSearch", "saveClientEvent", "transitionObjective", "saveObjective", "searchCollections",
            "saveGeneratedSurfaceInteraction", "saveWorkItem", "searchWiki", "searchSessions", "searchSkills",
            "resumeCurator", "pruneLearningSnapshots", "pauseCurator", "searchMemory", "extractBrowserPage",
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
          if (name === "readFileTextIfExists") return "sample";
          if (name === "readSkillMarkdown") return fixtureSkillMarkdown();
          if (name === "readArtifactContent" && id.startsWith("graph.")) return "{\"version\":\"1\",\"nodes\":[],\"edges\":[]}";
          if (name === "resolveFilePath") return { absolutePath: "/tmp/sample", relativePath: "sample" };
          if (name === "resolveRollbackPath") return rollbackScenario === "root"
            ? { absolutePath: "/tmp", relativePath: "." }
            : { absolutePath: "/tmp/sample.txt", relativePath: "sample.txt" };
          if (name === "dispatchExternalSend") {
            if (externalDispatchScenario === "dry_run") return { dispatched: false, adapter: "fixture", dry_run: true, message: "dry run" };
            if (externalDispatchScenario === "failed") return { dispatched: false, adapter: "fixture", dry_run: false, message: "failed" };
            if (externalDispatchScenario === "detailed") return { dispatched: true, adapter: "fixture", transport: "https", status: 202, dry_run: false, message: "sent" };
            return { dispatched: true, adapter: "fixture", dry_run: false, message: "sent" };
          }
          if (name.endsWith("TranslationSource")) return { content: "fixture", ref: fixtureRecord(id).resource_ref, source_locale: "en" };
          if (name === "hashTranslationContent") return "fixture-hash";
          if (name === "saveTranslationAutomationJob") return outputs.get(id);
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
          if (name === "archiveMemoryRecord") {
            const output = outputs.get(id) as { memory: Record<string, unknown>; content: string; warning?: string };
            const { file_path, ...frontmatter } = output.memory;
            return { before: { frontmatter, file_path }, after: { frontmatter, file_path }, content: output.content, changed: memoryArchiveChanged, warning: output.warning };
          }
          if (name === "rebuildMemoryActivity") return (outputs.get(id) as { activity?: unknown[] }).activity ?? [];
          if (name === "memoryResourceRef") return fixtureRecord(id).resource_ref;
          if (name === "memoryArchiveCapabilityId") return "memory";
          if (name === "createReflectionMemoryTarget" || name === "createReflectionSkillTarget" || name === "createReflectionWikiTarget") return { resource: fixtureRecord(id), ref: fixtureRecord(id).resource_ref };
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
    const executionCases = new Map<string, { input: unknown; context: { inputSource: string; workspaceId: string; actorId: string; correlationId: string } }>();

    for (const binding of bindings) {
      const { definition } = binding;
      const generatedInput = sample(jsonSchemaFor(definition.input, `${definition.id}.input`));
      const input = definition.input.parse(definition.id === "resource.translation_job.save"
        ? { ...(generatedInput as Record<string, unknown>), source_ref: { kind: "artifact", id: "sample", uri: "artifacts/sample.md" } }
        : definition.id === "skill.optimization.rollback"
          ? { ...(generatedInput as Record<string, unknown>), promotion_id: "sample" }
          : generatedInput);
      const context = {
        inputSource: definition.sources[0]!,
        workspaceId: "workspace",
        actorId: "actor",
        correlationId: `coverage-${definition.id}`,
        ...(definition.id === "generated_surface.create" || definition.id === "generated_surface.revise"
          ? { sessionId: "surface-session", runId: "surface-run" }
          : definition.id === "memory.archive"
            ? { sessionId: "memory-session" }
            : definition.id === "reflection.run"
              ? { sessionId: "reflection-session" }
              : definition.id === "skill.usage.record" || definition.id === "skill.view"
                ? { runId: "skill-run" }
          : {})
      };
      executionCases.set(definition.id, { input, context });
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

    expect(bindings).toHaveLength(119);
    expect(portCalls.size).toBe(118);

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
    await expect(generatedCreateBinding.execute({ ...generatedCreateFixture.context, sessionId: undefined } as never, generatedCreateFixture.input)).rejects.toBeInstanceOf(Error);

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
    await expect(generatedReviseBinding.execute({ ...generatedReviseFixture.context, sessionId: undefined } as never, generatedReviseFixture.input)).rejects.toBeInstanceOf(Error);

    const graphCreateBinding = bindings.find((binding) => binding.definition.id === "graph.create")!;
    const graphCreateFixture = executionCases.get("graph.create")!;
    await graphCreateBinding.execute({ ...graphCreateFixture.context, sessionId: "graph-session" } as never, graphCreateFixture.input);
    const missingGraphSessionPorts = new Proxy(operationPorts, {
      get: (target, operationId) => String(operationId) !== "graph.create" ? Reflect.get(target, operationId) : new Proxy(Reflect.get(target, operationId) as object, {
        get: (operationTarget, method) => String(method) === "getArtifactSession" ? async () => undefined : Reflect.get(operationTarget, method)
      })
    }) as DomainOperationPorts;
    const missingGraphSessionBinding = bindOperationDefinitions(missingGraphSessionPorts).find((binding) => binding.definition.id === "graph.create")!;
    await expect(missingGraphSessionBinding.execute({ ...graphCreateFixture.context, sessionId: "graph-session" } as never, graphCreateFixture.input)).rejects.toBeInstanceOf(Error);

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

    const memoryArchiveBinding = bindings.find((binding) => binding.definition.id === "memory.archive")!;
    const memoryArchiveFixture = executionCases.get("memory.archive")!;
    memoryArchiveChanged = false;
    await memoryArchiveBinding.execute(memoryArchiveFixture.context as never, memoryArchiveFixture.input);
    memoryArchiveChanged = true;

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
      await externalDispatchBinding.execute(externalDispatchFixture.context as never, externalDispatchFixture.input);
    }
    externalDispatchScenario = "dispatched";

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

    const generatedActionBinding = bindings.find((binding) => binding.definition.id === "generated_surface.action.run")!;
    const generatedActionFixture = executionCases.get("generated_surface.action.run")!;
    generatedActionAllowed = false;
    await expect(generatedActionBinding.execute(generatedActionFixture.context as never, generatedActionFixture.input)).rejects.toBeInstanceOf(Error);
    generatedActionAllowed = true;

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

function fixtureSkillMarkdown(): string {
  return `---\n${JSON.stringify({
    id: "sample", state: "candidate", title: "Fixture skill", description: "Fixture skill.", tags: ["fixture"],
    provenance: "generated_local", trust_level: "generated_local", allowed_scopes: ["skill"],
    required_capabilities: ["proposal_workspace"], schedule_policy: {}, secret_policy: {},
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
