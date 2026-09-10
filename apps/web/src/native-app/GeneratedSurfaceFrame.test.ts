import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GeneratedSurfaceBundleDetail, GeneratedSurfaceDetail } from "../lib/api";
import { GeneratedSurfaceFrame, generatedSurfaceActionFromMessage, generatedSurfaceBundleIdentity, generatedSurfaceConfirmationRequest, generatedSurfaceParentRetryRequest, generatedSurfaceSrcdoc, generatedSurfaceStateRetryRequest, matchingBundle, shouldConsumeGeneratedSurfaceConfirmationRequest, type GeneratedSurfaceActionCompletion, type GeneratedSurfaceActionRequest, type GeneratedSurfaceApprovalResolution } from "./GeneratedSurfaceFrame";

const createdAt = "2026-09-08T00:00:00.000Z";

const detail: GeneratedSurfaceDetail = {
  surface: {
    id: "surface_report",
    state: "ephemeral",
    title: "月次レポート",
    input_data_schema: {},
    actions: [
      { id: "refresh", label: "更新", command_id: "collection.action.run", input_schema: {}, payload_template: {}, requires_confirmation: false },
      { id: "publish", label: "公開", command_id: "collection.action.run", input_schema: {}, payload_template: { source: "generated_surface" }, requires_confirmation: true }
    ],
    capability_manifest: { allowed_domain_commands: ["collection.action.run"], network_access: "none", workspace_write: "domain_commands_only" },
    source_refs: [],
    content_hash: "surface_hash",
    current_revision_id: "surface_revision_1",
    current_revision: 1,
    preview_url: "/should-not-be-used",
    fallback_chain: ["artifact", "text"],
    created_at: createdAt,
    updated_at: createdAt
  },
  revisions: [{
    id: "surface_revision_1",
    surface_id: "surface_report",
    revision: 1,
    source_resource_refs: [],
    prompt_fingerprint: "prompt_hash",
    knowledge_refs: [],
    skill_refs: [],
    html_ref: { kind: "generated_surface_html", id: "surface_revision_1", uri: "generated/surface.html" },
    asset_refs: [],
    bundle_hash: "bundle_hash",
    validation_report: { valid: true, issues: [], html_bytes: 10, css_bytes: 0, script_bytes: 0, action_count: 2, csp: "default-src 'none'" },
    created_at: createdAt
  }],
  interactions: []
};

const bundle: GeneratedSurfaceBundleDetail = {
  surface: detail.surface,
  revision: detail.revisions[0]!,
  bundle: { html: "<main><button onclick=\"dispatchSamuraiAction('refresh',{scope:'latest'})\">更新</button></main>", css: "main { color: salmon; }", script: "window.surfaceReady = true;", assets: [] },
  csp: "default-src 'none'"
};

type FakeListener = (event: Event) => void;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<FakeListener>>();

  addEventListener(type: string, listener: FakeListener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: FakeListener | null): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    return true;
  }
}

class FakeNode extends FakeEventTarget {
  readonly nodeType: number;
  readonly ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  textContent = "";

  constructor(nodeType: number, ownerDocument: FakeDocument) {
    super();
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
  }

  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode = this;
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  contains(child: FakeNode): boolean {
    return this === child || this.childNodes.some((candidate) => candidate.contains(child));
  }

  dispatchEvent(event: Event): boolean {
    if (!Object.prototype.hasOwnProperty.call(event, "target")) {
      Object.defineProperty(event, "target", { configurable: true, value: this });
    }
    const dispatched = super.dispatchEvent(event);
    if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    return dispatched;
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly nodeName: string;
  readonly localName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  className = "";
  contentWindow?: { postMessage: ReturnType<typeof vi.fn> };

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.localName = tagName.toLowerCase();
    if (this.localName === "iframe") this.contentWindow = { postMessage: vi.fn() };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "class") this.className = "";
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeTextNode extends FakeNode {
  constructor(ownerDocument: FakeDocument, value: string) {
    super(3, ownerDocument);
    this.textContent = value;
  }
}

class FakeDocument extends FakeEventTarget {
  readonly nodeType = 9;
  readonly ownerDocument = this;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  defaultView!: FakeWindow;

  constructor() {
    super();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string): FakeElement {
    return this.createElement(tagName);
  }

  createTextNode(value: string): FakeTextNode {
    return new FakeTextNode(this, value);
  }

  createComment(value: string): FakeTextNode {
    return new FakeTextNode(this, value);
  }

  get activeElement(): FakeElement {
    return this.body;
  }
}

class FakeWindow extends FakeEventTarget {
  readonly document: FakeDocument;
  readonly navigator = { userAgent: "fake" };
  readonly location = { protocol: "http:", host: "localhost" };
  readonly window = this;
  readonly parent = {};
  readonly HTMLIFrameElement = FakeElement;
  readonly HTMLElement = FakeElement;
  readonly Element = FakeElement;
  readonly Node = FakeNode;

  constructor(document: FakeDocument) {
    super();
    this.document = document;
  }
}

function installFakeDom(): () => void {
  const fakeDocument = new FakeDocument();
  const fakeWindow = new FakeWindow(fakeDocument);
  fakeDocument.defaultView = fakeWindow;
  const globalObject = globalThis as typeof globalThis & Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const [name, value] of Object.entries({
    document: fakeDocument,
    window: fakeWindow,
    navigator: fakeWindow.navigator,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLIFrameElement: FakeElement,
    Text: FakeTextNode,
    Comment: FakeTextNode,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    previous.set(name, globalObject[name]);
    Object.defineProperty(globalObject, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [name, value] of previous) Object.defineProperty(globalObject, name, { configurable: true, writable: true, value });
  };
}

function findElement(root: FakeNode, tagName: string): FakeElement | undefined {
  for (const child of root.childNodes) {
    if (child instanceof FakeElement && child.localName === tagName) return child;
    const nested = findElement(child, tagName);
    if (nested) return nested;
  }
  return undefined;
}

function findElements(root: FakeNode, tagName: string): FakeElement[] {
  const elements: FakeElement[] = [];
  for (const child of root.childNodes) {
    if (child instanceof FakeElement && child.localName === tagName) elements.push(child);
    elements.push(...findElements(child, tagName));
  }
  return elements;
}

function nodeText(root: FakeNode): string {
  return [root.textContent, ...root.childNodes.map(nodeText)].join("");
}

function dispatchWindowMessage(windowObject: FakeWindow, data: unknown, source: unknown, origin: string): void {
  const event = new Event("message");
  Object.defineProperties(event, {
    data: { configurable: true, value: data },
    origin: { configurable: true, value: origin },
    source: { configurable: true, value: source }
  });
  windowObject.dispatchEvent(event);
}

describe("GeneratedSurfaceFrame", () => {
  it("builds a self-contained, network-free document with a revision-pinned bridge", () => {
    const document = generatedSurfaceSrcdoc(bundle);

    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("surface_id");
    expect(document).toContain("surface_report");
    expect(document).toContain("surface_revision_1");
    expect(document).toContain("samurai.generated_surface.action");
    expect(document).not.toContain("/should-not-be-used");
  });

  it("inlines the server-refetched asset bytes into the revision-pinned frame", () => {
    const document = generatedSurfaceSrcdoc({
      ...bundle,
      bundle: {
        ...bundle.bundle,
        html: '<img src="assets/logo.svg">',
        assets: [{ path: "logo.svg", content_base64: "PHN2Zz48L3N2Zz4=", mime_type: "image/svg+xml" }]
      }
    });

    expect(document).toContain("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
    expect(document).not.toContain('src="assets/logo.svg"');
  });

  it("fails closed when a revision asset has an unsafe path, MIME, or encoding", () => {
    expect(() => generatedSurfaceSrcdoc({
      ...bundle,
      bundle: { ...bundle.bundle, assets: [{ path: "../logo.svg", content_base64: "PHN2Zz48L3N2Zz4=", mime_type: "image/svg+xml" }] }
    })).toThrow("generated_surface_asset_path_invalid");
    expect(() => generatedSurfaceSrcdoc({
      ...bundle,
      bundle: { ...bundle.bundle, assets: [{ path: "logo.svg", content_base64: "not-base64", mime_type: "image/svg+xml" }] }
    })).toThrow("generated_surface_asset_base64_invalid");
    expect(() => generatedSurfaceSrcdoc({
      ...bundle,
      bundle: { ...bundle.bundle, assets: [{ path: "logo.svg", content_base64: "PHN2Zz48L3N2Zz4=", mime_type: "text/plain" }] }
    })).toThrow("generated_surface_asset_mime_type_conflict");
  });

  it("accepts only declared actions for the same Surface revision", () => {
    const accepted = generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      request_id: "request_refresh",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "refresh",
      payload: { nested: { enabled: true } }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions });

    if (!accepted) throw new Error("expected confirmation action");

    expect(accepted).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "refresh",
      payload: { nested: { enabled: true } },
      requestId: "request_refresh"
    });
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      request_id: "request_obsolete",
      surface_id: "surface_report",
      revision_id: "obsolete_revision",
      action_id: "refresh"
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      request_id: "request_undeclared",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "undeclared"
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      request_id: "request_oversized",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "refresh",
      payload: { oversized: "x".repeat(32 * 1024) }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
  });

  it("retains an input payload for a confirmation action until the parent starts approval", () => {
    const accepted = generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      request_id: "request_publish",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "publish",
      payload: { audience: "customers", notify: true }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions });

    if (!accepted) throw new Error("expected confirmation action");

    expect(accepted).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "publish",
      payload: { audience: "customers", notify: true },
      requestId: "request_publish"
    });
    expect(generatedSurfaceConfirmationRequest(accepted, {
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "publish"
    })).toEqual(accepted);
    expect(generatedSurfaceConfirmationRequest(accepted, {
      surfaceId: "surface_report",
      revisionId: "surface_revision_2",
      actionId: "publish"
    })).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_2",
      actionId: "publish",
      payload: {}
    });
    expect(generatedSurfaceParentRetryRequest(accepted, {
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "publish"
    })).toEqual(accepted);
    expect(shouldConsumeGeneratedSurfaceConfirmationRequest(accepted, accepted)).toBe(true);
    const newerRequest = { ...accepted };
    expect(shouldConsumeGeneratedSurfaceConfirmationRequest(newerRequest, accepted)).toBe(false);
  });

  it("keeps a failed Surface state transition as the retry operation", () => {
    const first = { surfaceId: "surface_report", revisionId: "surface_revision_1", action: "pin" as const };
    expect(generatedSurfaceStateRetryRequest(first, { ...first, action: "unpin" })).toBe(first);
    expect(generatedSurfaceStateRetryRequest(first, { ...first, revisionId: "surface_revision_2" })).toEqual({ ...first, revisionId: "surface_revision_2" });
  });

  it("does not reuse an old iframe bundle after the Surface revision changes", () => {
    const oldBundle = { ...bundle, revision: { ...bundle.revision, id: "surface_revision_old", revision: 0 } };
    expect(matchingBundle(oldBundle, detail)).toBeUndefined();
    expect(matchingBundle(bundle, detail)).toBe(bundle);
    expect(generatedSurfaceBundleIdentity(bundle)).toBe("surface_report\nsurface_revision_1");
  });

  it("can replace a stale initially supplied bundle with the fetched current revision", () => {
    const staleBundle = { ...bundle, revision: { ...bundle.revision, id: "surface_revision_old", revision: 0 } };
    const currentBundle = { ...bundle, bundle: { ...bundle.bundle, html: "<main>current</main>" } };
    const currentDetail = { ...detail, surface: { ...detail.surface, current_revision_id: "surface_revision_1" } };
    expect(matchingBundle(staleBundle, currentDetail)).toBeUndefined();
    expect(matchingBundle(currentBundle, currentDetail)).toBe(currentBundle);
  });

  it("renders the bundle only in an iframe without same-origin access", () => {
    const html = renderToStaticMarkup(createElement(GeneratedSurfaceFrame, {
      detail,
      bundle,
      onExport: async () => ({ file_name: "report.html", content_type: "text/html", content_base64: "" })
    }));

    expect(html).toContain("native-generated-surface-frame");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("公開（確認）");
    expect(html).toContain("HTML");
    expect(html).toContain("ZIP");
  });

  it("marks an archived Surface as non-interactive and keeps the archive state visible", () => {
    const archived = { ...detail, surface: { ...detail.surface, state: "archived" as const } };
    const html = renderToStaticMarkup(createElement(GeneratedSurfaceFrame, {
      detail: archived,
      bundle: { ...bundle, surface: archived.surface },
      onSetState: async () => undefined,
      onRunAction: async () => undefined
    }));

    expect(html).toContain("保管済み");
    expect(html).not.toContain(">保管<");
    expect(html).toContain('disabled=""');
  });

  it("returns a saved result to the same iframe after validating origin and source", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    const onRunAction = vi.fn(async (request: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => ({
      operationId: request.operationId,
      result: { ok: true, saved: true },
      latest: { artifact: { id: "artifact_latest" }, data: { refreshed: true } }
    }));
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      const action = {
        type: "samurai.generated_surface.action",
        request_id: "frame_request_1",
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id,
        action_id: "refresh",
        payload: { scope: "latest" }
      };

      dispatchWindowMessage(fakeWindow, action, {}, "null");
      dispatchWindowMessage(fakeWindow, action, frame.contentWindow, "https://attacker.invalid");
      expect(onRunAction).not.toHaveBeenCalled();

      dispatchWindowMessage(fakeWindow, {
        type: "samurai.generated_surface.ready",
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id
      }, frame.contentWindow, "null");
      dispatchWindowMessage(fakeWindow, action, frame.contentWindow, "null");
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onRunAction).toHaveBeenCalledWith(expect.objectContaining({
        requestId: "frame_request_1",
        operationId: expect.any(String),
        surfaceId: detail.surface.id,
        revisionId: detail.revisions[0]!.id
      }));
      const resultCall = frame.contentWindow.postMessage.mock.calls.find(([message]) => isRecordForTest(message) && message.type === "samurai.generated_surface.action.result");
      expect(resultCall?.[1]).toBe("*");
      expect(resultCall?.[0]).toMatchObject({
        request_id: "frame_request_1",
        operation_id: expect.any(String),
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id,
        status: "completed",
        saved: true,
        result: { ok: true, saved: true },
        latest: { surface: { id: detail.surface.id }, artifact: { id: "artifact_latest" }, data: { refreshed: true } }
      });

      dispatchWindowMessage(fakeWindow, action, frame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });
      const retriedResultCalls = frame.contentWindow.postMessage.mock.calls.filter(([message]) => isRecordForTest(message) && message.type === "samurai.generated_surface.action.result");
      expect(onRunAction).toHaveBeenCalledTimes(1);
      expect(retriedResultCalls.at(-1)?.[0]).toMatchObject({
        request_id: "frame_request_1",
        operation_id: (resultCall?.[0] as Record<string, unknown>)?.operation_id
      });

      const refreshedDetail: GeneratedSurfaceDetail = {
        ...detail,
        surface: { ...detail.surface, updated_at: "2026-09-08T00:01:00.000Z" },
        interactions: [{ id: "interaction_1", command_result: { ok: true }, created_at: "2026-09-08T00:01:00.000Z" }]
      };
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail: refreshedDetail, bundle, onRunAction }));
      });
      const refreshedResultCalls = frame.contentWindow.postMessage.mock.calls.filter(([message]) => isRecordForTest(message) && message.type === "samurai.generated_surface.action.result");
      expect(refreshedResultCalls.at(-1)?.[0]).toMatchObject({ latest: { surface: { updated_at: "2026-09-08T00:01:00.000Z" } } });
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("returns a correlated error to the iframe when the Server action fails", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    const onRunAction = vi.fn(async (_request: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => {
      throw new Error("保存に失敗しました");
    });
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      const identity = { surface_id: detail.surface.id, revision_id: detail.revisions[0]!.id };
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.ready", ...identity }, frame.contentWindow, "null");
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.action", request_id: "frame_request_failed", ...identity, action_id: "refresh", payload: {} }, frame.contentWindow, "null");
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const errorCall = frame.contentWindow.postMessage.mock.calls.find(([message]) => isRecordForTest(message) && message.type === "samurai.generated_surface.action.error");
      expect(errorCall?.[1]).toBe("*");
      expect(errorCall?.[0]).toMatchObject({
        request_id: "frame_request_failed",
        operation_id: expect.any(String),
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id,
        status: "failed",
        error: { code: "generated_surface_action_failed", message: "保存に失敗しました", retryable: true }
      });
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("delivers a durable approval result back into the mounted iframe", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    let approvalRequest: GeneratedSurfaceActionRequest | undefined;
    const onRequestApproval = vi.fn(async (request: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => {
      approvalRequest = request;
      return { operationId: request.operationId };
    });
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRequestApproval }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      const identity = { surface_id: detail.surface.id, revision_id: detail.revisions[0]!.id };
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.ready", ...identity }, frame.contentWindow, "null");
      dispatchWindowMessage(fakeWindow, {
        type: "samurai.generated_surface.action",
        request_id: "frame_publish_1",
        ...identity,
        action_id: "publish",
        payload: { audience: "customers" }
      }, frame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });
      expect(onRequestApproval).not.toHaveBeenCalled();

      const buttons = findElements(container, "button");
      const publishButton = buttons.at(-1);
      if (!publishButton) throw new Error("expected publish button");
      await act(async () => {
        publishButton.dispatchEvent(new Event("click", { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onRequestApproval).toHaveBeenCalledOnce();
      if (!approvalRequest?.operationId) throw new Error("expected approval operation");
      expect(approvalRequest.payload).toEqual({ audience: "customers", source: "generated_surface" });

      const resolution: GeneratedSurfaceApprovalResolution = {
        requestId: approvalRequest.requestId!,
        operationId: approvalRequest.operationId,
        status: "completed",
        result: { published: true },
        latest: { data: { published: true } }
      };
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRequestApproval, approvalResolution: resolution }));
        await Promise.resolve();
      });

      const resultCalls = frame.contentWindow.postMessage.mock.calls.filter(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result");
      expect(resultCalls.at(-1)?.[0]).toMatchObject({
        request_id: approvalRequest.requestId,
        operation_id: approvalRequest.operationId,
        status: "completed",
        saved: true,
        result: { published: true },
        latest: { data: { published: true } }
      });
      expect(findElements(container, "p").some((element) =>
        nodeText(element).includes("承認済みの操作結果をServerから受信しました。")
      )).toBe(true);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("does not present a previous interaction as the result of a new approval", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    const approvalDetail: GeneratedSurfaceDetail = {
      ...detail,
      interactions: [{ id: "old_interaction", command_result: { published: true }, created_at: "2026-09-08T00:01:00.000Z" }]
    };
    const onRequestApproval = vi.fn(async (request: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => ({
      operationId: request.operationId
    }));
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail: approvalDetail, bundle, onRequestApproval }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      const identity = { surface_id: detail.surface.id, revision_id: detail.revisions[0]!.id };
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.ready", ...identity }, frame.contentWindow, "null");
      const publishButton = findElements(container, "button").at(-1);
      if (!publishButton) throw new Error("expected publish button");
      publishButton.dispatchEvent(new Event("click", { bubbles: true }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      const resultCall = frame.contentWindow.postMessage.mock.calls.find(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result"
      );
      expect(resultCall?.[0]).toMatchObject({
        status: "accepted",
        saved: false,
        latest: { surface: { id: detail.surface.id } }
      });
      expect((resultCall?.[0] as Record<string, unknown>)?.result).toBeUndefined();
      expect((resultCall?.[0] as Record<string, unknown>)?.latest).not.toHaveProperty("data");
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("syncs recovery projection changes and never replays an obsolete recovery after ready", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const onRequestApproval = vi.fn(async (request: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => ({
      operationId: request.operationId
    }));
    const oldRecovery = {
      request: {
        surfaceId: detail.surface.id,
        revisionId: detail.revisions[0]!.id,
        actionId: "publish",
        payload: { audience: "customers", source: "generated_surface" },
        requestId: "generated_surface_recovered_request_old",
        operationId: "generated_surface_recovered_operation_old"
      },
      status: "completed" as const,
      result: { published: "old" },
      latest: { data: { published: "old" } }
    };
    const newRecovery = {
      request: {
        ...oldRecovery.request,
        requestId: "generated_surface_recovered_request_new",
        operationId: "generated_surface_recovered_operation_new"
      },
      status: "completed" as const,
      result: { published: "new" },
      latest: { data: { published: "new" } }
    };

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRequestApproval, approvalRecoveries: [oldRecovery] }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      dispatchWindowMessage(fakeWindow, {
        type: "samurai.generated_surface.ready",
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id
      }, frame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });

      const initialResultCalls = frame.contentWindow.postMessage.mock.calls.filter(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result"
      );
      expect(initialResultCalls).toHaveLength(1);
      expect(initialResultCalls[0]?.[0]).toMatchObject({
        request_id: oldRecovery.request.requestId,
        operation_id: oldRecovery.request.operationId,
        status: "completed",
        saved: true,
        result: { published: "old" },
        latest: { data: { published: "old" } }
      });

      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRequestApproval, approvalRecoveries: [newRecovery] }));
        await Promise.resolve();
      });

      const callsAfterProjectionUpdate = frame.contentWindow.postMessage.mock.calls.filter(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result"
      );
      expect(callsAfterProjectionUpdate.at(-1)?.[0]).toMatchObject({
        request_id: newRecovery.request.requestId,
        operation_id: newRecovery.request.operationId,
        result: { published: "new" },
        latest: { data: { published: "new" } }
      });
      expect(callsAfterProjectionUpdate.filter(([message]) =>
        isRecordForTest(message) && message.request_id === oldRecovery.request.requestId
      )).toHaveLength(1);

      // A second ready notification represents an iframe reload. Only the
      // current parent projection may be delivered to the generated document.
      dispatchWindowMessage(fakeWindow, {
        type: "samurai.generated_surface.ready",
        surface_id: detail.surface.id,
        revision_id: detail.revisions[0]!.id
      }, frame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });

      const resultCallsAfterReload = frame.contentWindow.postMessage.mock.calls.filter(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result"
      );
      expect(resultCallsAfterReload.at(-1)?.[0]).toMatchObject({
        request_id: newRecovery.request.requestId,
        operation_id: newRecovery.request.operationId,
        result: { published: "new" },
        latest: { data: { published: "new" } }
      });
      expect(resultCallsAfterReload.slice(initialResultCalls.length).every(([message]) =>
        isRecordForTest(message) && message.request_id === newRecovery.request.requestId
      )).toBe(true);

      const publishButton = findElements(container, "button").at(-1);
      if (!publishButton) throw new Error("expected publish button");
      const callsBeforeExplicitAction = onRequestApproval.mock.calls.length;
      publishButton.dispatchEvent(new Event("click", { bubbles: true }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onRequestApproval.mock.calls.length).toBe(callsBeforeExplicitAction + 1);
      expect(onRequestApproval).toHaveBeenLastCalledWith(expect.objectContaining({
        requestId: expect.not.stringMatching(newRecovery.request.requestId),
        operationId: expect.not.stringMatching(newRecovery.request.operationId)
      }));
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("keeps an explicit in-memory operation while the recovery projection changes", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    let capturedRequest: GeneratedSurfaceActionRequest | undefined;
    let resolveAction!: (value: GeneratedSurfaceActionCompletion) => void;
    const pendingCompletion = new Promise<GeneratedSurfaceActionCompletion>((resolve) => { resolveAction = resolve; });
    const onRunAction = vi.fn((request: GeneratedSurfaceActionRequest) => {
      capturedRequest = request;
      return pendingCompletion;
    });
    const recovery = {
      request: {
        surfaceId: detail.surface.id,
        revisionId: detail.revisions[0]!.id,
        actionId: "publish",
        payload: { audience: "customers", source: "generated_surface" },
        requestId: "generated_surface_recovered_request_projection",
        operationId: "generated_surface_recovered_operation_projection"
      },
      status: "completed" as const,
      result: { published: true }
    };

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction }));
      });
      const frame = findElement(container, "iframe");
      if (!frame?.contentWindow) throw new Error("expected iframe");
      const identity = { surface_id: detail.surface.id, revision_id: detail.revisions[0]!.id };
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.ready", ...identity }, frame.contentWindow, "null");
      dispatchWindowMessage(fakeWindow, {
        type: "samurai.generated_surface.action",
        request_id: "frame_in_memory_request",
        ...identity,
        action_id: "refresh",
        payload: {}
      }, frame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });
      if (!capturedRequest) throw new Error("expected in-memory request");

      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction, approvalRecoveries: [recovery] }));
        await Promise.resolve();
      });
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction, approvalRecoveries: [] }));
        await Promise.resolve();
      });

      resolveAction({ operationId: capturedRequest.operationId, result: { refreshed: true } });
      await act(async () => {
        await pendingCompletion;
        await Promise.resolve();
      });

      const resultCalls = frame.contentWindow.postMessage.mock.calls.filter(([message]) =>
        isRecordForTest(message) && message.type === "samurai.generated_surface.action.result"
      );
      expect(resultCalls.some(([message]) => isRecordForTest(message)
        && message.request_id === "frame_in_memory_request"
        && message.result && isRecordForTest(message.result)
        && message.result.refreshed === true)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });

  it("ignores a completion from an old revision after the frame rerenders", async () => {
    const restore = installFakeDom();
    const fakeWindow = (globalThis as unknown as { window: FakeWindow }).window;
    const container = fakeWindow.document.createElement("div");
    let resolveAction!: (value: GeneratedSurfaceActionCompletion) => void;
    let capturedRequest: GeneratedSurfaceActionRequest | undefined;
    const pendingCompletion = new Promise<GeneratedSurfaceActionCompletion>((resolve) => { resolveAction = resolve; });
    const onRunAction = vi.fn((request: GeneratedSurfaceActionRequest) => {
      capturedRequest = request;
      return pendingCompletion;
    });
    const root = createRoot(container as unknown as Element);

    try {
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail, bundle, onRunAction }));
      });
      const oldFrame = findElement(container, "iframe");
      if (!oldFrame?.contentWindow) throw new Error("expected old iframe");
      const identity = { surface_id: detail.surface.id, revision_id: detail.revisions[0]!.id };
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.ready", ...identity }, oldFrame.contentWindow, "null");
      dispatchWindowMessage(fakeWindow, { type: "samurai.generated_surface.action", request_id: "frame_request_error", ...identity, action_id: "refresh", payload: {} }, oldFrame.contentWindow, "null");
      await act(async () => { await Promise.resolve(); });
      if (!capturedRequest) throw new Error("expected captured request");

      const nextRevision = { ...detail.revisions[0]!, id: "surface_revision_2", revision: 2 };
      const nextDetail: GeneratedSurfaceDetail = {
        ...detail,
        surface: { ...detail.surface, current_revision_id: nextRevision.id, current_revision: nextRevision.revision },
        revisions: [...detail.revisions, nextRevision]
      };
      const nextBundle: GeneratedSurfaceBundleDetail = { ...bundle, surface: nextDetail.surface, revision: nextRevision };
      await act(async () => {
        root.render(createElement(GeneratedSurfaceFrame, { detail: nextDetail, bundle: nextBundle, onRunAction }));
      });
      resolveAction({ operationId: capturedRequest.operationId, result: { stale: true } });
      await act(async () => { await pendingCompletion; await Promise.resolve(); });

      expect(oldFrame.contentWindow.postMessage).not.toHaveBeenCalled();
      const nextFrame = findElement(container, "iframe");
      expect(nextFrame?.contentWindow?.postMessage).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      restore();
    }
  });
});

function isRecordForTest(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
