import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import browserInteract from "./interact.operation.js";
import browserNavigate from "./navigate.operation.js";
import browserDownload from "./download_to_workspace.operation.js";
import browserScreenshot from "./screenshot.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

const session = { id: "session_1" } as never;
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;

describe("Browser operation handlers", () => {
  it("owns navigate mutation orchestration", async () => {
    const readBrowserPage = vi.fn(async () => ({
      url: "https://example.com/",
      title: "Example",
      html: "<h1>Example</h1>",
      text: "Example",
      adapter: "fetch" as const
    }));
    const runBrowserMutation = vi.fn(async (input) => {
      const executed = await input.execute(operation);
      return { resource: executed.resource, operation, activity: [] };
    });
    const handler = browserNavigate.createHandler({
      readBrowserPage,
      ensureBrowserSession: async () => session,
      createBrowserEnvelope: () => envelope,
      stableBrowserHash: () => "page_hash",
      runBrowserMutation
    });

    const result = await handler.execute(context, { url: "https://example.com/" });

    expect(readBrowserPage).toHaveBeenCalledWith("https://example.com/");
    expect(runBrowserMutation).toHaveBeenCalledWith(expect.objectContaining({ operationName: "browser.navigate" }));
    expect(result.value.resource.title).toBe("Example");
  });

  it("owns interaction defaults and mutation orchestration", async () => {
    const interactWithBrowser = vi.fn(async () => ({
      adapterId: "playwright",
      url: "https://example.com/",
      title: "Example"
    }));
    const runBrowserMutation = vi.fn(async (input) => {
      const executed = await input.execute(operation);
      return { resource: executed.resource, operation, activity: [] };
    });
    const handler = browserInteract.createHandler({
      interactWithBrowser,
      ensureBrowserSession: async () => session,
      createBrowserEnvelope: () => envelope,
      stableBrowserHash: () => "page_hash",
      runBrowserMutation
    });

    const parsed = browserInteract.input.parse({ url: "https://example.com/" });
    const result = await handler.execute(context, parsed);

    expect(interactWithBrowser).toHaveBeenCalledWith({ url: "https://example.com/", action: "navigate" });
    expect(runBrowserMutation).toHaveBeenCalledWith(expect.objectContaining({ operationName: "browser.interact" }));
    expect(result.value.resource.adapterId).toBe("playwright");
  });

  it("rejects fields that belong to other browser operations", () => {
    expect(browserNavigate.input.safeParse({ url: "https://example.com/", selector: "#submit" }).success).toBe(false);
    expect(browserInteract.input.safeParse({ url: "not-a-url" }).success).toBe(false);
  });

  it("owns download persistence and rollback creation", async () => {
    const writeBrowserWorkspaceFile = vi.fn(async () => undefined);
    const createBrowserRollback = vi.fn(async () => ({ id: "rollback_1" }) as never);
    const handler = browserDownload.createHandler({
      readBrowserPage: async () => ({ url: "https://example.com/", html: "<p>body</p>", text: "body", adapter: "fetch" }),
      ensureBrowserSession: async () => session,
      createBrowserEnvelope: () => envelope,
      stableBrowserHash: () => "page_hash",
      resolveBrowserWorkspacePath: () => ({ absolutePath: "/workspace/browser/page.txt", relativePath: "browser/page.txt" }),
      ensureBrowserWorkspaceParent: async () => undefined,
      readBrowserWorkspaceText: async () => "old body",
      writeBrowserWorkspaceFile,
      createBrowserRollback,
      runBrowserMutation: async (input) => {
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      }
    });

    const result = await handler.execute(context, { url: "https://example.com/" });

    expect(writeBrowserWorkspaceFile).toHaveBeenCalledWith("/workspace/browser/page.txt", "body");
    expect(createBrowserRollback).toHaveBeenCalled();
    expect(result.value.resource.file_path).toBe("browser/page.txt");
  });

  it("owns screenshot persistence and binary rollback conversion", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const writeBrowserWorkspaceFile = vi.fn(async () => undefined);
    const handler = browserScreenshot.createHandler({
      captureBrowserScreenshot: async () => ({ adapterId: "playwright", bytes, mimeType: "image/png", width: 100, height: 50 }),
      ensureBrowserSession: async () => session,
      createBrowserEnvelope: () => envelope,
      stableBrowserHash: () => "page_hash",
      browserBytesToBase64: () => "AQID",
      resolveBrowserWorkspacePath: () => ({ absolutePath: "/workspace/browser/page.png", relativePath: "browser/page.png" }),
      ensureBrowserWorkspaceParent: async () => undefined,
      readBrowserWorkspaceBytes: async () => bytes,
      writeBrowserWorkspaceFile,
      createBrowserRollback: async () => ({ id: "rollback_1" }) as never,
      runBrowserMutation: async (input) => {
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      }
    });

    const result = await handler.execute(context, { url: "https://example.com/" });

    expect(writeBrowserWorkspaceFile).toHaveBeenCalledWith("/workspace/browser/page.png", bytes);
    expect(result.value.resource.mime_type).toBe("image/png");
  });
});
