import { createHash } from "node:crypto";
import type { ActivityInboxItem, ArtifactRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";

export interface WorkspacePath { absolutePath: string; relativePath: string }
interface FileInfo { size: number; modifiedAt: string }
interface DirectoryEntry { path: string; kind: "file" | "directory"; size?: number }
export interface FileResource { path: string; content?: string; entries?: DirectoryEntry[]; metadata?: Record<string, JsonValue>; provenance?: Record<string, JsonValue> }
interface FileMutationResult { resource: FileResource; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }

export interface FileReadPort {
  resolve(path: string): WorkspacePath;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<FileInfo>;
  /** Rechecks the target immediately before a direct file read. */
  assertReadablePath(path: string): Promise<void>;
  /** Already Room-scoped and rechecked file paths; never a raw filesystem scan. */
  listAccessibleFilePaths(path: WorkspacePath): Promise<string[]>;
  /** Provenance is scoped to the current Room before it reaches this service. */
  listArtifactsForPath(path: string): Promise<ArtifactRecord[]>;
  listChangesForPath(path: string): Promise<WorkspaceChangeRecord[]>;
}
export interface FileWritePort {
  readTextIfExists(path: string): Promise<string | undefined>;
  writeText(path: string, content: string): Promise<void>;
  ensureParent(path: string): Promise<void>;
  /** Rechecks the target immediately before a direct filesystem mutation. */
  assertWritablePath(path: string): Promise<void>;
  reindexCollections(): Promise<void>;
  isManagedCollectionPath(path: string): boolean;
}
export interface FileMutationHost {
  ensureSession(): Promise<SessionRecord>;
  createEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  runMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: FileResource; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<FileMutationResult>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  requestError(code: "not_found" | "conflict", message: string): Error;
}

export class FileDomainService {
  constructor(private readonly read: FileReadPort, private readonly write: FileWritePort, private readonly host: FileMutationHost) {}

  resolveFilePath(path: string) { return this.read.resolve(path); }
  ensureFileSession() { return this.host.ensureSession(); }
  createFileEnvelope(session: SessionRecord, content: string) { return this.host.createEnvelope(session, content); }
  runFileMutation(input: Parameters<FileMutationHost["runMutation"]>[0]) { return this.host.runMutation(input); }
  async readFileTextIfExists(path: string) {
    await this.write.assertWritablePath(path);
    return this.write.readTextIfExists(path);
  }
  async ensureFileParent(path: string) {
    await this.write.assertWritablePath(path);
    return this.write.ensureParent(path);
  }
  async writeFileText(path: string, content: string) {
    await this.write.assertWritablePath(path);
    return this.write.writeText(path, content);
  }
  isManagedCollectionPath(path: string) { return this.write.isManagedCollectionPath(path); }
  reindexManagedCollections(): Promise<void> { return this.write.reindexCollections(); }
  createFileRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.host.createRollback(operation, refs, before, after); }
  fileNotFoundError(path: string) { return this.host.requestError("not_found", `File not found: ${path}`); }
  filePatchConflictError() { return this.host.requestError("conflict", "file_patch_search_not_found"); }

  async readFile(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    await this.read.assertReadablePath(workspacePath.absolutePath);
    return { resource: { path: workspacePath.relativePath, content: await this.read.readText(workspacePath.absolutePath) } };
  }

  async listFiles(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    const filePaths = await this.read.listAccessibleFilePaths(workspacePath);
    const entries = (await Promise.all(filePaths.map(async (relativePath): Promise<DirectoryEntry | undefined> => {
      try {
        const resolved = this.read.resolve(relativePath);
        const info = await this.read.stat(resolved.absolutePath);
        return { path: resolved.relativePath, kind: "file" as const, size: info.size };
      } catch {
        // A permitted file may be removed between the final access check and
        // metadata lookup. It must not turn a list response into a stale read.
        return undefined;
      }
    }))).filter((entry): entry is DirectoryEntry => entry !== undefined);
    return { resource: { path: workspacePath.relativePath, entries } };
  }

  async inspectFile(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    await this.read.assertReadablePath(workspacePath.absolutePath);
    const [bytes, info, artifacts, changes] = await Promise.all([
      this.read.readBytes(workspacePath.absolutePath),
      this.read.stat(workspacePath.absolutePath),
      this.read.listArtifactsForPath(workspacePath.relativePath),
      this.read.listChangesForPath(workspacePath.relativePath)
    ]);
    return { resource: { path: workspacePath.relativePath, metadata: { size: info.size, modified_at: info.modifiedAt, content_hash: createHash("sha256").update(bytes).digest("hex") }, provenance: { artifact_ids: artifacts.map((artifact) => artifact.id), workspace_change_ids: changes.map((change) => change.id) } } };
  }

}
