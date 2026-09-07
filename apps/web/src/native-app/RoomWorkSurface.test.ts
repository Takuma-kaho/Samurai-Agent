import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RoomWorkSurface,
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
  it("uses public work vocabulary and renders server-confirmed progress", () => {
    const html = renderSurface();

    expect(html).toContain("Room workbench");
    expect(html).toContain("Research Agent");
    expect(html).toContain("仕事");
    expect(html).toContain("調査メモを整理");
    expect(html).toContain("受付済み");
    expect(html).toContain("配送済み");
    expect(html).toContain("Agentに反映");
    expect(html).toContain("要求中");
    expect(html).toContain("停止未確認");
    expect(html).toContain("停止未確認の担当: Research Agent");
    expect(html).toContain("コメント投稿はAgentへの指示になりません");
    expect(html).not.toMatch(/session/i);
  });

  it("does not enable a new request when the default Agent is missing or cannot execute", () => {
    const missingDefault = renderSurface({ room: { ...room, defaultAgentId: undefined } });
    const disabledDefault = renderSurface({
      agents: [{ id: "agent_research", displayName: "Research Agent", enabled: false, status: "disabled" }]
    });

    expect(missingDefault).toContain("既定Agent未設定");
    expect(missingDefault).toContain("既定Agentを設定すると新しい依頼を送れます");
    expect(disabledDefault).toContain("無効または実行不可");
    expect(disabledDefault).toContain("別のAgentをRoomの既定に設定してください");
    expect(disabledDefault).toContain("disabled=\"\"");
  });

  it("derives the default Agent from the authorized Agent list and Room execute capability", () => {
    const missingAgentStatus = renderSurface({ agents: [{ id: "agent_research", displayName: "Research Agent", enabled: true }] });
    const missingRoomCapability = renderSurface({ room: { ...room, canExecute: undefined } });

    expect(missingAgentStatus).toContain("既定Agentの状態を確認できません");
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
    const replyButtonIndex = replyButtonHtml.indexOf(">この仕事に返信</button>");
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
    expect(completedReplyHtml.slice(composerIndex, composerIndex + 520)).not.toContain("disabled");
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

  it("offers only active assignees for comment application and requires a target when there are several", () => {
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

    expect(html).toContain('aria-label="コメントの反映先"');
    expect(html).toContain('option value="assignment_public"');
    expect(html).toContain('option value="assignment_specialist"');
    expect(html).not.toContain('option value="assignment_completed"');
    expect(html).toContain("未終端の担当が複数あるため、反映先を指定してください。");
    const applyIndex = html.indexOf(">Agentに反映</button>");
    expect(applyIndex).toBeGreaterThan(0);
    expect(html.slice(html.lastIndexOf("<button", applyIndex), applyIndex)).toContain("disabled");
  });

  it("uses automatic application for one active assignee and blocks terminal-only work", () => {
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

    expect(oneActiveHtml).toContain("反映先: Serverが自動選択（未終端担当 1件）");
    expect(oneActiveHtml).not.toContain('aria-label="コメントの反映先"');
    expect(terminalOnlyHtml).toContain("未終端の担当がないため、コメントをAgentに反映できません。");
    const terminalApplyIndex = terminalOnlyHtml.indexOf(">Agentに反映</button>");
    expect(terminalOnlyHtml.slice(terminalOnlyHtml.lastIndexOf("<button", terminalApplyIndex), terminalApplyIndex)).toContain("disabled");
  });

  it("offers explicit multi-Agent delegation with only eligible Room specialists", () => {
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

    expect(html).toContain("専門Agentへ明示委譲");
    expect(html).toContain("委譲先Agent · 複数選択可");
    expect(html).toContain("Specialist Agent");
    expect(html).toContain("完了を待つ担当 · 任意");
    expect(html).toContain("Review Agent · 確認待ち");
    const delegationStart = html.indexOf("専門Agentへ明示委譲");
    const delegationEnd = html.indexOf("指示履歴", delegationStart);
    expect(html.slice(delegationStart, delegationEnd)).not.toContain("Disabled Agent");
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

  it("keeps stop available to the requester without granting execution, while restricting work controls", () => {
    const requesterStop = renderSurface({
      room: { ...room, canExecute: false, canStop: true }
    });
    const otherMember = renderSurface({
      room: { ...room, canManage: false, canStop: false },
      currentAccountId: "account_other"
    });
    const stopIndex = requesterStop.indexOf(">停止を要求</button>");
    const otherStopIndex = otherMember.indexOf(">停止を要求</button>");

    expect(stopIndex).toBeGreaterThan(0);
    expect(requesterStop.slice(requesterStop.lastIndexOf("<button", stopIndex), stopIndex)).not.toContain("disabled");
    expect(otherStopIndex).toBeGreaterThan(0);
    expect(otherMember.slice(otherMember.lastIndexOf("<button", otherStopIndex), otherStopIndex)).toContain("disabled");
    expect(otherMember).toContain("この仕事に返信");
  });

  it("requires edit capability for comments and execute capability for applying them", () => {
    const readOnlyComment = renderSurface({ room: { ...room, canEdit: false } });
    const noExecuteApply = renderSurface({ room: { ...room, canExecute: false } });

    expect(readOnlyComment).toContain("id=\"native-work-comment\"");
    const commentIndex = readOnlyComment.indexOf("id=\"native-work-comment\"");
    expect(readOnlyComment.slice(commentIndex, commentIndex + 260)).toContain("disabled=\"\"");
    const applyIndex = noExecuteApply.indexOf(">Agentに反映</button>");
    expect(noExecuteApply.slice(Math.max(0, applyIndex - 180), applyIndex)).toContain("disabled");
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
    expect(html).toContain("添付のみのコメント");
    expect(html).not.toContain("/Users/");
    expect(html).not.toContain("data:");
  });
});
