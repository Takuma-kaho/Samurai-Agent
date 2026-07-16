import {
  SurfaceGenerationRequestSchema,
  SurfaceInteractionRecordSchema,
  createId,
  nowIso,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceRevisionRecord,
  type JsonValue,
  type SurfaceInteractionRecord
} from "@samurai-agent/core-schemas";
import {
  buildGeneratedSurfaceRevision,
  parseGeneratedSurfaceOutput,
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
  dispatchCommand(input: {
    command_id: string; input_source: "generated_surface"; idempotency_key: string; payload: Record<string, JsonValue>;
  }): Promise<{ result: unknown }>;
}

export class GeneratedSurfaceDomainService {
  constructor(private readonly dependencies: {
    surfaces: GeneratedSurfacePort;
    requestError: (code: "conflict" | "forbidden" | "not_found", message: string) => Error;
  }) {}

  getSurface(id: string) { return this.dependencies.surfaces.getSurface(id); }
  getRevision(id: string) { return this.dependencies.surfaces.getRevision(id); }
  readBundle(id: string) { return this.dependencies.surfaces.readBundle(id); }
  saveInteractionRecord(record: SurfaceInteractionRecord) { return this.dependencies.surfaces.saveInteraction(record); }
  updateSurfaceState(id: string, state: "ephemeral" | "pinned" | "archived") { return this.dependencies.surfaces.updateState(id, state); }
  dispatchSurfaceCommand(input: Parameters<GeneratedSurfacePort["dispatchCommand"]>[0]) { return this.dependencies.surfaces.dispatchCommand(input); }
  buildSurfaceRevision(input: Parameters<typeof buildGeneratedSurfaceRevision>[0]) { return buildGeneratedSurfaceRevision(input); }
  saveSurfaceRevision(input: Parameters<GeneratedSurfacePort["saveRevision"]>[0]) { return this.dependencies.surfaces.saveRevision(input); }
  surfaceError(code: "conflict" | "forbidden" | "not_found", message: string) { return this.dependencies.requestError(code, message); }

  async runAction(payload: Record<string, JsonValue>) {
    const surface = await this.requireSurface(payload);
    const revisionId = optionalString(payload.revision_id) || surface.current_revision_id;
    if (revisionId !== surface.current_revision_id) throw this.dependencies.requestError("conflict", "generated_surface_revision_stale");
    const actionId = requiredId(payload, "action_id");
    const action = surface.actions.find((item) => item.id === actionId);
    if (!action || !surface.capability_manifest.allowed_domain_commands.includes(action.command_id)) {
      throw this.dependencies.requestError("forbidden", "generated_surface_action_not_declared");
    }
    const interactionId = requiredId(payload, "interaction_id");
    const command = await this.dependencies.surfaces.dispatchCommand({
      command_id: action.command_id,
      input_source: "generated_surface",
      idempotency_key: `${surface.id}:${revisionId}:${interactionId}:${action.id}`,
      payload: { ...action.payload_template, ...recordValue(payload.action_payload) }
    });
    await this.dependencies.surfaces.saveInteraction(SurfaceInteractionRecordSchema.parse({
      id: interactionId, kind: "action", session_id: surface.session_id,
      message_id: optionalString(payload.message_id) || undefined, surface_id: surface.id,
      revision_id: revisionId, command_id: action.command_id,
      command_result: jsonValue(command.result), created_at: nowIso()
    }));
    return { surface, action, command: { result: jsonValue(command.result) } };
  }

  create(payload: Record<string, JsonValue>) { return this.saveRevision(payload); }

  async revise(payload: Record<string, JsonValue>) {
    const existing = await this.requireSurface(payload);
    return this.saveRevision(payload, existing);
  }

  async export(payload: Record<string, JsonValue>) {
    const surface = await this.requireSurface(payload);
    const revisionId = optionalString(payload.revision_id) || surface.current_revision_id;
    const revision = await this.dependencies.surfaces.getRevision(revisionId);
    const bundle = revision ? await this.dependencies.surfaces.readBundle(revision.id) : undefined;
    if (!revision || revision.surface_id !== surface.id || !bundle) {
      throw this.dependencies.requestError("not_found", "generated_surface_revision_not_found");
    }
    const format = optionalString(payload.format) === "zip" ? "zip" as const : "html" as const;
    return { surface, revision, bundle, format, file_name: `${surface.id}-revision-${revision.revision}.${format}` };
  }

  async recordInteraction(payload: Record<string, JsonValue>) {
    const surface = await this.requireSurface(payload);
    return this.dependencies.surfaces.saveInteraction(SurfaceInteractionRecordSchema.parse({
      id: optionalString(payload.interaction_id) || createId("surface_interaction"),
      kind: optionalString(payload.kind), session_id: surface.session_id,
      message_id: optionalString(payload.message_id) || undefined, surface_id: surface.id,
      revision_id: optionalString(payload.revision_id) || surface.current_revision_id,
      command_id: optionalString(payload.command_id) || undefined,
      user_feedback: optionalString(payload.user_feedback) || undefined, created_at: nowIso()
    }));
  }

  async setState(payload: Record<string, JsonValue>) {
    const action = optionalString(payload.action);
    const state = action === "pin" ? "pinned" : action === "unpin" ? "ephemeral" : action === "archive" ? "archived" : undefined;
    if (!state) throw this.dependencies.requestError("conflict", "generated_surface_state_action_required");
    const surface = await this.dependencies.surfaces.updateState(requiredId(payload, "surface_id"), state);
    if (!surface) throw this.dependencies.requestError("not_found", "generated_surface_not_found");
    const kind = action === "pin" ? "pinned" : action === "unpin" ? "unpinned" : "dismissed";
    await this.dependencies.surfaces.saveInteraction(SurfaceInteractionRecordSchema.parse({
      id: optionalString(payload.interaction_id) || createId("surface_interaction"), kind,
      session_id: surface.session_id, message_id: optionalString(payload.message_id) || undefined,
      surface_id: surface.id, revision_id: surface.current_revision_id, created_at: nowIso()
    }));
    return surface;
  }

  private async saveRevision(payload: Record<string, JsonValue>, existing?: GeneratedSurfaceDefinition) {
    const request = SurfaceGenerationRequestSchema.parse(recordValue(payload.request));
    const bundle = parseGeneratedSurfaceOutput(recordValue(payload.bundle));
    if (!bundle) throw this.dependencies.requestError("conflict", "generated_surface_bundle_invalid");
    const built = buildGeneratedSurfaceRevision({
      request, bundle, existing,
      producerRunId: optionalString(payload.producer_run_id) || undefined,
      promptFingerprint: optionalString(payload.prompt_fingerprint) || undefined
    });
    return this.dependencies.surfaces.saveRevision({
      definition: built.definition, revision: built.revision,
      html: bundle.html, css: bundle.css, script: bundle.script, assets: bundle.assets
    });
  }

  private async requireSurface(payload: Record<string, JsonValue>): Promise<GeneratedSurfaceDefinition> {
    const surface = await this.dependencies.surfaces.getSurface(requiredId(payload, "surface_id"));
    if (!surface) throw this.dependencies.requestError("not_found", "generated_surface_not_found");
    return surface;
  }
}

function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function requiredId(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]) || optionalString(payload.id);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
