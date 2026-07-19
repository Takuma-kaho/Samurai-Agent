import type { ArtifactKind } from "@samurai-agent/artifacts";
import {
  GraphDocumentSchema,
  type ActivityInboxItem, type ArtifactRecord, type ArtifactRevisionRecord, type GraphDocument, type JsonValue,
  type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint,
  type SessionRecord, type SupportedLocale
} from "@samurai-agent/core-schemas";

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
export type ArtifactMutationInput<TExtra extends Record<string, unknown>> = { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<MutationExecution<TExtra>> };
export interface ArtifactExecutionPort {
  contract(id: string): { id: string; proposed_effects: string[] };
  createSession(input: { title: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }): Promise<SessionRecord>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(session: SessionRecord, content: string, inputLocale?: SupportedLocale, outputLocale?: SupportedLocale, metadata?: Record<string, JsonValue>, envelopeId?: string): MessageEnvelope;
  runMutation<TExtra extends Record<string, unknown>>(input: ArtifactMutationInput<TExtra>): Promise<ArtifactWriteResult & TExtra>;
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

  contract(id: string) { return this.artifacts.contract(id); }
  getArtifact(id: string) { return this.artifacts.getArtifact(id); }
  ensureArtifactSession() { return this.artifacts.ensureSession(); }
  createArtifactEnvelope(session: SessionRecord, content: string, inputLocale?: SupportedLocale, outputLocale?: SupportedLocale, metadata?: Record<string, JsonValue>, envelopeId?: string) { return this.artifacts.createEnvelope(session, content, inputLocale, outputLocale, metadata, envelopeId); }
  repairRevisionSource(id: string) { return this.artifacts.repairRevisionSource(id); }
  artifactNotFoundError() { return this.artifacts.requestError("not_found", "artifact_not_found"); }
  runArtifactMutation<TExtra extends Record<string, unknown>>(input: ArtifactMutationInput<TExtra>) { return this.artifacts.runMutation(input); }
  getRevision(id: string) { return this.artifacts.getRevision(id); }
  readRevisionContent(id: string) { return this.artifacts.readRevisionContent(id); }
  createRevision(input: ArtifactRevisionInputPort) { return this.artifacts.createRevision(input); }
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.artifacts.createRollback(operation, refs, before, after); }
  artifactRevisionNotFoundError() { return this.artifacts.requestError("not_found", "artifact_revision_not_found"); }
  artifactRevisionContentNotFoundError() { return this.artifacts.requestError("not_found", "artifact_revision_content_not_found"); }
  decodeImageBase64(value: string) { return Buffer.from(value, "base64"); }
  createArtifactDraft(input: ArtifactDraftInput) { return this.artifacts.createDraft(input); }
  imageArtifactNotFoundError() { return this.artifacts.requestError("not_found", "image_artifact_not_found"); }
  getArtifactSession(id: string) { return this.artifacts.getSession(id); }
  artifactSessionNotFoundError() { return this.artifacts.requestError("not_found", "session_not_found"); }
  validateGraphContent(content: string) { parseGraph(content, this.artifacts); }
  readArtifactContent(id: string) { return this.artifacts.readContent(id); }
  exportArtifactPdf(input: { title: string; content: string; source: ArtifactRecord }) { return this.artifacts.exportPdf(input); }
  artifactPdfSourceNotTextError() { return this.artifacts.requestError("conflict", "artifact_pdf_source_not_text"); }
  artifactPdfInvalidResultError() { return this.artifacts.requestError("provider_failed", "pdf_export_invalid_result"); }
  createArtifactSession(input: { title: string; ui_locale?: SupportedLocale; output_locale?: SupportedLocale }) { return this.artifacts.createSession(input); }
  graphArtifactNotFoundError() { return this.artifacts.requestError("not_found", "graph_artifact_not_found"); }
  graphDocumentContentNotFoundError() { return this.artifacts.requestError("not_found", "graph_document_content_not_found"); }
  graphDocumentInvalidError() { return this.artifacts.requestError("conflict", "graph_document_invalid"); }
}

function parseGraph(content: string, port: ArtifactExecutionPort): GraphDocument {
  try { return GraphDocumentSchema.parse(JSON.parse(content)); }
  catch { throw port.requestError("conflict", "graph_document_invalid"); }
}
