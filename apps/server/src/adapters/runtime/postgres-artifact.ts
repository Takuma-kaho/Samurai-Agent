import { createHash } from "node:crypto";
import { ArtifactRecordSchema, ArtifactRevisionRecordSchema, nowIso, type ArtifactRecord, type ArtifactRevisionRecord, type JsonValue, type SupportedLocale } from "@samurai-agent/core-schemas";
import { createSurfaceRenderSpec, type SurfaceOperation, type SurfaceOperationResultEnvelope, type SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import {
  WorkspaceServerError,
  type WorkspaceCompletionActivityInput,
  type WorkspaceCompletionActivityResult,
  type WorkspaceServerCommandService,
  type WorkspaceFileStore,
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
    return records.map((record) => artifactFromPayload(record.payload));
  }

  async get(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, artifactId: string): Promise<{ artifact: ArtifactRecord; content: string }> {
    const record = await this.commands.getRecord(context, { roomId, recordType: "artifact", id: artifactId });
    const artifact = artifactFromPayload(record.payload);
    const file = await this.files.read(context, { roomId, path: artifact.file_ref.uri });
    const contentType = typeof artifact.metadata.content_type === "string" ? artifact.metadata.content_type : "";
    const binary = artifact.kind === "pdf" || artifact.kind === "image" || contentType === "application/pdf" || contentType.startsWith("image/");
    return { artifact, content: binary ? file.content.toString("base64") : file.content.toString("utf8") };
  }

  async getRevision(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<ArtifactRevisionRecord> {
    const record = await this.commands.getRecord(context, { roomId, recordType: "artifact_revision", id: revisionId });
    return artifactRevisionFromPayload(record.payload);
  }

  async readRevisionContent(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<Uint8Array> {
    const revision = await this.getRevision(context, roomId, revisionId);
    const file = await this.files.read(context, { roomId, path: revision.file_ref.uri });
    if (file.file.sha256 !== revision.content_hash) throw new WorkspaceServerError("artifact_revision_hash_mismatch", 500);
    return file.content;
  }

  async revise(context: WorkspaceRequestContext, input: PostgresArtifactRevisionInput): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord; replayed: boolean }> {
    const artifactRecord = await this.commands.getRecord(context, { roomId: requiredText(input.roomId, "artifact_room_id_required", 160), recordType: "artifact", id: input.artifactId });
    const artifact = artifactFromPayload(artifactRecord.payload);
    const current = await this.currentRevision(context, artifactRecord.roomId, artifact);
    assertRevisionExpectation(current, input.baseRevisionId, input.expectedRevision);
    const revisionId = `artifact_revision_${createHash("sha256").update(`${context.workspaceId}|${context.operationId}|${input.artifactId}`).digest("hex").slice(0, 40)}`;

    const existing = await this.readExistingRevision(context, artifactRecord.roomId, revisionId);
    if (existing) {
      const latest = await this.commands.getRecord(context, { roomId: artifactRecord.roomId, recordType: "artifact", id: artifact.id });
      const latestArtifact = artifactFromPayload(latest.payload);
      if (latestArtifact.metadata.current_revision_id !== existing.id) {
        const latestRevision = await this.currentRevision(context, artifactRecord.roomId, latestArtifact);
        if (latestRevision && latestRevision.revision > existing.revision) throw new WorkspaceServerError("artifact_revision_conflict", 409);
        const recovered = await this.commands.putRecord({ ...context, operationId: `${context.operationId}_artifact_recover` }, {
          roomId: artifactRecord.roomId,
          recordType: "artifact",
          id: artifact.id,
          payload: artifactWithRevision(latestArtifact, existing) as unknown as Record<string, unknown>,
          searchText: latestArtifact.title,
          expectedVersion: latest.version
        });
        const recoveredArtifact = artifactFromPayload(recovered.record.payload);
        await this.ensureRevisionActivity(context, artifactRecord.roomId, recoveredArtifact, existing);
        return { artifact: recoveredArtifact, revision: existing, replayed: true };
      }
      await this.ensureRevisionActivity(context, artifactRecord.roomId, latestArtifact, existing);
      return { artifact: latestArtifact, revision: existing, replayed: true };
    }

    const bytes = Buffer.from(input.content);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const revisionNumber = (current?.revision ?? 0) + 1;
    const extension = safeExtension(input.extension ?? pathExtension(artifact.file_ref.uri));
    const revisionPath = `artifacts/${artifact.id}/revisions/${revisionNumber}-${revisionId}.${extension}`;
    // File records are Room-scoped. Keep the deduplicated blob within the
    // artifact's Room so identical content in another Room cannot collide
    // with the existing file record.
    const blobPath = `artifacts/${artifact.id}/blobs/${contentHash}.${extension}`;
    const createdPaths: string[] = [];
    try {
      await this.writeIfMissing(context, artifactRecord.roomId, revisionPath, bytes, createdPaths);
      await this.writeIfMissing(context, artifactRecord.roomId, blobPath, bytes, createdPaths);
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
      const savedRevision = await this.commands.putRecord({ ...context, operationId: `${context.operationId}_revision` }, {
        roomId: artifactRecord.roomId,
        recordType: "artifact_revision",
        id: revision.id,
        payload: revision as unknown as Record<string, unknown>,
        searchText: `${artifact.title} ${input.changeSummary ?? ""}`,
        expectedVersion: 0
      });
      const nextArtifact = artifactWithRevision(artifact, revision, now, bytes);
      let savedArtifact: ArtifactRecord;
      let artifactRecordVersion = savedRevision.record.version;
      try {
        const saved = await this.commands.putRecord({ ...context, operationId: `${context.operationId}_artifact` }, {
          roomId: artifactRecord.roomId,
          recordType: "artifact",
          id: artifact.id,
          payload: nextArtifact as unknown as Record<string, unknown>,
          searchText: `${nextArtifact.title} ${input.changeSummary ?? ""} ${bytes.toString("utf8").slice(0, 4_000)}`,
          expectedVersion: artifactRecord.version
        });
        savedArtifact = artifactFromPayload(saved.record.payload);
        artifactRecordVersion = saved.record.version;
      } catch (error) {
        await this.rollbackRevision(context, artifactRecord.roomId, revision, savedRevision.record.version, createdPaths);
        throw error;
      }
      try {
        await this.ensureRevisionActivity(context, artifactRecord.roomId, savedArtifact, revision);
      } catch (error) {
        try {
          await this.commands.putRecord({ ...context, operationId: `${context.operationId}_artifact_rollback` }, {
            roomId: artifactRecord.roomId,
            recordType: "artifact",
            id: artifact.id,
            payload: artifact as unknown as Record<string, unknown>,
            searchText: `${artifact.title}`,
            expectedVersion: artifactRecordVersion
          });
          await this.rollbackRevision(context, artifactRecord.roomId, revision, savedRevision.record.version, createdPaths);
        } catch {
          throw new WorkspaceServerError("artifact_revision_recovery_required", 503);
        }
        throw error;
      }
      return { artifact: savedArtifact, revision, replayed: savedRevision.replayed };
    } catch (error) {
      if (!(error instanceof WorkspaceServerError && error.code === "artifact_revision_recovery_required")) {
        await this.removeCreatedFiles(context, artifactRecord.roomId, createdPaths).catch(() => undefined);
      }
      throw error;
    }
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
        ...(input.metadata ?? {}),
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

    try {
      const existing = await this.commands.getRecord({ workspaceId: context.workspaceId, accountId: context.accountId }, { roomId, recordType: "artifact", id: artifactId });
      const saved = artifactFromPayload(existing.payload);
      const body = await this.files.read(context, { roomId, path: saved.file_ref.uri });
      await this.ensureCreationActivity(context, roomId, saved);
      return { artifact: saved, content: body.content.toString("utf8"), replayed: true };
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }

    const fileContext = childContext(context, "file");
    const recordContext = childContext(context, "record");
    const file = await this.files.write(fileContext, { roomId, path: filePath, content: Buffer.from(content), expectedVersion: 0 });
    try {
      const saved = await this.commands.putRecord(recordContext, {
        roomId,
        recordType: "artifact",
        id: artifactId,
        payload: artifact as unknown as Record<string, unknown>,
        searchText: `${artifact.title} ${content.slice(0, 4_000)}`,
        expectedVersion: 0
      });
      const savedArtifact = artifactFromPayload(saved.record.payload);
      try {
        await this.ensureCreationActivity(context, roomId, savedArtifact);
      } catch (error) {
        await this.rollbackCreatedArtifact(context, roomId, savedArtifact, saved.record.version, file.file.version);
        throw error;
      }
      return { artifact: savedArtifact, content, replayed: saved.replayed };
    } catch (error) {
      try {
        await this.files.remove(childContext(context, "rollback"), { roomId, path: file.file.path, expectedVersion: file.file.version });
      } catch {
        throw new WorkspaceServerError("artifact_creation_recovery_required", 503);
      }
      throw error;
    }
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

  private async readExistingRevision(context: Pick<WorkspaceRequestContext, "workspaceId" | "accountId">, roomId: string, revisionId: string): Promise<ArtifactRevisionRecord | undefined> {
    try { return await this.getRevision(context, roomId, revisionId); } catch (error) {
      if (error instanceof WorkspaceServerError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async writeIfMissing(context: WorkspaceRequestContext, roomId: string, filePath: string, content: Uint8Array, createdPaths: string[]): Promise<void> {
    try {
      const existing = await this.files.read(context, { roomId, path: filePath });
      if (existing.file.sha256 !== createHash("sha256").update(content).digest("hex")) throw new WorkspaceServerError("artifact_revision_hash_conflict", 409);
      return;
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 404) throw error;
    }
    try {
      await this.files.write({ ...context, operationId: `${context.operationId}_${hashPath(filePath)}` }, { roomId, path: filePath, content, expectedVersion: 0 });
      createdPaths.push(filePath);
    } catch (error) {
      if (!(error instanceof WorkspaceServerError) || error.status !== 409) throw error;
      const existing = await this.files.read(context, { roomId, path: filePath });
      if (existing.file.sha256 !== createHash("sha256").update(content).digest("hex")) throw new WorkspaceServerError("artifact_revision_hash_conflict", 409);
    }
  }

  private async rollbackRevision(context: WorkspaceRequestContext, roomId: string, revision: ArtifactRevisionRecord, revisionRecordVersion: number, createdPaths: readonly string[]): Promise<void> {
    await this.commands.deleteRecord({ ...context, operationId: `${context.operationId}_revision_rollback` }, { roomId, recordType: "artifact_revision", id: revision.id, expectedVersion: revisionRecordVersion });
    await this.removeCreatedFiles(context, roomId, createdPaths);
  }

  private async removeCreatedFiles(context: WorkspaceRequestContext, roomId: string, paths: readonly string[]): Promise<void> {
    for (const filePath of [...paths].reverse()) {
      try {
        const file = await this.files.read(context, { roomId, path: filePath });
        await this.files.remove({ ...context, operationId: `${context.operationId}_file_rollback` }, { roomId, path: filePath, expectedVersion: file.file.version });
      } catch (error) {
        if (!(error instanceof WorkspaceServerError && error.status === 404)) throw error;
      }
    }
  }

  private async rollbackCreatedArtifact(
    context: WorkspaceRequestContext,
    roomId: string,
    artifact: ArtifactRecord,
    recordVersion: number,
    fileVersion: number
  ): Promise<void> {
    try {
      await this.commands.deleteRecord(childContext(context, "rollback-record"), { roomId, recordType: "artifact", id: artifact.id, expectedVersion: recordVersion });
      await this.files.remove(childContext(context, "rollback-file"), { roomId, path: artifact.file_ref.uri, expectedVersion: fileVersion });
    } catch {
      throw new WorkspaceServerError("artifact_creation_recovery_required", 503);
    }
  }
}

function artifactFromPayload(payload: Record<string, unknown>): ArtifactRecord {
  const parsed = ArtifactRecordSchema.safeParse(payload);
  if (!parsed.success) throw new WorkspaceServerError("artifact_record_invalid", 503);
  return parsed.data;
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
