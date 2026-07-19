import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";

export interface Page { url: string; title?: string; html: string; text: string; adapter: "playwright" | "fetch" }
export type BrowserResource = object;
export interface BrowserMutationResult<T extends BrowserResource> { resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
export interface BrowserMutationInput<T extends BrowserResource> {
  session: SessionRecord;
  envelope: MessageEnvelope;
  operationName: string;
  proposedEffects: string[];
  execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
}
export interface WorkspacePath { absolutePath: string; relativePath: string }

export interface BrowserReadPort { readPage(url: string): Promise<Page> }
export interface BrowserAdapterPort {
  interact(input: { url: string; action: "navigate" | "click" | "input"; selector?: string; value?: string }): Promise<{ adapterId: string; url: string; title?: string; text?: string }>;
  screenshot(input: { url: string }): Promise<{ adapterId: string; bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; width?: number; height?: number }>;
}
export interface BrowserWorkspacePort {
  resolve(path: string): WorkspacePath; ensureParent(path: string): Promise<void>; readBytesIfExists(path: string): Promise<Uint8Array | undefined>;
  readTextIfExists(path: string): Promise<string | undefined>; write(path: string, content: string | Uint8Array): Promise<void>;
}
export interface BrowserMutationHost {
  ensureSession(): Promise<SessionRecord>; createEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  runMutation<T extends BrowserResource>(input: BrowserMutationInput<T>): Promise<BrowserMutationResult<T>>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  stableHash(value: unknown): string;
}

export class BrowserDomainService {
  constructor(private readonly read: BrowserReadPort, private readonly adapter: BrowserAdapterPort, private readonly workspace: BrowserWorkspacePort, private readonly host: BrowserMutationHost) {}

  readPage(url: string) { return this.read.readPage(url); }
  interactPage(input: { url: string; action: "navigate" | "click" | "input"; selector?: string; value?: string }) { return this.adapter.interact(input); }
  ensureSession() { return this.host.ensureSession(); }
  createEnvelope(session: SessionRecord, content: string) { return this.host.createEnvelope(session, content); }
  runRecordedMutation<T extends BrowserResource>(input: BrowserMutationInput<T>): Promise<BrowserMutationResult<T>> { return this.host.runMutation(input); }
  stableHash(value: unknown) { return this.host.stableHash(value); }
  captureScreenshot(url: string) { return this.adapter.screenshot({ url }); }
  resolveWorkspacePath(path: string) { return this.workspace.resolve(path); }
  ensureWorkspaceParent(path: string) { return this.workspace.ensureParent(path); }
  readWorkspaceBytesIfExists(path: string) { return this.workspace.readBytesIfExists(path); }
  readWorkspaceTextIfExists(path: string) { return this.workspace.readTextIfExists(path); }
  writeWorkspaceFile(path: string, content: string | Uint8Array) { return this.workspace.write(path, content); }
  createBrowserRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.host.createRollback(operation, refs, before, after); }
  browserBytesToBase64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }

  async extract(input: { url: string }) { const page = await this.read.readPage(input.url); return { resource: page }; }
}
