import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";

export interface Page { url: string; title?: string; html: string; text: string; adapter: "playwright" | "fetch" }
type BrowserResource = object;
interface BrowserMutationResult<T extends BrowserResource> { resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }
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
  runMutation<T extends BrowserResource>(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<BrowserMutationResult<T>>;
  createRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  stableHash(value: unknown): string;
}

export class BrowserDomainService {
  constructor(private readonly read: BrowserReadPort, private readonly adapter: BrowserAdapterPort, private readonly workspace: BrowserWorkspacePort, private readonly host: BrowserMutationHost) {}

  readPage(url: string) { return this.read.readPage(url); }
  interactPage(input: { url: string; action: "navigate" | "click" | "input"; selector?: string; value?: string }) { return this.adapter.interact(input); }
  ensureSession() { return this.host.ensureSession(); }
  createEnvelope(session: SessionRecord, content: string) { return this.host.createEnvelope(session, content); }
  runRecordedMutation<T extends BrowserResource>(input: Parameters<BrowserMutationHost["runMutation"]>[0]) { return this.host.runMutation(input) as Promise<BrowserMutationResult<T>>; }
  stableHash(value: unknown) { return this.host.stableHash(value); }
  captureScreenshot(url: string) { return this.adapter.screenshot({ url }); }
  resolveWorkspacePath(path: string) { return this.workspace.resolve(path); }
  ensureWorkspaceParent(path: string) { return this.workspace.ensureParent(path); }
  readWorkspaceBytesIfExists(path: string) { return this.workspace.readBytesIfExists(path); }
  readWorkspaceTextIfExists(path: string) { return this.workspace.readTextIfExists(path); }
  writeWorkspaceFile(path: string, content: string | Uint8Array) { return this.workspace.write(path, content); }
  createBrowserRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>) { return this.host.createRollback(operation, refs, before, after); }
  browserBytesToBase64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }

  async extract(payload: Record<string, JsonValue>) { const url = text(payload.url); const page = await this.read.readPage(url); return { resource: page }; }

  async navigate(payload: Record<string, JsonValue>) {
    const url = text(payload.url);
    return this.runMutation("browser.navigate", url, async () => {
      const page = await this.read.readPage(url);
      return { resource: page, ref: pageRef(url, page.title, this.host), summary: `Read browser page ${url}.` };
    });
  }

  async interact(payload: Record<string, JsonValue>) {
    const url = text(payload.url); const interaction = action(payload.action) ?? "navigate";
    return this.runMutation("browser.interact", url, async () => {
      const result = await this.adapter.interact({ url, action: interaction, selector: optional(payload.selector), value: optional(payload.value) });
      return { resource: result, ref: pageRef(result.url, result.title, this.host), summary: `Completed browser ${interaction} through ${result.adapterId}.` };
    });
  }

  async screenshot(payload: Record<string, JsonValue>) {
    const url = text(payload.url);
    return this.runMutation("browser.screenshot", url, async (operation) => {
    const capture = await this.adapter.screenshot({ url }); const extension = capture.mimeType === "image/jpeg" ? "jpg" : "png";
    const target = this.workspace.resolve(optional(payload.output_path) || `browser/${this.host.stableHash(url)}.${extension}`);
    await this.workspace.ensureParent(target.absolutePath); const before = await this.workspace.readBytesIfExists(target.absolutePath); await this.workspace.write(target.absolutePath, capture.bytes);
    const ref = fileRef(target.relativePath); const rollbackPoint = await this.host.createRollback(operation, [ref], { path: target.relativePath, content: before ? Buffer.from(before).toString("base64") : null }, { path: target.relativePath, content_hash: this.host.stableHash(capture.bytes) });
    return { resource: { url, file_path: target.relativePath, screenshot_ref: target.relativePath, adapter_id: capture.adapterId, mime_type: capture.mimeType, width: capture.width, height: capture.height }, ref, rollbackPoint, summary: `Captured a real browser screenshot from ${url}.` };
    });
  }

  async downloadToWorkspace(payload: Record<string, JsonValue>) {
    const url = text(payload.url);
    return this.runMutation("browser.download_to_workspace", url, async (operation) => {
    const page = await this.read.readPage(url);
    const target = this.workspace.resolve(optional(payload.output_path) || `browser/${this.host.stableHash(url)}.txt`);
    await this.workspace.ensureParent(target.absolutePath); const before = await this.workspace.readTextIfExists(target.absolutePath); await this.workspace.write(target.absolutePath, page.text);
    const ref = fileRef(target.relativePath); const rollbackPoint = await this.host.createRollback(operation, [ref], { path: target.relativePath, content: before ?? null }, { path: target.relativePath, content: page.text });
    return { resource: { ...page, file_path: target.relativePath, snapshot_kind: "html_snapshot" as const }, ref, rollbackPoint, summary: `Saved an HTML/text snapshot from ${url} into the workspace.` };
    });
  }

  private async runMutation<T extends BrowserResource>(operationName: string, url: string, execute: (operation: OperationRecord) => Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>): Promise<BrowserMutationResult<T>> {
    const session = await this.host.ensureSession(); const envelope = this.host.createEnvelope(session, `${operationName}: ${url}`);
    return this.host.runMutation({ session, envelope, operationName, proposedEffects: [`${operationName} ${url} without mutating external state.`], execute });
  }
}

function text(value: JsonValue | undefined): string { return typeof value === "string" ? value : ""; }
function optional(value: JsonValue | undefined): string | undefined { const result = text(value); return result || undefined; }
function action(value: JsonValue | undefined): "navigate" | "click" | "input" | undefined { return value === "navigate" || value === "click" || value === "input" ? value : undefined; }
function fileRef(path: string): ResourceRef { return { kind: "file", id: path, uri: path, label: path }; }
function pageRef(url: string, title: string | undefined, host: BrowserMutationHost): ResourceRef { return { kind: "browser_page", id: host.stableHash(url), uri: url, label: title || url }; }
