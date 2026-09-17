import { describe, expect, it } from "vitest";
import type { DesktopWorkspaceRoom } from "../lib/api";
import type { NativeWorkspace } from "./types";
import {
  nativeAgentShareSelectionForTarget,
  nativeRoomShareSelectionForTarget,
  workspaceShareDraftToDomain,
  workspaceShareLinkViewToDomain,
  workspaceShareSummaryToDialog
} from "./native-share-state";
import { nativeShareImportDestinations, nativeShareImportRooms, nativeShareScopeKey } from "./use-native-share-state";

const target = { connectionId: "connection_a", workspaceId: "workspace_a" };

describe("native share source guards", () => {
  it("invalidates overlays when Room, Agent, or selection generation changes", () => {
    const base = nativeShareScopeKey({ ...target, selectionGeneration: 1 }, "room_a", "agent_a");
    expect(nativeShareScopeKey({ ...target, selectionGeneration: 2 }, "room_a", "agent_a")).not.toBe(base);
    expect(nativeShareScopeKey({ ...target, selectionGeneration: 1 }, "room_b", "agent_a")).not.toBe(base);
    expect(nativeShareScopeKey({ ...target, selectionGeneration: 1 }, "room_a", "agent_b")).not.toBe(base);
  });

  it("accepts only confirmed Room Knowledge from the selected Room", () => {
    const selection = {
      source: { kind: "room_knowledge" as const, id: "room_a", label: "調査Room" },
      resources: [{ id: "knowledge_a", version: 2, kind: "knowledge" as const, title: "確認済み" }]
    };

    expect(nativeRoomShareSelectionForTarget(selection, { ...target, roomId: "room_a" }, "room_a")).toEqual({
      source: { kind: "room_knowledge", id: "room_a", label: "調査Room" },
      resources: [{ id: "knowledge_a", version: 2, kind: "knowledge", title: "確認済み" }]
    });
    expect(nativeRoomShareSelectionForTarget(selection, { ...target, roomId: "room_other" }, "room_other")).toBeUndefined();
    expect(nativeRoomShareSelectionForTarget({ ...selection, resources: [] }, { ...target, roomId: "room_a" }, "room_a")).toBeUndefined();
  });

  it("rejects Workspace/AI-managed/archived or another Agent resource", () => {
    const base = {
      workspaceId: "workspace_a",
      id: "resource_a",
      scope: { kind: "agent" as const, agentId: "agent_a" },
      kind: "knowledge" as const,
      title: "Agent Knowledge",
      evidenceState: "confirmed",
      lifecycleState: "active",
      aiManaged: false,
      version: 1
    };
    const selection = { agentId: "agent_a", resourceId: "resource_a", kind: "knowledge" as const };
    expect(nativeAgentShareSelectionForTarget(selection, target, [base], "調査Agent")?.source).toEqual({ kind: "agent", id: "agent_a", label: "調査Agent" });
    expect(nativeAgentShareSelectionForTarget(selection, target, [{ ...base, lifecycleState: "archived" }], "調査Agent")).toBeUndefined();
    expect(nativeAgentShareSelectionForTarget(selection, target, [{ ...base, aiManaged: true }], "調査Agent")).toBeUndefined();
    expect(nativeAgentShareSelectionForTarget({ ...selection, agentId: "agent_other" }, target, [base], "別Agent")).toBeUndefined();
    expect(nativeAgentShareSelectionForTarget(selection, { ...target, workspaceId: "workspace_other" }, [base], "調査Agent")).toBeUndefined();
  });
});

describe("native share import destinations", () => {
  it("keeps only active granted Workspaces authorized by the current connection and Account", () => {
    const workspaces: NativeWorkspace[] = [
      { id: "workspace_a", name: "現在", state: "active", access: "granted", accountId: "account_a", target: { connectionId: "connection_a", workspaceId: "workspace_a" } },
      { id: "workspace_b", name: "別Workspace", state: "active", access: "granted", accountId: "account_a", target: { connectionId: "connection_a", workspaceId: "workspace_b" } },
      { id: "workspace_archived", name: "アーカイブ", state: "archived", access: "granted", accountId: "account_a", target: { connectionId: "connection_a", workspaceId: "workspace_archived" } },
      { id: "workspace_denied", name: "拒否", state: "active", access: "none", accountId: "account_a", target: { connectionId: "connection_a", workspaceId: "workspace_denied" } },
      { id: "workspace_other_server", name: "別接続", state: "active", access: "granted", accountId: "account_a", target: { connectionId: "connection_b", workspaceId: "workspace_other_server" } },
      { id: "workspace_other_account", name: "別Account", state: "active", access: "granted", accountId: "account_b", target: { connectionId: "connection_a", workspaceId: "workspace_other_account" } }
    ];

    const destinations = nativeShareImportDestinations(workspaces, target, "account_a");
    expect(destinations.map((destination) => destination.workspaceId)).toEqual(["workspace_a", "workspace_b"]);
    expect(new Set(destinations.map((destination) => destination.targetKey)).size).toBe(2);
    expect(destinations.every((destination) => destination.target.connectionId === "connection_a")).toBe(true);
  });

  it("excludes Agent DM and non-editable Rooms while retaining the destination target key", () => {
    const [destination] = nativeShareImportDestinations([
      { id: "workspace_a", name: "現在", state: "active", access: "granted", target }
    ], target);
    expect(destination).toBeDefined();
    const rooms: DesktopWorkspaceRoom[] = [
      { id: "room_editable", workspaceId: "workspace_a", name: "編集可能", version: 1, kind: "normal", canEdit: true, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
      { id: "room_dm", workspaceId: "workspace_a", name: "Agent DM", version: 1, kind: "agent_dm", canEdit: true, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
      { id: "room_read_only", workspaceId: "workspace_a", name: "読み取り専用", version: 1, kind: "normal", canEdit: false, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" },
      { id: "room_other", workspaceId: "workspace_b", name: "別Workspace", version: 1, kind: "normal", canEdit: true, createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" }
    ];
    const importRooms = nativeShareImportRooms(destination!, rooms);
    expect(importRooms).toEqual([{ id: "room_editable", workspaceId: "workspace_a", name: "編集可能", canImport: true, workspaceTargetKey: destination!.targetKey }]);
  });
});

describe("native share response projections", () => {
  it("does not infer recipient IDs from a bridge recipient count when resuming", () => {
    const draft = workspaceShareDraftToDomain({
      draftId: "draft_a",
      version: 3,
      manifest: {
        formatVersion: 1,
        kind: "room_knowledge",
        title: "共有用",
        entries: [{ entryId: "entry_a", kind: "knowledge", title: "確認済み", content: "本文", knowledgeKind: "fact", files: [] }]
      },
      contentHash: "a".repeat(64),
      visibility: "restricted",
      recipientCount: 4,
      removedReferenceCount: 1
    });
    expect(draft.recipient_account_ids).toEqual([]);
    expect(workspaceShareDraftToDomain({
      draftId: "draft_a",
      version: 3,
      manifest: {
        formatVersion: 1,
        kind: "room_knowledge",
        title: "共有用",
        entries: [{ entryId: "entry_a", kind: "knowledge", title: "確認済み", content: "本文", knowledgeKind: "fact", files: [] }]
      },
      contentHash: "a".repeat(64),
      visibility: "restricted",
      recipientCount: 4,
      removedReferenceCount: 1
    }, ["account_b"]).recipient_account_ids).toEqual(["account_b"]);
  });

  it("keeps link view content while exposing no source capability fields", () => {
    const view = workspaceShareLinkViewToDomain({
      sourceUrl: "https://source.example/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceOrigin: "https://source.example/",
      locator: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "共有Knowledge",
      visibility: "public",
      manifest: {
        formatVersion: 1,
        kind: "room_knowledge",
        title: "共有Knowledge",
        entries: [{ entryId: "entry_a", kind: "knowledge", title: "本文", content: "固定コピー", knowledgeKind: "fact", files: [] }]
      },
      contentHash: "b".repeat(64),
      publishedAt: "2026-09-17T00:00:00.000Z"
    });
    expect(view).toEqual(expect.objectContaining({ title: "共有Knowledge", contentHash: "b".repeat(64) }));
    expect(Object.keys(view)).not.toContain("locator");
  });

  it("does not turn a saved draft into a published row", () => {
    expect(workspaceShareSummaryToDialog({
      shareId: "draft_a", version: 1, title: "下書き", status: "draft", visibility: "public", recipientCount: 0,
      createdAt: "2026-09-17T00:00:00.000Z", publishedAt: null, revokedAt: null
    })).toBeUndefined();
    expect(workspaceShareSummaryToDialog({
      shareId: "share_a", version: 2, title: "公開", status: "active", visibility: "public", recipientCount: 0,
      createdAt: "2026-09-17T00:00:00.000Z", publishedAt: "2026-09-17T00:01:00.000Z", revokedAt: null
    })).toEqual(expect.objectContaining({ shareId: "share_a", status: "active", publishedAt: "2026-09-17T00:01:00.000Z" }));
  });
});
