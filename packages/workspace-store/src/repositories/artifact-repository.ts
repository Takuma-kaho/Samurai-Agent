import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createId, nowIso, redactPrivateData, type ArtifactRecord, type ArtifactRevisionRecord, type JsonValue, type OperationRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";
import type { SessionSearchEntry } from "../kernel/session-search-index";
import type { WorkspaceHealthReport } from "../workspace-store-contracts";
import { artifactContentTypeFromMetadata, isTextArtifactContentType, safeArtifactExtension } from "./artifact-file-codecs";
import { artifactFromRow, artifactRevisionToRow } from "./artifact-row-codecs";
import { parse, stringify } from "./serialization";
import { listArtifactFiles, pathExists } from "./workspace-file-codecs";

export interface ArtifactSearchPort {
  getOperation(operationId: string): Promise<OperationRecord | undefined>;
  upsert(entry: SessionSearchEntry): Promise<void>;
}

/** Artifact metadata and filesystem-backed revision history. */
export class ArtifactRepository {
  constructor(
    private readonly db: Kysely<WorkspaceDb>,
    private readonly rootDir: string,
    private readonly search: ArtifactSearchPort
  ) {}

  async saveArtifactMetadata(record: ArtifactRecord): Promise<ArtifactRecord> {
    const safeRecord = { ...record, metadata: redactPrivateData(record.metadata, { redactPii: true }) };
    await this.db.insertInto("artifacts").values({
      id: safeRecord.id,
      title: safeRecord.title,
      kind: safeRecord.kind,
      locale: safeRecord.locale,
      source_locales_json: stringify(safeRecord.source_locales),
      file_ref_json: stringify(safeRecord.file_ref),
      metadata_json: stringify(safeRecord.metadata),
      source_operation_id: safeRecord.source_operation_id,
      created_by: safeRecord.created_by,
      created_at: safeRecord.created_at,
      updated_at: safeRecord.updated_at
    }).execute();
    const sourceOperation = await this.search.getOperation(record.source_operation_id);
    await this.search.upsert({
      kind: "artifact",
      id: record.id,
      sessionId: sourceOperation?.session_id,
      operationId: record.source_operation_id,
      title: record.title,
      body: (await this.readArtifactContent(record.id).catch(() => "")) ?? ""
    });
    return safeRecord;
  }

  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    const row = await this.db.selectFrom("artifacts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? artifactFromRow(row) : undefined;
  }

  async listArtifacts(input: { artifactIds?: readonly string[] } = {}): Promise<ArtifactRecord[]> {
    const artifactIds = input.artifactIds ? [...new Set(input.artifactIds)] : undefined;
    if (artifactIds?.length === 0) return [];
    let query = this.db.selectFrom("artifacts").selectAll();
    if (artifactIds) query = query.where("id", "in", artifactIds);
    return (await query.orderBy("updated_at", "desc").execute()).map(artifactFromRow);
  }

  async listArtifactsForSession(sessionId: string): Promise<ArtifactRecord[]> {
    const rows = await this.db.selectFrom("artifacts")
      .innerJoin("operations", "operations.id", "artifacts.source_operation_id")
      .selectAll("artifacts")
      .where("operations.session_id", "=", sessionId)
      .orderBy("artifacts.updated_at", "desc")
      .execute();
    return rows.map(artifactFromRow);
  }

  async createArtifactRevision(input: {
    artifactId: string;
    content: string | Uint8Array;
    producerRunId?: string;
    extension?: string;
    baseRevisionId?: string;
    editorSource?: ArtifactRevisionRecord["editor_source"];
    changeSummary?: string;
    provenance?: Record<string, JsonValue>;
  }): Promise<{ artifact: ArtifactRecord; revision: ArtifactRevisionRecord }> {
    const artifact = await this.getArtifact(input.artifactId);
    if (!artifact) throw new Error(`artifact_not_found:${input.artifactId}`);
    const revisions = await this.listArtifactRevisions(artifact.id);
    const currentRevisionId = revisions.at(-1)?.id;
    if (input.baseRevisionId && input.baseRevisionId !== currentRevisionId) throw new Error(`artifact_revision_conflict:${currentRevisionId ?? "none"}`);
    const revisionNumber = (revisions.at(-1)?.revision ?? 0) + 1;
    const extension = safeArtifactExtension((input.extension ?? path.extname(artifact.file_ref.uri).slice(1)) || "bin");
    const content = Buffer.from(input.content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const revisionId = createId("artifact_revision");
    const revisionPath = path.join("artifacts", artifact.id, "revisions", `${revisionNumber}.${extension}`);
    const blobPath = path.join("artifacts", ".blobs", `${contentHash}.${extension}`);
    await mkdir(path.join(this.rootDir, path.dirname(revisionPath)), { recursive: true });
    await mkdir(path.join(this.rootDir, path.dirname(blobPath)), { recursive: true });
    if (!await pathExists(path.join(this.rootDir, blobPath))) {
      await writeFile(path.join(this.rootDir, blobPath), content, { flag: "wx" }).catch(async (error) => {
        if (!await pathExists(path.join(this.rootDir, blobPath))) throw error;
      });
    }
    await writeFile(path.join(this.rootDir, revisionPath), content, { flag: "wx" });
    const now = nowIso();
    const revision: ArtifactRevisionRecord = {
      id: revisionId,
      artifact_id: artifact.id,
      revision: revisionNumber,
      parent_revision_id: revisions.at(-1)?.id,
      producer_run_id: input.producerRunId,
      base_revision_id: input.baseRevisionId,
      editor_source: input.editorSource,
      change_summary: input.changeSummary,
      provenance: input.provenance ?? {},
      source_ref: artifact.file_ref,
      file_ref: { kind: "artifact_revision", id: revisionId, uri: revisionPath, label: `${artifact.title} r${revisionNumber}` },
      blob_ref: { kind: "artifact_blob", id: contentHash, uri: blobPath, label: contentHash },
      content_hash: contentHash,
      content_bytes: content.byteLength,
      created_at: now
    };
    const nextArtifact: ArtifactRecord = {
      ...artifact,
      file_ref: revision.file_ref,
      metadata: { ...artifact.metadata, current_revision_id: revision.id, current_revision: revision.revision, content_hash: revision.content_hash },
      updated_at: now
    };
    try {
      await this.db.transaction().execute(async (transaction) => {
        await transaction.insertInto("artifact_revisions").values(artifactRevisionToRow(revision)).execute();
        await transaction.updateTable("artifacts").set({ file_ref_json: stringify(nextArtifact.file_ref), metadata_json: stringify(nextArtifact.metadata), updated_at: now }).where("id", "=", artifact.id).execute();
      });
    } catch (error) {
      await rm(path.join(this.rootDir, revisionPath), { force: true });
      throw error;
    }
    return { artifact: nextArtifact, revision };
  }

  async listArtifactRevisions(artifactId: string): Promise<ArtifactRevisionRecord[]> {
    return (await this.db.selectFrom("artifact_revisions").selectAll().where("artifact_id", "=", artifactId).orderBy("revision", "asc").execute())
      .map((row) => parse<ArtifactRevisionRecord>(row.revision_json));
  }

  async getArtifactRevision(revisionId: string): Promise<ArtifactRevisionRecord | undefined> {
    const row = await this.db.selectFrom("artifact_revisions").selectAll().where("id", "=", revisionId).executeTakeFirst();
    return row ? parse<ArtifactRevisionRecord>(row.revision_json) : undefined;
  }

  async readArtifactRevisionContent(revisionId: string): Promise<Uint8Array | undefined> {
    const revision = await this.getArtifactRevision(revisionId);
    return revision ? readFile(path.join(this.rootDir, revision.file_ref.uri)).catch(() => undefined) : undefined;
  }

  async repairArtifactRevisionSource(artifactId: string): Promise<{ repaired: boolean; revision?: ArtifactRevisionRecord }> {
    const artifact = await this.getArtifact(artifactId);
    if (!artifact) throw new Error(`artifact_not_found:${artifactId}`);
    const revisionId = typeof artifact.metadata.current_revision_id === "string" ? artifact.metadata.current_revision_id : undefined;
    const revision = revisionId ? await this.getArtifactRevision(revisionId) : undefined;
    if (!revision) return { repaired: false };
    const target = path.join(this.rootDir, revision.file_ref.uri);
    if (await pathExists(target)) return { repaired: false, revision };
    const blob = path.join(this.rootDir, revision.blob_ref.uri);
    if (!await pathExists(blob)) throw new Error("artifact_revision_blob_missing");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(blob, target);
    const restoredHash = createHash("sha256").update(await readFile(target)).digest("hex");
    if (restoredHash !== revision.content_hash) {
      await rm(target, { force: true });
      throw new Error("artifact_revision_repair_hash_mismatch");
    }
    return { repaired: true, revision };
  }

  async readArtifactContent(id: string): Promise<string | undefined> {
    const artifact = await this.getArtifact(id);
    if (!artifact || !isTextArtifactContentType(artifactContentTypeFromMetadata(artifact))) return undefined;
    return readFile(path.join(this.rootDir, artifact.file_ref.uri), "utf8");
  }

  async readArtifactBinaryContent(id: string): Promise<Uint8Array | undefined> {
    const artifact = await this.getArtifact(id);
    return artifact ? readFile(path.join(this.rootDir, artifact.file_ref.uri)) : undefined;
  }

  async writeArtifactContent(id: string, content: string | Uint8Array, options: { extension?: string } = {}): Promise<string> {
    const extension = safeArtifactExtension(typeof content === "string" ? options.extension ?? "md" : options.extension ?? "bin");
    const relativePath = path.join("artifacts", `${id}.${extension}`);
    await writeFile(path.join(this.rootDir, relativePath), content);
    const artifact = await this.getArtifact(id);
    if (artifact) await this.search.upsert({ kind: "artifact", id, operationId: artifact.source_operation_id, title: artifact.title, body: typeof content === "string" ? content : "" });
    return relativePath;
  }

  /** Reports Artifact metadata/revision file drift without modifying either source. */
  async inspectFilesystemIndex(): Promise<WorkspaceHealthReport["indexes"]["artifacts"]> {
    const [rows, revisionRows] = await Promise.all([
      this.db.selectFrom("artifacts").selectAll().execute(),
      this.db.selectFrom("artifact_revisions").selectAll().execute()
    ]);
    const artifactFiles = await listArtifactFiles(this.rootDir);
    const artifactFileSet = new Set(artifactFiles);
    const indexedFileSet = new Set([
      ...rows.map((row) => artifactFromRow(row).file_ref.uri),
      ...revisionRows.flatMap((row) => [row.file_path, row.blob_path])
    ]);
    const missingFiles = [
      ...rows
        .map(artifactFromRow)
        .filter((artifact) => !artifactFileSet.has(artifact.file_ref.uri))
        .map((artifact) => ({ id: artifact.id, file_path: artifact.file_ref.uri, title: artifact.title })),
      ...revisionRows.flatMap((row) => [row.file_path, row.blob_path]
        .filter((filePath) => !artifactFileSet.has(filePath))
        .map((filePath) => ({ id: row.artifact_id, file_path: filePath, title: `Artifact revision ${row.revision}` })))
    ];
    const unindexedFiles = artifactFiles.filter((filePath) => !indexedFileSet.has(filePath));
    return {
      ok: missingFiles.length === 0 && unindexedFiles.length === 0,
      files: artifactFiles.length,
      indexed: indexedFileSet.size,
      missing_files: missingFiles,
      unindexed_files: unindexedFiles
    };
  }
}
