import type { DomainCommandInputSource } from "@samurai-agent/action-catalog";
import type { ArtifactKind } from "@samurai-agent/artifacts";
import {
  GraphDocumentSchema, GraphEdgeSchema, GraphNodeSchema, supportedLocales,
  type ActivityInboxItem, type ArtifactRecord, type ArtifactRevisionRecord, type GraphDocument, type JsonValue,
  type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint,
  type SessionRecord, type SupportedLocale, type WorkspaceChangeRecord
} from "@samurai-agent/core-schemas";
import type { SurfaceOperationResultKind, SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

export interface ArtifactCreateInput {
  sessionId?: string;
  title: string;
  instruction: string;
  kind?: ArtifactKind;
  uiLocale?: SupportedLocale;
  inputLocale?: SupportedLocale;
  outputLocale?: SupportedLocale;
  providerToolCall: boolean;
  metadata: Record<string, JsonValue>;
  envelopeId?: string;
  surfaceOperationId?: string;
}

export interface ArtifactRevisionInput {
  artifactId: string;
  content: string;
  sessionId?: string;
  producerRunId?: string;
  extension?: string;
  baseRevisionId?: string;
  editorSource?: string;
  changeSummary?: string;
  provenance: Record<string, JsonValue>;
}

interface ArtifactDraftInput {
  operation: OperationRecord; title: string; content: string | { bytes: Uint8Array; mime_type: string; extension: string; preview?: string };
  kind?: ArtifactKind; locale: SupportedLocale; sourceLocales: SupportedLocale[]; createdBy: string; metadata?: Record<string, JsonValue>;
}
interface ArtifactRevisionInputPort {
  artifactId: string; content: string | Uint8Array; producerRunId?: string; extension?: string; baseRevisionId?: string;
  editorSource?: "chat" | "surface" | "provider" | "image_provider" | "restore" | "system"; changeSummary?: string; provenance?: Record<string, JsonValue>;
}
interface MutationExecution<TExtra extends Record<string, unknown>> {
  resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string;
  extra: TExtra;
}
interface ArtifactWriteResult { resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
interface SurfaceArtifactWriteResult extends ArtifactWriteResult { sourceArtifact?: ArtifactRecord; workspaceChange: WorkspaceChangeRecord }
export interface ArtifactSurfaceResult {
  operation: Record<string, JsonValue>;
  result_kind: SurfaceOperationResultKind;
  render_spec: SurfaceRenderSpec;
  render_specs?: SurfaceRenderSpec[];
  result: SurfaceArtifactWriteResult;
}
export type ArtifactMutationInput<TExtra extends Record<string, unknown>> = { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<MutationExecution<TExtra>> };
export interface ArtifactExecutionPort {
  contract(id: string): { id: string; proposed_effects: string[] };
  createSession(input: { title: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(session: SessionRecord, content: string, inputLocale?: SupportedLocale, outputLocale?: SupportedLocale, metadata?: Record<string, JsonValue>, envelopeId?: string): MessageEnvelope;
  runMutation<TExtra extends Record<string, unknown>>(input: ArtifactMutationInput<TExtra>): Promise<ArtifactWriteResult & TExtra>;
  runSurface(input: Record<string, unknown>): Promise<ArtifactSurfaceResult>;
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  readContent(id: string): Promise<string | undefined>;
  getRevision(id: string): Promise<ArtifactRevisionRecord | undefined>;
  readRevisionContent(id: string): Promise<Uint8Array | undefined>;
  createRevision(input: ArtifactRevisionInputPort): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }>;
  repairRevisionSource(id: string): Promise<{ repaired: boolean }>;
  createDraft(input: ArtifactDraftInput): Promise<ArtifactRecord>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  exportPdf(input: { title: string; content: string; source: ArtifactRecord }): Promise<{ adapterId: string; bytes: Uint8Array }>;
  requestError(code: "not_found" | "conflict" | "provider_not_configured" | "provider_failed", message: string): Error;
}

export class ArtifactDomainService {
  constructor(private readonly artifacts: ArtifactExecutionPort) {}

  create(payload: Record<string, JsonValue>, source: DomainCommandInputSource) {
    return this.createArtifact(createInput(payload, false), source, "artifact.create");
  }
  createGraph(payload: Record<string, JsonValue>, source: DomainCommandInputSource) {
    return this.createPersistedArtifact(createInput(payload, true), "graph.create");
  }
  exportPdf(payload: Record<string, JsonValue>) {
    return this.exportArtifactPdf(requiredId(payload, "artifact_id"));
  }
  repair(payload: Record<string, JsonValue>) { return this.repairArtifact(requiredId(payload, "artifact_id")); }
  restoreRevision(payload: Record<string, JsonValue>) {
    return this.restoreArtifactRevision({
      artifactId: requiredId(payload, "artifact_id"), revisionId: requiredId(payload, "revision_id"),
      baseRevisionId: optionalString(payload.base_revision_id) || undefined,
      changeSummary: optionalString(payload.change_summary) || undefined
    });
  }
  revise(payload: Record<string, JsonValue>, source: DomainCommandInputSource) {
    return this.reviseArtifact(revisionInput(payload), source);
  }
  patchGraph(payload: Record<string, JsonValue>, source: DomainCommandInputSource) {
    return this.patchGraphArtifact({
      artifactId: requiredId(payload, "artifact_id"), patch: payload,
      baseRevisionId: optionalString(payload.base_revision_id) || undefined,
      editorSource: optionalString(payload.editor_source) || undefined,
      changeSummary: optionalString(payload.change_summary) || undefined,
      provenance: recordValue(payload.provenance)
    }, source);
  }
  editImage(payload: Record<string, JsonValue>) { return this.editImageArtifact(payload); }
  generateImage(payload: Record<string, JsonValue>) { return this.generateImageArtifact(payload); }

  private async createArtifact(input: ArtifactCreateInput, source: DomainCommandInputSource, commandId: "artifact.create" | "graph.create"): Promise<ArtifactWriteResult | ArtifactSurfaceResult> {
    const sessionId = input.sessionId || (await this.artifacts.createSession({ title: input.title || "Artifact entry", ui_locale: input.uiLocale, output_locale: input.outputLocale })).id;
    if (input.kind === "graph") parseGraph(input.instruction, this.artifacts);
    if (!input.providerToolCall) {
      const originalSurface = input.metadata.surface_operation_payload;
      if (originalSurface && typeof originalSurface === "object" && !Array.isArray(originalSurface)) return this.artifacts.runSurface(originalSurface as Record<string, unknown>);
      return this.artifacts.runSurface({ id: input.surfaceOperationId, kind: "artifact.request", session_id: sessionId, action: "create", title: input.title, instruction: input.instruction, input_locale: input.inputLocale, output_locale: input.outputLocale, metadata: input.metadata });
    }
    return this.createPersistedArtifact({ ...input, sessionId }, commandId);
  }

  private async createPersistedArtifact(input: ArtifactCreateInput, commandId: "artifact.create" | "graph.create"): Promise<ArtifactWriteResult> {
    const contract = this.artifacts.contract(commandId);
    const sessionId = input.sessionId || (await this.artifacts.createSession({ title: input.title || "Artifact entry", ui_locale: input.uiLocale, output_locale: input.outputLocale })).id;
    if (input.kind === "graph") parseGraph(input.instruction, this.artifacts);
    const session = await this.artifacts.getSession(sessionId);
    if (!session) throw this.artifacts.requestError("not_found", `Session not found: ${sessionId}`);
    const inputLocale = input.inputLocale ?? session.ui_locale;
    const outputLocale = input.outputLocale ?? session.output_locale;
    const envelope = this.artifacts.createEnvelope(session, input.instruction, inputLocale, outputLocale, input.metadata, input.envelopeId);
    return this.artifacts.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
      const artifact = await this.artifacts.createDraft({ operation, title: input.title, content: input.instruction, kind: input.kind, locale: outputLocale, sourceLocales: [inputLocale], createdBy: "backend" });
      const rollbackPoint = await this.artifacts.createRollback(operation, [artifact.file_ref], {}, { artifact_id: artifact.id });
      return { resource: artifact, ref: artifact.file_ref, rollbackPoint, summary: `Created artifact ${artifact.title}.`, extra: {} };
    }});
  }

  private async exportArtifactPdf(artifactId: string) {
    const contract = this.artifacts.contract("artifact.export_pdf");
    const source = await this.artifacts.getArtifact(artifactId);
    if (!source) throw this.artifacts.requestError("not_found", "artifact_not_found");
    const content = await this.artifacts.readContent(artifactId);
    if (content === undefined) throw this.artifacts.requestError("conflict", "artifact_pdf_source_not_text");
    const { adapterId, bytes } = await this.artifacts.exportPdf({ title: source.title, content, source });
    if (bytes.byteLength < 8 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw this.artifacts.requestError("provider_failed", "pdf_export_invalid_result");
    const session = await this.artifacts.ensureSession();
    const envelope = this.artifacts.createEnvelope(session, `Export PDF: ${source.title}`);
    return this.artifacts.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [source.file_ref], execute: async (operation) => {
      const pdf = await this.artifacts.createDraft({ operation, title: `${source.title}.pdf`, content: { bytes, mime_type: "application/pdf", extension: "pdf", preview: source.title }, kind: "pdf", locale: source.locale, sourceLocales: source.source_locales, createdBy: "pdf_export_adapter", metadata: { source_artifact_id: source.id, source_revision_id: typeof source.metadata.current_revision_id === "string" ? source.metadata.current_revision_id : null, export_adapter_id: adapterId } });
      const rollbackPoint = await this.artifacts.createRollback(operation, [source.file_ref, pdf.file_ref], {}, { artifact_id: pdf.id, source_artifact_id: source.id });
      return { resource: pdf, ref: pdf.file_ref, rollbackPoint, summary: `Exported ${source.title} as PDF.`, extra: {} };
    }});
  }

  private async repairArtifact(artifactId: string) {
    const contract = this.artifacts.contract("artifact.repair");
    const artifact = await this.artifacts.getArtifact(artifactId);
    if (!artifact) throw this.artifacts.requestError("not_found", "artifact_not_found");
    const session = await this.artifacts.ensureSession(); const envelope = this.artifacts.createEnvelope(session, `Repair artifact source: ${artifact.title}`);
    return this.artifacts.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref], execute: async () => {
      const repair = await this.artifacts.repairRevisionSource(artifactId);
      return { resource: artifact, ref: artifact.file_ref, summary: repair.repaired ? `Repaired artifact ${artifact.title}.` : `Artifact ${artifact.title} did not require repair.`, extra: { repair } };
    }});
  }

  private async restoreArtifactRevision(input: { artifactId: string; revisionId: string; baseRevisionId?: string; changeSummary?: string }) {
    const contract = this.artifacts.contract("artifact.restore_revision");
    const artifact = await this.artifacts.getArtifact(input.artifactId); const sourceRevision = await this.artifacts.getRevision(input.revisionId);
    if (!artifact || !sourceRevision || sourceRevision.artifact_id !== input.artifactId) throw this.artifacts.requestError("not_found", "artifact_revision_not_found");
    const content = await this.artifacts.readRevisionContent(input.revisionId);
    if (!content) throw this.artifacts.requestError("not_found", "artifact_revision_content_not_found");
    return this.saveRevision(contract, artifact, `Restore artifact revision: ${artifact.title}`, {
      artifactId: input.artifactId, content, baseRevisionId: input.baseRevisionId || currentRevisionId(artifact), editorSource: "restore",
      changeSummary: input.changeSummary || `Restored revision ${sourceRevision.revision}.`, provenance: { restored_from_revision_id: sourceRevision.id }
    }, [sourceRevision.file_ref], `Restored revision ${sourceRevision.revision} of ${artifact.title}.`);
  }

  private async reviseArtifact(input: ArtifactRevisionInput, source: DomainCommandInputSource) {
    const contract = this.artifacts.contract("artifact.revise");
    if (!input.content) throw this.artifacts.requestError("conflict", "artifact_revision_content_required");
    const artifact = await this.artifacts.getArtifact(input.artifactId);
    if (!artifact) throw this.artifacts.requestError("not_found", "artifact_not_found");
    if (artifact.kind === "graph") parseGraph(input.content, this.artifacts);
    const session = input.sessionId ? await this.artifacts.getSession(input.sessionId) : await this.artifacts.ensureSession();
    if (!session) throw this.artifacts.requestError("not_found", "session_not_found");
    return this.saveRevision(contract, artifact, `Revise artifact: ${artifact.title}`, { ...input, editorSource: editorSource(input.editorSource, source) }, [], `Created revision of ${artifact.title}.`, session);
  }

  private async patchGraphArtifact(input: { artifactId: string; patch: Record<string, JsonValue>; baseRevisionId?: string; editorSource?: string; changeSummary?: string; provenance: Record<string, JsonValue> }, source: DomainCommandInputSource) {
    const contract = this.artifacts.contract("graph.patch"); const artifact = await this.artifacts.getArtifact(input.artifactId);
    if (!artifact || artifact.kind !== "graph") throw this.artifacts.requestError("not_found", "graph_artifact_not_found");
    const content = await this.artifacts.readContent(input.artifactId); if (!content) throw this.artifacts.requestError("not_found", "graph_document_content_not_found");
    const next = applyGraphPatch(parseGraph(content, this.artifacts), input.patch, this.artifacts);
    return this.saveRevision(contract, artifact, `Edit graph: ${artifact.title}`, { artifactId: input.artifactId, content: `${JSON.stringify(next, null, 2)}\n`, extension: "json", baseRevisionId: input.baseRevisionId || currentRevisionId(artifact), editorSource: editorSource(input.editorSource, source), changeSummary: input.changeSummary || "Updated graph nodes and edges.", provenance: input.provenance }, [], `Updated graph ${artifact.title}.`);
  }

  private async editImageArtifact(payload: Record<string, JsonValue>) {
    const artifact = await this.artifacts.getArtifact(requiredId(payload, "artifact_id"));
    if (!artifact || artifact.kind !== "image") throw this.artifacts.requestError("not_found", "image_artifact_not_found");
    const image = imageResult(payload, this.artifacts);
    return this.saveRevision(this.artifacts.contract("image.edit"), artifact, `Save edited image: ${artifact.title}`, { artifactId: artifact.id, content: image.bytes, extension: image.extension, baseRevisionId: optionalString(payload.base_revision_id) || currentRevisionId(artifact), producerRunId: image.sourceRunId, editorSource: "image_provider", changeSummary: optionalString(payload.change_summary) || "Saved image provider edit.", provenance: imageProvenance("edit", image, artifact.id) }, [], `Saved edited image ${artifact.title}.`);
  }

  private async generateImageArtifact(payload: Record<string, JsonValue>) {
    const contract = this.artifacts.contract("image.generate"); const image = imageResult(payload, this.artifacts); const session = await this.artifacts.ensureSession();
    const title = optionalString(payload.title) || "Generated image"; const envelope = this.artifacts.createEnvelope(session, `Save generated image: ${title}`);
    return this.artifacts.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
      const artifact = await this.artifacts.createDraft({ operation, title, content: { bytes: image.bytes, mime_type: image.mimeType, extension: image.extension, preview: optionalString(payload.preview) || undefined }, kind: "image", locale: locale(payload.output_locale) ?? session.output_locale, sourceLocales: [locale(payload.input_locale) ?? session.ui_locale], createdBy: "image_provider", metadata: { image_operation: "generate", ...imageProvenance("generate", image) } });
      const created = await this.artifacts.createRevision({ artifactId: artifact.id, content: image.bytes, extension: image.extension, producerRunId: image.sourceRunId, editorSource: "image_provider", changeSummary: "Saved generated image provider result.", provenance: imageProvenance("generate", image) });
      const rollbackPoint = await this.artifacts.createRollback(operation, [artifact.file_ref, created.revision.file_ref], {}, { artifact_id: artifact.id });
      return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary: `Saved generated image ${artifact.title}.`, extra: { revision: created.revision } };
    }});
  }

  private async saveRevision(contract: { id: string; proposed_effects: string[] }, artifact: ArtifactRecord, message: string, input: ArtifactRevisionInputPort, extraRefs: ResourceRef[], summary: string, givenSession?: SessionRecord) {
    const session = givenSession ?? await this.artifacts.ensureSession(); const envelope = this.artifacts.createEnvelope(session, message);
    return this.artifacts.runMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref, ...extraRefs], execute: async (operation) => {
      const created = await this.artifacts.createRevision(input); const rollbackPoint = await this.artifacts.createRollback(operation, [artifact.file_ref, created.revision.file_ref], { artifact: artifact as unknown as JsonValue }, { artifact: created.artifact as unknown as JsonValue });
      return { resource: created.artifact, ref: created.artifact.file_ref, rollbackPoint, summary, extra: { revision: created.revision } };
    }});
  }
}

function createInput(payload: Record<string, JsonValue>, graph: boolean): ArtifactCreateInput {
  const instruction = optionalString(payload.instruction) || optionalString(payload.content) || optionalString(payload.body);
  if (!instruction) throw new Error("domain_command_artifact_instruction_required");
  return {
    sessionId: optionalString(payload.session_id) || undefined,
    title: optionalString(payload.title) || "Untitled artifact",
    instruction,
    kind: graph ? "graph" : artifactKind(payload.kind),
    uiLocale: locale(payload.ui_locale), inputLocale: locale(payload.input_locale), outputLocale: locale(payload.output_locale),
    providerToolCall: graph || payload.provider_tool_call === true,
    metadata: recordValue(payload.metadata), envelopeId: optionalString(payload.envelope_id) || optionalString(payload.input_message_id) || undefined,
    surfaceOperationId: optionalString(payload.surface_operation_id) || undefined
  };
}
function revisionInput(payload: Record<string, JsonValue>): ArtifactRevisionInput {
  return {
    artifactId: requiredId(payload, "artifact_id"), content: optionalString(payload.content), sessionId: optionalString(payload.session_id) || undefined,
    producerRunId: optionalString(payload.producer_run_id) || undefined, extension: optionalString(payload.extension) || undefined,
    baseRevisionId: optionalString(payload.base_revision_id) || undefined, editorSource: optionalString(payload.editor_source) || undefined,
    changeSummary: optionalString(payload.change_summary) || undefined, provenance: recordValue(payload.provenance)
  };
}
function optionalString(value: JsonValue | undefined): string { return typeof value === "string" ? value.trim() : ""; }
function requiredId(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]) || optionalString(payload.id);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
function recordValue(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function locale(value: JsonValue | undefined): SupportedLocale | undefined { return typeof value === "string" && supportedLocales.includes(value as SupportedLocale) ? value as SupportedLocale : undefined; }
function artifactKind(value: JsonValue | undefined): ArtifactKind | undefined {
  return value === "markdown" || value === "document" || value === "table" || value === "chart" || value === "graph" || value === "image" || value === "pdf" || value === "structured_draft" || value === "generated_report" || value === "note" ? value : undefined;
}

function currentRevisionId(artifact: ArtifactRecord): string | undefined { return typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined; }
function editorSource(value: string | undefined, source: DomainCommandInputSource): ArtifactRevisionInputPort["editorSource"] {
  if (value === "chat" || value === "surface" || value === "provider" || value === "image_provider" || value === "restore" || value === "system") return value;
  if (source === "surface_operation" || source === "generated_surface") return "surface";
  return source === "provider_tool_call" ? "provider" : "system";
}
function parseGraph(content: string, port: ArtifactExecutionPort): GraphDocument {
  try { return GraphDocumentSchema.parse(JSON.parse(content)); }
  catch { throw port.requestError("conflict", "graph_document_invalid"); }
}
function stringArray(value: JsonValue | undefined): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []; }
function applyGraphPatch(current: GraphDocument, payload: Record<string, JsonValue>, port: ArtifactExecutionPort): GraphDocument {
  try {
    if (payload.document && typeof payload.document === "object" && !Array.isArray(payload.document)) return GraphDocumentSchema.parse(payload.document);
    const nodes = new Map(current.nodes.map((node) => [node.id, node])); const edges = new Map(current.edges.map((edge) => [edge.id, edge]));
    for (const id of stringArray(payload.delete_node_ids)) nodes.delete(id); for (const id of stringArray(payload.delete_edge_ids)) edges.delete(id);
    for (const value of Array.isArray(payload.nodes) ? payload.nodes : []) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); const id = typeof value.id === "string" ? value.id : ""; nodes.set(id, GraphNodeSchema.parse({ ...nodes.get(id), ...value })); }
    for (const value of Array.isArray(payload.edges) ? payload.edges : []) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); const id = typeof value.id === "string" ? value.id : ""; edges.set(id, GraphEdgeSchema.parse({ ...edges.get(id), ...value })); }
    return GraphDocumentSchema.parse({ version: "1", nodes: [...nodes.values()], edges: [...edges.values()] });
  } catch { throw port.requestError("conflict", "graph_document_invalid"); }
}
interface ImageResult { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml"; extension: "png" | "jpg" | "webp" | "svg"; provider: string; prompt: string; sourceRunId: string; width: number; height: number; provenance: Record<string, JsonValue> }
function imageResult(payload: Record<string, JsonValue>, port: ArtifactExecutionPort): ImageResult {
  const provider = optionalString(payload.provider), prompt = optionalString(payload.prompt), sourceRunId = optionalString(payload.source_run_id), encoded = optionalString(payload.data_base64), mimeType = optionalString(payload.mime_type);
  const width = typeof payload.width === "number" ? payload.width : 0, height = typeof payload.height === "number" ? payload.height : 0;
  if (!provider || !prompt || !sourceRunId || !encoded || !Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw port.requestError("conflict", "image_provider_result_incomplete");
  const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" } as const;
  if (!(mimeType in extensions)) throw port.requestError("conflict", "image_mime_type_unsupported");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw port.requestError("conflict", "image_data_invalid");
  const bytes = Buffer.from(encoded, "base64"); if (!bytes.byteLength) throw port.requestError("conflict", "image_data_invalid");
  return { bytes, mimeType: mimeType as ImageResult["mimeType"], extension: extensions[mimeType as keyof typeof extensions], provider, prompt, sourceRunId, width, height, provenance: recordValue(payload.provenance) };
}
function imageProvenance(operation: "edit" | "generate", image: ImageResult, sourceAssetId?: string): Record<string, JsonValue> {
  return { operation, prompt: image.prompt, provider: image.provider, source_run_id: image.sourceRunId, mime_type: image.mimeType, width: image.width, height: image.height, ...(sourceAssetId ? { source_asset_id: sourceAssetId } : {}), ...image.provenance };
}
