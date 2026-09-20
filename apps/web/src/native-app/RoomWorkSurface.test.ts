import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RoomWorkSurface,
  nativeRoomWorkConversationEntries,
  nativeRoomWorkConversationEntriesForRoom,
  nativeRoomWorkConversationWorks,
  nativeRoomWorkResultCards,
  resizeRoomWorkComposer,
  roomWorkShouldSubmitOnKeyDown,
  roomWorkControlStatusLabel,
  roomWorkInstructionStatusLabel,
  roomWorkMutationNeedsRetry,
  roomWorkStatusLabel
} from "./RoomWorkSurface";
import type { RoomWorkSurfaceProps } from "./RoomWorkSurface";
import type { NativeRoom, NativeRoomWork } from "./types";

const room: NativeRoom = {
  id: "room_public",
  workspaceId: "workspace_public",
  name: "Research Room",
  canEdit: true,
  canExecute: true,
  canManage: true,
  canStop: true,
  defaultAgentId: "agent_research",
  defaultAgentVersion: 4,
  version: 7
};

const work: NativeRoomWork = {
  id: "work_public",
  roomId: room.id,
  requesterId: "account_owner",
  defaultAgentId: "agent_research",
  title: "調査メモを整理",
  objective: "公開情報から判断材料を整理する",
  status: "running",
  instructionVersion: 3,
  generation: 1,
  version: 9,
  assignees: [{
    id: "assignment_public",
    workId: "work_public",
    agentId: "agent_research",
    status: "running",
    instructionVersion: 3,
    generation: 1,
    version: 2
  }],
  instructions: [
    {
      id: "instruction_1",
      workId: "work_public",
      kind: "initial",
      instruction: "一次資料を比較する",
      attachments: [],
      version: 1,
      generation: 0,
      status: "accepted",
      createdBy: "account_owner"
    },
    {
      id: "instruction_2",
      workId: "work_public",
      assigneeId: "assignment_public",
      kind: "reply",
      instruction: "差分を反映する",
      attachments: [],
      version: 2,
      generation: 1,
      status: "delivered",
      createdBy: "account_owner"
    }
  ],
  comments: [{
    id: "comment_public",
    workId: "work_public",
    authorId: "account_owner",
    body: "ここは確認してから反映してください。",
    attachments: [],
    version: 1,
    reactionCount: 2,
    appliedInstructionIds: []
  }],
  controls: [{
    id: "control_requested",
    workId: "work_public",
    action: "stop",
    status: "requested",
    generation: 1,
    version: 1,
    unconfirmedAssigneeIds: ["assignment_public"]
  }]
};

function renderSurface(overrides: Partial<RoomWorkSurfaceProps> = {}): string {
  const props: RoomWorkSurfaceProps = {
    room,
    currentAccountId: "account_owner",
    agents: [{ id: "agent_research", displayName: "Research Agent", enabled: true, status: "active", canExecute: true }],
    works: [work],
    selectedWork: work,
    selectedWorkId: work.id,
    onSelectWork: vi.fn(),
    onSetReplyWorkId: vi.fn(),
    workDraft: "",
    onSetWorkDraft: vi.fn(),
    onClearWorkDraft: vi.fn(),
    workCommentDraft: "",
    onSetWorkCommentDraft: vi.fn(),
    onClearWorkCommentDraft: vi.fn(),
    onSend: vi.fn(),
    onCreateComment: vi.fn(),
    onApplyComment: vi.fn(),
    onReactComment: vi.fn(),
    onStopWork: vi.fn(),
    onStopAssignee: vi.fn(),
    onReassignAssignee: vi.fn(),
    onSetDefaultAgent: vi.fn(),
    onOpenAgentDm: vi.fn(),
    onReconnect: vi.fn()
  };
  return renderToStaticMarkup(createElement(RoomWorkSurface, { ...props, ...overrides }));
}

describe("RoomWorkSurface", () => {
  it("keeps Room controls in the shared header row at a narrow content width", () => {
    const html = renderSurface({
      participants: [
        { id: "member_a", kind: "human", label: "A" },
        { id: "member_b", kind: "human", label: "B" },
        { id: "member_c", kind: "agent", label: "C" }
      ]
    });

    expect(html).toContain("container-type: inline-size");
    expect(html).toContain("@container (max-width: 560px)");
    expect(html).not.toContain(".native-work-surface .native-chat-header { align-items: flex-start; flex-direction: column; }");
  });

  it("pairs each direct-open result with only its Server-linked revision", () => {
    const completedWork: NativeRoomWork = {
      ...work,
      status: "completed",
      assignees: [{
        ...work.assignees![0]!,
        status: "completed",
        result: {
          resourceRefs: [
            { kind: "artifact", id: "artifact_plan", uri: "artifacts/artifact_plan/revisions/2.md", label: "計画" },
            { kind: "artifact_revision", id: "artifact_revision_2", parentId: "artifact_plan", uri: "artifacts/artifact_plan/revisions/2.md" },
            { kind: "generated_surface", id: "surface_dashboard", uri: "surfaces/surface_dashboard", label: "ダッシュボード" },
            { kind: "generated_surface_revision", id: "surface_revision_3", parentId: "surface_dashboard", uri: "surfaces/surface_dashboard/revisions/3.html" },
            { kind: "artifact_revision", id: "artifact_revision_1", parentId: "artifact_plan", uri: "artifacts/artifact_plan/revisions/1.md" }
          ]
        }
      }]
    };

    const cards = nativeRoomWorkResultCards(completedWork, room);

    expect(cards).toEqual([
      expect.objectContaining({ resource: expect.objectContaining({ kind: "artifact", id: "artifact_plan" }) }),
      expect.objectContaining({ resource: expect.objectContaining({ kind: "generated_surface", id: "surface_dashboard", revisionId: "surface_revision_3" }) })
    ]);
    // Two revisions for the Artifact make the historical target ambiguous, so
    // the UI intentionally opens the current durable version instead.
    expect(cards[0]?.resource.revisionId).toBeUndefined();
    expect(nativeRoomWorkResultCards(completedWork, { ...room, id: "room_other" })).toEqual([]);
  });

  it("projects human Instructions right and current Assignment results left", () => {
    const currentAssignee = {
      ...work.assignees[0]!,
      version: 5,
      updatedAt: "2026-09-15T10:04:00.000Z",
      result: {
        state: "updated" as const,
        summary: "実返答本文がここに入る",
        resourceRefs: [{ kind: "artifact" as const, id: "artifact_current", uri: "artifacts/artifact_current" }]
      }
    };
    const staleDuplicate = {
      ...currentAssignee,
      version: 4,
      updatedAt: "2026-09-15T10:03:00.000Z",
      result: { summary: "古い返答を表示してはいけない" }
    };
    const wrongRoomAssignee = {
      ...currentAssignee,
      id: "assignment_wrong_room",
      workId: "work_other_room",
      result: { summary: "別Roomの結果を混ぜない" }
    };
    const conversationWork: NativeRoomWork = {
      ...work,
      resultSummary: "実返答本文がここに入る",
      assignees: [currentAssignee, staleDuplicate, wrongRoomAssignee]
    };

    const entries = nativeRoomWorkConversationEntries(conversationWork, room, [{ id: "agent_research" }]);

    expect(entries.filter((entry) => entry.side === "human")).toHaveLength(2);
    expect(entries.filter((entry) => entry.side === "human").every((entry) => entry.kind === "instruction")).toBe(true);
    expect(entries.filter((entry) => entry.side === "human").map((entry) => entry.authorId)).toEqual(["account_owner", "account_owner"]);
    expect(entries.filter((entry) => entry.side === "agent")).toHaveLength(1);
    expect(entries.find((entry) => entry.side === "agent")?.text).toBe("実返答本文がここに入る");
    expect(entries.find((entry) => entry.side === "agent")?.resultCards).toHaveLength(1);
    expect(entries.map((entry) => entry.text)).not.toContain("古い返答を表示してはいけない");
    expect(entries.map((entry) => entry.text)).not.toContain("別Roomの結果を混ぜない");
    expect(nativeRoomWorkConversationEntries({ ...conversationWork, roomId: "room_other" }, room)).toEqual([]);
  });

  it("keeps another human author's identity available for the left-side message", () => {
    const otherHumanWork: NativeRoomWork = {
      ...work,
      instructions: [{ ...work.instructions![0]!, createdBy: "account_other", instruction: "別メンバーの依頼" }]
    };

    const entries = nativeRoomWorkConversationEntries(otherHumanWork, room, [{ id: "agent_research" }]);

    expect(entries[0]).toMatchObject({ side: "human", authorId: "account_other", text: "別メンバーの依頼" });
  });

  it("keeps an output body when a bridge forwards the current result shape directly", () => {
    const directOutputWork: NativeRoomWork = {
      ...work,
      assignees: [{
        ...work.assignees[0]!,
        result: { output_summary: "Serverから返った実行本文" } as unknown as NonNullable<NativeRoomWork["assignees"][number]["result"]>
      }]
    };

    const entries = nativeRoomWorkConversationEntries(directOutputWork, room, [{ id: "agent_research" }]);

    expect(entries.some((entry) => entry.side === "agent" && entry.text === "Serverから返った実行本文")).toBe(true);
  });

  it("merges same-Room Work histories and ignores stale or foreign snapshots", () => {
    const staleWork: NativeRoomWork = {
      ...work,
      version: 8,
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:01:00.000Z",
      instructions: [{
        ...work.instructions![0]!,
        instruction: "古い依頼本文",
        version: 1,
        generation: 0,
        createdAt: "2026-09-15T10:00:01.000Z"
      }],
      assignees: [{
        ...work.assignees[0]!,
        version: 1,
        result: { summary: "古い結果本文" },
        updatedAt: "2026-09-15T10:00:02.000Z"
      }]
    };
    const currentWork: NativeRoomWork = {
      ...work,
      version: 9,
      createdAt: "2026-09-15T10:00:00.000Z",
      updatedAt: "2026-09-15T10:03:00.000Z",
      instructions: [{
        ...work.instructions![0]!,
        instruction: "新しい依頼本文",
        version: 2,
        generation: 1,
        createdAt: "2026-09-15T10:00:01.000Z"
      }],
      assignees: [{
        ...work.assignees[0]!,
        version: 2,
        result: { summary: "新しい結果本文" },
        updatedAt: "2026-09-15T10:03:02.000Z"
      }]
    };
    const otherWork: NativeRoomWork = {
      ...work,
      id: "work_other_same_list",
      roomId: "room_other",
      title: "別の依頼",
      version: 1,
      createdAt: "2026-09-15T10:02:00.000Z",
      updatedAt: "2026-09-15T10:02:00.000Z",
      instructions: [{
        ...work.instructions![0]!,
        id: "instruction_other_same_list",
        workId: "work_other_same_list",
        instruction: "別のRoomの依頼",
        createdAt: "2026-09-15T10:02:01.000Z"
      }]
    };
    const followupWork: NativeRoomWork = {
      ...work,
      id: "work_followup",
      title: "続きの依頼",
      version: 1,
      createdAt: "2026-09-15T10:04:00.000Z",
      updatedAt: "2026-09-15T10:04:00.000Z",
      instructions: [{
        ...work.instructions![0]!,
        id: "instruction_followup",
        workId: "work_followup",
        instruction: "続きの依頼本文",
        createdAt: "2026-09-15T10:04:01.000Z"
      }],
      assignees: [{
        ...work.assignees[0]!,
        id: "assignment_followup",
        workId: "work_followup",
        version: 1,
        result: { summary: "続きの結果本文" },
        updatedAt: "2026-09-15T10:04:02.000Z"
      }]
    };

    const conversationWorks = nativeRoomWorkConversationWorks([followupWork, staleWork, currentWork, otherWork], room, currentWork);
    expect(conversationWorks.map((item) => item.id)).toEqual(["work_public", "work_followup"]);

    const entries = nativeRoomWorkConversationEntriesForRoom([followupWork, staleWork, currentWork, otherWork], room, [{ id: "agent_research" }], currentWork);
    expect(entries.map((entry) => entry.workId)).toEqual([
      "work_public",
      "work_public",
      "work_followup",
      "work_followup"
    ]);
    expect(entries.map((entry) => entry.text)).not.toContain("古い依頼本文");
    expect(entries.map((entry) => entry.text)).not.toContain("古い結果本文");
    expect(entries.map((entry) => entry.text)).not.toContain("別のRoomの依頼");
    expect(entries.map((entry) => entry.text)).toEqual(expect.arrayContaining(["新しい依頼本文", "新しい結果本文", "続きの依頼本文", "続きの結果本文"]));
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
  });

  it("renders a Chat-first Room conversation while keeping deferred controls out", () => {
    const html = renderSurface();

    expect(html).not.toContain("Room workbench");
    expect(html).toContain("Research Agent");
    expect(html).not.toContain("調査メモを整理");
    expect(html).toContain("native-work-message-avatar");
    expect(html).toContain('data-author-id="account_owner"');
    expect(html).toContain("native-work-conversation");
    expect(html).toContain("native-work-message-agent");
    expect(html).toContain("grid-column: 2; grid-row: 2; justify-self: start;");
    expect(html).toContain("display: block; margin-left: auto;");
    expect(html).not.toContain("Assignment結果");
    expect(html).not.toContain("Assignment状態");
    expect(html).not.toContain("既定Agentを変更");
    expect(html).not.toContain('aria-label="Roomの仕事"');
    expect(html).not.toContain('class="native-work-list"');
    expect(html).not.toContain('class="native-work-detail"');
    expect(html).not.toContain("Agentに反映");
    expect(html).not.toContain("停止を要求");
    expect(html).not.toContain("コメント投稿");
    expect(html).not.toMatch(/session/i);
  });

  it("renders every available Room Work and binds each reply to its own Work", () => {
    const secondWork: NativeRoomWork = {
      ...work,
      id: "work_second",
      title: "二つ目の依頼",
      version: 1,
      createdAt: "2026-09-15T11:00:00.000Z",
      updatedAt: "2026-09-15T11:00:00.000Z",
      instructions: [{
        ...work.instructions![0]!,
        id: "instruction_second",
        workId: "work_second",
        instruction: "二つ目の依頼本文",
        createdAt: "2026-09-15T11:00:01.000Z"
      }],
      assignees: [{
        ...work.assignees[0]!,
        id: "assignment_second",
        workId: "work_second",
        version: 1,
        updatedAt: "2026-09-15T11:00:02.000Z"
      }]
    };
    const html = renderSurface({
      works: [work, secondWork],
      selectedWork: work,
      selectedWorkId: work.id
    });

    expect(html).toContain("二つ目の依頼本文");
    expect(html).toContain('class="native-text-button native-work-message-reply" data-work-id="work_public"');
    expect(html).toContain('class="native-text-button native-work-message-reply" data-work-id="work_second"');

    const replyHtml = renderSurface({
      works: [work, secondWork],
      selectedWork: work,
      selectedWorkId: work.id,
      replyWorkId: secondWork.id,
      workDraft: "二つ目への返信"
    });
    expect(replyHtml).toContain("二つ目の依頼");
    expect(replyHtml).toContain("返信対象");
    expect(replyHtml).toContain('id="native-room-work-input"');
  });

  it("hides terminal success labels while keeping action-needed status labels", () => {
    const terminalWork: NativeRoomWork = {
      ...work,
      status: "completed",
      instructions: work.instructions!.map((instruction, index) => ({
        ...instruction,
        createdBy: "account_other",
        status: index === 0 ? "delivered" : "applied"
      })),
      assignees: [{ ...work.assignees[0]!, status: "completed" }]
    };
    const terminalHtml = renderSurface({
      works: [terminalWork],
      selectedWork: terminalWork,
      selectedWorkId: terminalWork.id
    });

    expect(nativeRoomWorkConversationEntries(terminalWork, room, [{ id: "agent_research" }]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: "assignment-state", status: "completed" })]));
    expect(terminalHtml).not.toContain("完了確認済み");
    expect(terminalHtml).not.toContain("配送済み");
    expect(terminalHtml).not.toContain("反映済み");

    const actionableWork: NativeRoomWork = {
      ...work,
      instructions: work.instructions!.map((instruction, index) => ({
        ...instruction,
        createdBy: "account_other",
        status: index === 0 ? "queued" : "failed"
      })),
      assignees: [{ ...work.assignees[0]!, status: "waiting" }]
    };
    const actionableHtml = renderSurface({
      works: [actionableWork],
      selectedWork: actionableWork,
      selectedWorkId: actionableWork.id
    });

    expect(actionableHtml).toContain("反映待ち");
    expect(actionableHtml).toContain("反映失敗");
    expect(actionableHtml).toContain("確認待ち");
  });

  it("renders the selected Room's artifact entry in the Chat header", () => {
    const html = renderSurface({
      roomToolLinks: createElement("button", { type: "button" }, "成果物")
    });

    expect(html).toContain("成果物");
    expect(html).toContain("native-chat-header");
  });

  it("renders one compact mixed participant trigger with wide and narrow overflow counts", () => {
    const html = renderSurface({
      participants: [
        { id: "account_a", kind: "account", label: "Aさん", state: "active" },
        { id: "agent_a", kind: "agent", label: "Research Agent", state: "available" },
        { id: "account_b", kind: "account", label: "Bさん", state: "active" },
        { id: "agent_b", kind: "agent", label: "Review Agent", state: "available" },
        { id: "account_c", kind: "account", label: "Cさん", state: "active" }
      ],
      onOpenRoomParticipants: vi.fn()
    });

    expect(html).toContain('aria-label="参加者一覧を開く"');
    expect(html).toContain('data-participant-kind="account"');
    expect(html).toContain('data-participant-kind="agent"');
    expect(html).toContain('class="native-work-participant-overflow native-work-participants-overflow-wide">+1</span>');
    expect(html).toContain('class="native-work-participant-overflow native-work-participants-overflow-narrow">+2</span>');
    expect(html).toContain(".native-work-participant-stack .native-work-participant-avatar:nth-of-type(4) { display: none; }");
    expect(html).toContain("参加者 5");
    expect(html).not.toContain('role="dialog" aria-label="Roomの参加者"');
  });

  it("keeps participant loading and failure states from looking like zero people", () => {
    const loading = renderSurface({ participantsLoading: true });
    const failed = renderSurface({ participantsError: "参加者を確認できません。" });

    expect(loading).toContain("参加者を確認中…");
    expect(loading).not.toContain("参加者 0");
    expect(failed).toContain("参加者を確認できません");
    expect(failed).not.toContain("参加者 0");
  });

  it("keeps Room menu and composer controls while the artifact toggle lives in the app shell", () => {
    const html = renderSurface({
      onOpenRoomParticipants: vi.fn()
    });

    expect(html).toContain('data-icon="room-menu"');
    expect(html).not.toContain('data-icon="artifacts-toggle"');
    expect(html).toContain('data-icon="add"');
    expect(html).toContain('data-icon="send"');
    expect(html).not.toContain("⌘/Ctrl + Enter");
  });

  it("places the default Agent selector between the add control and send control", () => {
    const html = renderSurface({ onSetDefaultAgent: vi.fn() });
    const composerFooterIndex = html.indexOf('class="native-composer-footer"');
    const addControlIndex = html.indexOf('data-icon="add"');
    const agentRowIndex = html.indexOf('class="native-work-agent-row"');
    const sendControlIndex = html.indexOf('data-icon="send"');
    const headerEnd = html.indexOf("</header>");

    expect(agentRowIndex).toBeGreaterThan(composerFooterIndex);
    expect(agentRowIndex).toBeGreaterThan(addControlIndex);
    expect(agentRowIndex).toBeLessThan(sendControlIndex);
    expect(agentRowIndex).toBeGreaterThan(headerEnd);
    expect(html.slice(0, headerEnd)).not.toContain("Research Agent");
    expect(html).toContain('aria-label="Roomの既定Agent"');
    expect(html).toContain("border-radius: 28px");
    expect(html).toContain(".native-work-surface .native-composer { background: var(--native-surface-raised); border: 0;");
    expect(html).toContain(".native-work-agent-row .native-work-default-label { display: none; }");
  });

  it("does not submit the composer while an IME is composing", () => {
    const base = { key: "Enter", metaKey: true, ctrlKey: false, shiftKey: false };
    expect(roomWorkShouldSubmitOnKeyDown(base)).toBe(true);
    expect(roomWorkShouldSubmitOnKeyDown({ ...base, isComposing: true })).toBe(false);
    expect(roomWorkShouldSubmitOnKeyDown({ ...base, shiftKey: true })).toBe(false);
    expect(roomWorkShouldSubmitOnKeyDown({ ...base, metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("grows the composer until its cap, then keeps overflow inside the input", () => {
    const input = { scrollHeight: 90, style: { height: "", overflowY: "" } };

    resizeRoomWorkComposer(input);
    expect(input.style).toEqual({ height: "90px", overflowY: "hidden" });

    Object.assign(input, { scrollHeight: 300 });
    resizeRoomWorkComposer(input);
    expect(input.style).toEqual({ height: "216px", overflowY: "auto" });
  });

  it("uses shared native theme tokens for work status and resource colors", () => {
    const html = renderSurface();

    expect(html).toContain("var(--native-success)");
    expect(html).toContain("var(--native-danger)");
    expect(html).toContain("var(--native-accent-soft)");
    expect(html).not.toMatch(/#9bd3ad|#efaaa2|#a8cdec/i);
    expect(html).not.toMatch(/rgba\(/i);
  });

  it("shows Knowledge/Skill selections separately from uploaded file attachments", () => {
    const resourceWork: NativeRoomWork = {
      ...work,
      instructions: [{
        ...work.instructions![0]!,
        instruction: "",
        resourceRefs: [{ kind: "knowledge", id: "knowledge_policy", uri: "knowledge/policy.md", version: "3", label: "公開方針" }]
      }]
    };
    const html = renderSurface({
      works: [resourceWork],
      selectedWork: resourceWork,
      workResourceRefs: [{ kind: "skill", id: "skill_review", version: 2, label: "レビュー手順" }],
      onRemoveWorkResourceRef: vi.fn(),
      onClearWorkResourceRefs: vi.fn()
    });

    expect(html).toContain("利用したKnowledgeとSkill");
    expect(html).toContain("公開方針");
    expect(html).toContain("仕事で使うKnowledgeとSkill");
    expect(html).toContain("レビュー手順");
    expect(html).toContain("ファイルを添付");
  });

  it("does not enable a new request when the default Agent is missing or cannot execute", () => {
    const missingDefault = renderSurface({ room: { ...room, defaultAgentId: undefined } });
    const disabledDefault = renderSurface({
      agents: [{ id: "agent_research", displayName: "Research Agent", enabled: false, status: "disabled" }]
    });

    expect(missingDefault).toContain("既定Agent未設定");
    expect(missingDefault).toContain('class="native-work-agent-row"');
    expect(missingDefault).toContain('value="" disabled="" selected="">既定Agent未設定</option>');
    expect(disabledDefault).toContain("無効または実行不可");
    expect(disabledDefault).toContain('class="native-work-agent-state"');
    expect(disabledDefault).not.toContain("別のAgentをRoomの既定に設定してください");
    expect(disabledDefault).toContain("disabled=\"\"");
  });

  it("derives the default Agent from the authorized Agent list and Room execute capability", () => {
    const missingAgentStatus = renderSurface({ agents: [{ id: "agent_research", displayName: "Research Agent", enabled: true }] });
    const missingRoomCapability = renderSurface({ room: { ...room, canExecute: undefined } });

    expect(missingAgentStatus).toContain("実行可否を確認できません");
    expect(missingRoomCapability).toContain("このRoomの実行権限を確認できません");
  });

  it("requires an explicit assignee when replying to a work with multiple active assignees", () => {
    const multiAssigneeWork: NativeRoomWork = {
      ...work,
      assignees: [
        ...work.assignees,
        {
          id: "assignment_specialist",
          workId: work.id,
          agentId: "agent_specialist",
          status: "waiting",
          instructionVersion: 2,
          generation: 1,
          version: 4
        }
      ]
    };
    const html = renderSurface({
      agents: [
        { id: "agent_research", displayName: "Research Agent", enabled: true, status: "active", canExecute: true },
        { id: "agent_specialist", displayName: "Specialist Agent", enabled: true, status: "active", canExecute: true }
      ],
      works: [multiAssigneeWork],
      selectedWork: multiAssigneeWork,
      selectedWorkId: multiAssigneeWork.id,
      replyWorkId: multiAssigneeWork.id
    });

    expect(html).toContain("返信先担当 · 必須");
    expect(html).toContain('id="native-work-reply-assignee"');
    expect(html).toContain('option value="assignment_public"');
    expect(html).toContain('option value="assignment_specialist"');
    expect(html).toContain("未終端の担当が複数あるため、返信先を指定してから送信してください。");
    const composerIndex = html.indexOf('id="native-room-work-input"');
    expect(composerIndex).toBeGreaterThan(0);
    expect(html.slice(composerIndex, composerIndex + 280)).toContain("disabled");
  });

  it("keeps the automatic reply path when only one assignee is active", () => {
    const html = renderSurface({ replyWorkId: work.id });

    expect(html).toContain("返信先担当: Serverが自動選択（未終端担当 1件）");
    expect(html).not.toContain('id="native-work-reply-assignee"');
  });

  it("enables replying to a completed Work and keeps stopped or unknown Work closed", () => {
    const completedWork: NativeRoomWork = {
      ...work,
      status: "completed",
      stopState: "none",
      assignees: work.assignees.map((assignee) => ({ ...assignee, status: "completed" as const }))
    };
    const replyButtonHtml = renderSurface({
      works: [completedWork],
      selectedWork: completedWork,
      selectedWorkId: completedWork.id
    });
    const replyButtonIndex = replyButtonHtml.indexOf(">返信</button>");
    expect(replyButtonIndex).toBeGreaterThan(0);
    expect(replyButtonHtml.slice(replyButtonHtml.lastIndexOf("<button", replyButtonIndex), replyButtonIndex)).not.toContain("disabled");

    const completedReplyHtml = renderSurface({
      works: [completedWork],
      selectedWork: completedWork,
      selectedWorkId: completedWork.id,
      replyWorkId: completedWork.id,
      workDraft: "完了した仕事の続きです"
    });
    const composerIndex = completedReplyHtml.indexOf('id="native-room-work-input"');
    expect(composerIndex).toBeGreaterThan(0);
    const composerOpeningTag = completedReplyHtml.slice(composerIndex, completedReplyHtml.indexOf(">", composerIndex) + 1);
    expect(composerOpeningTag).not.toContain("disabled");
    expect(completedReplyHtml).toContain("返信を送信");
    expect(completedReplyHtml).toContain("前回の担当をServerが引き継ぎます（未終端担当なし）");

    for (const blockedWork of [
      { ...completedWork, status: "cancelled" as const, stopState: "confirmed" as const },
      { ...completedWork, status: "outcome_unknown" as const, stopState: "unconfirmed" as const },
      { ...completedWork, status: "running" as const, stopState: "requested" as const }
    ]) {
      const blockedHtml = renderSurface({
        works: [blockedWork],
        selectedWork: blockedWork,
        selectedWorkId: blockedWork.id,
        replyWorkId: blockedWork.id,
        workDraft: "安全境界確認"
      });
      const blockedComposerIndex = blockedHtml.indexOf('id="native-room-work-input"');
      expect(blockedComposerIndex).toBeGreaterThan(0);
      expect(blockedHtml.slice(blockedComposerIndex, blockedComposerIndex + 520)).toContain("disabled");
    }

    const unauthorizedHtml = renderSurface({
      room: { ...room, canManage: false },
      currentAccountId: "account_other",
      works: [completedWork],
      selectedWork: completedWork,
      selectedWorkId: completedWork.id,
      replyWorkId: completedWork.id,
      workDraft: "権限境界確認"
    });
    const unauthorizedComposerIndex = unauthorizedHtml.indexOf('id="native-room-work-input"');
    expect(unauthorizedComposerIndex).toBeGreaterThan(0);
    expect(unauthorizedHtml.slice(unauthorizedComposerIndex, unauthorizedComposerIndex + 520)).toContain("disabled");
  });

  it("keeps comment application out of the Chat projection", () => {
    const multiAssigneeWork: NativeRoomWork = {
      ...work,
      assignees: [
        ...work.assignees,
        {
          id: "assignment_specialist",
          workId: work.id,
          agentId: "agent_specialist",
          status: "waiting",
          instructionVersion: 2,
          generation: 1,
          version: 4
        },
        {
          id: "assignment_completed",
          workId: work.id,
          agentId: "agent_research",
          status: "completed",
          instructionVersion: 1,
          generation: 0,
          version: 2
        }
      ]
    };
    const html = renderSurface({
      agents: [
        { id: "agent_research", displayName: "Research Agent", enabled: true, status: "active", canExecute: true },
        { id: "agent_specialist", displayName: "Specialist Agent", enabled: true, status: "active", canExecute: true }
      ],
      works: [multiAssigneeWork],
      selectedWork: multiAssigneeWork,
      selectedWorkId: multiAssigneeWork.id
    });

    expect(html).not.toContain('aria-label="コメントの反映先"');
    expect(html).not.toContain("Agentに反映");
    expect(html).not.toContain("コメントを投稿");
    expect(html).toContain("Research Agent");
    expect(html).toContain("Specialist Agent");
  });

  it("does not render comment application for active or terminal assignments", () => {
    const oneActive = {
      ...work,
      assignees: [
        ...work.assignees,
        {
          id: "assignment_completed",
          workId: work.id,
          agentId: "agent_research",
          status: "completed" as const,
          instructionVersion: 1,
          generation: 0,
          version: 2
        }
      ]
    } satisfies NativeRoomWork;
    const oneActiveHtml = renderSurface({ works: [oneActive], selectedWork: oneActive });
    const terminalOnly = {
      ...work,
      status: "completed" as const,
      assignees: work.assignees.map((assignee) => ({ ...assignee, status: "completed" as const }))
    } satisfies NativeRoomWork;
    const terminalOnlyHtml = renderSurface({ works: [terminalOnly], selectedWork: terminalOnly });

    expect(oneActiveHtml).not.toContain("反映先: Serverが自動選択");
    expect(oneActiveHtml).not.toContain('aria-label="コメントの反映先"');
    expect(terminalOnlyHtml).not.toContain("コメントをAgentに反映");
    expect(terminalOnlyHtml).not.toContain("Agentに反映");
  });

  it("does not move delegation controls into the Chat stream", () => {
    const delegatedWork: NativeRoomWork = {
      ...work,
      assignees: [
        ...work.assignees,
        {
          id: "assignment_reviewer",
          workId: work.id,
          agentId: "agent_reviewer",
          status: "waiting",
          instructionVersion: 2,
          generation: 1,
          version: 4
        }
      ]
    };
    const html = renderSurface({
      agents: [
        { id: "agent_research", displayName: "Research Agent", enabled: true, status: "active", canExecute: true },
        { id: "agent_reviewer", displayName: "Review Agent", enabled: true, status: "active", canExecute: true },
        { id: "agent_specialist", displayName: "Specialist Agent", enabled: true, status: "active", canExecute: true },
        { id: "agent_disabled", displayName: "Disabled Agent", enabled: false, status: "disabled", canExecute: false }
      ],
      roomAgentMembers: [
        { id: "member_research", roomId: room.id, agentId: "agent_research", canView: true, canEdit: true, canExecute: true, version: 1, removed: false },
        { id: "member_reviewer", roomId: room.id, agentId: "agent_reviewer", canView: true, canEdit: true, canExecute: true, version: 1, removed: false },
        { id: "member_specialist", roomId: room.id, agentId: "agent_specialist", canView: true, canEdit: true, canExecute: true, version: 1, removed: false },
        { id: "member_disabled", roomId: room.id, agentId: "agent_disabled", canView: true, canEdit: true, canExecute: false, version: 1, removed: false }
      ],
      works: [delegatedWork],
      selectedWork: delegatedWork,
      onDelegateAssignee: vi.fn()
    });

    expect(html).not.toContain("専門Agentへ明示委譲");
    expect(html).not.toContain("委譲先Agent · 複数選択可");
    expect(html).not.toContain("完了を待つ担当 · 任意");
    expect(html).toContain("Review Agent");
    expect(html).not.toContain("session_id");
  });

  it("does not expose explicit delegation controls in an Agent DM", () => {
    const html = renderSurface({
      room: {
        ...room,
        id: "room_dm",
        kind: "agent_dm"
      },
      onDelegateAssignee: vi.fn()
    });

    expect(html).not.toContain("専門Agentへ明示委譲");
  });

  it("keeps execution status visible without moving stop controls into Chat", () => {
    const requesterStop = renderSurface({
      room: { ...room, canExecute: false, canStop: true }
    });
    const otherMember = renderSurface({
      room: { ...room, canManage: false, canStop: false },
      currentAccountId: "account_other"
    });
    expect(requesterStop).not.toContain(">停止を要求</button>");
    expect(otherMember).not.toContain(">停止を要求</button>");
    expect(requesterStop).toContain("実行中");
    expect(otherMember).toContain(">返信</button>");
  });

  it("does not expose comment capability controls in the Chat-first surface", () => {
    const readOnlyComment = renderSurface({ room: { ...room, canEdit: false } });
    const noExecuteApply = renderSurface({ room: { ...room, canExecute: false } });

    expect(readOnlyComment).not.toContain('id="native-work-comment"');
    expect(noExecuteApply).not.toContain("Agentに反映");
  });

  it("keeps an Agent DM explicitly private", () => {
    const html = renderSurface({
      room: {
        ...room,
        id: "room_dm",
        name: "Research Agent DM",
        kind: "agent_dm"
      }
    });

    expect(html).toContain("Private Agent DM");
    expect(html).toContain("あなたとこのAgentだけが参加できます");
    expect(html).not.toContain("Workspace Admin");
    expect(html).not.toContain("このAgentとDM");
    expect(html).not.toContain('aria-label="Roomの既定Agent"');
    expect(html).not.toContain("既定Agentを変更");
    const composerIndex = html.indexOf('id="native-room-work-input"');
    expect(composerIndex).toBeGreaterThan(0);
    expect(html.slice(composerIndex, composerIndex + 260)).not.toContain("disabled");
  });

  it("exposes status labels as a small pure projection", () => {
    expect(roomWorkStatusLabel("stopping")).toBe("停止要求中");
    expect(roomWorkStatusLabel("cancelled")).toBe("停止確認済み");
    expect(roomWorkInstructionStatusLabel("pending")).toBe("送信待ち");
    expect(roomWorkInstructionStatusLabel("applied")).toBe("反映済み");
    expect(roomWorkInstructionStatusLabel("rejected")).toBe("拒否");
    expect(roomWorkControlStatusLabel("unconfirmed")).toBe("停止未確認");
    expect(roomWorkControlStatusLabel("completed")).toBe("停止確認済み");
  });

  it("keeps the operation ID only when the projection refresh still needs a retry", () => {
    expect(roomWorkMutationNeedsRetry({ operationId: "op_pending", refreshed: false })).toBe(true);
    expect(roomWorkMutationNeedsRetry({ operationId: "op_done", refreshed: true })).toBe(false);
    expect(roomWorkMutationNeedsRetry()).toBe(false);
  });

  it("keeps a requested stop visible even when work execution has not reached a terminal state", () => {
    const html = renderSurface({ selectedWork: { ...work, stopState: "requested" } });
    expect(html).toContain("停止要求中");
    expect(html).not.toContain("停止確認済み</span><button");
  });

  it("renders only safe server-issued attachment labels in work history", () => {
    const attachment = {
      kind: "file" as const,
      id: "a".repeat(64),
      uri: "attachments/brief.pdf",
      version: "1",
      label: "attachments/brief.pdf"
    };
    const initialInstruction = work.instructions?.[0];
    const firstComment = work.comments?.[0];
    if (!initialInstruction || !firstComment) throw new Error("fixture_incomplete");
    const attachedWork: NativeRoomWork = {
      ...work,
      instructions: [{ ...initialInstruction, instruction: "", attachments: [attachment] }],
      comments: [{ ...firstComment, body: "", attachments: [attachment] }]
    };
    const html = renderSurface({ works: [attachedWork], selectedWork: attachedWork });

    expect(html).toContain("attachments/brief.pdf");
    expect(html).toContain("添付のみの指示");
    expect(html).not.toContain("添付のみのコメント");
    expect(html).not.toContain('class="native-work-comments"');
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("data:");
  });
});
