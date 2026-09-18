import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import NativeAgentResources, {
  nativeAgentResourceCanBeShown,
  nativeAgentResourceErrorMessage,
  nativeAgentSafeSupportFiles,
  nativeAgentSupportFilePath,
  type NativeAgentResource
} from "./NativeAgentResources";

const agentId = "agent-a";

function resource(overrides: Partial<NativeAgentResource> = {}): NativeAgentResource {
  return {
    workspaceId: "workspace-a",
    id: "resource-a",
    scope: { kind: "agent", agentId },
    kind: "knowledge",
    knowledgeKind: "fact",
    title: "Agentの手動Knowledge",
    evidenceState: "confirmed",
    lifecycleState: "active",
    aiManaged: false,
    version: 3,
    ...overrides
  };
}

describe("NativeAgentResources boundary", () => {
  it("only accepts confirmed, manual resources belonging to the fixed Agent", () => {
    expect(nativeAgentResourceCanBeShown(resource(), agentId)).toBe(true);
    expect(nativeAgentResourceCanBeShown(resource({ scope: { kind: "agent", agentId: "agent-b" } }), agentId)).toBe(false);
    expect(nativeAgentResourceCanBeShown(resource({ scope: { kind: "agent", agentId: "agent-a" } }), "")).toBe(false);
    expect(nativeAgentResourceCanBeShown(resource({ evidenceState: "provisional" }), agentId)).toBe(false);
    expect(nativeAgentResourceCanBeShown(resource({ aiManaged: true }), agentId)).toBe(false);
    expect(nativeAgentResourceCanBeShown(resource({ lifecycleState: "disabled" }), agentId)).toBe(false);
    expect(nativeAgentResourceCanBeShown(resource({ kind: "skill", lifecycleState: "archived" }), agentId)).toBe(true);
    expect(nativeAgentResourceCanBeShown(resource({ scope: { kind: "agent", agentId: "agent-a" }, kind: "knowledge" }), "agent-b")).toBe(false);
  });

  it("keeps support file display to safe relative paths and de-duplicates entries", () => {
    expect(nativeAgentSupportFilePath({ path: "skills/checklist.md" })).toBe("skills/checklist.md");
    expect(nativeAgentSupportFilePath({ bodyPath: "skills/checklist.md" })).toBe("skills/checklist.md");
    expect(nativeAgentSupportFilePath({ path: "../private.txt" })).toBeUndefined();
    expect(nativeAgentSupportFilePath({ path: "/private/private.txt" })).toBeUndefined();
    expect(nativeAgentSupportFilePath({ path: "C:/private.txt" })).toBeUndefined();
    expect(nativeAgentSafeSupportFiles([
      { path: "skills/checklist.md", hash: "hash-a", version: 2 },
      { path: "skills/checklist.md", hash: "hash-b", version: 3 },
      { path: "../private.txt", hash: "secret" },
      { bodyPath: "skills/notes.md", bodyHash: "hash-c", bodyVersion: 4 }
    ])).toEqual([
      { path: "skills/checklist.md", hash: "hash-a", version: 2 },
      { path: "skills/notes.md", hash: "hash-c", version: 4 }
    ]);
  });

  it("renders only the fixed Agent resource list and keeps management callbacks opt-in", () => {
    const callbacks = {
      onCreateResource: vi.fn(async () => resource({ id: "created" })),
      onUpdateResource: vi.fn(async () => resource({ version: 4 })),
      onArchiveResource: vi.fn(async () => resource({ lifecycleState: "archived", version: 4 })),
      onOpenShare: vi.fn(),
      onSelectResource: vi.fn()
    };
    const markup = renderToStaticMarkup(createElement(NativeAgentResources, {
      agentId,
      agentLabel: "調査Agent",
      canManage: true,
      resources: [
        resource(),
        resource({ id: "wrong-agent", title: "別AgentのKnowledge", scope: { kind: "agent", agentId: "agent-b" } }),
        resource({ id: "workspace-memory", title: "Workspace旧Memory", scope: { kind: "agent", agentId }, evidenceState: "provisional" }),
        resource({ id: "ai-resource", title: "自動管理資源", aiManaged: true })
      ],
      ...callbacks
    }));

    expect(markup).toContain("AgentのKnowledge / Skill");
    expect(markup).toContain("Agentの手動Knowledge");
    expect(markup).toContain("調査Agent");
    expect(markup).toContain("agent-a");
    expect(markup).toContain("対象固定");
    expect(markup).toContain("新規作成");
    expect(markup).not.toContain("別AgentのKnowledge");
    expect(markup).not.toContain("Workspace旧Memory");
    expect(markup).not.toContain("自動管理資源");
    expect(markup).toContain("Roomの自動学習");
    expect(callbacks.onCreateResource).not.toHaveBeenCalled();
    expect(callbacks.onUpdateResource).not.toHaveBeenCalled();
    expect(callbacks.onArchiveResource).not.toHaveBeenCalled();
    expect(callbacks.onOpenShare).not.toHaveBeenCalled();
    expect(callbacks.onSelectResource).not.toHaveBeenCalled();
  });

  it("fails closed for no permission, empty, loading, and error states", () => {
    const markup = renderToStaticMarkup(createElement(NativeAgentResources, {
      agentId,
      canManage: false,
      resources: [],
      loading: true,
      error: "接続に失敗しました",
      onCreateResource: vi.fn()
    }));

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("接続に失敗しました");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("読み込み中");
    expect(markup).toContain("管理権限が確認できない");
    expect(markup).not.toContain("新規作成");

    const empty = renderToStaticMarkup(createElement(NativeAgentResources, { agentId, resources: [] }));
    expect(empty).toContain("確認済みのAgent資源はありません");
    expect(empty).toContain("一覧からAgent資源を選ぶと");
  });

  it("keeps conflict and retired Workspace-memory errors explicit", () => {
    expect(nativeAgentResourceErrorMessage({ code: "completion_version_conflict" })).toContain("版が更新されています");
    expect(nativeAgentResourceErrorMessage({ code: "forbidden" })).toContain("権限");
    expect(nativeAgentResourceErrorMessage({ code: "workspace_memory_removed" })).toContain("旧Memory");
    expect(nativeAgentResourceErrorMessage({ code: "unknown" }, "archive")).toContain("保管できません");
  });
});
