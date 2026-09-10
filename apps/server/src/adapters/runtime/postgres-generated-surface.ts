import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ActivityRecordSchema,
  GeneratedSurfaceActionDeclarationSchema,
  GeneratedSurfaceDefinitionSchema,
  type GeneratedSurfaceActionDeclaration,
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
  type SurfaceInteractionRecord,
  jsonValueSchema
} from "@samurai-agent/core-schemas";
import {
  domainQueryReadCapability,
  parseDomainOperationInput,
  generatedSurfaceActionRun,
  generatedSurfaceCreate,
  generatedSurfaceExport,
  generatedSurfaceInteractionRecord,
  generatedSurfaceRevise,
  generatedSurfaceState,
  type DomainCommandId,
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
  type WorkspaceServerCommandService,
  type WorkspaceServerStore
} from "@samurai-agent/workspace-server";

const surfaceRecordType = "generated_surface";
const revisionRecordType = "generated_surface_revision";
const interactionRecordType = "surface_interaction";
const operationRecordType = "domain_operation";
/**
 * Completed operation responses are immutable snapshots. Replays must not
 * read the current Surface row after a later state or revision change.
 */
const operationResultRecordType = "generated_surface_operation_result";
const actionResultRecordType = "generated_surface_action_result";

type GeneratedSurfaceBundle = {
  html: string;
  css?: string;
  script?: string;
  assets: Array<{ path: string; content_base64: string; mime_type: string }>;
};

type GeneratedSurfaceAssetInput = NonNullable<GeneratedSurfaceBundleInput["assets"]>[number];
type GeneratedSurfaceBundleFilesInput = {
  html: string;
  css?: string;
  script?: string;
  assets?: GeneratedSurfaceBundleInput["assets"];
};

/** Runtime tool ingress may add a persisted Run identity. It is never read
 * from HTTP JSON and becomes immutable provenance on the saved revision. */
type GeneratedSurfaceMutationContext = WorkspaceRequestContext & { runtimeRunId?: string; runtimeWorkId?: string };

type GeneratedSurfaceOperationResultSnapshot = {
  operation_id: string;
  operation: string;
  input_hash: string;
  room_id: string;
  resource: GeneratedSurfaceDefinition;
  revision?: GeneratedSurfaceRevisionRecord;
};

const generatedSurfaceActionResultSchema = z.object({
  surface: GeneratedSurfaceDefinitionSchema,
  action: GeneratedSurfaceActionDeclarationSchema,
  command: z.object({
    result: z.object({
      command_id: z.string().min(1),
      payload_template: z.record(jsonValueSchema).optional()
    }).strict()
  }).strict(),
  interaction: SurfaceInteractionRecordSchema,
  target_result: jsonValueSchema
}).strict();

type GeneratedSurfaceActionResult = z.infer<typeof generatedSurfaceActionResultSchema>;

type GeneratedSurfaceActionResultSnapshot = {
  operation_id: string;
  operation: string;
  input_hash: string;
  room_id: string;
  result: GeneratedSurfaceActionResult;
};

type GeneratedSurfaceRoomAuthorization = Pick<WorkspaceServerStore, "assertRoomWritable">;

/** The Room Work source is derived from the admitted Runtime binding, never
 * from provider-generated Surface input. */
export function generatedSurfaceRoomWorkSourceRef(workId: string): ResourceRef {
  return ResourceRefSchema.parse({
    kind: "room_work",
    id: workId,
    uri: `samurai://room_work/${workId}`,
    label: workId
  });
}

export function applyRuntimeRoomWorkSourceRefs<T extends {
  definition: GeneratedSurfaceDefinition;
  revision: GeneratedSurfaceRevisionRecord;
}>(value: T, workId?: string): T {
  if (!workId) return value;
  const sourceRef = generatedSurfaceRoomWorkSourceRef(workId);
  return {
    ...value,
    definition: {
      ...value.definition,
      source_refs: [...value.definition.source_refs.filter((ref) => ref.kind !== "room_work"), sourceRef]
    },
    revision: {
      ...value.revision,
      source_resource_refs: [...value.revision.source_resource_refs.filter((ref) => ref.kind !== "room_work"), sourceRef]
    }
  } as T;
}

export interface GeneratedSurfaceTargetCommandResult {
  result?: JsonValue;
  resourceRefs?: string[];
}

/**
 * Immutable Server-owned target for a Generated Surface action.
 *
 * This is persisted inside an Interaction Request before a confirmation is
 * shown.  A renderer may initiate an action, but it never decides the command
 * ID, target revision, or final payload used when the request is later
 * executed.
 */
export interface GeneratedSurfaceActionTarget {
  kind: "generated_surface_action";
  room_id: string;
  surface_id: string;
  revision_id: string;
  action_id: string;
  command_id: string;
  payload: Record<string, JsonValue>;
  interaction_id?: string;
  message_id?: string;
}

export type GeneratedSurfaceActionRequest = GeneratedSurfaceActionRunInput & {
  room_id: string;
  action_payload?: Record<string, JsonValue>;
  interaction_id?: string;
  message_id?: string;
};

export interface PreparedGeneratedSurfaceAction {
  surface: GeneratedSurfaceDefinition;
  revisionId: string;
  action: GeneratedSurfaceActionDeclaration;
  target: GeneratedSurfaceActionTarget;
  /**
   * The command-schema-normalized payload used only at the side-effect
   * boundary.  It is intentionally separate from `target.payload`: the
   * durable approval target must preserve the exact values the renderer
   * submitted, while a Domain schema may add defaults such as `metadata: {}`.
   */
  executionPayload: Record<string, JsonValue>;
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
    ) => Promise<GeneratedSurfaceTargetCommandResult>,
    private readonly roomAuthorization?: GeneratedSurfaceRoomAuthorization
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

  async create(context: GeneratedSurfaceMutationContext, roomId: string, input: GeneratedSurfaceCreateInput): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; replayed: boolean }> {
    const parsedInput = generatedSurfaceCreate.input.parse(input);
    const inputHash = stableHash(parsedInput);
    const replayed = await this.operationAlreadyExists(context, roomId, inputHash, "generated_surface.create");
    const trusted = trustedContext(context, roomId);
    const ports = this.createPorts(context, roomId, inputHash);
    const result = await generatedSurfaceCreate.createHandler(ports).execute(trusted, parsedInput);
    const value = unwrap(result);
    return { ...value, replayed };
  }

  async revise(context: GeneratedSurfaceMutationContext, roomId: string, input: GeneratedSurfaceReviseInput): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; replayed: boolean }> {
    const parsedInput = generatedSurfaceRevise.input.parse(input);
    const inputHash = stableHash(parsedInput);
    const replayed = await this.operationAlreadyExists(context, roomId, inputHash, "generated_surface.revise");
    const trusted = trustedContext(context, roomId);
    const ports = this.revisePorts(context, roomId, inputHash, input.surface_id);
    const result = await generatedSurfaceRevise.createHandler(ports).execute(trusted, parsedInput);
    const value = unwrap(result);
    return { ...value, replayed };
  }

  /**
   * Resolves and validates the exact action target before it is executed or
   * persisted for a confirmation.  The declared command and current Surface
   * revision remain the source of truth; client JSON can only provide values
   * permitted by that already-declared command.
   */
  async prepareAction(context: WorkspaceRequestContext, input: GeneratedSurfaceActionRequest): Promise<PreparedGeneratedSurfaceAction> {
    const surface = await this.get(context, input.room_id, input.surface_id);
    await this.commands.assertRoomExecutable(context, input.room_id);
    const trusted = trustedContext(context, input.room_id, surface.session_id);
    let resolvedRevisionId: string | undefined;
    const resolved = unwrap(await generatedSurfaceActionRun.createHandler({
      resolveGeneratedSurfaceAction: async (actionInput) => {
        const current = await this.get(context, input.room_id, actionInput.surfaceId);
        const revisionId = actionInput.revisionId ?? current.current_revision_id;
        if (revisionId !== current.current_revision_id) throw new WorkspaceServerError("generated_surface_revision_stale", 409);
        const action = current.actions.find((candidate) => candidate.id === actionInput.actionId);
        if (!action || !current.capability_manifest.allowed_domain_commands.includes(action.command_id)) {
          throw new WorkspaceServerError("generated_surface_action_not_declared", 403);
        }
        resolvedRevisionId = revisionId;
        return { surface: current, revisionId, action };
      }
    }).execute(trusted, {
      action_id: input.action_id,
      ...(input.revision_id ? { revision_id: input.revision_id } : {}),
      surface_id: input.surface_id
    }));
    if (!resolvedRevisionId) throw new WorkspaceServerError("generated_surface_action_resolution_invalid", 500);
    const payload = resolvedGeneratedSurfaceActionPayload(resolved.action, input.action_payload);
    return {
      surface: resolved.surface,
      revisionId: resolvedRevisionId,
      action: resolved.action,
      target: {
        kind: "generated_surface_action",
        room_id: input.room_id,
        surface_id: resolved.surface.id,
        revision_id: resolvedRevisionId,
        action_id: resolved.action.id,
        command_id: resolved.action.command_id,
        payload: payload.targetPayload,
        ...(input.interaction_id ? { interaction_id: input.interaction_id } : {}),
        ...(input.message_id ? { message_id: input.message_id } : {})
      },
      executionPayload: payload.executionPayload
    };
  }

  /** Executes a previously prepared current action without a confirmation. */
  async runAction(context: WorkspaceRequestContext, input: GeneratedSurfaceActionRequest): Promise<Record<string, unknown>> {
    const executed = await this.runActionWithReplay(context, input);
    return executed.result as unknown as Record<string, unknown>;
  }

  /**
   * Runs a non-confirmation action through the same durable operation ledger
   * used by Surface creation/state changes. The target command is never
   * retried after an operation has become indeterminate; a completed result
   * is replayed from the immutable snapshot instead of resolving the current
   * Surface again.
   */
  async runActionWithReplay(
    context: WorkspaceRequestContext,
    input: GeneratedSurfaceActionRequest
  ): Promise<{ result: GeneratedSurfaceActionResult; replayed: boolean }> {
    const roomId = input.room_id;
    const inputHash = generatedSurfaceActionInputHash(input);
    const previous = await this.tryGetRecord(context, roomId, operationRecordType, context.operationId);
    if (previous) {
      const previousOperation = actionOperationFromRecord(previous, roomId, inputHash);
      await this.commands.assertRoomExecutable(context, roomId);
      const previousResult = await this.readActionResultSnapshot(context, roomId, previousOperation.id);
      if (previousOperation.status === "completed") {
        if (!previousResult || previousResult.operation !== previousOperation.operation || previousResult.input_hash !== previousOperation.input_hash) {
          throw new WorkspaceServerError("generated_surface_action_recovery_required", 503, { operation_id: previousOperation.id });
        }
        return { result: previousResult.result, replayed: true };
      }
      if (previousOperation.status === "failed") {
        throw new WorkspaceServerError("generated_surface_action_failed", 409, {
          operation_id: previousOperation.id,
          error_code: previousOperation.error ?? "generated_surface_action_failed"
        });
      }
      if (previousResult) {
        await this.completeActionOperation(context, roomId, previous, previousOperation, previousResult);
        return { result: previousResult.result, replayed: true };
      }
      throw new WorkspaceServerError("generated_surface_action_recovery_required", 503, { operation_id: previousOperation.id });
    }

    const prepared = await this.prepareAction(context, input);
    if (prepared.action.requires_confirmation) {
      throw new WorkspaceServerError("generated_surface_action_confirmation_required", 409);
    }
    const operation = createActionOperation(context, roomId, inputHash, prepared);
    let operationRecord: WorkspaceRecord;
    try {
      const saved = await this.commands.putRecord(scopedContext(context, "action-operation-start"), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: operation as unknown as Record<string, unknown>,
        searchText: `${operation.operation} ${prepared.action.label}`,
        expectedVersion: 0
      });
      operationRecord = saved.record;
    } catch (error) {
      const raced = await this.tryGetRecord(context, roomId, operationRecordType, context.operationId);
      if (!raced) throw error;
      const racedOperation = actionOperationFromRecord(raced, roomId, inputHash);
      await this.commands.assertRoomExecutable(context, roomId);
      const racedResult = await this.readActionResultSnapshot(context, roomId, racedOperation.id);
      if (racedOperation.status === "completed" && racedResult) return { result: racedResult.result, replayed: true };
      throw new WorkspaceServerError("generated_surface_action_recovery_required", 503, { operation_id: racedOperation.id });
    }

    let result: GeneratedSurfaceActionResult;
    try {
      result = await this.executeResolvedAction(context, prepared);
    } catch (error) {
      const failed = OperationRecordSchema.parse({
        ...operation,
        status: "failed",
        error: publicErrorCode(error),
        updated_at: nowIso()
      });
      await this.commands.putRecord(scopedContext(context, "action-operation-failed"), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: failed as unknown as Record<string, unknown>,
        searchText: `${failed.operation} failed`,
        expectedVersion: operationRecord.version
      }).catch(() => undefined);
      throw error;
    }

    const snapshot: GeneratedSurfaceActionResultSnapshot = {
      operation_id: operation.id,
      operation: operation.operation,
      input_hash: operation.input_hash,
      room_id: roomId,
      result
    };
    await this.saveActionResultSnapshot(context, roomId, snapshot);
    await this.completeActionOperation(context, roomId, operationRecord, operation, snapshot);
    return { result, replayed: false };
  }

  /**
   * Revalidates a durable approval target immediately before side effects.
   * A Surface revision/action/command/payload mismatch is never silently
   * redirected to the latest Surface.
   */
  async executeActionTarget(context: WorkspaceRequestContext, target: GeneratedSurfaceActionTarget): Promise<Record<string, unknown>> {
    const parsedTarget = parseGeneratedSurfaceActionTarget(target);
    const prepared = await this.prepareAction(context, {
      room_id: parsedTarget.room_id,
      surface_id: parsedTarget.surface_id,
      revision_id: parsedTarget.revision_id,
      action_id: parsedTarget.action_id,
      action_payload: parsedTarget.payload,
      ...(parsedTarget.interaction_id ? { interaction_id: parsedTarget.interaction_id } : {}),
      ...(parsedTarget.message_id ? { message_id: parsedTarget.message_id } : {})
    });
    if (canonicalJson(prepared.target) !== canonicalJson(parsedTarget)) {
      throw new WorkspaceServerError("generated_surface_action_target_stale", 409);
    }
    return this.executeResolvedAction(context, prepared);
  }

  /**
   * Reads the durable result of an already-claimed action. This is used only
   * while reconciling an accepted approval; it never trusts the response
   * body, renderer values, or a client-supplied confirmation flag.
   */
  async getActionTargetResult(
    context: WorkspaceRequestContext,
    target: GeneratedSurfaceActionTarget,
    executionOperationId: string
  ): Promise<JsonValue | undefined> {
    const parsedTarget = parseGeneratedSurfaceActionTarget(target);
    const interactionId = parsedTarget.interaction_id ?? deterministicInteractionId(executionOperationId);
    const record = await this.tryGetRecord(context, parsedTarget.room_id, interactionRecordType, interactionId);
    if (!record) return undefined;
    const interaction = interactionFromRecord(record);
    if (interaction.domain_operation_id !== executionOperationId
      || interaction.kind !== "action"
      || interaction.surface_id !== parsedTarget.surface_id
      || interaction.revision_id !== parsedTarget.revision_id
      || interaction.command_id !== parsedTarget.command_id
      || (parsedTarget.message_id !== undefined && interaction.message_id !== parsedTarget.message_id)) {
      throw new WorkspaceServerError("generated_surface_interaction_conflict", 409, { interaction_id: interactionId });
    }
    if (!isGeneratedSurfaceActionJsonObject(interaction.command_result)
      || interaction.command_result.ok !== true
      || !Object.hasOwn(interaction.command_result, "result")
      || !isGeneratedSurfaceActionJsonValue(interaction.command_result.result)) {
      throw new WorkspaceServerError("generated_surface_action_result_unavailable", 503, { interaction_id: interactionId });
    }
    return interaction.command_result.result;
  }

  private async executeResolvedAction(context: WorkspaceRequestContext, prepared: PreparedGeneratedSurfaceAction): Promise<GeneratedSurfaceActionResult> {
    const { surface, revisionId, action, target, executionPayload } = prepared;
    // The check in prepareAction protects target construction. Recheck at the
    // side-effect boundary to handle a revoked permission between approval and
    // execution.
    await this.commands.assertRoomExecutable(context, target.room_id);
    let targetResult: GeneratedSurfaceTargetCommandResult;
    try {
      if (!this.targetCommand) throw new WorkspaceServerError("generated_surface_target_command_not_connected", 503);
      // A renderer operation ID may be a UUID, while downstream Domain and
      // Completion operations require an opaque, namespaced identifier. Keep
      // the user action's correlation ID on the interaction itself, but give
      // every target side effect one deterministic, retry-safe operation ID.
      const targetContext = scopedContext(context, "target");
      targetResult = await this.targetCommand(targetContext, {
        roomId: target.room_id,
        commandId: target.command_id,
        payload: executionPayload,
        operationId: targetContext.operationId
      });
    } catch (error) {
      const interaction = await this.recordInteraction(context, {
        room_id: target.room_id,
        surface_id: target.surface_id,
        revision_id: revisionId,
        interaction_id: target.interaction_id ?? deterministicInteractionId(context.operationId),
        ...(target.message_id ? { message_id: target.message_id } : {}),
        command_id: target.command_id,
        kind: "action",
        command_result: { ok: false, error: publicErrorCode(error) }
      }, surface.session_id);
      throw new WorkspaceServerError("generated_surface_action_failed", error instanceof WorkspaceServerError && error.status >= 500 ? 503 : 409, { interaction_id: interaction.id });
    }
    const interaction = await this.recordInteraction(context, {
      room_id: target.room_id,
      surface_id: target.surface_id,
      revision_id: revisionId,
      interaction_id: target.interaction_id ?? deterministicInteractionId(context.operationId),
      ...(target.message_id ? { message_id: target.message_id } : {}),
      command_id: target.command_id,
      kind: "action",
      command_result: { ok: true, result: targetResult.result ?? null }
    }, surface.session_id);
    return {
      surface,
      action,
      command: {
        result: {
          command_id: action.command_id,
          ...(action.payload_template === undefined ? {} : { payload_template: action.payload_template })
        }
      },
      interaction,
      target_result: targetResult.result ?? null
    };
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

  async stateWithReplay(context: GeneratedSurfaceMutationContext, input: GeneratedSurfaceStateInput & { room_id: string }): Promise<{
    surface: GeneratedSurfaceDefinition;
    replayed: boolean;
  }> {
    const { room_id: roomId, ...operationInput } = input;
    const parsedInput = generatedSurfaceState.input.parse({
      ...operationInput,
      interaction_id: operationInput.interaction_id ?? deterministicInteractionId(context.operationId)
    });
    const inputHash = stableHash({ room_id: roomId, ...parsedInput });
    await this.assertStateMutationAuthorization(context, roomId);
    return this.runStateMutation(context, roomId, parsedInput, inputHash);
  }

  /** Compatibility response shape for the older Surface REST route. */
  async state(context: GeneratedSurfaceMutationContext, input: GeneratedSurfaceStateInput & { room_id: string }): Promise<GeneratedSurfaceDefinition> {
    return (await this.stateWithReplay(context, input)).surface;
  }

  async export(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, input: GeneratedSurfaceExportInput): Promise<{
    surface: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    bundle: { html: string; css?: string; script?: string; assets: Array<{ path: string; content_base64: string; mime_type: string }> };
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
    const exported = unwrap(await generatedSurfaceExport.createHandler(ports).execute(trusted, input));
    if (!Array.isArray(exported.bundle.assets)) {
      throw new WorkspaceServerError("generated_surface_asset_list_missing", 503, { revision_id: exported.revision.id });
    }
    return { ...exported, bundle: { ...exported.bundle, assets: exported.bundle.assets } };
  }

  async readAssets(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revision: GeneratedSurfaceRevisionRecord): Promise<Array<{ path: string; content: Buffer; mime_type: string }>> {
    const assets: Array<{ path: string; content: Buffer; mime_type: string }> = [];
    for (const ref of revision.asset_refs) {
      const assetPath = generatedSurfaceAssetRefPath(revision, ref);
      try {
        const file = await this.files.read(context, { roomId, path: ref.uri });
        const mimeType = generatedSurfaceAssetMimeType(assetPath);
        if (!isGeneratedSurfaceAssetMimeType(mimeType)) throw new WorkspaceServerError("generated_surface_asset_mime_type_invalid", 409);
        if (!ref.content_hash) {
          throw new WorkspaceServerError("generated_surface_asset_integrity_missing", 409, { revision_id: revision.id, path: assetPath });
        }
        if (file.file.sha256 !== ref.content_hash) {
          throw new WorkspaceServerError("generated_surface_asset_modified", 409, {
            revision_id: revision.id,
            path: assetPath,
            expected_hash: ref.content_hash,
            actual_hash: file.file.sha256
          });
        }
        assets.push({ path: assetPath, content: file.content, mime_type: mimeType });
      } catch (error) {
        if (error instanceof WorkspaceServerError && error.status === 404) {
          throw new WorkspaceServerError("generated_surface_asset_missing", 409, { revision_id: revision.id, path: assetPath });
        }
        throw error;
      }
    }
    return assets;
  }

  async createExportZip(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, input: GeneratedSurfaceExportInput): Promise<{ fileName: string; content: Buffer }> {
    const exported = await this.export(context, roomId, { ...input, format: "zip" });
    const assets = await this.readAssets(context, roomId, exported.revision);
    const assetPayload = assets.map((asset) => ({ path: asset.path, content_base64: asset.content.toString("base64"), mime_type: asset.mime_type }));
    const html = generatedSurfaceDocument(exported.bundle, exported.surface.actions, assetPayload);
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

  private createPorts(context: GeneratedSurfaceMutationContext, roomId: string, inputHash: string): GeneratedSurfaceCreatePorts {
    const surfaceId = deterministicSurfaceId(context, roomId);
    return {
      createGeneratedSurfaceRequestId: () => `surface_request_${stableHash(`${context.workspaceId}|${context.operationId}`)}`,
      generatedSurfaceNow: nowIso,
      generatedSurfaceFingerprint: stableHash,
      buildGeneratedSurfaceRevision: (input) => applyRuntimeRoomWorkSourceRefs(buildGeneratedSurfaceRevision({
        ...input,
        surfaceId,
        revisionId: deterministicRevisionId(context, surfaceId)
      }), context.runtimeWorkId),
      saveGeneratedSurfaceRevision: (input) => this.saveRevision(context, roomId, input),
      runGeneratedSurfaceMutation: (input) => this.runMutation(context, roomId, input, inputHash)
    };
  }

  private revisePorts(context: GeneratedSurfaceMutationContext, roomId: string, inputHash: string, surfaceId: string): GeneratedSurfaceRevisePorts {
    return {
      getGeneratedSurface: (id) => this.get(context, roomId, id),
      createGeneratedSurfaceRequestId: () => `surface_request_${stableHash(`${context.workspaceId}|${context.operationId}`)}`,
      generatedSurfaceNow: nowIso,
      generatedSurfaceFingerprint: stableHash,
      buildGeneratedSurfaceRevision: (input) => applyRuntimeRoomWorkSourceRefs(buildGeneratedSurfaceRevision({
        ...input,
        revisionId: deterministicRevisionId(context, surfaceId)
      }), context.runtimeWorkId),
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
        const snapshot = await this.readOperationResultSnapshot(context, roomId, previousOperation.id);
        if (!snapshot || snapshot.operation !== previousOperation.operation || snapshot.input_hash !== previousOperation.input_hash || snapshot.room_id !== roomId) {
          throw new WorkspaceServerError("generated_surface_revision_recovery_required", 503, { operation_id: previousOperation.id });
        }
        if (snapshot.resource.id !== previousOperation.result_ref.id
          || !snapshot.revision
          || snapshot.revision.surface_id !== snapshot.resource.id
          || snapshot.resource.current_revision_id !== snapshot.revision.id
          || snapshot.revision.domain_operation_id !== previousOperation.id) {
          throw new WorkspaceServerError("generated_surface_revision_operation_conflict", 409, {
            operation_id: previousOperation.id,
            revision_id: snapshot.revision?.id
          });
        }
        await this.ensureCompletionActivity(context, roomId, previousOperation, snapshot.resource, snapshot.revision);
        return { resource: snapshot.resource, operation: previousOperation, activity: [], revision: snapshot.revision } as unknown as { resource: GeneratedSurfaceDefinition; operation: OperationRecord; activity: Array<import("@samurai-agent/core-schemas").ActivityInboxItem> } & TExtra;
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
    const executionWithRevision = execution as typeof execution & { revision?: GeneratedSurfaceRevisionRecord };
    await this.saveOperationResultSnapshot(context, roomId, {
      operation_id: operation.id,
      operation: operation.operation,
      input_hash: operation.input_hash,
      room_id: roomId,
      resource: execution.resource,
      ...(executionWithRevision.revision ? { revision: executionWithRevision.revision } : {})
    });
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
    await this.ensureCompletionActivity(context, roomId, completed, execution.resource, executionWithRevision.revision);
    const { resource, ref: _ref, summary: _summary, ...extra } = execution;
    return { resource, operation: completed, ...(execution.rollbackPoint ? { rollbackPoint: execution.rollbackPoint } : {}), activity: [], ...(extra as unknown as TExtra) };
  }

  private async saveRevision(context: GeneratedSurfaceMutationContext, roomId: string, input: {
    definition: GeneratedSurfaceDefinition;
    revision: GeneratedSurfaceRevisionRecord;
    html: string;
    css?: string;
    script?: string;
    assets?: GeneratedSurfaceBundleInput["assets"];
  }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }> {
    const withProvenance = applyRuntimeRoomWorkSourceRefs({ definition: input.definition, revision: input.revision }, context.runtimeWorkId);
    const definition = normalizedGeneratedSurfaceDefinition(context.workspaceId, withProvenance.definition);
    const revision = GeneratedSurfaceRevisionRecordSchema.parse(withProvenance.revision);
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

  private async writeBundleFiles(context: WorkspaceRequestContext, roomId: string, revision: GeneratedSurfaceRevisionRecord, input: GeneratedSurfaceBundleFilesInput): Promise<void> {
    // Resolve every declared asset before writing any file. This prevents a
    // malformed asset from leaving a partially persisted revision behind.
    const assets = resolveGeneratedSurfaceAssets(revision, input.assets);
    await this.writeFileIfNeeded(context, roomId, revision.html_ref.uri, Buffer.from(input.html, "utf8"), "html");
    if (revision.css_ref) await this.writeFileIfNeeded(context, roomId, revision.css_ref.uri, Buffer.from(input.css ?? "", "utf8"), "css");
    if (revision.script_ref) await this.writeFileIfNeeded(context, roomId, revision.script_ref.uri, Buffer.from(input.script ?? "", "utf8"), "script");
    for (const asset of assets) {
      await this.writeFileIfNeeded(context, roomId, asset.ref.uri, asset.content, `asset-${stableHash(asset.path)}`);
    }
  }

  private async verifyBundleFiles(context: WorkspaceRequestContext, roomId: string, revision: GeneratedSurfaceRevisionRecord, input: GeneratedSurfaceBundleFilesInput): Promise<void> {
    const assets = resolveGeneratedSurfaceAssets(revision, input.assets);
    const verify = async (path: string, expected: Buffer) => {
      const actual = await this.files.read(context, { roomId, path });
      if (!actual.content.equals(expected)) throw new WorkspaceServerError("generated_surface_file_conflict", 409, { path });
    };
    await verify(revision.html_ref.uri, Buffer.from(input.html, "utf8"));
    if (revision.css_ref) await verify(revision.css_ref.uri, Buffer.from(input.css ?? "", "utf8"));
    if (revision.script_ref) await verify(revision.script_ref.uri, Buffer.from(input.script ?? "", "utf8"));
    for (const asset of assets) {
      await verify(asset.ref.uri, asset.content);
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
      assets: assets.map((asset) => ({ path: asset.path, content_base64: asset.content.toString("base64"), mime_type: asset.mime_type }))
    };
  }

  private async runStateMutation(
    context: GeneratedSurfaceMutationContext,
    roomId: string,
    input: GeneratedSurfaceStateInput,
    inputHash: string
  ): Promise<{ surface: GeneratedSurfaceDefinition; replayed: boolean }> {
    const previous = await this.tryGetRecord(context, roomId, operationRecordType, context.operationId);
    if (previous) {
      const previousOperation = OperationRecordSchema.parse(previous.payload);
      if (previousOperation.input_hash !== inputHash
        || previousOperation.operation !== "generated_surface.state"
        || previousOperation.room_id !== roomId) {
        throw new WorkspaceServerError("generated_surface_operation_conflict", 409);
      }
      if (previousOperation.status === "completed") {
        if (!previousOperation.result_ref
          || previousOperation.result_ref.kind !== surfaceRecordType
          || previousOperation.result_ref.id !== input.surface_id) {
          throw new WorkspaceServerError("generated_surface_state_recovery_required", 503, { operation_id: previousOperation.id });
        }
        const surface = await this.get(context, roomId, input.surface_id);
        const interactionId = input.interaction_id ?? deterministicInteractionId(context.operationId);
        const interactionRecord = await this.tryGetRecord(context, roomId, interactionRecordType, interactionId);
        if (!interactionRecord) {
          throw new WorkspaceServerError("generated_surface_state_recovery_required", 503, {
            operation_id: previousOperation.id,
            interaction_id: interactionId
          });
        }
        const interaction = interactionFromRecord(interactionRecord);
        if (interaction.domain_operation_id !== previousOperation.id
          || interaction.kind !== stateInteractionKind(input.action)
          || interaction.surface_id !== surface.id) {
          throw new WorkspaceServerError("generated_surface_state_operation_conflict", 409, { operation_id: previousOperation.id });
        }
        const snapshot = await this.readOperationResultSnapshot(context, roomId, previousOperation.id);
        if (!snapshot
          || snapshot.operation !== previousOperation.operation
          || snapshot.input_hash !== previousOperation.input_hash
          || snapshot.room_id !== roomId
          || snapshot.resource.id !== surface.id
          || snapshot.resource.current_revision_id !== interaction.revision_id) {
          throw new WorkspaceServerError("generated_surface_state_recovery_required", 503, { operation_id: previousOperation.id });
        }
        return { surface: snapshot.resource, replayed: true };
      }
    }

    const surface = await this.get(context, roomId, input.surface_id);
    const trusted = trustedContext(context, roomId, surface.session_id);
    const now = nowIso();
    const operation = OperationRecordSchema.parse({
      id: context.operationId,
      ...(trusted.sessionId ? { session_id: trusted.sessionId } : {}),
      ...(context.runtimeRunId ? { run_id: context.runtimeRunId } : {}),
      capability_id: "generated_surface.state",
      operation: "generated_surface.state",
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
      target_resource_refs: [{ kind: surfaceRecordType, id: surface.id, uri: `surfaces/${surface.id}`, label: surface.title }],
      proposed_effects: ["Change Generated Surface lifecycle state."],
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
        searchText: `${operation.operation} ${input.action} ${surface.id}`,
        expectedVersion: previous.version
      })
      : await this.commands.putRecord(scopedContext(context, "operation-start-0"), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: operation as unknown as Record<string, unknown>,
        searchText: `${operation.operation} ${input.action} ${surface.id}`,
        expectedVersion: 0
      });
    const ports: GeneratedSurfaceStatePorts = {
      updateGeneratedSurfaceState: async (id, state) => this.updateState(context, roomId, id, state),
      saveGeneratedSurfaceInteraction: async (record) => this.saveStateInteraction(context, roomId, {
        ...record,
        id: input.interaction_id ?? deterministicInteractionId(context.operationId),
        domain_operation_id: context.operationId
      }),
      generatedSurfaceStateError: (code, message) => new WorkspaceServerError(message, code === "not_found" ? 404 : 409)
    };
    let result: GeneratedSurfaceDefinition;
    try {
      result = unwrap(await generatedSurfaceState.createHandler(ports).execute(trusted, input));
    } catch (error) {
      const failed = OperationRecordSchema.parse({
        ...operation,
        status: "failed",
        error: publicErrorCode(error),
        updated_at: nowIso()
      });
      await this.commands.putRecord(scopedContext(context, `operation-failed-${operationRecord.record.version}`), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: failed as unknown as Record<string, unknown>,
        searchText: `${failed.operation} failed`,
        expectedVersion: operationRecord.record.version
      }).catch(() => undefined);
      throw error;
    }
    const completed = OperationRecordSchema.parse({
      ...operation,
      status: "completed",
      result_ref: ResourceRefSchema.parse({
        kind: surfaceRecordType,
        id: result.id,
        uri: `surfaces/${result.id}`,
        label: result.title
      }),
      updated_at: nowIso()
    });
    await this.saveOperationResultSnapshot(context, roomId, {
      operation_id: operation.id,
      operation: operation.operation,
      input_hash: operation.input_hash,
      room_id: roomId,
      resource: result
    });
    await this.commands.putRecord(scopedContext(context, `operation-complete-${operationRecord.record.version}`), {
      roomId,
      recordType: operationRecordType,
      id: operation.id,
      payload: completed as unknown as Record<string, unknown>,
      searchText: `${completed.operation} completed`,
      expectedVersion: operationRecord.record.version
    });
    return { surface: result, replayed: false };
  }

  private async updateState(context: WorkspaceRequestContext, roomId: string, surfaceId: string, state: GeneratedSurfaceDefinition["state"]): Promise<GeneratedSurfaceDefinition | undefined> {
    const currentRecord = await this.tryGetRecord(context, roomId, surfaceRecordType, surfaceId);
    if (!currentRecord) return undefined;
    const current = surfaceFromRecord(currentRecord);
    if (current.state === state) return current;
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

  private async saveStateInteraction(context: WorkspaceRequestContext, roomId: string, record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord> {
    const parsed = SurfaceInteractionRecordSchema.parse(record);
    const existing = await this.tryGetRecord(context, roomId, interactionRecordType, parsed.id);
    if (existing) {
      const current = interactionFromRecord(existing);
      if (!sameStateInteraction(current, parsed)) throw new WorkspaceServerError("generated_surface_interaction_conflict", 409);
      return current;
    }
    try {
      return await this.saveInteraction(context, roomId, parsed);
    } catch (error) {
      const raced = await this.tryGetRecord(context, roomId, interactionRecordType, parsed.id);
      if (!raced) throw error;
      const current = interactionFromRecord(raced);
      if (!sameStateInteraction(current, parsed)) throw new WorkspaceServerError("generated_surface_interaction_conflict", 409);
      return current;
    }
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

  private async readActionResultSnapshot(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    operationId: string
  ): Promise<GeneratedSurfaceActionResultSnapshot | undefined> {
    const record = await this.tryGetRecord(context, roomId, actionResultRecordType, operationId);
    return record ? actionResultSnapshotFromRecord(record) : undefined;
  }

  private async saveActionResultSnapshot(
    context: WorkspaceRequestContext,
    roomId: string,
    snapshot: GeneratedSurfaceActionResultSnapshot
  ): Promise<void> {
    const payload = {
      operation_id: snapshot.operation_id,
      operation: snapshot.operation,
      input_hash: snapshot.input_hash,
      room_id: snapshot.room_id,
      result: snapshot.result
    } as unknown as Record<string, unknown>;
    const existing = await this.tryGetRecord(context, roomId, actionResultRecordType, snapshot.operation_id);
    if (existing) {
      const current = actionResultSnapshotFromRecord(existing);
      if (canonicalJson(current) !== canonicalJson(snapshot)) {
        throw new WorkspaceServerError("generated_surface_action_result_conflict", 409, { operation_id: snapshot.operation_id });
      }
      return;
    }
    try {
      await this.commands.putRecord(scopedContext(context, "action-result"), {
        roomId,
        recordType: actionResultRecordType,
        id: snapshot.operation_id,
        payload,
        searchText: `${snapshot.operation} ${snapshot.result.action.label}`,
        expectedVersion: 0
      });
    } catch (error) {
      const raced = await this.tryGetRecord(context, roomId, actionResultRecordType, snapshot.operation_id);
      if (!raced) throw error;
      const current = actionResultSnapshotFromRecord(raced);
      if (canonicalJson(current) !== canonicalJson(snapshot)) {
        throw new WorkspaceServerError("generated_surface_action_result_conflict", 409, { operation_id: snapshot.operation_id });
      }
    }
  }

  private async completeActionOperation(
    context: WorkspaceRequestContext,
    roomId: string,
    previousRecord: WorkspaceRecord,
    operation: OperationRecord,
    snapshot: GeneratedSurfaceActionResultSnapshot
  ): Promise<void> {
    const completed = OperationRecordSchema.parse({
      ...operation,
      status: "completed",
      result_ref: {
        kind: actionResultRecordType,
        id: snapshot.operation_id,
        uri: `generated-surface-actions/${snapshot.operation_id}`,
        label: snapshot.result.action.label
      },
      updated_at: nowIso()
    });
    try {
      await this.commands.putRecord(scopedContext(context, "action-operation-complete"), {
        roomId,
        recordType: operationRecordType,
        id: operation.id,
        payload: completed as unknown as Record<string, unknown>,
        searchText: `${completed.operation} completed`,
        expectedVersion: previousRecord.version
      });
    } catch (error) {
      const raced = await this.tryGetRecord(context, roomId, operationRecordType, operation.id);
      if (!raced) throw error;
      const racedOperation = actionOperationFromRecord(raced, roomId, operation.input_hash);
      if (racedOperation.status === "completed"
        && racedOperation.result_ref?.kind === actionResultRecordType
        && racedOperation.result_ref.id === snapshot.operation_id) return;
      throw error;
    }
  }

  private async assertStateMutationAuthorization(context: GeneratedSurfaceMutationContext, roomId: string): Promise<void> {
    // The command facade owns execute admission. Edit admission is delegated
    // to the existing Store/RLS service; this adapter does not reimplement
    // membership policy. Both checks intentionally run for replays too.
    await this.commands.assertRoomExecutable(context, roomId);
    if (!this.roomAuthorization) throw new WorkspaceServerError("generated_surface_room_edit_authorization_unavailable", 503);
    await this.roomAuthorization.assertRoomWritable(context, roomId);
  }

  private async saveOperationResultSnapshot(context: WorkspaceRequestContext, roomId: string, snapshot: GeneratedSurfaceOperationResultSnapshot): Promise<void> {
    const payload = {
      operation_id: snapshot.operation_id,
      operation: snapshot.operation,
      input_hash: snapshot.input_hash,
      room_id: snapshot.room_id,
      resource: snapshot.resource,
      ...(snapshot.revision ? { revision: snapshot.revision } : {})
    } as unknown as Record<string, unknown>;
    const existing = await this.tryGetRecord(context, roomId, operationResultRecordType, snapshot.operation_id);
    if (existing) {
      const current = operationResultSnapshotFromRecord(existing);
      if (canonicalJson(current) !== canonicalJson(snapshot)) {
        throw new WorkspaceServerError("generated_surface_operation_result_conflict", 409, { operation_id: snapshot.operation_id });
      }
      return;
    }
    try {
      await this.commands.putRecord(scopedContext(context, "operation-result"), {
        roomId,
        recordType: operationResultRecordType,
        id: snapshot.operation_id,
        payload,
        searchText: `${snapshot.operation} ${snapshot.resource.title}`,
        expectedVersion: 0
      });
    } catch (error) {
      const raced = await this.tryGetRecord(context, roomId, operationResultRecordType, snapshot.operation_id);
      if (!raced) throw error;
      const current = operationResultSnapshotFromRecord(raced);
      if (canonicalJson(current) !== canonicalJson(snapshot)) {
        throw new WorkspaceServerError("generated_surface_operation_result_conflict", 409, { operation_id: snapshot.operation_id });
      }
    }
  }

  private async readOperationResultSnapshot(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    operationId: string
  ): Promise<GeneratedSurfaceOperationResultSnapshot | undefined> {
    const record = await this.tryGetRecord(context, roomId, operationResultRecordType, operationId);
    return record ? operationResultSnapshotFromRecord(record) : undefined;
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

const maxGeneratedSurfaceActionPayloadBytes = 64 * 1024;

/**
 * Builds a target payload from the declared action and renderer values. A
 * declaration's template is Server-owned: callers may repeat a fixed value,
 * but cannot replace it with a different target such as another Collection
 * ID or record version.
 */
function resolvedGeneratedSurfaceActionPayload(
  action: GeneratedSurfaceActionDeclaration,
  actionPayload: Record<string, JsonValue> | undefined
): {
  targetPayload: Record<string, JsonValue>;
  executionPayload: Record<string, JsonValue>;
} {
  if (actionPayload !== undefined && !isGeneratedSurfaceActionJsonObject(actionPayload)) {
    throw new WorkspaceServerError("generated_surface_action_payload_invalid", 400);
  }
  const supplied = cloneGeneratedSurfaceActionPayload(actionPayload ?? {});
  for (const [key, templateValue] of Object.entries(action.payload_template)) {
    if (Object.hasOwn(supplied, key) && canonicalJson(supplied[key]) !== canonicalJson(templateValue)) {
      throw new WorkspaceServerError("generated_surface_action_payload_template_override", 409, { key });
    }
  }
  const payload = { ...supplied, ...action.payload_template } as Record<string, JsonValue>;
  assertGeneratedSurfaceActionPayloadSize(payload);
  try {
    const parsed = parseDomainOperationInput(action.command_id as DomainCommandId, payload);
    if (!isGeneratedSurfaceActionJsonObject(parsed)) throw new WorkspaceServerError("generated_surface_target_payload_invalid", 400);
    return {
      targetPayload: payload,
      executionPayload: cloneGeneratedSurfaceActionPayload(parsed)
    };
  } catch (error) {
    if (error instanceof WorkspaceServerError) throw error;
    throw new WorkspaceServerError("generated_surface_target_payload_invalid", 400, { command_id: action.command_id });
  }
}

function parseGeneratedSurfaceActionTarget(value: unknown): GeneratedSurfaceActionTarget {
  if (!isGeneratedSurfaceActionJsonObject(value)
    || value.kind !== "generated_surface_action"
    || typeof value.room_id !== "string"
    || typeof value.surface_id !== "string"
    || typeof value.revision_id !== "string"
    || typeof value.action_id !== "string"
    || typeof value.command_id !== "string"
    || !isGeneratedSurfaceActionJsonObject(value.payload)) {
    throw new WorkspaceServerError("generated_surface_action_target_invalid", 400);
  }
  const target = {
    kind: "generated_surface_action" as const,
    room_id: requireGeneratedSurfaceActionId(value.room_id, "room"),
    surface_id: requireGeneratedSurfaceActionId(value.surface_id, "surface"),
    revision_id: requireGeneratedSurfaceActionId(value.revision_id, "revision"),
    action_id: requireGeneratedSurfaceActionId(value.action_id, "action"),
    command_id: requireGeneratedSurfaceActionId(value.command_id, "command"),
    payload: cloneGeneratedSurfaceActionPayload(value.payload),
    ...(value.interaction_id === undefined ? {} : { interaction_id: requireGeneratedSurfaceActionId(value.interaction_id, "interaction") }),
    ...(value.message_id === undefined ? {} : { message_id: requireGeneratedSurfaceActionId(value.message_id, "message") })
  };
  assertGeneratedSurfaceActionPayloadSize(target.payload);
  return target;
}

function requireGeneratedSurfaceActionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new WorkspaceServerError("generated_surface_action_target_invalid", 400, { field });
  }
  return value.trim();
}

function cloneGeneratedSurfaceActionPayload(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function assertGeneratedSurfaceActionPayloadSize(value: Record<string, JsonValue>): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxGeneratedSurfaceActionPayloadBytes) {
    throw new WorkspaceServerError("generated_surface_action_payload_too_large", 400);
  }
}

function isGeneratedSurfaceActionJsonObject(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, child]) => Boolean(key) && isGeneratedSurfaceActionJsonValue(child));
}

function isGeneratedSurfaceActionJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return Number.isFinite(value as number) || typeof value !== "number";
  if (Array.isArray(value)) return value.every(isGeneratedSurfaceActionJsonValue);
  return isGeneratedSurfaceActionJsonObject(value);
}

function trustedContext(context: Pick<GeneratedSurfaceMutationContext, "workspaceId" | "accountId" | "operationId" | "runtimeRunId">, roomId: string, sessionId?: string): import("@samurai-agent/domain-operations").TrustedDomainContext {
  return {
    inputSource: "runtime_api",
    workspaceId: context.workspaceId,
    actorId: context.accountId,
    participant: { kind: "human", participantId: context.accountId },
    roomId,
    ...(sessionId ? { sessionId } : {}),
    ...(context.runtimeRunId ? { runId: context.runtimeRunId } : {}),
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

function operationResultSnapshotFromRecord(record: WorkspaceRecord): GeneratedSurfaceOperationResultSnapshot {
  const payload = record.payload;
  if (typeof payload.operation_id !== "string"
    || typeof payload.operation !== "string"
    || typeof payload.input_hash !== "string"
    || typeof payload.room_id !== "string") {
    throw new WorkspaceServerError("generated_surface_operation_result_invalid", 503, { operation_id: record.id });
  }
  try {
    const resource = GeneratedSurfaceDefinitionSchema.parse(payload.resource);
    const revision = payload.revision === undefined ? undefined : GeneratedSurfaceRevisionRecordSchema.parse(payload.revision);
    if (payload.operation_id !== record.id) throw new Error("operation_id_mismatch");
    return {
      operation_id: payload.operation_id,
      operation: payload.operation,
      input_hash: payload.input_hash,
      room_id: payload.room_id,
      resource,
      ...(revision ? { revision } : {})
    };
  } catch {
    throw new WorkspaceServerError("generated_surface_operation_result_invalid", 503, { operation_id: record.id });
  }
}

function actionOperationFromRecord(record: WorkspaceRecord, roomId: string, inputHash: string): OperationRecord {
  const operation = OperationRecordSchema.parse(record.payload);
  if (operation.operation !== "generated_surface.action.run"
    || operation.input_hash !== inputHash
    || operation.room_id !== roomId) {
    throw new WorkspaceServerError("generated_surface_action_operation_conflict", 409, { operation_id: record.id });
  }
  return operation;
}

function createActionOperation(
  context: WorkspaceRequestContext,
  roomId: string,
  inputHash: string,
  prepared: PreparedGeneratedSurfaceAction
): OperationRecord {
  const now = nowIso();
  return OperationRecordSchema.parse({
    id: context.operationId,
    ...(prepared.surface.session_id ? { session_id: prepared.surface.session_id } : {}),
    capability_id: "generated_surface.action.run",
    operation: "generated_surface.action.run",
    actor_identity: "owner",
    participant_id: context.accountId,
    participant_kind: "human",
    room_id: roomId,
    principal: { kind: "human", participant_id: context.accountId },
    source: { kind: "native_app", app_id: "samurai-workspace-client" },
    instruction_source: "owner_instruction",
    instruction_authority: "room_execute",
    channel: "workspace-server",
    input_hash: inputHash,
    target_resource_refs: [
      ResourceRefSchema.parse({ kind: "generated_surface", id: prepared.surface.id, uri: `surfaces/${prepared.surface.id}`, label: prepared.surface.title }),
      ResourceRefSchema.parse({ kind: "generated_surface_revision", id: prepared.revisionId, uri: `surfaces/${prepared.surface.id}/revisions/${prepared.revisionId}`, label: prepared.revisionId })
    ],
    proposed_effects: [`Execute Generated Surface action: ${prepared.action.label}.`],
    status: "created",
    correlation_id: context.operationId,
    created_at: now,
    updated_at: now
  });
}

function generatedSurfaceActionInputHash(input: GeneratedSurfaceActionRequest): string {
  return stableHash({
    room_id: input.room_id,
    surface_id: input.surface_id,
    action_id: input.action_id,
    revision_id: input.revision_id ?? null,
    action_payload: input.action_payload ?? {},
    interaction_id: input.interaction_id ?? null,
    message_id: input.message_id ?? null
  });
}

function actionResultSnapshotFromRecord(record: WorkspaceRecord): GeneratedSurfaceActionResultSnapshot {
  const payload = record.payload;
  if (typeof payload.operation_id !== "string"
    || typeof payload.operation !== "string"
    || typeof payload.input_hash !== "string"
    || typeof payload.room_id !== "string") {
    throw new WorkspaceServerError("generated_surface_action_result_invalid", 503, { operation_id: record.id });
  }
  try {
    if (payload.operation_id !== record.id) throw new Error("operation_id_mismatch");
    return {
      operation_id: payload.operation_id,
      operation: payload.operation,
      input_hash: payload.input_hash,
      room_id: payload.room_id,
      result: generatedSurfaceActionResultSchema.parse(payload.result)
    };
  } catch {
    throw new WorkspaceServerError("generated_surface_action_result_invalid", 503, { operation_id: record.id });
  }
}

function generatedSurfaceAssetRefPath(revision: GeneratedSurfaceRevisionRecord, ref: ResourceRef): string {
  if (ref.kind !== "generated_surface_asset" || typeof ref.label !== "string") {
    throw new WorkspaceServerError("generated_surface_asset_scope_invalid", 409, { revision_id: revision.id });
  }
  const assetPath = safeGeneratedSurfaceAssetPath(ref.label);
  const expectedRoot = `surfaces/${revision.surface_id}/revisions/${revision.revision}/assets/`;
  if (!assetPath
    || assetPath !== ref.label
    || ref.id !== `${revision.id}:${assetPath}`
    || ref.uri !== `${expectedRoot}${assetPath}`
    || ["index.html", "surface.css", "surface.js"].includes(assetPath)) {
    throw new WorkspaceServerError("generated_surface_asset_path_invalid", 409, { revision_id: revision.id, path: ref.label });
  }
  return assetPath;
}

function resolveGeneratedSurfaceAssets(
  revision: GeneratedSurfaceRevisionRecord,
  assets: GeneratedSurfaceBundleInput["assets"]
): Array<{ path: string; ref: ResourceRef; content: Buffer }> {
  const expected = new Map<string, ResourceRef>();
  for (const ref of revision.asset_refs) {
    const path = generatedSurfaceAssetRefPath(revision, ref);
    if (expected.has(path)) {
      throw new WorkspaceServerError("generated_surface_asset_duplicate", 409, { revision_id: revision.id, path });
    }
    expected.set(path, ref);
  }

  const resolved: Array<{ path: string; ref: ResourceRef; content: Buffer }> = [];
  const seen = new Set<string>();
  for (const asset of assets ?? []) {
    const path = safeGeneratedSurfaceAssetPath(asset.path);
    if (!path) {
      throw new WorkspaceServerError("generated_surface_asset_path_invalid", 400, { path: asset.path });
    }
    if (seen.has(path)) {
      throw new WorkspaceServerError("generated_surface_asset_duplicate", 400, { path });
    }
    const ref = expected.get(path);
    if (!ref) {
      throw new WorkspaceServerError("generated_surface_asset_ref_missing", 409, { path });
    }
    seen.add(path);
    resolved.push({ path, ref, content: decodeGeneratedSurfaceAsset(asset, path) });
  }

  for (const path of expected.keys()) {
    if (!seen.has(path)) {
      throw new WorkspaceServerError("generated_surface_asset_missing", 409, { revision_id: revision.id, path });
    }
  }
  return resolved;
}

function decodeGeneratedSurfaceAsset(asset: GeneratedSurfaceAssetInput, path: string): Buffer {
  const declaredMimeType = asset.mime_type?.trim();
  if (declaredMimeType !== undefined && !isGeneratedSurfaceAssetMimeType(declaredMimeType)) {
    throw new WorkspaceServerError("generated_surface_asset_mime_type_invalid", 400, { path });
  }
  const inferredMimeType = generatedSurfaceAssetMimeType(path);
  if (declaredMimeType !== undefined
    && inferredMimeType !== "application/octet-stream"
    && declaredMimeType !== inferredMimeType) {
    throw new WorkspaceServerError("generated_surface_asset_mime_type_conflict", 409, {
      path,
      expected_mime_type: inferredMimeType,
      received_mime_type: declaredMimeType
    });
  }

  if (asset.encoding === "base64") {
    if (!isCanonicalBase64(asset.content)) {
      throw new WorkspaceServerError("generated_surface_asset_base64_invalid", 400, { path });
    }
    const content = Buffer.from(asset.content, "base64");
    if (content.toString("base64") !== asset.content) {
      throw new WorkspaceServerError("generated_surface_asset_base64_invalid", 400, { path });
    }
    return content;
  }
  if (asset.encoding !== undefined && asset.encoding !== "utf8") {
    throw new WorkspaceServerError("generated_surface_asset_encoding_invalid", 400, { path });
  }
  return Buffer.from(asset.content, "utf8");
}

function stateInteractionKind(action: GeneratedSurfaceStateInput["action"]): SurfaceInteractionRecord["kind"] {
  return action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : "dismissed";
}

function sameStateInteraction(current: SurfaceInteractionRecord, requested: SurfaceInteractionRecord): boolean {
  const withoutCreatedAt = (value: SurfaceInteractionRecord): Omit<SurfaceInteractionRecord, "created_at"> => {
    const { created_at: _createdAt, ...rest } = value;
    return rest;
  };
  return canonicalJson(withoutCreatedAt(current)) === canonicalJson(withoutCreatedAt(requested));
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
    if (!path || path !== asset.path) {
      throw new WorkspaceServerError("generated_surface_asset_path_invalid", 409, { path: asset.path });
    }
    if (!isGeneratedSurfaceAssetMimeType(asset.mime_type)) {
      throw new WorkspaceServerError("generated_surface_asset_mime_type_invalid", 409, { path });
    }
    if (!isCanonicalBase64(asset.content_base64) || Buffer.from(asset.content_base64, "base64").toString("base64") !== asset.content_base64) {
      throw new WorkspaceServerError("generated_surface_asset_base64_invalid", 409, { path });
    }
    if (dataByPath.has(path)) {
      throw new WorkspaceServerError("generated_surface_asset_duplicate", 409, { path });
    }
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
    css: "text/css",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp"
  };
  return (extension && mimeTypes[extension]) ?? "application/octet-stream";
}

function isGeneratedSurfaceAssetMimeType(value: string): boolean {
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value);
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
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
