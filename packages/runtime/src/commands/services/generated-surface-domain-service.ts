import {
  createId,
  nowIso,
  stableHash,
  type ActivityInboxItem,
  type ActivityRecord,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceActionDeclaration,
  type GeneratedSurfaceRevisionRecord,
  type OperationRecord,
  type ResourceRef,
  type RollbackPoint,
  type SurfaceGenerationRequest,
  type SurfaceInteractionRecord
} from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import {
  buildGeneratedSurfaceRevision,
  type GeneratedSurfaceBundleInput
} from "../../presentation/generated-surface";

export interface GeneratedSurfacePort {
  getSurface(id: string): Promise<GeneratedSurfaceDefinition | undefined>;
  getRevision(id: string): Promise<GeneratedSurfaceRevisionRecord | undefined>;
  readBundle(id: string): Promise<{ html: string; css?: string; script?: string } | undefined>;
  saveRevision(input: {
    definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord;
    html: string; css?: string; script?: string; assets?: GeneratedSurfaceBundleInput["assets"];
  }): Promise<{ definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord }>;
  saveInteraction(record: SurfaceInteractionRecord): Promise<SurfaceInteractionRecord>;
  updateState(id: string, state: "ephemeral" | "pinned" | "archived"): Promise<GeneratedSurfaceDefinition | undefined>;
}

export interface GeneratedSurfaceRevisionBuildRequest {
  request: SurfaceGenerationRequest;
  bundle: GeneratedSurfaceBundleInput;
  existing?: GeneratedSurfaceDefinition;
  producerRunId?: string;
  promptFingerprint?: string;
}

export interface GeneratedSurfaceRevisionSaveRequest {
  definition: GeneratedSurfaceDefinition;
  revision: GeneratedSurfaceRevisionRecord;
  html: string;
  css?: string;
  script?: string;
  assets?: GeneratedSurfaceBundleInput["assets"];
}

export interface GeneratedSurfaceMutationInput<TExtra extends Record<string, unknown> = {}> {
  trustedContext: TrustedDomainContext;
  inputSummary: string;
  operationName: string;
  proposedEffects: string[];
  targetResourceRefs?: ResourceRef[];
  execute(operation: OperationRecord, activity?: ActivityRecord): Promise<{
    resource: GeneratedSurfaceDefinition;
    ref: ResourceRef;
    rollbackPoint?: RollbackPoint;
    summary: string;
  } & TExtra>;
}

export interface GeneratedSurfaceMutationResult<TExtra extends Record<string, unknown> = {}> {
  resource: GeneratedSurfaceDefinition;
  operation: OperationRecord;
  rollbackPoint?: RollbackPoint;
  activity: ActivityInboxItem[];
}

export class GeneratedSurfaceDomainService {
  constructor(private readonly dependencies: {
    surfaces: GeneratedSurfacePort;
    runMutation<TExtra extends Record<string, unknown>>(input: GeneratedSurfaceMutationInput<TExtra>): Promise<GeneratedSurfaceMutationResult<TExtra> & TExtra>;
    requestError: (code: "conflict" | "forbidden" | "not_found", message: string) => Error;
  }) {}

  getSurface(id: string) { return this.dependencies.surfaces.getSurface(id); }
  async resolveSurfaceAction(input: { surfaceId: string; revisionId?: string; actionId: string }): Promise<{
    surface: GeneratedSurfaceDefinition;
    revisionId: string;
    action: GeneratedSurfaceActionDeclaration;
  }> {
    const surface = await this.getSurface(input.surfaceId);
    if (!surface) throw this.surfaceError("not_found", "generated_surface_not_found");
    const revisionId = input.revisionId ?? surface.current_revision_id;
    if (revisionId !== surface.current_revision_id) throw this.surfaceError("conflict", "generated_surface_revision_stale");
    const action = surface.actions.find((candidate) => candidate.id === input.actionId);
    if (!action || !surface.capability_manifest.allowed_domain_commands.includes(action.command_id)) {
      throw this.surfaceError("forbidden", "generated_surface_action_not_declared");
    }
    return { surface, revisionId, action };
  }
  getRevision(id: string) { return this.dependencies.surfaces.getRevision(id); }
  readBundle(id: string) { return this.dependencies.surfaces.readBundle(id); }
  saveInteractionRecord(record: SurfaceInteractionRecord) { return this.dependencies.surfaces.saveInteraction(record); }
  updateSurfaceState(id: string, state: "ephemeral" | "pinned" | "archived") { return this.dependencies.surfaces.updateState(id, state); }
  createGeneratedSurfaceRequestId() { return createId("surface_request"); }
  generatedSurfaceNow() { return nowIso(); }
  generatedSurfaceFingerprint(value: string) { return stableHash(value); }
  buildSurfaceRevision(input: GeneratedSurfaceRevisionBuildRequest) { return buildGeneratedSurfaceRevision(input); }
  saveSurfaceRevision(input: GeneratedSurfaceRevisionSaveRequest) { return this.dependencies.surfaces.saveRevision(input); }
  runSurfaceMutation<TExtra extends Record<string, unknown>>(input: GeneratedSurfaceMutationInput<TExtra>) { return this.dependencies.runMutation(input); }
  surfaceError(code: "conflict" | "forbidden" | "not_found", message: string) { return this.dependencies.requestError(code, message); }
}
