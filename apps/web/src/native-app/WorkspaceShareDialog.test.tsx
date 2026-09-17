import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PublicShareDraft, PublicShareManifest } from "@samurai-agent/domain-api";
import WorkspaceShareDialog, { WorkspaceShareView, workspaceShareDiscardResultIsValid, workspaceShareDraftCanPublish } from "./WorkspaceShareDialog";

const manifest: PublicShareManifest = {
  format_version: 1,
  kind: "room_knowledge",
  title: "公開用のKnowledge",
  entries: [{
    entry_id: "entry-public",
    kind: "knowledge",
    title: "確認済みの知識",
    content: "共有用の本文です。<script>はテキストとして扱います。",
    knowledge_kind: "fact",
    files: []
  }]
};

const draft: PublicShareDraft = {
  draft_id: "draft-internal",
  version: 2,
  manifest,
  content_hash: "a".repeat(64),
  visibility: "restricted",
  recipient_account_ids: ["account-internal"],
  removed_references: []
};

const callbacks = {
  onCreateDraft: vi.fn(async () => draft),
  onUpdateDraft: vi.fn(async () => draft),
  onDiscardDraft: vi.fn(async () => ({ draft_id: draft.draft_id, discarded: true as const })),
  onPublishDraft: vi.fn(async () => ({ share_id: "share-internal", version: 3, url: "https://source.example/s/secret-locator", content_hash: draft.content_hash, published_at: "2026-09-17T00:00:00.000Z" })),
  onRevokeShare: vi.fn(async () => ({ share_id: "share-internal", version: 4, status: "revoked" as const, revoked_at: "2026-09-17T00:01:00.000Z" }))
};

describe("WorkspaceShareDialog", () => {
  it("starts with only same-kind selectable resources and does not render source identifiers", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareDialog, {
      source: { kind: "room_knowledge", id: "room-internal", label: "現在のRoom" },
      resources: [
        { id: "knowledge-1", version: 3, kind: "knowledge", title: "Knowledge A" },
        { id: "skill-1", version: 2, kind: "skill", title: "Skill A" }
      ],
      ...callbacks
    }));

    expect(html).toContain("Knowledge A");
    expect(html).not.toContain("Skill A");
    expect(html).toContain("共有用コピーを編集");
    expect(html).not.toContain("room-internal");
    expect(html).not.toContain("secret-locator");
  });

  it("uses restricted sharing in the editing draft and keeps recipient IDs out of the display", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareDialog, {
      source: { kind: "room_knowledge", id: "room-internal", label: "現在のRoom" },
      resources: [],
      recipientOptions: [{ accountId: "account-internal", label: "受信者A" }],
      draft,
      initialStage: "edit",
      ...callbacks
    }));

    expect(html).toContain("限定共有");
    expect(html).toContain("受信者A");
    expect(html).not.toContain("account-internal");
    expect(html).toContain("元のRoomやAgentを変更しません");
  });

  it("shows the explicit publish confirmation and the fixed-copy stop warning", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareDialog, {
      source: { kind: "room_knowledge", id: "room-internal", label: "現在のRoom" },
      resources: [],
      draft,
      initialStage: "review",
      ...callbacks
    }));

    expect(html).toContain("発行前の最終確認");
    expect(html).toContain("共有リンクを発行");
    expect(html).toContain("すでに取得した独立コピーを回収することはできません");
    expect(html).toContain("共有用の本文です。&lt;script&gt;はテキストとして扱います。");
    expect(html).not.toContain("draft-internal");
  });

  it("does not reveal restricted content before Account verification and safely renders public text", () => {
    const view = { title: "限定共有", kind: "room_knowledge" as const, visibility: "restricted" as const, manifest, contentHash: draft.content_hash, publishedAt: "2026-09-17T00:00:00.000Z" };
    const restricted = renderToStaticMarkup(createElement(WorkspaceShareView, { view }));
    expect(restricted).toContain("本人確認後に内容を確認");
    expect(restricted).not.toContain("共有用の本文です");

    const publicView = renderToStaticMarkup(createElement(WorkspaceShareView, { view: { ...view, visibility: "public" as const } }));
    expect(publicView).toContain("共有用の本文です");
    expect(publicView).toContain("&lt;script&gt;");
    expect(publicView).not.toContain("account-internal");
    expect(publicView).not.toContain("secret-locator");
  });

  it("requires a recipient for restricted publishing and a clean saved draft", () => {
    expect(workspaceShareDraftCanPublish(draft)).toBe(true);
    expect(workspaceShareDraftCanPublish({ ...draft, recipient_account_ids: [] })).toBe(false);
    expect(workspaceShareDraftCanPublish({ ...draft, visibility: "public", recipient_account_ids: [] })).toBe(true);
    expect(workspaceShareDraftCanPublish(draft, true)).toBe(false);
  });

  it("offers explicit saved-draft discard without exposing the draft identifier", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceShareDialog, {
      source: { kind: "room_knowledge", id: "room-internal", label: "現在のRoom" },
      resources: [],
      draft,
      initialStage: "edit",
      ...callbacks
    }));

    expect(html).toContain("保存済み下書きを破棄");
    expect(html).not.toContain("draft-internal");
    expect(html).not.toContain("share-internal");
  });

  it("accepts only the exact server discard confirmation", () => {
    expect(workspaceShareDiscardResultIsValid({ draft_id: draft.draft_id, discarded: true }, draft.draft_id)).toBe(true);
    expect(workspaceShareDiscardResultIsValid({ draft_id: "other-draft", discarded: true }, draft.draft_id)).toBe(false);
    expect(workspaceShareDiscardResultIsValid({ draft_id: draft.draft_id, discarded: false }, draft.draft_id)).toBe(false);
    expect(workspaceShareDiscardResultIsValid(undefined, draft.draft_id)).toBe(false);
  });
});
