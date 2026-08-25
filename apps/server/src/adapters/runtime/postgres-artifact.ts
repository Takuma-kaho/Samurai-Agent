import { createHash } from "node:crypto";
import { ArtifactRecordSchema, ArtifactRevisionRecordSchema, nowIso, type ArtifactRecord, type ArtifactRevisionRecord, type JsonValue, type SupportedLocale } from "@samurai-agent/core-schemas";
import { createSurfaceRenderSpec, type SurfaceOperation, type SurfaceOperationResultEnvelope, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  canonicalJson,
  WorkspaceServerError,
  type WorkspaceCompletionActivityInput,
  type WorkspaceCompletionActivityResult,
  type WorkspaceServerCommandService,
  type WorkspaceFileStore,
  type WorkspaceRecord,
  type WorkspaceRequestContext
} from "@samurai-agent/workspace-server";

export interface PostgresArtifactCreateInput {
  roomId: string;
  title: string;
  content: string | Record<string, JsonValue> | JsonValue[];
  kind?: ArtifactRecord["kind"];
  locale?: SupportedLocale;
  sourceLocales?: SupportedLocale[];
  metadata?: Record<string, JsonValue>;
}

export interface PostgresArtifactRevisionInput {
  roomId: string;
  artifactId: string;
  content: string | Uint8Array;
  baseRevisionId?: string;
  expectedRevision?: number;
  editorSource?: ArtifactRevisionRecord["editor_source"];
  changeSummary?: string;
  provenance?: Record<string, JsonValue>;
  extension?: string;
}

type CompletionActivityIngest = (
  context: WorkspaceRequestContext,
  input: WorkspaceCompletionActivityInput
) => Promise<WorkspaceCompletionActivityResult>;

const ARTIFACT_TRANSACTION_RECORD_TYPE = "artifact_transaction";
type ArtifactTransactionPhase = "prepared" | "files_written" | "records_written" | "activity_confirmed" | "completed";
type ArtifactTransactionPayload = {
  transaction_id: string;
  request_hash: string;
  kind: "create" | "revise";
  phase: ArtifactTransactionPhase;
  room_id: string;
  artifact_id: string;
  revision_id?: string;
  content_base64: string;
  content_hash: string;
  file_path: string;
  blob_path?: string;
  artifact_payload?: Record<string, unknown>;
  revision_payload?: Record<string, unknown>;
  artifact_record_version?: number;
  revision_record_version?: number;
  created_at: string;
};
type ArtifactTransactionRecord = { record: WorkspaceRecord; payload: ArtifactTransactionPayload };

/** Room-scoped Artifact use case. Metadata is an indexed PostgreSQL record;
 * the human-readable/binary body is a Workspace File Transaction. */
export class PostgresArtifact {
  constructor(
    private readonly commands: WorkspaceServerCommandService,
    private readonly files: WorkspaceFileStore,
    private readonly ingestActivity: CompletionActivityIngest
  ) {}

  async list(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string): Promise<ArtifactRecord[]> {
    const records = await this.commands.listRecords(context, { roomId, recordType: "artifact", limit: 500 });
    return records
      .map((record) => artifactFromPayload(record.payload))
      .filter((artifact) => artifact.metadata.transaction_state !== "pending");
  }

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, artifactId: string): Promise<{ artifact: ArtifactRecord; content: string }> {
    const record = await this.commands.getRecord(context, { roomId, recordType: "artifact", id: artifactId });
    const artifact = artifactFromPayload(record.payload);
    if (artifact.metadata.transaction_state === "pending") {
      throw new WorkspaceServerError("artifact_recovery_required", 503, { artifact_id: artifact.id });
    }
    const file = await this.files.read(context, { roomId, path: artifact.file_ref.uri });
    const contentType = typeof artifact.metadata.content_type === "string" ? artifact.metadata.content_type : "";
    const binary = artifact.kind === "pdf" || artifact.kind === "image" || contentType === "application/pdf" || contentType.startsWith("image/");
    return { artifact, content: binary ? file.content.toString("base64") : file.content.toString("utf8") };
  }

  async getRevision(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<ArtifactRevisionRecord> {
    const record = await this.commands.getRecord(context, { roomId, recordType: "artifact_revision", id: revisionId });
    const revision = artifactRevisionFromPayload(record.payload);
    const transaction = await this.findActiveTransaction(context, roomId, { revisionId });
    if (transaction) {
      throw new WorkspaceServerError("artifact_revision_recovery_required", 503, { revision_id: revision.id });
    }
    return revision;
  }

  async readRevisionContent(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<Uint8Array> {
    const revision = await this.getRevision(context, roomId, revisionId);
    const file = await this.files.read(context, { roomId, path: revision.file_ref.uri });
    if (file.file.sha256 !== revision.content_hash) throw new WorkspaceServerError("artifact_revision_hash_mismatch", 500);
    return file.content;
  }

  async revise(context: WorkspaceRequestContext, input: PostgresArtifactRevisionInput): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord; replayed: boolean }> {
    const roomId = requiredText(input.roomId, "artifact_room_id_required", 160);
    const artifactRecord = await this.commands.getRecord(context, { roomId, recordType: "artifact", id: input.artifactId });
    const artifact = artifactFromPayload(artifactRecord.payload);
    const transactionId = artifactTransactionId(context, "revise", input.artifactId);
    const { content: _content, ...revisionRequest } = input;
    const requestHash = artifactRequestHash("revise", revisionRequest as unknown as Record<string, unknown>, Buffer.from(input.content));
    const existingTransaction = await this.readTransaction(context, roomId, transactionId);
    if (existingTransaction) {
      assertTransactionRequest(existingTransaction.payload, requestHash);
      const resumed = await this.resumeRevisionTransaction(context, existingTransaction);
      return { ...resumed, replayed: true };
    }
    if (artifact.metadata.transaction_state === "pending") {
      throw new WorkspaceServerError("artifact_recovery_required", 503, { artifact_id: artifact.id });
    }

    const current = await this.currentRevision(context, roomId, artifact);
    assertRevisionExpectation(current, input.baseRevisionId, input.expectedRevision);
    const revisionId = `artifact_revision_${createHash("sha256").update(`${context.workspaceId}|${context.operationId}|${input.artifactId}`).digest("hex").slice(0, 40)}`;
    const bytes = Buffer.from(input.content);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const revisionNumber = (current?.revision ?? 0) + 1;
    const extension = safeExtension(input.extension ?? pathExtension(artifact.file_ref.uri));
    const revisionPath = `artifacts/${artifact.id}/revisions/${revisionNumber}-${revisionId}.${extension}`;
    const blobPath = `artifacts/${artifact.id}/blobs/${contentHash}.${extension}`;
    const now = nowIso();
    const revision = ArtifactRevisionRecordSchema.parse({
      id: revisionId,
      artifact_id: artifact.id,
      revision: revisionNumber,
      ...(current ? { parent_revision_id: current.id } : {}),
      ...(input.baseRevisionId ? { base_revision_id: input.baseRevisionId } : {}),
      ...(input.editorSource ? { editor_source: input.editorSource } : {}),
      ...(input.changeSummary ? { change_summary: input.changeSummary } : {}),
      provenance: input.provenance ?? {},
      source_ref: artifact.file_ref,
      file_ref: { kind: "artifact_revision", id: revisionId, uri: revisionPath, label: `${artifact.title} r${revisionNumber}` },
      blob_ref: { kind: "artifact_blob", id: contentHash, uri: blobPath, label: contentHash },
      content_hash: contentHash,
      content_bytes: bytes.byteLength,
      created_at: now
    });
    const transaction = await this.putTransaction(context, roomId, transactionId, {
      transaction_id: transactionId,
      request_hash: requestHash,
      kind: "revise",
      phase: "prepared",
      room_id: roomId,
      artifact_id: artifact.id,
      revision_id: revision.id,
      content_base64: bytes.toString("base64"),
      content_hash: contentHash,
      file_path: revisionPath,
      blob_path: blobPath,
      artifact_payload: artifact as unknown as Record<string, unknown>,
      revision_payload: revision as unknown as Record<string, unknown>,
      artifact_record_version: artifactRecord.version,
      created_at: now
    }, 0);
    const resumed = await this.resumeRevisionTransaction(context, transaction);
    return { ...resumed, replayed: false };
  }

  async restoreRevision(context: WorkspaceRequestContext, input: { roomId: string; artifactId: string; revisionId: string; baseRevisionId?: string; expectedRevision?: number; changeSummary?: string }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord; replayed: boolean }> {
    const content = await this.readRevisionContent(context, input.roomId, input.revisionId);
    const source = await this.getRevision(context, input.roomId, input.revisionId);
    if (source.artifact_id !== input.artifactId) throw new WorkspaceServerError("artifact_revision_not_found", 404);
    return this.revise(context, {
      roomId: input.roomId,
      artifactId: input.artifactId,
      content,
      baseRevisionId: input.baseRevisionId,
      expectedRevision: input.expectedRevision,
      editorSource: "restore",
      changeSummary: input.changeSummary ?? `Restore revision ${source.revision}`,
      provenance: { restored_from_revision_id: source.id },
      extension: pathExtension(source.file_ref.uri)
    });
  }

  async create(context: WorkspaceRequestContext, input: PostgresArtifactCreateInput): Promise<{ artifact: ArtifactRecord; content: string; replayed: boolean }> {
    const roomId = requiredText(input.roomId, "artifact_room_id_required", 160);
    const title = requiredText(input.title, "artifact_title_required", 20_000);
    const kind = input.kind ?? "markdown";
    const content = serializeContent(input.content);
    const artifactId = `artifact_${createHash("sha256").update(`${context.workspaceId}|${context.operationId}`).digest("hex").slice(0, 40)}`;
    const extension = kind === "pdf" ? "pdf" : kind === "image" ? "bin" : kind === "table" || kind === "chart" || kind === "graph" || kind === "structured_draft" ? "json" : "md";
    const filePath = `artifacts/${artifactId}.${extension}`;
    const now = nowIso();
    const contentHash = createHash("sha256").update(content).digest("hex");
    const artifact = ArtifactRecordSchema.parse({
      id: artifactId,
      title,
      kind,
      locale: input.locale ?? "ja",
      source_locales: input.sourceLocales ?? [input.locale ?? "ja"],
      file_ref: { kind: "artifact", id: artifactId, uri: filePath, version: now, label: title },
      metadata: {
        ...userArtifactMetadata(input.metadata),
        content_type: kind === "pdf" ? "application/pdf" : kind === "image" ? "image/*" : kind === "table" || kind === "chart" || kind === "graph" || kind === "structured_draft" ? "application/json" : "text/markdown",
        status: "draft",
        byte_size: Buffer.byteLength(content, "utf8"),
        content_hash: contentHash,
        preview: createPreview(content),
        word_count: content.trim().split(/\s+/).filter(Boolean).length
      },
      source_operation_id: context.operationId,
      created_by: context.accountId,
      created_at: now,
      updated_at: now
    });

    const transactionId = artifactTransactionId(context, "create", artifactId);
    const requestHash = artifactRequestHash("create", {
      roomId,
      title,
      kind,
      locale: input.locale,
      sourceLocales: input.sourceLocales,
      metadata: input.metadata
    }, Buffer.from(content));
    const existingTransaction = await this.readTransaction(context, roomId, transactionId);
    if (existingTransaction) {
      assertTransactionRequest(existingTransaction.payload, requestHash);
      const resumed = await this.resumeCreateTransaction(context, existingTransaction);
      return { ...resumed, replayed: true };
    }

    let existing: WorkspaceRecord | undefined;
    try {
      existing = await this.commands.getRecord({ workspaceId: context.workspaceId, accountId: context.accountId }, { roomId, recordType: "artifact", id: artifactId });
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    if (existing) {
      const saved = artifactFromPayload(existing.payload);
      if (saved.metadata.transaction_state === "pending") {
        throw new WorkspaceServerError("artifact_recovery_required", 503, { artifact_id: saved.id });
      }
      const body = await this.files.read(context, { roomId, path: saved.file_ref.uri });
      await this.ensureCreationActivity(context, roomId, saved);
      return { artifact: saved, content: body.content.toString("utf8"), replayed: true };
    }

    const transaction = await this.putTransaction(context, roomId, transactionId, {
      transaction_id: transactionId,
      request_hash: requestHash,
      kind: "create",
      phase: "prepared",
      room_id: roomId,
      artifact_id: artifactId,
      content_base64: Buffer.from(content).toString("base64"),
      content_hash: contentHash,
      file_path: filePath,
      artifact_payload: artifact as unknown as Record<string, unknown>,
      created_at: now
    }, 0);
    const resumed = await this.resumeCreateTransaction(context, transaction);
    return { ...resumed, replayed: false };
  }

  async runSurfaceOperation(context: WorkspaceRequestContext, roomId: string, operation: SurfaceOperation): Promise<SurfaceOperationResultEnvelope> {
    if (operation.kind !== "artifact.request") throw new WorkspaceServerError("artifact_surface_operation_kind_invalid", 400);
    if (operation.action !== "create" && !operation.artifact_id) throw new WorkspaceServerError("artifact_id_required", 400);
    const source = operation.artifact_id ? await this.get(context, roomId, operation.artifact_id) : undefined;
    if ((operation.action === "preview" || operation.action === "export") && !source) {
      throw new WorkspaceServerError("artifact_id_required", 400);
    }
    if (operation.action === "preview" || operation.action === "export") {
      const preview = source;
      if (!preview) throw new WorkspaceServerError("artifact_id_required", 400);
      const renderSpec = artifactRenderSpec(operation, preview.artifact, preview.artifact);
      return {
        operation,
        result_kind: "artifact",
        render_spec: renderSpec,
        render_specs: [renderSpec],
        result: preview
      };
    }
    const content = operation.instruction;
    const created = await this.create(context, {
      roomId,
      title: operation.title?.trim() || source?.artifact.title || "Artifact request",
      content,
      kind: source?.artifact.kind ?? "markdown",
      metadata: { surface_operation_id: operation.id, surface_operation_kind: operation.kind, ...(source ? { source_artifact_id: source.artifact.id } : {}) }
    });
    const renderSpec = artifactRenderSpec(operation, created.artifact, source?.artifact);
    return { operation, result_kind: "artifact", render_spec: renderSpec, render_specs: [renderSpec], result: created };
  }

  private async ensureCreationActivity(context: WorkspaceRequestContext, roomId: string, artifact: ArtifactRecord): Promise<void> {
    const activityContext = childContext(context, "activity");
    const activityId = `artifact_activity_${createHash("sha256").update(`${context.workspaceId}|${artifact.id}`).digest("hex").slice(0, 40)}`;
    await this.ingestActivity(activityContext, {
      id: activityId,
      roomId,
      sourceApp: "workspace-artifact",
      sourceId: artifact.id,
      operationId: context.operationId,
      instructionSummary: `Artifactを保存: ${artifact.title}`,
      resultSummary: `Artifact ${artifact.kind} をFile Transactionで確定`,
      changedResources: [artifact.id],
      verificationOutcome: "confirmed",
      failureState: "none",
      outcome: "completed",
      payload: {
        artifact_id: artifact.id,
        artifact_kind: artifact.kind,
        file_path: artifact.file_ref.uri,
        content_hash: typeof artifact.metadata.content_hash === "string" ? artifact.metadata.content_hash : ""
      }
    });
  }

  private async ensureRevisionActivity(context: WorkspaceRequestContext, roomId: string, artifact: ArtifactRecord, revision: ArtifactRevisionRecord): Promise<void> {
    await this.ingestActivity(childContext(context, "revision_activity"), {
      id: `artifact_revision_activity_${createHash("sha256").update(`${context.workspaceId}|${revision.id}`).digest("hex").slice(0, 40)}`,
      roomId,
      sourceApp: "workspace-artifact",
      sourceId: revision.id,
      operationId: context.operationId,
      instructionSummary: `Artifactを改訂: ${artifact.title}`,
      resultSummary: `Artifact revision ${revision.revision} をFile Transactionで確定`,
      changedResources: [artifact.id, revision.id],
      verificationOutcome: "confirmed",
      failureState: "none",
      outcome: "completed",
      payload: { artifact_id: artifact.id, revision_id: revision.id, content_hash: revision.content_hash, file_path: revision.file_ref.uri }
    });
  }

  private async currentRevision(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, artifact: ArtifactRecord): Promise<ArtifactRevisionRecord | undefined> {
    const id = typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined;
    if (id) return this.getRevision(context, roomId, id);
    const records = await this.commands.listRecords(context, { roomId, recordType: "artifact_revision", limit: 500 });
    return records
      .map((record) => artifactRevisionFromPayload(record.payload))
      .filter((revision) => revision.artifact_id === artifact.id)
      .sort((left, right) => right.revision - left.revision)[0];
  }

  private async readTransaction(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    transactionId: string
  ): Promise<ArtifactTransactionRecord | undefined> {
    try {
      const record = await this.commands.getRecord(context, { roomId, recordType: ARTIFACT_TRANSACTION_RECORD_TYPE, id: transactionId });
      const payload = artifactTransactionFromPayload(record.payload);
      if (payload.room_id !== roomId || payload.transaction_id !== transactionId) {
        throw new WorkspaceServerError("artifact_transaction_invalid", 503);
      }
      return { record, payload };
    } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async findActiveTransaction(
    context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">,
    roomId: string,
    match: { artifactId?: string; revisionId?: string }
  ): Promise<ArtifactTransactionPayload | undefined> {
    const records = await this.commands.listRecords(context, { roomId, recordType: ARTIFACT_TRANSACTION_RECORD_TYPE, limit: 500 });
    for (const record of records) {
      const transaction = artifactTransactionFromPayload(record.payload);
      if (transaction.phase === "completed") continue;
      if (match.artifactId && transaction.artifact_id !== match.artifactId) continue;
      if (match.revisionId && transaction.revision_id !== match.revisionId) continue;
      return transaction;
    }
    return undefined;
  }

  private async putTransaction(
    context: WorkspaceRequestContext,
    roomId: string,
    transactionId: string,
    payload: ArtifactTransactionPayload,
    expectedVersion: number
  ): Promise<ArtifactTransactionRecord> {
    const saved = await this.commands.putRecord(transactionContext(context, transactionId, payload.phase, expectedVersion), {
      roomId,
      recordType: ARTIFACT_TRANSACTION_RECORD_TYPE,
      id: transactionId,
      payload: payload as unknown as Record<string, unknown>,
      searchText: `${payload.kind} ${payload.artifact_id} ${payload.revision_id ?? ""}`,
      expectedVersion
    });
    return { record: saved.record, payload };
  }

  private async setTransactionPhase(
    context: WorkspaceRequestContext,
    transaction: ArtifactTransactionRecord,
    phase: ArtifactTransactionPhase
  ): Promise<ArtifactTransactionRecord> {
    if (transactionPhaseRank(transaction.payload.phase) >= transactionPhaseRank(phase)) return transaction;
    return this.putTransaction(context, transaction.payload.room_id, transaction.record.id, { ...transaction.payload, phase }, transaction.record.version);
  }

  private async completeTransaction(context: WorkspaceRequestContext, transaction: ArtifactTransactionRecord): Promise<void> {
    const completed = await this.setTransactionPhase(context, transaction, "completed");
    try {
      await this.commands.deleteRecord(transactionContext(context, completed.record.id, "delete", completed.record.version), {
        roomId: completed.payload.room_id,
        recordType: ARTIFACT_TRANSACTION_RECORD_TYPE,
        id: completed.record.id,
        expectedVersion: completed.record.version
      });
    } catch {
      // A completed marker is safe to retain. A later retry sees the marker
      // and does not expose an unfinished Artifact; cleanup is best effort.
    }
  }

  private async ensureFileContent(context: WorkspaceRequestContext, roomId: string, filePath: string, content: Uint8Array, errorCode: string): Promise<void> {
    const expectedHash = createHash("sha256").update(content).digest("hex");
    try {
      const existing = await this.files.read(context, { roomId, path: filePath });
      if (existing.file.sha256 !== expectedHash) throw new WorkspaceServerError(errorCode, 409, { path: filePath });
      return;
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    try {
      await this.files.write({ ...context, operationId: `${context.operationId}_${hashPath(filePath)}` }, { roomId, path: filePath, content, expectedVersion: 0 });
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 409) throw error;
      const existing = await this.files.read(context, { roomId, path: filePath });
      if (existing.file.sha256 !== expectedHash) throw new WorkspaceServerError(errorCode, 409, { path: filePath });
    }
  }

  private async resumeCreateTransaction(context: WorkspaceRequestContext, transaction: ArtifactTransactionRecord): Promise<{ artifact: ArtifactRecord; content: string }> {
    if (transaction.payload.kind !== "create" || !transaction.payload.artifact_payload) throw new WorkspaceServerError("artifact_transaction_invalid", 503);
    const bytes = Buffer.from(transaction.payload.content_base64, "base64");
    await this.ensureFileContent(context, transaction.payload.room_id, transaction.payload.file_path, bytes, "artifact_creation_file_conflict");
    let current = await this.setTransactionPhase(context, transaction, "files_written");
    let record: WorkspaceRecord | undefined;
    try {
      record = await this.commands.getRecord(context, { roomId: transaction.payload.room_id, recordType: "artifact", id: transaction.payload.artifact_id });
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    let artifact: ArtifactRecord;
    if (!record) {
      const base = artifactFromPayload(transaction.payload.artifact_payload);
      const pending = artifactWithTransactionState(base, "pending");
      const saved = await this.commands.putRecord(transactionContext(context, transaction.record.id, "artifact", 0), {
        roomId: transaction.payload.room_id,
        recordType: "artifact",
        id: pending.id,
        payload: pending as unknown as Record<string, unknown>,
        searchText: `${pending.title} ${bytes.toString("utf8").slice(0, 4_000)}`,
        expectedVersion: 0
      });
      record = saved.record;
    }
    artifact = artifactFromPayload(record.payload);
    if (artifact.metadata.content_hash !== transaction.payload.content_hash) throw new WorkspaceServerError("artifact_creation_hash_conflict", 409);
    current = await this.setTransactionPhase(context, current, "records_written");
    await this.ensureCreationActivity(context, transaction.payload.room_id, artifact);
    if (artifact.metadata.transaction_state === "pending") {
      const ready = artifactWithTransactionState(artifact, "ready");
      const saved = await this.commands.putRecord(transactionContext(context, transaction.record.id, "artifact_ready", record.version), {
        roomId: transaction.payload.room_id,
        recordType: "artifact",
        id: artifact.id,
        payload: ready as unknown as Record<string, unknown>,
        searchText: `${ready.title} ${bytes.toString("utf8").slice(0, 4_000)}`,
        expectedVersion: record.version
      });
      artifact = artifactFromPayload(saved.record.payload);
    }
    current = await this.setTransactionPhase(context, current, "activity_confirmed");
    await this.completeTransaction(context, current);
    return { artifact, content: bytes.toString("utf8") };
  }

  private async resumeRevisionTransaction(
    context: WorkspaceRequestContext,
    transaction: ArtifactTransactionRecord
  ): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }> {
    if (transaction.payload.kind !== "revise" || !transaction.payload.revision_payload || !transaction.payload.blob_path) throw new WorkspaceServerError("artifact_transaction_invalid", 503);
    const bytes = Buffer.from(transaction.payload.content_base64, "base64");
    const revision = artifactRevisionFromPayload(transaction.payload.revision_payload);
    await this.ensureFileContent(context, transaction.payload.room_id, transaction.payload.file_path, bytes, "artifact_revision_file_conflict");
    await this.ensureFileContent(context, transaction.payload.room_id, transaction.payload.blob_path, bytes, "artifact_revision_blob_conflict");
    let current = await this.setTransactionPhase(context, transaction, "files_written");

    let revisionRecord: WorkspaceRecord | undefined;
    try {
      revisionRecord = await this.commands.getRecord(context, { roomId: transaction.payload.room_id, recordType: "artifact_revision", id: revision.id });
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    if (revisionRecord) {
      const stored = artifactRevisionFromPayload(revisionRecord.payload);
      if (stored.content_hash !== revision.content_hash) throw new WorkspaceServerError("artifact_revision_hash_conflict", 409);
    } else {
      const savedRevision = await this.commands.putRecord(transactionContext(context, transaction.record.id, "revision", 0), {
        roomId: transaction.payload.room_id,
        recordType: "artifact_revision",
        id: revision.id,
        payload: revision as unknown as Record<string, unknown>,
        searchText: `${artifactFromPayload(transaction.payload.artifact_payload ?? {}).title} ${revision.change_summary ?? ""}`,
        expectedVersion: 0
      });
      revisionRecord = savedRevision.record;
    }
    current = await this.setTransactionPhase(context, current, "records_written");

    const latest = await this.commands.getRecord(context, { roomId: transaction.payload.room_id, recordType: "artifact", id: revision.artifact_id });
    let artifact = artifactFromPayload(latest.payload);
    const currentRevisionNumber = typeof artifact.metadata.current_revision === "number" ? artifact.metadata.current_revision : 0;
    if (artifact.metadata.current_revision_id && artifact.metadata.current_revision_id !== revision.id && currentRevisionNumber > revision.revision) {
      throw new WorkspaceServerError("artifact_revision_conflict", 409);
    }
    if (artifact.metadata.current_revision_id !== revision.id || artifact.metadata.transaction_state === "pending") {
      const pending = artifactWithTransactionState(artifactWithRevision(artifact, revision, nowIso(), bytes), "pending");
      const savedArtifact = await this.commands.putRecord(transactionContext(context, transaction.record.id, "artifact", latest.version), {
        roomId: transaction.payload.room_id,
        recordType: "artifact",
        id: artifact.id,
        payload: pending as unknown as Record<string, unknown>,
        searchText: `${pending.title} ${revision.change_summary ?? ""} ${bytes.toString("utf8").slice(0, 4_000)}`,
        expectedVersion: latest.version
      });
      artifact = artifactFromPayload(savedArtifact.record.payload);
    }
    await this.ensureRevisionActivity(context, transaction.payload.room_id, artifact, revision);
    if (artifact.metadata.transaction_state === "pending") {
      const ready = artifactWithTransactionState(artifact, "ready");
      const currentArtifactRecord = await this.commands.getRecord(context, { roomId: transaction.payload.room_id, recordType: "artifact", id: artifact.id });
      const savedArtifact = await this.commands.putRecord(transactionContext(context, transaction.record.id, "artifact_ready", currentArtifactRecord.version), {
        roomId: transaction.payload.room_id,
        recordType: "artifact",
        id: artifact.id,
        payload: ready as unknown as Record<string, unknown>,
        searchText: `${ready.title} ${revision.change_summary ?? ""}`,
        expectedVersion: currentArtifactRecord.version
      });
      artifact = artifactFromPayload(savedArtifact.record.payload);
    }
    current = await this.setTransactionPhase(context, current, "activity_confirmed");
    await this.completeTransaction(context, current);
    return { artifact, revision };
  }
}

function artifactFromPayload(payload: Record<string, unknown>): ArtifactRecord {
  const parsed = ArtifactRecordSchema.safeParse(payload);
  if (!parsed.success) throw new WorkspaceServerError("artifact_record_invalid", 503);
  return parsed.data;
}

function artifactTransactionFromPayload(payload: Record<string, unknown>): ArtifactTransactionPayload {
  if (!isRecord(payload)) throw new WorkspaceServerError("artifact_transaction_invalid", 503);
  const phase = payload.phase;
  const kind = payload.kind;
  if (
    typeof payload.transaction_id !== "string" ||
    typeof payload.request_hash !== "string" ||
    (kind !== "create" && kind !== "revise") ||
    !["prepared", "files_written", "records_written", "activity_confirmed", "completed"].includes(String(phase)) ||
    typeof payload.room_id !== "string" ||
    typeof payload.artifact_id !== "string" ||
    typeof payload.content_base64 !== "string" ||
    typeof payload.content_hash !== "string" ||
    typeof payload.file_path !== "string" ||
    typeof payload.created_at !== "string"
  ) {
    throw new WorkspaceServerError("artifact_transaction_invalid", 503);
  }
  return {
    transaction_id: payload.transaction_id,
    request_hash: payload.request_hash,
    kind,
    phase: phase as ArtifactTransactionPhase,
    room_id: payload.room_id,
    artifact_id: payload.artifact_id,
    ...(typeof payload.revision_id === "string" ? { revision_id: payload.revision_id } : {}),
    content_base64: payload.content_base64,
    content_hash: payload.content_hash,
    file_path: payload.file_path,
    ...(typeof payload.blob_path === "string" ? { blob_path: payload.blob_path } : {}),
    ...(isRecord(payload.artifact_payload) ? { artifact_payload: payload.artifact_payload } : {}),
    ...(isRecord(payload.revision_payload) ? { revision_payload: payload.revision_payload } : {}),
    ...(typeof payload.artifact_record_version === "number" ? { artifact_record_version: payload.artifact_record_version } : {}),
    ...(typeof payload.revision_record_version === "number" ? { revision_record_version: payload.revision_record_version } : {}),
    created_at: payload.created_at
  };
}

function artifactTransactionId(context: Pick<WorkspaceRequestContext, "workspaceId" | "operationId">, kind: "create" | "revise", resourceId: string): string {
  return `artifact_tx_${kind}_${createHash("sha256").update(`${context.workspaceId}|${context.operationId}|${resourceId}`).digest("hex").slice(0, 40)}`;
}

function artifactRequestHash(kind: "create" | "revise", input: Record<string, unknown>, content: Uint8Array): string {
  const contentHash = createHash("sha256").update(content).digest("hex");
  return createHash("sha256").update(canonicalJson({ kind, input: removeUndefined(input), content_hash: contentHash })).digest("hex");
}

function assertTransactionRequest(transaction: ArtifactTransactionPayload, requestHash: string): void {
  if (transaction.request_hash !== requestHash) throw new WorkspaceServerError("artifact_transaction_request_conflict", 409);
}

function transactionPhaseRank(phase: ArtifactTransactionPhase): number {
  return { prepared: 1, files_written: 2, records_written: 3, activity_confirmed: 4, completed: 5 }[phase];
}

function transactionContext(context: WorkspaceRequestContext, transactionId: string, step: string, expectedVersion: number): WorkspaceRequestContext {
  return { ...context, operationId: `${context.operationId}_artifact_tx_${hashPath(`${transactionId}:${step}:${expectedVersion}`)}` };
}

function artifactWithTransactionState(artifact: ArtifactRecord, state: "pending" | "ready"): ArtifactRecord {
  return ArtifactRecordSchema.parse({
    ...artifact,
    metadata: { ...artifact.metadata, transaction_state: state },
    updated_at: nowIso()
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, removeUndefined(item)]));
  }
  return value;
}

function artifactRevisionFromPayload(payload: Record<string, unknown>): ArtifactRevisionRecord {
  const parsed = ArtifactRevisionRecordSchema.safeParse(payload);
  if (!parsed.success) throw new WorkspaceServerError("artifact_revision_record_invalid", 503);
  return parsed.data;
}

function artifactWithRevision(artifact: ArtifactRecord, revision: ArtifactRevisionRecord, updatedAt = nowIso(), content?: Uint8Array): ArtifactRecord {
  const bytes = content?.byteLength ?? revision.content_bytes;
  const preview = content ? createPreview(Buffer.from(content).toString("utf8")) : artifact.metadata.preview;
  const wordCount = content ? Buffer.from(content).toString("utf8").trim().split(/\s+/).filter(Boolean).length : artifact.metadata.word_count;
  return ArtifactRecordSchema.parse({
    ...artifact,
    file_ref: revision.file_ref,
    metadata: {
      ...artifact.metadata,
      current_revision_id: revision.id,
      current_revision: revision.revision,
      content_hash: revision.content_hash,
      byte_size: bytes,
      ...(preview === undefined ? {} : { preview }),
      ...(wordCount === undefined ? {} : { word_count: wordCount })
    },
    updated_at: updatedAt
  });
}

function assertRevisionExpectation(current: ArtifactRevisionRecord | undefined, baseRevisionId?: string, expectedRevision?: number): void {
  if (baseRevisionId && baseRevisionId !== current?.id) throw new WorkspaceServerError("artifact_revision_conflict", 409);
  if (expectedRevision !== undefined && expectedRevision !== current?.revision) throw new WorkspaceServerError("artifact_revision_conflict", 409);
}

function pathExtension(value: string): string {
  const extension = value.split("/").pop()?.split(".").pop() ?? "md";
  return safeExtension(extension);
}

function safeExtension(value: string): string {
  const normalized = value.replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(normalized)) throw new WorkspaceServerError("artifact_extension_invalid", 400);
  return normalized;
}

function hashPath(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function serializeContent(content: string | Record<string, JsonValue> | JsonValue[]): string {
  return typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
}

function createPreview(content: string): string {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 140);
}

function artifactRenderSpec(operation: SurfaceOperation & { kind: "artifact.request" }, artifact: ArtifactRecord, source?: ArtifactRecord): SurfaceRenderSpec {
  return createSurfaceRenderSpec({
    kind: "artifact",
    priority: "primary",
    state: "ready",
    title: artifact.title,
    resource_refs: [artifact.file_ref, ...(source ? [source.file_ref] : [])],
    props: {
      artifact_id: artifact.id,
      file_path: artifact.file_ref.uri,
      title: artifact.title,
      action: operation.action,
      ...(source ? { source_artifact_id: source.id } : {})
    }
  });
}

function childContext(context: WorkspaceRequestContext, suffix: string): WorkspaceRequestContext {
  return { ...context, operationId: `${context.operationId}_${suffix}` };
}

function requiredText(value: string | undefined, code: string, max: number): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > max) throw new WorkspaceServerError(code, 400);
  return normalized;
}

function userArtifactMetadata(value: Record<string, JsonValue> | undefined): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== "transaction_state")) as Record<string, JsonValue>;
}
