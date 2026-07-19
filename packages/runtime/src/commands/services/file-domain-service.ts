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
  list(path: WorkspacePath): Promise<DirectoryEntry[]>;
  listArtifacts(): Promise<ArtifactRecord[]>;
  listChanges(): Promise<WorkspaceChangeRecord[]>;
}
export interface FileWritePort {
  readTextIfExists(path: string): Promise<string | undefined>;
  writeText(path: string, content: string): Promise<void>;
  ensureParent(path: string): Promise<void>;
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
  readFileTextIfExists(path: string) { return this.write.readTextIfExists(path); }
  ensureFileParent(path: string) { return this.write.ensureParent(path); }
  writeFileText(path: string, content: string) { return this.write.writeText(path, content); }
  isManagedCollectionPath(path: string) { return this.write.isManagedCollectionPath(path); }
  reindexManagedCollections(): Promise<void> { return this.write.reindexCollections(); }
  createFileRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.host.createRollback(operation, refs, before, after); }
  fileNotFoundError(path: string) { return this.host.requestError("not_found", `File not found: ${path}`); }
  filePatchConflictError() { return this.host.requestError("conflict", "file_patch_search_not_found"); }

  async readFile(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    return { resource: { path: workspacePath.relativePath, content: await this.read.readText(workspacePath.absolutePath) } };
  }

  async listFiles(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    return { resource: { path: workspacePath.relativePath, entries: await this.read.list(workspacePath) } };
  }

  async inspectFile(input: { path: string }): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(input.path);
    const [bytes, info, artifacts, changes] = await Promise.all([this.read.readBytes(workspacePath.absolutePath), this.read.stat(workspacePath.absolutePath), this.read.listArtifacts(), this.read.listChanges()]);
    return { resource: { path: workspacePath.relativePath, metadata: { size: info.size, modified_at: info.modifiedAt, content_hash: createHash("sha256").update(bytes).digest("hex") }, provenance: { artifact_ids: artifacts.filter((artifact) => artifact.file_ref.uri === workspacePath.relativePath).map((artifact) => artifact.id), workspace_change_ids: changes.filter((change) => change.resource_ref.uri === workspacePath.relativePath).map((change) => change.id) } } };
  }

}
