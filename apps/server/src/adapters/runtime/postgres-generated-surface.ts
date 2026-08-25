import { createHash } from "node:crypto";
import {
  ActivityRecordSchema,
  GeneratedSurfaceDefinitionSchema,
  GeneratedSurfaceRevisionRecordSchema,
  OperationRecordSchema,
  ResourceRefSchema,
  SurfaceInteractionRecordSchema,
  nowIso,
  stableHash,
  type ActivityRecord,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceRevisionRecord,
  type JsonValue,
  type OperationRecord,
  type ResourceRef,
  type SurfaceInteractionRecord
} from "@samurai-agent/core-schemas";
import {
  domainQueryReadCapability,
  generatedSurfaceActionRun,
  generatedSurfaceCreate,
  generatedSurfaceExport,
  generatedSurfaceInteractionRecord,
  generatedSurfaceRevise,
  generatedSurfaceState,
  type GeneratedSurfaceActionRunInput,
  type GeneratedSurfaceCreateInput,
  type GeneratedSurfaceCreatePorts,
  type GeneratedSurfaceExportInput,
  type GeneratedSurfaceExportPorts,
  type GeneratedSurfaceInteractionRecordInput,
  type GeneratedSurfaceInteractionRecordPorts,
  type GeneratedSurfaceReviseInput,
  type GeneratedSurfaceRevisePorts,
  type GeneratedSurfaceStateInput,
  type GeneratedSurfaceStatePorts
} from "@samurai-agent/domain-operations";
import { buildGeneratedSurfaceRevision, generatedSurfaceCsp, safeGeneratedSurfaceAssetPath, type GeneratedSurfaceBundleInput } from "@samurai-agent/runtime";
import {
  WorkspaceServerError,
  canonicalJson,
  type WorkspaceFileStore,
  type WorkspaceRecord,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService
} from "@samurai-agent/workspace-server";

const surfaceRecordType = "generated_surface";
const revisionRecordType = "generated_surface_revision";
const interactionRecordType = "surface_interaction";
const operationRecordType = "domain_operation";

type GeneratedSurfaceBundle = {
  html: string;
  css?: string;
  script?: string;
  assets?: Array<{ path: string; content_base64: string; mime_type: string }>;
};

export interface GeneratedSurfaceTargetCommandResult {
  result?: JsonValue;
  resourceRefs?: string[];
}

/**
 * Standard PostgreSQL Generated Surface adapter.
 *
 * The generic Workspace record is the Room-scoped index and revision ledger;
 * HTML, CSS, JavaScript and assets remain ordinary user-owned Workspace files.
 * This keeps Surface data portable without adding a second legacy-shaped
 * database to the PostgreSQL path. Every mutation still enters through the
 * formal Generated Surface Domain Operation handler.
 */
export class PostgresGeneratedSurface {
  constructor(
    private readonly commands: WorkspaceServerCommandService,
    private readonly files: WorkspaceFileStore,
    private readonly targetCommand?: (
      context: WorkspaceRequestContext,
      input: { roomId: string; commandId: string; payload: Record<string, JsonValue>; operationId: string }
    ) => Promise<GeneratedSurfaceTargetCommandResult>
  ) {}

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, surfaceId: string): Promise<GeneratedSurfaceDefinition> {
    const row = await this.commands.getRecord(context, { roomId, recordType: surfaceRecordType, id: surfaceId });
    return normalizedGeneratedSurfaceDefinition(context.workspaceId, surfaceFromRecord(row));
  }

  async detail(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, surfaceId: string): Promise<{
    surface: GeneratedSurfaceDefinition;
    revisions: GeneratedSurfaceRevisionRecord[];
    interactions: SurfaceInteractionRecord[];
  }> {
    const surface = await this.get(context, roomId, surfaceId);
    const [revisionRows, interactionRows] = await Promise.all([
      this.commands.listRecords(context, { roomId, recordType: revisionRecordType, limit: 500 }),
      this.commands.listRecords(context, { roomId, recordType: interactionRecordType, limit: 500 })
    ]);
    const revisions = revisionRows
      .map(revisionFromRecord)
      .filter((revision) => revision.surface_id === surface.id)
      .sort((left, right) => left.revision - right.revision);
    const interactions = interactionRows
      .map(interactionFromRecord)
      .filter((interaction) => interaction.surface_id === surface.id)
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    return { surface, revisions, interactions };
  }

  async bundle(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, surfaceId: string, revisionId?: string): Promise<{
    surface: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    bundle: GeneratedSurfaceBundle;
    csp: string;
  }> {
    const surface = await this.get(context, roomId, surfaceId);
    const revision = await this.getRevision(context, roomId, revisionId ?? surface.current_revision_id);
    if (revision.surface_id !== surface.id) throw new WorkspaceServerError("generated_surface_revision_not_found", 404);
    const bundle = await this.readBundle(context, roomId, revision);
    return { surface, revision, bundle, csp: generatedSurfaceCsp };
  }

  async getRevision(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<GeneratedSurfaceRevisionRecord> {
    const row = await this.commands.getRecord(context, { roomId, recordType: revisionRecordType, id: revisionId });
    return revisionFromRecord(row);
  }

  async create(context: WorkspaceRequestContext, roomId: string, input: GeneratedSurfaceCreateInput): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; replayed: boolean }> {
    const parsedInput = generatedSurfaceCreate.input.parse(input);
    const inputHash = stableHash(parsedInput);
    const replayed = await this.operationAlreadyExists(context, roomId, inputHash, "generated_surface.create");
    const trusted = trustedContext(context, roomId);
    const ports = this.createPorts(context, roomId, inputHash);
    const result = await generatedSurfaceCreate.createHandler(ports).execute(trusted, parsedInput);
    const value = unwrap(result);
    return { ...value, replayed };
  }

  async revise(context: WorkspaceRequestContext, roomId: string, input: GeneratedSurfaceReviseInput): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; replayed: boolean }> {
    const parsedInput = generatedSurfaceRevise.input.parse(input);
    const inputHash = stableHash(parsedInput);
    const replayed = await this.operationAlreadyExists(context, roomId, inputHash, "generated_surface.revise");
    const trusted = trustedContext(context, roomId);
    const ports = this.revisePorts(context, roomId, inputHash, input.surface_id);
    const result = await generatedSurfaceRevise.createHandler(ports).execute(trusted, parsedInput);
    const value = unwrap(result);
    return { ...value, replayed };
  }

  async runAction(context: WorkspaceRequestContext, input: GeneratedSurfaceActionRunInput & { room_id: string; action_payload?: Record<string, JsonValue>; interaction_id?: string; message_id?: string; confirmed?: boolean }): Promise<Record<string, unknown>> {
    const surface = await this.get(context, input.room_id, input.surface_id);
    await this.commands.assertRoomExecutable(context, input.room_id);
    const trusted = trustedContext(context, input.room_id, surface.session_id);
    const revisionId = input.revision_id ?? surface.current_revision_id;
    const resolved = unwrap(await generatedSurfaceActionRun.createHandler({
      resolveGeneratedSurfaceAction: async (actionInput) => {
        const current = await this.get(context, input.room_id, actionInput.surfaceId);
        const revisionId = actionInput.revisionId ?? current.current_revision_id;
        if (revisionId !== current.current_revision_id) throw new WorkspaceServerError("generated_surface_revision_stale", 409);
        const action = current.actions.find((candidate) => candidate.id === actionInput.actionId);
        if (!action || !current.capability_manifest.allowed_domain_commands.includes(action.command_id)) {
          throw new WorkspaceServerError("generated_surface_action_not_declared", 403);
        }
        return { surface: current, revisionId, action };
      }
    }).execute(trusted, {
      action_id: input.action_id,
      ...(input.revision_id ? { revision_id: input.revision_id } : {}),
      surface_id: input.surface_id
    }));
    if (resolved.action.requires_confirmation && input.confirmed !== true) {
      throw new WorkspaceServerError("generated_surface_action_confirmation_required", 409);
    }
    const payload = {
      ...resolved.action.payload_template,
      ...(input.action_payload ?? {})
    } as Record<string, JsonValue>;
    const commandId = resolved.action.command_id;
    let targetResult: GeneratedSurfaceTargetCommandResult;
    try {
      if (!this.targetCommand) throw new WorkspaceServerError("generated_surface_target_command_not_connected", 503);
      targetResult = await this.targetCommand(context, {
        roomId: input.room_id,
        commandId,
        payload,
        operationId: scopedOperationId(context.operationId, "target")
      });
    } catch (error) {
      const interaction = await this.recordInteraction(context, {
        room_id: input.room_id,
        surface_id: input.surface_id,
        revision_id: revisionId,
        interaction_id: input.interaction_id ?? deterministicInteractionId(context.operationId),
        message_id: input.message_id,
        command_id: commandId,
        kind: "action",
        command_result: { ok: false, error: publicErrorCode(error) }
      }, surface.session_id);
      throw new WorkspaceServerError("generated_surface_action_failed", error instanceof WorkspaceServerError && error.status >= 500 ? 503 : 409, { interaction_id: interaction.id });
    }
    const interaction = await this.recordInteraction(context, {
      room_id: input.room_id,
      surface_id: input.surface_id,
      revision_id: revisionId,
      interaction_id: input.interaction_id ?? deterministicInteractionId(context.operationId),
      message_id: input.message_id,
      command_id: commandId,
      kind: "action",
      command_result: { ok: true, result: targetResult.result ?? null }
    }, surface.session_id);
    return { ...resolved, interaction, target_result: targetResult.result ?? null };
  }

  async recordInteraction(context: WorkspaceRequestContext, input: GeneratedSurfaceInteractionRecordInput & { room_id: string }, sessionId?: string): Promise<SurfaceInteractionRecord> {
    const surface = await this.get(context, input.room_id, input.surface_id);
    const trusted = trustedContext(context, input.room_id, sessionId ?? surface.session_id);
    const ports: GeneratedSurfaceInteractionRecordPorts = {
      getGeneratedSurface: async (id) => this.get(context, input.room_id, id),
      saveGeneratedSurfaceInteraction: async (record) => this.saveInteraction(context, input.room_id, {
        ...record,
        domain_operation_id: context.operationId
      }),
      generatedSurfaceInteractionError: (message) => new WorkspaceServerError(message, 409)
    };
    const { room_id: _roomId, ...operationInput } = input;
    const result = await generatedSurfaceInteractionRecord.createHandler(ports).execute(trusted, {
      ...operationInput,
      interaction_id: input.interaction_id ?? deterministicInteractionId(context.operationId)
    });
    return unwrap(result);
  }

  async state(context: WorkspaceRequestContext, input: GeneratedSurfaceStateInput & { room_id: string }): Promise<GeneratedSurfaceDefinition> {
    const surface = await this.get(context, input.room_id, input.surface_id);
    const trusted = trustedContext(context, input.room_id, surface.session_id);
    const ports: GeneratedSurfaceStatePorts = {
      updateGeneratedSurfaceState: async (id, state) => this.updateState(context, input.room_id, id, state),
      saveGeneratedSurfaceInteraction: async (record) => this.saveInteraction(context, input.room_id, {
        ...record,
        id: input.interaction_id ?? deterministicInteractionId(context.operationId),
        domain_operation_id: context.operationId
      }),
      generatedSurfaceStateError: (code, message) => new WorkspaceServerError(message, code === "not_found" ? 404 : 409)
    };
    const { room_id: _roomId, ...operationInput } = input;
    const result = await generatedSurfaceState.createHandler(ports).execute(trusted, {
      ...operationInput,
      interaction_id: input.interaction_id ?? deterministicInteractionId(context.operationId)
    });
    return unwrap(result);
  }

  async export(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, input: GeneratedSurfaceExportInput): Promise<{
    surface: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    bundle: { html: string; css?: string; script?: string };
    format: "html" | "zip";
    file_name: string;
  }> {
    const trusted = trustedContext({ ...context, operationId: `surface_export_${stableHash(input)}` }, roomId);
    const ports: GeneratedSurfaceExportPorts = {
      [domainQueryReadCapability]: true,
      getGeneratedSurface: readCapability(async (id) => this.get(context, roomId, id)),
      getGeneratedSurfaceRevision: readCapability(async (id) => this.getRevision(context, roomId, id)),
      readGeneratedSurfaceBundle: readCapability(async (id) => {
        const revision = await this.getRevision(context, roomId, id);
        return this.readBundle(context, roomId, revision);
      }),
      generatedSurfaceQueryError: readCapability((message) => new WorkspaceServerError(message, 404))
    };
    return unwrap(await generatedSurfaceExport.createHandler(ports).execute(trusted, input));
  }

  async readAssets(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revision: GeneratedSurfaceRevisionRecord): Promise<Array<{ path: string; content: Buffer; mime_type: string }>> {
    const assets: Array<{ path: string; content: Buffer; mime_type: string }> = [];
    for (const ref of revision.asset_refs) {
      try {
        const file = await this.files.read(context, { roomId, path: ref.uri });
        const path = safeGeneratedSurfaceAssetPath(ref.label ?? ref.uri.split("/").pop() ?? ref.uri);
        if (!path) throw new WorkspaceServerError("generated_surface_asset_path_invalid", 409);
        assets.push({ path, content: file.content, mime_type: generatedSurfaceAssetMimeType(path) });
      } catch (error) {
        if (error instanceof WorkspaceServerError && error.status === 404) continue;
        throw error;
      }
    }
    return assets;
  }

  async createExportZip(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, input: GeneratedSurfaceExportInput): Promise<{ fileName: string; content: Buffer }> {
    const exported = await this.export(context, roomId, { ...input, format: "zip" });
    const assets = await this.readAssets(context, roomId, exported.revision);
    const html = generatedSurfaceDocument(exported.bundle, exported.surface.actions);
    return {
      fileName: exported.file_name,
      content: createStoredZip([
        { name: "index.html", content: html },
        ...(exported.bundle.css === undefined ? [] : [{ name: "surface.css", content: exported.bundle.css }]),
        ...(exported.bundle.script === undefined ? [] : [{ name: "surface.js", content: exported.bundle.script }]),
        ...assets.map((asset) => ({ name: asset.path, content: asset.content }))
      ])
    };
  }

  private createPorts(context: WorkspaceRequestContext, roomId: string, inputHash: string): GeneratedSurfaceCreatePorts {
    const surfaceId = deterministicSurfaceId(context, roomId);
    return {
      createGeneratedSurfaceRequestId: () => `surface_request_${stableHash(`${context.workspaceId}|${context.operationId}`)}`,
      generatedSurfaceNow: nowIso,
      generatedSurfaceFingerprint: stableHash,
      buildGeneratedSurfaceRevision: (input) => buildGeneratedSurfaceRevision({
        ...input,
        surfaceId,
        revisionId: deterministicRevisionId(context, surfaceId)
      }),
      saveGeneratedSurfaceRevision: (input) => this.saveRevision(context, roomId, input),
      runGeneratedSurfaceMutation: (input) => this.runMutation(context, roomId, input, inputHash)
    };
  }

  private revisePorts(context: WorkspaceRequestContext, roomId: string, inputHash: string, surfaceId: string): GeneratedSurfaceRevisePorts {
    return {
      getGeneratedSurface: (id) => this.get(context, roomId, id),
      createGeneratedSurfaceRequestId: () => `surface_request_${stableHash(`${context.workspaceId}|${context.operationId}`)}`,
      generatedSurfaceNow: nowIso,
      generatedSurfaceFingerprint: stableHash,
      buildGeneratedSurfaceRevision: (input) => buildGeneratedSurfaceRevision({
        ...input,
        revisionId: deterministicRevisionId(context, surfaceId)
      }),
      saveGeneratedSurfaceRevision: (input) => this.saveRevision(context, roomId, input),
      generatedSurfaceReviseError: (message) => new WorkspaceServerError(message, message === "generated_surface_not_found" ? 404 : 409),
      runGeneratedSurfaceMutation: (input) => this.runMutation(context, roomId, input, inputHash)
    };
  }

  private async runMutation<TExtra extends Record<string, unknown>>(
    context: WorkspaceRequestContext,
    roomId: string,
    input: {
      trustedContext: import("@samurai-agent/domain-operations").TrustedDomainContext;
      inputSummary: string;
      operationName: string;
      proposedEffects: string[];
      targetResourceRefs?: ResourceRef[];
      execute(operation: OperationRecord, activity?: ActivityRecord): Promise<{ resource: GeneratedSurfaceDefinition; ref: ResourceRef; rollbackPoint?: import("@samurai-agent/core-schemas").RollbackPoint; summary: string } & TExtra>;
    },
    inputHash: string
  ): Promise<{ resource: GeneratedSurfaceDefinition; operation: OperationRecord; rollbackPoint?: import("@samurai-agent/core-schemas").RollbackPoint; activity: Array<import("@samurai-agent/core-schemas").ActivityInboxItem> } & TExtra> {
    const previous = await this.tryGetRecord(context, roomId, operationRecordType, context.operationId);
    if (previous) {
      const previousOperation = OperationRecordSchema.parse(previous.payload);
      if (previousOperation.input_hash !== inputHash || previousOperation.operation !== input.operationName) {
        throw new WorkspaceServerError("generated_surface_operation_conflict", 409);
      }
      if (previousOperation.status === "completed" && previousOperation.result_ref) {
        const surface = await this.get(context, roomId, previousOperation.result_ref.id);
        // A later revision may already exist when the original request is
        // retried after Activity persistence failed. Replaying the operation
        // must return and reconcile the exact revision produced by that
        // operation, not whichever revision happens to be current now.
        const revisionId = deterministicRevisionId(context, surface.id);
        let revision: GeneratedSurfaceRevisionRecord;
        try {
          revision = await this.getRevision(context, roomId, revisionId);
        } catch (error) {
          if (error instanceof WorkspaceServerError && error.status === 404) {
            throw new WorkspaceServerError("generated_surface_revision_recovery_required", 503, { operation_id: previousOperation.id, revision_id: revisionId });
          }
          throw error;
        }
        if (revision.domain_operation_id !== previousOperation.id || revision.surface_id !== surface.id) {
          throw new WorkspaceServerError("generated_surface_revision_operation_conflict", 409, { operation_id: previousOperation.id, revision_id: revision.id });
        }
        await this.ensureCompletionActivity(context, roomId, previousOperation, surface, revision);
        return { resource: surface, operation: previousOperation, activity: [], revision } as unknown as { resource: GeneratedSurfaceDefinition; operation: OperationRecord; activity: Array<import("@samurai-agent/core-schemas").ActivityInboxItem> } & TExtra;
      }
    }

    const now = nowIso();
    const operation = OperationRecordSchema.parse({
      id: context.operationId,
      ...(input.trustedContext.sessionId ? { session_id: input.trustedContext.sessionId } : {}),
      capability_id: input.operationName,
      operation: input.operationName,
      actor_identity: "owner",
      participant_id: context.accountId,
      participant_kind: "human",
      room_id: roomId,
      principal: { kind: "human", participant_id: context.accountId },
      source: { kind: "native_app", app_id: "samurai-workspace-client" },
      instruction_source: "owner_instruction",
      instruction_authority: "room_edit",
      channel: "workspace-server",
      input_hash: inputHash,
      ...(input.targetResourceRefs ? { target_resource_refs: input.targetResourceRefs } : { target_resource_refs: [] }),
      proposed_effects: input.proposedEffects,
      status: "created",
      correlation_id: context.operationId,
      created_at: now,
      updated_at: now
    });
    const operationRecord = previous
      ? await this.commands.putRecord(scopedContext(context, `operation-start-${previous.version}`), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: operation as unknown as Record<string, unknown>,
        searchText: `${operation.operation} ${input.inputSummary}`,
        expectedVersion: previous.version
      })
      : await this.commands.putRecord(scopedContext(context, "operation-start-0"), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: operation as unknown as Record<string, unknown>,
        searchText: `${operation.operation} ${input.inputSummary}`,
        expectedVersion: 0
      });
    const activity = ActivityRecordSchema.parse({
      id: completionActivityId(context),
      workspace_id: context.workspaceId,
      room_id: roomId,
      principal: { kind: "human", participant_id: context.accountId },
      source: { kind: "native_app", app_id: "samurai-workspace-client" },
      status: "recording",
      idempotency_key: operation.id,
      instruction_summary: input.inputSummary,
      verification: [],
      session_ref: input.trustedContext.sessionRef,
      domain_operation_ids: [operation.id],
      provenance: { kind: "domain_operation", source_id: operation.id, recorded_at: now },
      created_at: now,
      updated_at: now
    });
    let execution: { resource: GeneratedSurfaceDefinition; ref: ResourceRef; rollbackPoint?: import("@samurai-agent/core-schemas").RollbackPoint; summary: string } & TExtra;
    try {
      execution = await input.execute(operation, activity);
    } catch (error) {
      const failed = OperationRecordSchema.parse({ ...operation, status: "failed", error: publicErrorCode(error), updated_at: nowIso() });
      await this.commands.putRecord(scopedContext(context, `operation-failed-${operationRecord.record.version}`), {
        roomId, recordType: operationRecordType, id: operation.id,
        payload: failed as unknown as Record<string, unknown>, searchText: `${failed.operation} failed`, expectedVersion: operationRecord.record.version
      }).catch(() => undefined);
      throw error;
    }
    const completed = OperationRecordSchema.parse({
      ...operation,
      status: "completed",
      result_ref: ResourceRefSchema.parse(execution.ref),
      updated_at: nowIso()
    });
    await this.commands.putRecord(scopedContext(context, `operation-complete-${operationRecord.record.version}`), {
      roomId, recordType: operationRecordType, id: operation.id,
      payload: completed as unknown as Record<string, unknown>, searchText: `${completed.operation} completed`, expectedVersion: operationRecord.record.version
    });
    const executionWithRevision = execution as typeof execution & { revision?: GeneratedSurfaceRevisionRecord };
    await this.ensureCompletionActivity(context, roomId, completed, execution.resource, executionWithRevision.revision);
    const { resource, ref: _ref, summary: _summary, ...extra } = execution;
    return { resource, operation: completed, ...(execution.rollbackPoint ? { rollbackPoint: execution.rollbackPoint } : {}), activity: [], ...(extra as unknown as TExtra) };
  }

  private async saveRevision(context: WorkspaceRequestContext, roomId: string, input: {
    definition: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    html: string;
    css?: string;
    script?: string;
    assets?: GeneratedSurfaceBundleInput["assets"];
  }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }> {
    const definition = normalizedGeneratedSurfaceDefinition(context.workspaceId, input.definition);
    const revision = GeneratedSurfaceRevisionRecordSchema.parse(input.revision);
    const existingRevisionRecord = await this.tryGetRecord(context, roomId, revisionRecordType, revision.id);
    if (existingRevisionRecord) {
      const existingRevision = revisionFromRecord(existingRevisionRecord);
      if (canonicalJson(existingRevision) !== canonicalJson(revision)) throw new WorkspaceServerError("generated_surface_revision_operation_conflict", 409);
      await this.verifyBundleFiles(context, roomId, revision, input);
    } else {
      await this.writeBundleFiles(context, roomId, revision, input);
      await this.commands.putRecord(scopedContext(context, "revision-index"), {
        roomId,
        recordType: revisionRecordType,
        id: revision.id,
        payload: revision as unknown as Record<string, unknown>,
        searchText: `${definition.title} revision ${revision.revision}`,
        expectedVersion: 0
      });
    }
    const currentSurface = await this.tryGetRecord(context, roomId, surfaceRecordType, definition.id);
    if (currentSurface) {
      const current = surfaceFromRecord(currentSurface);
      if (current.current_revision_id === definition.current_revision_id) {
        if (canonicalJson(current) !== canonicalJson(definition)) throw new WorkspaceServerError("generated_surface_operation_conflict", 409);
        return { definition: current, revision };
      }
      if (definition.current_revision !== current.current_revision + 1 || revision.parent_revision_id !== current.current_revision_id) {
        throw new WorkspaceServerError("generated_surface_revision_version_conflict", 409);
      }
      const saved = await this.commands.putRecord(scopedContext(context, "surface-index"), {
        roomId, recordType: surfaceRecordType, id: definition.id,
        payload: definition as unknown as Record<string, unknown>, searchText: `${definition.title} ${definition.content_hash}`,
        expectedVersion: currentSurface.version
      });
      return { definition: surfaceFromRecord(saved.record), revision };
    }
    const saved = await this.commands.putRecord(scopedContext(context, "surface-index"), {
      roomId, recordType: surfaceRecordType, id: definition.id,
      payload: definition as unknown as Record<string, unknown>, searchText: `${definition.title} ${definition.content_hash}`,
      expectedVersion: 0
    });
    return { definition: surfaceFromRecord(saved.record), revision };
  }

  private async writeBundleFiles(context: WorkspaceRequestContext, roomId: string, revision: GeneratedSurfaceRevisionRecord, input: { html: string; css?: string; script?: string; assets?: GeneratedSurfaceBundleInput["assets"] }): Promise<void> {
    await this.writeFileIfNeeded(context, roomId, revision.html_ref.uri, Buffer.from(input.html, "utf8"), "html");
    if (revision.css_ref) await this.writeFileIfNeeded(context, roomId, revision.css_ref.uri, Buffer.from(input.css ?? "", "utf8"), "css");
    if (revision.script_ref) await this.writeFileIfNeeded(context, roomId, revision.script_ref.uri, Buffer.from(input.script ?? "", "utf8"), "script");
    for (const asset of input.assets ?? []) {
      const ref = revision.asset_refs.find((candidate) => candidate.label === asset.path);
      if (!ref) throw new WorkspaceServerError("generated_surface_asset_ref_missing", 409);
      await this.writeFileIfNeeded(context, roomId, ref.uri, asset.encoding === "base64" ? Buffer.from(asset.content, "base64") : Buffer.from(asset.content, "utf8"), `asset-${stableHash(asset.path)}`);
    }
  }

  private async verifyBundleFiles(context: WorkspaceRequestContext, roomId: string, revision: GeneratedSurfaceRevisionRecord, input: { html: string; css?: string; script?: string; assets?: GeneratedSurfaceBundleInput["assets"] }): Promise<void> {
    const verify = async (path: string, expected: Buffer) => {
      const actual = await this.files.read(context, { roomId, path });
      if (!actual.content.equals(expected)) throw new WorkspaceServerError("generated_surface_file_conflict", 409, { path });
    };
    await verify(revision.html_ref.uri, Buffer.from(input.html, "utf8"));
    if (revision.css_ref) await verify(revision.css_ref.uri, Buffer.from(input.css ?? "", "utf8"));
    if (revision.script_ref) await verify(revision.script_ref.uri, Buffer.from(input.script ?? "", "utf8"));
    for (const asset of input.assets ?? []) {
      const ref = revision.asset_refs.find((candidate) => candidate.label === asset.path);
      if (!ref) throw new WorkspaceServerError("generated_surface_asset_ref_missing", 409);
      await verify(ref.uri, asset.encoding === "base64" ? Buffer.from(asset.content, "base64") : Buffer.from(asset.content, "utf8"));
    }
  }

  private async writeFileIfNeeded(context: WorkspaceRequestContext, roomId: string, filePath: string, content: Buffer, suffix: string): Promise<void> {
    try {
      const existing = await this.files.read(context, { roomId, path: filePath });
      if (!existing.content.equals(content)) throw new WorkspaceServerError("generated_surface_file_conflict", 409, { path: filePath });
      return;
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    await this.files.write(scopedContext(context, `file-${suffix}`), { roomId, path: filePath, content, expectedVersion: 0 });
  }

  private async readBundle(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revision: GeneratedSurfaceRevisionRecord): Promise<GeneratedSurfaceBundle> {
    const html = await this.files.read(context, { roomId, path: revision.html_ref.uri });
    const css = revision.css_ref ? await this.files.read(context, { roomId, path: revision.css_ref.uri }) : undefined;
    const script = revision.script_ref ? await this.files.read(context, { roomId, path: revision.script_ref.uri }) : undefined;
    const assets = await this.readAssets(context, roomId, revision);
    return {
      html: html.content.toString("utf8"),
      ...(css ? { css: css.content.toString("utf8") } : {}),
      ...(script ? { script: script.content.toString("utf8") } : {}),
      ...(assets.length > 0 ? { assets: assets.map((asset) => ({ path: asset.path, content_base64: asset.content.toString("base64"), mime_type: asset.mime_type })) } : {})
    };
  }

  private async updateState(context: WorkspaceRequestContext, roomId: string, surfaceId: string, state: GeneratedSurfaceDefinition["state"]): Promise<GeneratedSurfaceDefinition | undefined> {
    const currentRecord = await this.tryGetRecord(context, roomId, surfaceRecordType, surfaceId);
    if (!currentRecord) return undefined;
    const current = surfaceFromRecord(currentRecord);
    const next = GeneratedSurfaceDefinitionSchema.parse({ ...current, state, updated_at: nowIso() });
    const saved = await this.commands.putRecord(scopedContext(context, "state-index"), {
      roomId, recordType: surfaceRecordType, id: surfaceId,
      payload: next as unknown as Record<string, unknown>, searchText: `${next.title} ${next.content_hash}`,
      expectedVersion: currentRecord.version
    });
    return surfaceFromRecord(saved.record);
  }

  private async saveInteraction(context: WorkspaceRequestContext, roomId: string, record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord> {
    const parsed = SurfaceInteractionRecordSchema.parse(record);
    const existing = await this.tryGetRecord(context, roomId, interactionRecordType, parsed.id);
    if (existing) {
      const current = interactionFromRecord(existing);
      if (canonicalJson(current) !== canonicalJson(parsed)) throw new WorkspaceServerError("generated_surface_interaction_conflict", 409);
      return current;
    }
    const saved = await this.commands.putRecord(scopedContext(context, "interaction-index"), {
      roomId, recordType: interactionRecordType, id: parsed.id,
      payload: parsed as unknown as Record<string, unknown>, searchText: `${parsed.kind} ${parsed.surface_id}`,
      expectedVersion: 0
    });
    return interactionFromRecord(saved.record);
  }

  private async operationAlreadyExists(context: WorkspaceRequestContext, roomId: string, inputHash: string, operationName: string): Promise<boolean> {
    const record = await this.tryGetRecord(context, roomId, operationRecordType, context.operationId);
    if (!record) return false;
    const operation = OperationRecordSchema.parse(record.payload);
    if (operation.input_hash !== inputHash || operation.operation !== operationName) {
      throw new WorkspaceServerError("generated_surface_operation_conflict", 409);
    }
    return true;
  }

  private async tryGetRecord(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, recordType: string, id: string): Promise<WorkspaceRecord | undefined> {
    try {
      return await this.commands.getRecord(context, { roomId, recordType, id });
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async ensureCompletionActivity(context: WorkspaceRequestContext, roomId: string, operation: OperationRecord, surface: GeneratedSurfaceDefinition, revision?: GeneratedSurfaceRevisionRecord): Promise<void> {
    if (!revision) return;
    try {
      await this.commands.ingestCompletionActivity(scopedContext(context, "activity"), {
        id: completionActivityId(context),
        roomId,
        sourceApp: "samurai-workspace-client",
        sourceId: operation.operation,
        operationId: operation.id,
        instructionSummary: `Generated Surface: ${surface.title}`,
        resultSummary: `Generated Surface revision ${revision.revision} persisted.`,
        changedResources: [surface.id, revision.id, revision.html_ref.uri, ...revision.asset_refs.map((ref) => ref.uri)],
        verificationOutcome: "confirmed",
        failureState: "none",
        outcome: "completed",
        payload: { domain_operation_id: operation.id, surface_id: surface.id, revision_id: revision.id }
      });
    } catch (error) {
      throw new WorkspaceServerError("generated_surface_activity_recovery_required", 503, { operation_id: operation.id, cause: publicErrorCode(error) });
    }
  }
}

function trustedContext(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId" | "operationId">, roomId: string, sessionId?: string): import("@samurai-agent/domain-operations").TrustedDomainContext {
  return {
    inputSource: "runtime_api",
    workspaceId: context.workspaceId,
    actorId: context.accountId,
    participant: { kind: "human", participantId: context.accountId },
    roomId,
    ...(sessionId ? { sessionId } : {}),
    source: { kind: "native_app", app_id: "samurai-workspace-client" },
    correlationId: context.operationId,
    idempotencyKey: context.operationId
  };
}

function scopedContext(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  return { ...context, operationId: scopedOperationId(context.operationId, suffix) };
}

function scopedOperationId(operationId: string, suffix: string): string {
  return `surface_${stableHash(`${operationId}|${suffix}`)}`;
}

function deterministicSurfaceId(context: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">, roomId: string): string {
  return `surface_${stableHash(`${context.workspaceId}|${roomId}|${context.operationId}`)}`;
}

function deterministicRevisionId(context: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">, surfaceId: string): string {
  return `surface_revision_${stableHash(`${context.workspaceId}|${context.operationId}|${surfaceId}`)}`;
}

function deterministicInteractionId(operationId: string): string {
  return `surface_interaction_${stableHash(operationId)}`;
}

function completionActivityId(context: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">): string {
  return `completion_activity_${stableHash(`${context.workspaceId}|generated_surface|${context.operationId}`)}`;
}

function surfaceFromRecord(record: WorkspaceRecord): GeneratedSurfaceDefinition {
  return GeneratedSurfaceDefinitionSchema.parse(record.payload);
}

function normalizedGeneratedSurfaceDefinition(workspaceId: string, definition: GeneratedSurfaceDefinition): GeneratedSurfaceDefinition {
  return GeneratedSurfaceDefinitionSchema.parse({
    ...definition,
    preview_url: `/api/workspaces/${encodeURIComponent(workspaceId)}/generated-surfaces/${encodeURIComponent(definition.id)}/revisions/${encodeURIComponent(definition.current_revision_id)}/preview`
  });
}

function revisionFromRecord(record: WorkspaceRecord): GeneratedSurfaceRevisionRecord {
  return GeneratedSurfaceRevisionRecordSchema.parse(record.payload);
}

function interactionFromRecord(record: WorkspaceRecord): SurfaceInteractionRecord {
  return SurfaceInteractionRecordSchema.parse(record.payload);
}

function unwrap<T>(result: { ok: true; value: T }): T {
  return result.value;
}

function readCapability<Args extends unknown[], Result>(
  fn: (...args: Args) => Result
): ((...args: Args) => Result) & { readonly [domainQueryReadCapability]: true } {
  return Object.assign(fn, { [domainQueryReadCapability]: true as const });
}

function publicErrorCode(error: unknown): string {
  if (error instanceof WorkspaceServerError) return error.code;
  if (error instanceof Error) return error.message.slice(0, 256);
  return "generated_surface_operation_failed";
}

function generatedSurfaceDocument(bundle: { html: string; css?: string; script?: string }, actions: Array<{ id: string }>, assets: Array<{ path: string; content_base64: string; mime_type: string }> = []): string {
  const bridge = JSON.stringify({ actions: actions.map((action) => action.id) }).replace(/</g, "\\u003c");
  const html = inlineGeneratedSurfaceAssets(bundle.html, assets);
  const css = (bundle.css ?? "").replace(/<\/style/gi, "<\\/style");
  const script = (bundle.script ?? "").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${generatedSurfaceCsp}"><style>${css}</style></head><body>${html}<script>${script}</script><script>window.samuraiGeneratedSurface=${bridge};window.dispatchSamuraiAction=function(actionId,payload){window.parent.postMessage({type:"samurai.generated_surface.action",action_id:actionId,payload:payload||{}},"*")};</script></body></html>`;
}

function inlineGeneratedSurfaceAssets(source: string, assets: Array<{ path: string; content_base64: string; mime_type: string }>): string {
  const dataByPath = new Map<string, string>();
  for (const asset of assets) {
    const path = safeGeneratedSurfaceAssetPath(asset.path);
    if (!path) continue;
    const dataUrl = `data:${asset.mime_type};base64,${asset.content_base64}`;
    dataByPath.set(path, dataUrl);
    dataByPath.set(`assets/${path}`, dataUrl);
  }
  const replaceReference = (reference: string): string => {
    const normalized = reference.trim().replace(/^\.\//, "");
    return dataByPath.get(normalized) ?? reference;
  };
  return source
    .replace(/((?:src|href)\s*=\s*["'])([^"']+)(["'])/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`)
    .replace(/(url\(\s*["']?)([^"')]+)(["']?\s*\))/gi, (_match, prefix: string, reference: string, suffix: string) => `${prefix}${replaceReference(reference)}${suffix}`);
}

function generatedSurfaceAssetMimeType(assetPath: string): string {
  const extension = assetPath.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp"
  };
  return (extension && mimeTypes[extension]) ?? "application/octet-stream";
}

function createStoredZip(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30 + name.length + content.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26); name.copy(local, 30); content.copy(local, 30 + name.length);
    localParts.push(local);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centralParts.push(central); offset += local.length;
  }
  const localData = Buffer.concat(localParts); const centralData = Buffer.concat(centralParts); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(localData.length, 16);
  return Buffer.concat([localData, centralData, end]);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
