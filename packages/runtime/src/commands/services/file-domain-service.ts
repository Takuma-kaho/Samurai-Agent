import { createHash } from "node:crypto";
import type { ActivityInboxItem, ArtifactRecord, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord, WorkspaceChangeRecord } from "@samurai-agent/core-schemas";

interface WorkspacePath { absolutePath: string; relativePath: string }
interface FileInfo { size: number; modifiedAt: string }
interface DirectoryEntry { path: string; kind: "file" | "directory"; size?: number }
interface FileResource { path: string; content?: string; entries?: DirectoryEntry[]; metadata?: Record<string, JsonValue>; provenance?: Record<string, JsonValue> }
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
  reindexCollections(): Promise<unknown>;
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

  async readFile(payload: Record<string, JsonValue>): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(text(payload.path));
    return { resource: { path: workspacePath.relativePath, content: await this.read.readText(workspacePath.absolutePath) } };
  }

  async listFiles(payload: Record<string, JsonValue>): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(text(payload.path));
    return { resource: { path: workspacePath.relativePath, entries: await this.read.list(workspacePath) } };
  }

  async inspectFile(payload: Record<string, JsonValue>): Promise<{ resource: FileResource }> {
    const workspacePath = this.read.resolve(text(payload.path));
    const [bytes, info, artifacts, changes] = await Promise.all([this.read.readBytes(workspacePath.absolutePath), this.read.stat(workspacePath.absolutePath), this.read.listArtifacts(), this.read.listChanges()]);
    return { resource: { path: workspacePath.relativePath, metadata: { size: info.size, modified_at: info.modifiedAt, content_hash: createHash("sha256").update(bytes).digest("hex") }, provenance: { artifact_ids: artifacts.filter((artifact) => artifact.file_ref.uri === workspacePath.relativePath).map((artifact) => artifact.id), workspace_change_ids: changes.filter((change) => change.resource_ref.uri === workspacePath.relativePath).map((change) => change.id) } } };
  }

  async writeFile(payload: Record<string, JsonValue>): Promise<FileMutationResult> {
    return this.mutateFile("file.write", payload, async (_before) => text(payload.content), "Wrote");
  }

  async patchFile(payload: Record<string, JsonValue>): Promise<FileMutationResult> {
    return this.mutateFile("file.patch", payload, async (before, workspacePath) => {
      if (before === undefined) throw this.host.requestError("not_found", `File not found: ${workspacePath.relativePath}`);
      const search = text(payload.search);
      if (!search || !before.includes(search)) throw this.host.requestError("conflict", "file_patch_search_not_found");
      return before.replace(search, text(payload.replace));
    }, "Patched");
  }

  private async mutateFile(operationName: "file.write" | "file.patch", payload: Record<string, JsonValue>, contentFor: (before: string | undefined, path: WorkspacePath) => Promise<string>, summaryVerb: "Wrote" | "Patched"): Promise<FileMutationResult> {
    const workspacePath = this.read.resolve(text(payload.path)); const session = await this.host.ensureSession();
    const envelope = this.host.createEnvelope(session, `${operationName}: ${workspacePath.relativePath}`); const ref = fileRef(workspacePath.relativePath);
    return this.host.runMutation({ session, envelope, operationName, proposedEffects: [`${operationName} ${workspacePath.relativePath} inside the workspace.`], targetResourceRefs: [ref], execute: async (operationRecord) => {
      const before = await this.write.readTextIfExists(workspacePath.absolutePath);
      const content = await contentFor(before, workspacePath);
      await this.write.ensureParent(workspacePath.absolutePath); await this.write.writeText(workspacePath.absolutePath, content);
      if (this.write.isManagedCollectionPath(workspacePath.relativePath)) await this.write.reindexCollections();
      const rollbackPoint = await this.host.createRollback(operationRecord, [ref], { path: workspacePath.relativePath, content: before ?? null }, { path: workspacePath.relativePath, content });
      return { resource: { path: workspacePath.relativePath, content }, ref, rollbackPoint, summary: `${summaryVerb} workspace file ${workspacePath.relativePath}.` };
    }});
  }
}

function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : ""; }
function fileRef(path: string): ResourceRef { return { kind: "file", id: path, uri: path, label: path }; }
