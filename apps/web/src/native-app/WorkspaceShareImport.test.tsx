import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PublicShareImportResult } from "@samurai-agent/domain-api";
import WorkspaceShareImport, { workspaceShareImportCanStart, workspaceShareImportStatusLabel } from "./WorkspaceShareImport";
import type { WorkspaceSharePublishedView } from "./WorkspaceShareDialog";

const view: WorkspaceSharePublishedView = {
  title: "共有されたKnowledge",
  kind: "room_knowledge",
  visibility: "public",
  manifest: {
    format_version: 1,
    kind: "room_knowledge",
    title: "共有されたKnowledge",
    entries: [{ entry_id: "entry-1", kind: "knowledge", title: "本文", content: "確認済みの本文", knowledge_kind: "fact", files: [] }]
  },
  contentHash: "b".repeat(64),
  publishedAt: "2026-09-17T00:00:00.000Z"
};

const source = {
  sourceOrigin: "https://source.example/",
  locator: "secret-locator",
  claimId: "claim-internal",
  contentHash: view.contentHash,
  delegation: { payload: { secret: true } }
};

const status: PublicShareImportResult = {
  import_id: "operation-internal",
  kind: "room_knowledge",
  status: "staging",
  phase: "fetch",
  retryable: true,
  failure_code: null,
  created_resource_ids: [],
  created_agent_id: null,
  committed_at: null
};

describe("WorkspaceShareImport", () => {
  it("shows the safe content and authorized destinations without exposing locator or delegation", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareImport, {
      view,
      source,
      authenticated: true,
      workspaces: [{ id: "workspace-internal", name: "受け手Workspace" }],
      rooms: [{ id: "room-internal", workspaceId: "workspace-internal", name: "受け手Room" }],
      onStartImport: vi.fn(async () => status),
      onGetStatus: vi.fn(async () => status)
    }));

    expect(html).toContain("共有されたKnowledge");
    expect(html).toContain("受け手Workspace");
    // Room choices are intentionally unavailable until a Workspace is
    // explicitly selected; the component must not silently choose a target.
    expect(html).toContain("Roomを選択");
    expect(html).toContain("明示的に取り込む");
    expect(html).not.toContain("secret-locator");
    expect(html).not.toContain("claim-internal");
    expect(html).not.toContain("secret");
    expect(html).toContain("Agentを実行したりせず");
  });

  it("renders an opaque target key for each destination instead of using a Workspace ID alone", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareImport, {
      view,
      source,
      authenticated: true,
      workspaces: [
        { id: "workspace-same", name: "Server A", targetKey: "connection-a:workspace-same" },
        { id: "workspace-same", name: "Server B", targetKey: "connection-b:workspace-same" }
      ],
      onStartImport: vi.fn(async () => status),
      onGetStatus: vi.fn(async () => status)
    }));

    expect(html).toContain('value="connection-a:workspace-same"');
    expect(html).toContain('value="connection-b:workspace-same"');
    expect(html).toContain("Server A");
    expect(html).toContain("Server B");
  });

  it("keeps the read-only shared view visible when no destination Workspace is available", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareImport, {
      view,
      source,
      authenticated: true,
      workspaces: [],
      onStartImport: vi.fn(async () => status),
      onGetStatus: vi.fn(async () => status)
    }));

    expect(html).toContain("共有されたKnowledge");
    expect(html).toContain("Workspaceを選択");
    expect(html).not.toContain("Server A");
  });

  it("requires authentication and keeps the import action behind an explicit confirmation", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareImport, {
      view,
      source,
      authenticated: false,
      workspaces: [{ id: "workspace-internal", name: "受け手Workspace" }],
      onAuthenticate: vi.fn(),
      onStartImport: vi.fn(async () => status),
      onGetStatus: vi.fn(async () => status)
    }));

    expect(html).toContain("本人確認が必要です");
    expect(html).toContain("本人確認へ進む");
    expect(html).not.toContain("明示的に取り込む");
    expect(html).toContain("共有されたKnowledge");
  });

  it("re-displays status without treating staging as completion", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareImport, {
      view,
      source,
      authenticated: true,
      initialStatus: status,
      initialOperationId: "operation-internal",
      workspaces: [{ id: "workspace-internal", name: "受け手Workspace" }],
      onStartImport: vi.fn(async () => status),
      onGetStatus: vi.fn(async () => status)
    }));

    expect(html).toContain("取り込み処理中");
    expect(html).toContain("同じ操作の状態を再表示");
    expect(html).not.toContain("取り込み完了");
    expect(html).not.toContain("operation-internal");
  });

  it("keeps the core start guard strict for Room and Agent imports", () => {
    expect(workspaceShareImportCanStart({ authenticated: false, confirmed: true, hasSource: true, workspaceId: "w", kind: "agent", roomId: "" })).toBe(false);
    expect(workspaceShareImportCanStart({ authenticated: true, confirmed: false, hasSource: true, workspaceId: "w", kind: "room_knowledge", roomId: "r" })).toBe(false);
    expect(workspaceShareImportCanStart({ authenticated: true, confirmed: true, hasSource: true, workspaceId: "w", kind: "room_knowledge", roomId: "" })).toBe(false);
    expect(workspaceShareImportCanStart({ authenticated: true, confirmed: true, hasSource: true, workspaceId: "w", kind: "room_knowledge", roomId: "r" })).toBe(true);
    expect(workspaceShareImportCanStart({ authenticated: true, confirmed: true, hasSource: true, workspaceId: "w", kind: "agent", roomId: "", status: "staging" })).toBe(false);
    expect(workspaceShareImportStatusLabel("committed")).toBe("取り込み完了");
  });
});
