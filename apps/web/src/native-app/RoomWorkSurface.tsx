import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type FormEvent, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { createIdempotencyKey, getWorkspaceClientBridge, type WorkspaceAttachmentUploadResult } from "../lib/api";
import { WorkspaceFileResourceRefSchema, type ResourceRef } from "@samurai-agent/core-schemas";
import { nativeRoomAgentIsAvailable, nativeRoomWorkErrorIsExplicitServerFailure, type NativeRoomWorkMutationResult } from "./use-native-app";
import type {
  NativeAgent,
  NativeAgentBackend,
  NativeRoom,
  NativeRoomAgentMember,
  NativeRoomWork,
  NativeRoomWorkAssignee,
  NativeRoomWorkAssigneeStatus,
  NativeRoomWorkComment,
  NativeRoomWorkControl,
  NativeRoomWorkInstruction,
  NativeRoomWorkResourceRefInput,
  NativeRoomWorkInstructionStatus,
  NativeRoomWorkStatus,
  NativeArtifactWorkspaceInitialResource
} from "./types";
import type { NativeRoomParticipant } from "./use-native-room-participants";

export type NativeRoomPanelState = "closed" | "artifacts" | "room_settings";

export interface RoomWorkSurfaceProps {
  room?: NativeRoom;
  currentAccountId?: string;
  agents: NativeAgent[];
  agentBackends?: NativeAgentBackend[];
  roomAgentMembers?: NativeRoomAgentMember[];
  agentLoading?: boolean;
  agentError?: string | null;
  works: NativeRoomWork[];
  workLoading?: boolean;
  workDetailLoading?: boolean;
  workError?: string | null;
  workDetailError?: string | null;
  selectedWork?: NativeRoomWork;
  selectedWorkId?: string;
  onSelectWork: (workId: string) => void;
  replyWorkId?: string;
  onSetReplyWorkId: (workId: string | undefined) => void;
  workDraft: string;
  onSetWorkDraft: (value: string) => void;
  onClearWorkDraft: () => void;
  workCommentDraft: string;
  onSetWorkCommentDraft: (value: string) => void;
  onClearWorkCommentDraft: () => void;
  loading?: boolean;
  sending?: boolean;
  archived?: boolean;
  readOnly?: boolean;
  connectionState?: "connected" | "reconnecting" | "offline";
  onSend: (content: string, targetWorkId?: string, targetAssigneeId?: string, operationId?: string, attachments?: ResourceRef[], resourceRefs?: NativeRoomWorkResourceRefInput[]) => void | NativeRoomWorkMutationResult | Promise<void | NativeRoomWorkMutationResult>;
  /** Knowledge/Skill refs selected in the Room toolkit for this Work draft. */
  workResourceRefs?: NativeRoomWorkResourceRefInput[];
  onRemoveWorkResourceRef?: (ref: NativeRoomWorkResourceRefInput) => void;
  onClearWorkResourceRefs?: () => void;
  onCreateComment: (workId: string, body?: string, attachments?: ResourceRef[]) => void | Promise<void>;
  onApplyComment: (workId: string, comment: NativeRoomWorkComment, assigneeId?: string, operationId?: string) => void | NativeRoomWorkMutationResult | Promise<void | NativeRoomWorkMutationResult>;
  onReactComment?: (workId: string, commentId: string) => void | Promise<void>;
  onStopWork: (work: NativeRoomWork) => void | Promise<void>;
  onStopAssignee: (work: NativeRoomWork, assignee: NativeRoomWorkAssignee) => void | Promise<void>;
  onReassignAssignee: (work: NativeRoomWork, assignee: NativeRoomWorkAssignee, agentId: string) => void | Promise<void>;
  onDelegateAssignee?: (
    work: NativeRoomWork,
    parentAssignee: NativeRoomWorkAssignee,
    agentId: string,
    instruction: string,
    dependencyAssigneeIds?: string[],
    operationId?: string,
    attachments?: ResourceRef[]
  ) => void | NativeRoomWorkMutationResult | Promise<void | NativeRoomWorkMutationResult>;
  onSetDefaultAgent?: (agentId: string) => void | Promise<void>;
  onOpenAgentDm?: (agentId: string) => void | Promise<void>;
  onOpenAgentSettings?: () => void;
  participants?: readonly NativeRoomParticipant[];
  participantsLoading?: boolean;
  participantsError?: string | null;
  /** NativeApp owns the combined participant list/menu; this surface only opens it. */
  onOpenRoomParticipants?: () => void;
  roomParticipantsOpen?: boolean;
  onOpenRoomSettings?: () => void;
  onOpenRoomKnowledge?: () => void;
  onOpenRoomShare?: () => void;
  roomKnowledgeShareAvailable?: boolean;
  /** The selected Room's minimal header-level tool entry. */
  roomToolLinks?: ReactNode;
  onOpenResultResource?: (resource: NativeArtifactWorkspaceInitialResource) => void;
  onReconnect: () => void | Promise<void>;
}

const terminalWorkStatuses: readonly NativeRoomWorkStatus[] = ["completed", "failed", "cancelled"];
const terminalAssigneeStatuses: readonly NativeRoomWorkAssigneeStatus[] = ["completed", "failed", "cancelled"];

interface PendingRoomWorkOperation {
  key: string;
  operationId: string;
}

interface PendingRoomWorkDelegation {
  key: string;
  operationIds: Record<string, string>;
  completedAgentIds: string[];
}

type AttachmentDraftStatus = "uploading" | "ready" | "failed";

interface RoomAttachmentDraft {
  id: string;
  name: string;
  size: number;
  file: File;
  path: string;
  operationId: string;
  status: AttachmentDraftStatus;
  resourceRef?: ResourceRef;
  error?: string;
}

type RoomWorkActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

const workStatusLabels: Record<NativeRoomWorkStatus, string> = {
  queued: "受付済み",
  running: "実行中",
  waiting: "確認待ち",
  blocked: "ブロック中",
  completed: "完了確認済み",
  failed: "失敗",
  stopping: "停止要求中",
  cancelled: "停止確認済み",
  outcome_unknown: "結果未確認"
};

const instructionStatusLabels: Record<NativeRoomWorkInstructionStatus, string> = {
  pending: "送信待ち",
  accepted: "受付済み",
  queued: "反映待ち",
  delivered: "配送済み",
  applied: "反映済み",
  failed: "反映失敗",
  rejected: "拒否"
};

const controlStatusLabels: Record<NativeRoomWorkControl["status"], string> = {
  pending: "処理待ち",
  requested: "要求中",
  accepted: "受信済み",
  running: "停止処理中",
  completed: "停止確認済み",
  confirmed: "停止確認済み",
  failed: "停止失敗",
  unconfirmed: "停止未確認",
  rejected: "拒否"
};

export function roomWorkStatusLabel(status: NativeRoomWorkStatus | NativeRoomWorkAssigneeStatus): string {
  if (status === "ready") return "待機中";
  return workStatusLabels[status as NativeRoomWorkStatus] ?? status;
}

export function roomWorkInstructionStatusLabel(status: NativeRoomWorkInstructionStatus): string {
  return instructionStatusLabels[status];
}

function roomWorkConversationStatusLabel(entry: NativeRoomWorkConversationEntry): string | undefined {
  if (entry.side === "human") {
    const status = entry.status as NativeRoomWorkInstructionStatus;
    if (status === "delivered" || status === "applied") return undefined;
    return roomWorkInstructionStatusLabel(status);
  }

  const status = entry.status as NativeRoomWorkAssigneeStatus;
  if (status === "completed") return undefined;
  return roomWorkStatusLabel(status);
}

export function roomWorkControlStatusLabel(status: NativeRoomWorkControl["status"]): string {
  return controlStatusLabels[status];
}

/** Keep the operation ID when the mutation may be committed but the projection refresh failed. */
export function roomWorkMutationNeedsRetry(result: NativeRoomWorkMutationResult | void): boolean {
  return result?.refreshed === false;
}

export interface NativeRoomWorkResultCard {
  resource: NativeArtifactWorkspaceInitialResource;
  title: string;
  typeLabel: "Artifact" | "Generated Surface";
  stateLabel: "作成済み" | "更新済み" | "結果を記録";
}

export interface NativeRoomWorkConversationEntry {
  id: string;
  workId: string;
  side: "human" | "agent";
  kind: "instruction" | "assignment-result" | "assignment-state";
  /** Agent ID is present only for the Agent-side entries. */
  agentId?: string;
  /** The Server-issued creator ID for human instructions. */
  authorId?: string;
  assigneeId?: string;
  text: string;
  version: number;
  generation: number;
  status: NativeRoomWorkInstructionStatus | NativeRoomWorkAssigneeStatus;
  createdAt?: string;
  attachments: ResourceRef[];
  resourceRefs: ResourceRef[];
  resultCards: NativeRoomWorkResultCard[];
}

/** Builds direct-open entries from validated Assignment result refs only. */
export function nativeRoomWorkResultCards(work: NativeRoomWork, room?: Pick<NativeRoom, "id" | "workspaceId">): NativeRoomWorkResultCard[] {
  if (room && work.roomId !== room.id) return [];
  const cards: NativeRoomWorkResultCard[] = [];
  const seen = new Set<string>();
  for (const assignee of work.assignees) {
    if (assignee.workId !== work.id) continue;
    const result = assignee.result;
    if (!result?.resourceRefs?.length) continue;
    for (const ref of result.resourceRefs) {
      if (ref.kind !== "artifact" && ref.kind !== "generated_surface") continue;
      if ((ref.roomId && ref.roomId !== work.roomId)
        || (room && ref.workspaceId && ref.workspaceId !== room.workspaceId)) continue;
      const key = `${ref.kind}\n${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const typeLabel = ref.kind === "artifact" ? "Artifact" : "Generated Surface";
      const revisionRefs = result.resourceRefs.filter((candidate) => candidate.parentId === ref.id
        && (!candidate.roomId || candidate.roomId === work.roomId)
        && (!room || !candidate.workspaceId || candidate.workspaceId === room.workspaceId));
      // A single, Server-linked revision can be opened exactly. If one work
      // changed the same resource multiple times, open the current durable
      // version instead of guessing which historical revision the person wants.
      const revisionId = revisionRefs.length === 1 ? revisionRefs[0]?.id : undefined;
      cards.push({
        resource: {
          kind: ref.kind,
          id: ref.id,
          uri: ref.uri,
          ...(revisionId ? { revisionId } : {}),
          ...(ref.label ? { label: ref.label } : {}),
          ...(ref.connectionId ? { connectionId: ref.connectionId } : {}),
          ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
          roomId: ref.roomId ?? work.roomId
        },
        title: ref.label?.trim() || ref.id,
        typeLabel,
        stateLabel: result.state === "created" ? "作成済み" : result.state === "updated" ? "更新済み" : "結果を記録"
      });
    }
  }
  return cards;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Assignment results have appeared in a few Server projections over time.
 * The normalizer usually gives the UI `summary`, but keeping this small
 * fallback here means a persisted output body is never silently dropped if a
 * bridge forwards the result shape directly.
 */
function roomWorkAssignmentResultText(result: NativeRoomWorkAssignee["result"]): string | undefined {
  if (!result) return undefined;
  const record = result as unknown as Record<string, unknown>;
  const output = record.output;
  const outputRecord = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : undefined;
  return nonEmptyText(result.summary)
    ?? nonEmptyText(record.output_summary)
    ?? nonEmptyText(record.result_summary)
    ?? nonEmptyText(record.message)
    ?? nonEmptyText(output)
    ?? nonEmptyText(outputRecord?.summary)
    ?? nonEmptyText(outputRecord?.output_summary)
    ?? nonEmptyText(outputRecord?.result_summary)
    ?? nonEmptyText(outputRecord?.message);
}

function conversationEntryTime(entry: NativeRoomWorkConversationEntry): number | undefined {
  if (!entry.createdAt) return undefined;
  const timestamp = Date.parse(entry.createdAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function compareAssigneeSnapshot(left: NativeRoomWorkAssignee, right: NativeRoomWorkAssignee): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  if (left.version !== right.version) return left.version - right.version;
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? 1 : -1;
  return 0;
}

function compareInstructionSnapshot(left: NativeRoomWorkInstruction, right: NativeRoomWorkInstruction): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  if (left.version !== right.version) return left.version - right.version;
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? 1 : -1;
  return 0;
}

function compareWorkSnapshot(left: NativeRoomWork, right: NativeRoomWork): number {
  if (left.generation !== right.generation) return left.generation - right.generation;
  if (left.version !== right.version) return left.version - right.version;
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : Number.NaN;
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : Number.NaN;
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? 1 : -1;
  return 0;
}

function conversationWorkDetailScore(work: NativeRoomWork): number {
  return (work.instructions?.length ?? 0)
    + work.assignees.length
    + (work.resultSummary ? 1 : 0)
    + (work.resourceRefs?.length ?? 0);
}

function conversationWorkTime(work: NativeRoomWork): number | undefined {
  const createdAt = work.createdAt ? Date.parse(work.createdAt) : Number.NaN;
  if (Number.isFinite(createdAt)) return createdAt;
  const updatedAt = work.updatedAt ? Date.parse(work.updatedAt) : Number.NaN;
  return Number.isFinite(updatedAt) ? updatedAt : undefined;
}

/**
 * Keeps one newest, same-Room Work snapshot per Work ID while retaining a
 * richer detail response when its version is equal to the list projection.
 * The selected Work is only an additional source for that existing Work; it
 * does not make the conversation depend on a single selected item.
 */
export function nativeRoomWorkConversationWorks(
  works: NativeRoomWork[],
  room?: Pick<NativeRoom, "id" | "workspaceId">,
  selectedWork?: NativeRoomWork
): NativeRoomWork[] {
  const rows = new Map<string, NativeRoomWork>();
  const add = (candidate: NativeRoomWork, preferEqualSnapshot = false): void => {
    if (room && candidate.roomId !== room.id) return;
    const current = rows.get(candidate.id);
    if (!current) {
      rows.set(candidate.id, candidate);
      return;
    }
    const snapshotOrder = compareWorkSnapshot(candidate, current);
    if (snapshotOrder > 0 || (snapshotOrder === 0 && (preferEqualSnapshot || conversationWorkDetailScore(candidate) > conversationWorkDetailScore(current)))) {
      rows.set(candidate.id, candidate);
    }
  };
  works.forEach((work) => add(work));
  if (selectedWork) add(selectedWork, true);

  return [...rows.values()].sort((left, right) => {
    const leftTime = conversationWorkTime(left);
    const rightTime = conversationWorkTime(right);
    if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime;
    if (leftTime !== undefined && rightTime === undefined) return -1;
    if (leftTime === undefined && rightTime !== undefined) return 1;
    const snapshotOrder = compareWorkSnapshot(left, right);
    if (snapshotOrder !== 0) return snapshotOrder;
    return left.id.localeCompare(right.id);
  });
}

function resultCardsForAssignee(
  work: NativeRoomWork,
  assignee: NativeRoomWorkAssignee,
  room?: Pick<NativeRoom, "id" | "workspaceId">
): NativeRoomWorkResultCard[] {
  return nativeRoomWorkResultCards({ ...work, assignees: [assignee] }, room);
}

/**
 * Projects one Room Work into the Chat-first message stream.
 *
 * Work/Assignment IDs are deliberately part of the projection key. This
 * keeps a stale detail response or a duplicate list row from becoming a new
 * visible message, while preserving the existing Work detail fetch boundary.
 */
export function nativeRoomWorkConversationEntries(
  work: NativeRoomWork,
  room?: Pick<NativeRoom, "id" | "workspaceId">,
  agents: Pick<NativeAgent, "id">[] = []
): NativeRoomWorkConversationEntry[] {
  if (room && work.roomId !== room.id) return [];

  const entries: NativeRoomWorkConversationEntry[] = [];
  const agentIds = new Set(agents.map((agent) => agent.id));

  const latestInstructions = new Map<string, NativeRoomWorkInstruction>();
  for (const instruction of work.instructions ?? []) {
    if (instruction.workId !== work.id) continue;
    const current = latestInstructions.get(instruction.id);
    if (!current || compareInstructionSnapshot(instruction, current) > 0) latestInstructions.set(instruction.id, instruction);
  }

  for (const instruction of latestInstructions.values()) {
    const text = nonEmptyText(instruction.instruction)
      ?? (instruction.attachments.length > 0 ? "添付のみの指示"
        : instruction.resourceRefs?.length ? "Knowledge/Skillのみの指示" : "本文なしの指示");
    const isAgentInstruction = agentIds.has(instruction.createdBy);
    entries.push({
      id: `instruction:${work.id}:${instruction.id}`,
      workId: work.id,
      side: isAgentInstruction ? "agent" : "human",
      kind: "instruction",
      ...(isAgentInstruction ? { agentId: instruction.createdBy } : {}),
      ...(!isAgentInstruction ? { authorId: instruction.createdBy } : {}),
      text,
      version: instruction.version,
      generation: instruction.generation,
      status: instruction.status,
      ...(instruction.createdAt ? { createdAt: instruction.createdAt } : {}),
      attachments: instruction.attachments,
      resourceRefs: instruction.resourceRefs ?? [],
      resultCards: []
    });
  }

  // A list refresh can contain the same assignment more than once. Keep the
  // newest generation/version before turning it into a Chat message.
  const latestAssignees = new Map<string, NativeRoomWorkAssignee>();
  for (const assignee of work.assignees) {
    if (assignee.workId !== work.id) continue;
    const current = latestAssignees.get(assignee.id);
    if (!current || compareAssigneeSnapshot(assignee, current) > 0) latestAssignees.set(assignee.id, assignee);
  }

  const resultTexts = new Set<string>();
  for (const assignee of latestAssignees.values()) {
    const result = assignee.result;
    const resultCards = resultCardsForAssignee(work, assignee, room);
    const resultText = roomWorkAssignmentResultText(result);
    if (resultText) resultTexts.add(resultText);
    const displayStatus = work.stopState && work.stopState !== "none" ? workDisplayStatus(work) : assignee.status;
    const text = resultText ?? (resultCards.length > 0 ? "成果物を記録しました。" : `担当作業: ${roomWorkStatusLabel(displayStatus)}`);
    const hasResult = Boolean(resultText || resultCards.length);
    entries.push({
      id: `${hasResult ? "result" : "state"}:${work.id}:${assignee.id}:${assignee.generation}:${assignee.version}`,
      workId: work.id,
      side: "agent",
      kind: hasResult ? "assignment-result" : "assignment-state",
      agentId: assignee.agentId,
      assigneeId: assignee.id,
      text,
      version: assignee.version,
      generation: assignee.generation,
      status: displayStatus,
      ...(assignee.updatedAt ?? assignee.createdAt ? { createdAt: assignee.updatedAt ?? assignee.createdAt } : {}),
      attachments: [],
      resourceRefs: [],
      resultCards
    });
  }

  // Some current Server responses expose the final body on Work rather than
  // on Assignment.result. Show it once, but do not duplicate an Assignment
  // result carrying the same body.
  const workResultText = nonEmptyText(work.resultSummary);
  if (workResultText && !resultTexts.has(workResultText)) {
    entries.push({
      id: `result:${work.id}:work:${work.version}:${work.generation}`,
      workId: work.id,
      side: "agent",
      kind: "assignment-result",
      agentId: work.defaultAgentId,
      text: workResultText,
      version: work.version,
      generation: work.generation,
      status: work.status,
      ...(work.updatedAt ?? work.createdAt ? { createdAt: work.updatedAt ?? work.createdAt } : {}),
      attachments: [],
      resourceRefs: [],
      resultCards: nativeRoomWorkResultCards(work, room)
    });
  }

  return entries
    .map((entry, index) => ({ entry, index, time: conversationEntryTime(entry) }))
    .sort((left, right) => {
      if (left.time !== undefined && right.time !== undefined && left.time !== right.time) return left.time - right.time;
      if (left.time !== undefined && right.time === undefined) return -1;
      if (left.time === undefined && right.time !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ entry }) => entry);
}

/** Projects all available same-Room Work histories into one chronological stream. */
export function nativeRoomWorkConversationEntriesForRoom(
  works: NativeRoomWork[],
  room?: Pick<NativeRoom, "id" | "workspaceId">,
  agents: Pick<NativeAgent, "id">[] = [],
  selectedWork?: NativeRoomWork
): NativeRoomWorkConversationEntry[] {
  const conversationWorks = nativeRoomWorkConversationWorks(works, room, selectedWork);
  const entries = conversationWorks.flatMap((work, workIndex) => nativeRoomWorkConversationEntries(work, room, agents)
    .map((entry, entryIndex) => ({
      entry,
      workIndex,
      entryIndex,
      workTime: conversationWorkTime(work)
    })));
  const seen = new Set<string>();
  return entries
    .filter(({ entry }) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((left, right) => {
      const leftTime = conversationEntryTime(left.entry) ?? left.workTime;
      const rightTime = conversationEntryTime(right.entry) ?? right.workTime;
      if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) return leftTime - rightTime;
      if (leftTime !== undefined && rightTime === undefined) return -1;
      if (leftTime === undefined && rightTime !== undefined) return 1;
      if (left.workIndex !== right.workIndex) return left.workIndex - right.workIndex;
      if (left.entry.generation !== right.entry.generation) return left.entry.generation - right.entry.generation;
      if (left.entry.version !== right.entry.version) return left.entry.version - right.entry.version;
      if (left.entryIndex !== right.entryIndex) return left.entryIndex - right.entryIndex;
      return left.entry.id.localeCompare(right.entry.id);
    })
    .map(({ entry }) => entry);
}

function roomWorkControlLabel(control: NativeRoomWorkControl): string {
  if (control.action === "assignee.reassign") {
    if (control.status === "requested") return "担当変更要求中";
    if (control.status === "completed" || control.status === "confirmed") return "担当変更確認済み";
  }
  if (control.action === "assignee.stop" && control.status === "requested") return "担当停止要求中";
  if (control.action === "assignee.stop" && (control.status === "completed" || control.status === "confirmed")) return "担当停止確認済み";
  if (control.status === "requested") return "停止要求中";
  return roomWorkControlStatusLabel(control.status);
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return value.slice(0, 6) + "…" + value.slice(-4);
}

function actorLabel(value: string | undefined, currentAccountId: string | undefined): string {
  if (!value) return "不明なアカウント";
  return value === currentAccountId ? "あなた" : shortId(value);
}

function agentLabel(agentId: string, agents: NativeAgent[]): string {
  const agent = agents.find((item) => item.id === agentId);
  return agent ? agent.displayName : "Agent " + shortId(agentId);
}

function actorInitial(label: string): string {
  return label.trim().slice(0, 1) || "?";
}

export interface RoomWorkComposerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

/** Keep IME composition confirmation from being treated as a send shortcut. */
export function roomWorkShouldSubmitOnKeyDown(event: RoomWorkComposerKeyEvent): boolean {
  return event.key === "Enter"
    && (event.metaKey || event.ctrlKey)
    && !event.shiftKey
    && !event.isComposing;
}

export const roomWorkComposerMaxHeight = 216;
export const roomWorkComposerMinHeight = 44;

export interface RoomWorkComposerResizeTarget {
  readonly scrollHeight: number;
  style: {
    height: string;
    overflowY: string;
  };
}

/** Grow with the draft until the transcript still has useful room to remain visible. */
export function resizeRoomWorkComposer(
  input: RoomWorkComposerResizeTarget,
  maxHeight = roomWorkComposerMaxHeight
): void {
  // Reset first so deletions shrink the field too; flex sizing must not decide its height.
  input.style.overflowY = "hidden";
  input.style.height = "0px";
  const contentHeight = input.scrollHeight;
  const height = Math.min(Math.max(contentHeight, roomWorkComposerMinHeight), maxHeight);
  input.style.height = `${height}px`;
  input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

function RoomMenuIcon(): ReactNode {
  return (
    <svg className="native-work-header-icon" data-icon="room-menu" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="13" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

function RoomComposerAddIcon(): ReactNode {
  return (
    <svg className="native-work-composer-icon" data-icon="add" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" />
    </svg>
  );
}

function RoomSendIcon(): ReactNode {
  return (
    <svg className="native-work-composer-icon" data-icon="send" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 18V6M7.5 10.5 12 6l4.5 4.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
    </svg>
  );
}

function RoomChevronIcon(): ReactNode {
  return (
    <svg className="native-work-composer-chevron" data-icon="chevron-down" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="m2.5 4.5 3.5 3 3.5-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
    </svg>
  );
}

function roomCapability(room: NativeRoom | undefined, capability: "canEdit" | "canExecute" | "canManage" | "canStop"): boolean {
  return room?.[capability] === true || room?.capabilities?.[capability] === true;
}

function roomCapabilityKnown(room: NativeRoom | undefined, capability: "canEdit" | "canExecute" | "canManage" | "canStop"): boolean {
  return typeof room?.[capability] === "boolean" || typeof room?.capabilities?.[capability] === "boolean";
}

function agentIsAvailable(agent: NativeAgent | undefined, backends?: NativeAgentBackend[], roomAgentMembers?: NativeRoomAgentMember[]): boolean {
  if (!agent || (roomAgentMembers !== undefined && !roomAgentMembers.some((member) => member.agentId === agent.id && !member.removed && member.canExecute))) return false;
  if (backends) return nativeRoomAgentIsAvailable(agent, backends);
  return agent.enabled === true && agent.status === "active" && agent.canExecute !== false;
}

/** A renderer-side hint only; the Room Work operation repeats this check on the Server. */
export function roomWorkControlAllowed(room: NativeRoom | undefined, work: NativeRoomWork, currentAccountId: string | undefined): boolean {
  if (!roomExecutionAllowed(room) || !currentAccountId) return false;
  return work.requesterId === currentAccountId || roomCapability(room, "canManage");
}

function roomExecutionAllowed(room: NativeRoom | undefined): boolean {
  if (room?.canExecute === false || room?.capabilities?.canExecute === false) return false;
  if (room?.kind === "agent_dm") return true;
  return roomCapability(room, "canExecute");
}

function workStopAllowed(room: NativeRoom | undefined, work: NativeRoomWork, currentAccountId: string | undefined): boolean {
  const explicit = room?.canStop ?? room?.capabilities?.canStop;
  if (typeof explicit === "boolean") return explicit;
  if (!currentAccountId) return false;
  return work.requesterId === currentAccountId || roomCapability(room, "canManage");
}

function statusTone(status: NativeRoomWorkStatus): string {
  if (status === "completed") return "is-complete";
  if (status === "failed" || status === "outcome_unknown" || status === "blocked") return "is-alert";
  if (status === "stopping" || status === "cancelled") return "is-stop";
  if (status === "running") return "is-live";
  return "is-neutral";
}

function instructionTone(status: NativeRoomWorkInstructionStatus): string {
  if (status === "applied") return "is-complete";
  if (status === "failed" || status === "rejected") return "is-alert";
  if (status === "delivered") return "is-live";
  return "is-neutral";
}

function controlTone(status: NativeRoomWorkControl["status"]): string {
  if (status === "completed") return "is-complete";
  if (status === "failed" || status === "rejected" || status === "unconfirmed") return "is-alert";
  if (status === "running") return "is-live";
  return "is-neutral";
}

function workIsTerminal(work: NativeRoomWork): boolean {
  return terminalWorkStatuses.includes(work.status) || work.stopState === "confirmed";
}

/**
 * A known Work can receive a new instruction as a continuation. Stopped and
 * unknown-outcome Work stay closed in the UI, and a requested stop is not a
 * safe point for starting another Run.
 */
export function roomWorkCanReceiveReply(work: NativeRoomWork): boolean {
  if (work.stopState !== undefined && work.stopState !== "none") return false;
  return work.status !== "cancelled" && work.status !== "outcome_unknown" && work.status !== "stopping";
}

function workDisplayStatus(work: NativeRoomWork): NativeRoomWorkStatus {
  if (work.stopState === "requested") return "stopping";
  if (work.stopState === "confirmed") return "cancelled";
  if (work.stopState === "unconfirmed") return "outcome_unknown";
  return work.status;
}

function assigneeIsTerminal(assignee: NativeRoomWorkAssignee): boolean {
  return terminalAssigneeStatuses.includes(assignee.status);
}

function workActionLabel(action: NativeRoomWorkControl["action"]): string {
  if (action === "assignee.stop") return "担当停止";
  if (action === "assignee.reassign") return "担当変更";
  return "仕事停止";
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

const attachmentPathPattern = /^attachments\/[A-Za-z0-9._-]{1,220}$/;

function safeAttachmentName(value: string): string {
  const basename = value.split(/[\\/]/).pop() ?? "file";
  return basename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "file";
}

function attachmentPath(id: string, name: string): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96) || "attachment";
  const safeName = safeAttachmentName(name);
  const path = `attachments/${safeId}-${safeName}`;
  if (!attachmentPathPattern.test(path)) throw new Error("workspace_attachment_path_invalid");
  return path;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function safeAttachmentRef(value: ResourceRef | undefined): ResourceRef | undefined {
  const parsed = WorkspaceFileResourceRefSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { ...parsed.data, label: parsed.data.label ?? parsed.data.uri };
}

function attachmentRefs(drafts: RoomAttachmentDraft[]): ResourceRef[] {
  return drafts.flatMap((draft) => {
    if (draft.status !== "ready") return [];
    const ref = safeAttachmentRef(draft.resourceRef);
    return ref ? [ref] : [];
  });
}

function attachmentDraftKey(drafts: RoomAttachmentDraft[]): string {
  return drafts.map((draft) => `${draft.id}:${draft.status}:${draft.resourceRef?.id ?? ""}:${draft.resourceRef?.version ?? ""}`).join("|");
}

function attachmentErrorMessage(): string {
  return "アップロードに失敗しました。再試行するか、添付を外してください。";
}

function renderSavedAttachmentRefs(refs: ResourceRef[]): ReactNode {
  const safeRefs = refs.flatMap((ref) => {
    const safe = safeAttachmentRef(ref);
    return safe ? [safe] : [];
  });
  if (!safeRefs.length) return null;
  return (
    <div className="native-work-attachment-list" aria-label="添付">
      {safeRefs.map((ref) => <span className="native-work-attachment-item" key={`${ref.id}:${ref.version ?? ""}`}>{ref.label ?? ref.uri}{ref.version ? <span className="native-work-attachment-action">v{ref.version}</span> : null}</span>)}
    </div>
  );
}

function resourceRefKey(ref: Pick<NativeRoomWorkResourceRefInput, "kind" | "id" | "version">): string {
  return `${ref.kind}\n${ref.id}\n${ref.version}`;
}

function resourceRefDisplayLabel(ref: Pick<NativeRoomWorkResourceRefInput, "kind" | "id" | "version" | "label">): string {
  return ref.label?.trim() || ref.id;
}

function renderSavedRoomWorkResourceRefs(refs: ResourceRef[]): ReactNode {
  const safeRefs = refs.flatMap((ref) => {
    if ((ref.kind !== "knowledge" && ref.kind !== "skill") || !ref.version || !/^[1-9][0-9]*$/.test(ref.version)) return [];
    return [ref];
  });
  if (!safeRefs.length) return null;
  return (
    <div className="native-work-resource-list" aria-label="利用したKnowledgeとSkill">
      {safeRefs.map((ref) => <span className="native-work-resource-item" key={`${ref.kind}:${ref.id}:${ref.version}`}>
        <span>{ref.kind === "knowledge" ? "Knowledge" : "Skill"}</span>
        {ref.label ?? ref.id}
        <span className="native-work-resource-version">v{ref.version}</span>
      </span>)}
    </div>
  );
}

const roomWorkStyles = [
  ".native-work-surface { container-type: inline-size; min-height: 0; }",
  ".native-work-surface .native-chat-header { align-items: center; gap: 12px; height: var(--native-room-header-height, 56px); min-height: var(--native-room-header-height, 56px); padding: 0 var(--native-chat-header-right-inset, 24px) 0 24px; }",
  "@media (max-width: 700px) { .native-work-surface .native-chat-header { padding-left: 56px; padding-right: var(--native-chat-header-right-inset, 24px); } }",
  ".native-work-surface .native-chat-header .native-section-eyebrow { display: none; }",
  ".native-work-surface .native-room-heading { min-width: 0; }",
  ".native-work-surface .native-chat-header h1 { color: var(--native-copy); font-family: Avenir Next, Hiragino Sans, ui-sans-serif, sans-serif; font-size: 17px; font-weight: 600; letter-spacing: .02em; line-height: 1.25; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-surface .native-chat-header h1::before { color: var(--native-dim); content: '#'; font-size: 20px; font-weight: 400; margin-right: 10px; }",
  ".native-work-header-artifact-link.native-room-tool-links { border: 0; display: block; padding: 0; }",
  ".native-work-header-meta { align-items: center; display: flex; flex: 0 1 auto; flex-direction: row; flex-wrap: nowrap; gap: 8px; justify-content: flex-end; min-width: 0; }",
  ".native-work-default { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }",
  ".native-work-default-avatar { align-items: center; background: var(--native-panel-soft); border-radius: 8px; color: var(--native-copy); display: inline-flex; font-size: 10px; font-weight: 600; height: 25px; justify-content: center; width: 25px; }",
  ".native-work-default-label { color: var(--native-dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }",
  ".native-work-default-value { color: var(--native-copy); font-size: 12px; }",
  ".native-work-default-value.is-missing, .native-work-default-value.is-invalid { color: var(--native-accent); }",
  ".native-work-default-select { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 7px; color: var(--native-copy); font: inherit; font-size: 11px; max-width: 180px; min-height: 28px; padding: 0 8px; }",
  ".native-work-default-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-reply-target { align-items: center; background: var(--native-accent-soft); border: 1px solid var(--native-line-strong); border-radius: 9px; display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 10px 0; padding: 8px 10px; }",
  ".native-work-reply-icon { color: var(--native-accent); flex: 0 0 auto; font-size: 14px; }",
  ".native-work-reply-context { display: grid; gap: 2px; min-width: 0; flex: 1 1 180px; }",
  ".native-work-reply-context small { color: var(--native-dim); font-size: 9px; }",
  ".native-work-reply-context strong { color: var(--native-copy); font-size: 10px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-reply-clear { align-items: center; background: transparent; border: 0; border-radius: 5px; color: var(--native-dim); cursor: pointer; display: inline-flex; font: inherit; font-size: 17px; height: 24px; justify-content: center; padding: 0; width: 24px; }",
  ".native-work-reply-clear:hover { background: var(--native-panel-soft); color: var(--native-copy); }",
  ".native-work-reply-target label { align-items: center; color: var(--native-copy); display: flex; flex-wrap: wrap; font-size: 10px; gap: 8px; }",
  ".native-work-reply-target label span { color: var(--native-accent); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }",
  ".native-work-reply-select { background: var(--native-panel); border: 1px solid var(--native-line-strong); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 11px; min-height: 28px; padding: 0 8px; }",
  ".native-work-reply-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-reply-note { color: var(--native-muted); font-size: 10px; line-height: 1.5; }",
  ".native-work-reply-note.is-required { color: var(--native-accent); }",
  ".native-work-private-note { color: var(--native-muted); font-size: 10px; line-height: 1.5; text-align: right; }",
  ".native-work-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }",
  ".native-work-conversation { display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }",
  ".native-work-thread-switcher { align-items: center; border-bottom: 1px solid var(--native-line); display: flex; flex-wrap: nowrap; gap: 7px; height: 52px; max-height: 52px; overflow-x: auto; overflow-y: hidden; padding: 8px 30px; }",
  ".native-work-thread-switcher-label { color: var(--native-dim); flex: 0 0 auto; font-size: 9px; letter-spacing: .1em; margin-right: 4px; text-transform: uppercase; }",
  ".native-work-thread-switcher button { align-items: center; background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 999px; color: var(--native-muted); cursor: pointer; display: inline-flex; flex: 0 0 auto; font: inherit; font-size: 10px; gap: 7px; max-width: min(240px, 100%); min-height: 28px; padding: 0 10px; }",
  ".native-work-thread-switcher button:hover:not(:disabled) { border-color: var(--native-line-strong); color: var(--native-copy); }",
  ".native-work-thread-switcher button.is-selected { background: var(--native-accent-soft); border-color: var(--native-accent); color: var(--native-copy); }",
  ".native-work-thread-switcher button:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-thread-switcher button:disabled { cursor: default; opacity: .6; }",
  ".native-work-thread-switcher-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-conversation-header { align-items: flex-start; display: flex; gap: 18px; justify-content: space-between; margin: 14px auto 0; max-width: 800px; padding: 0 30px; width: 100%; }",
  ".native-work-conversation-header.is-compact { align-items: center; justify-content: flex-end; margin-top: 10px; min-height: 26px; }",
  ".native-work-conversation-heading { min-width: 0; }",
  ".native-work-conversation-heading h2 { color: var(--native-copy); font-family: Avenir Next, Hiragino Sans, ui-sans-serif, sans-serif; font-size: 17px; font-weight: 600; letter-spacing: .02em; margin: 0; }",
  ".native-work-conversation-heading p { color: var(--native-muted); font-size: 12px; line-height: 1.65; margin: 6px 0 0; max-width: 650px; white-space: pre-wrap; }",
  ".native-work-conversation-actions { align-items: center; display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }",
  ".native-work-conversation-status { align-items: center; display: flex; gap: 8px; }",
  ".native-work-message-list { gap: 17px; padding-top: 22px; }",
  ".native-work-message { max-width: 770px; position: relative; width: min(100%, 770px); }",
  ".native-work-message-self { align-self: flex-end; max-width: min(76%, 560px); width: auto; }",
  ".native-work-message-peer, .native-work-message-agent { align-self: flex-start; display: grid; gap: 11px; grid-template-columns: 31px minmax(0, 1fr); }",
  ".native-work-message-peer .native-message-content, .native-work-message-agent .native-message-content { text-align: left; }",
  ".native-work-message-avatar { align-items: center; background: var(--native-panel-soft); border-radius: 10px; color: var(--native-copy); display: inline-flex; flex: 0 0 auto; font-size: 11px; font-weight: 600; height: 31px; justify-content: center; width: 31px; }",
  ".native-work-message-main { min-width: 0; }",
  ".native-work-message-bubble { min-width: 0; }",
  ".native-work-message-peer .native-message-meta { color: var(--native-dim); font-size: 10px; letter-spacing: 0; margin-bottom: 6px; }",
  ".native-work-message-agent .native-message-meta { flex-wrap: wrap; margin-bottom: 6px; }",
  ".native-work-message-status { color: var(--native-dim); font-size: 9px; font-weight: 400; letter-spacing: 0; }",
  ".native-work-message-agent .native-message-content { max-width: 720px; }",
  ".native-work-message-peer .native-work-message-reply, .native-work-message-agent .native-work-message-reply { grid-column: 2; grid-row: 2; justify-self: start; }",
  ".native-work-message-self .native-work-message-reply { display: block; margin-left: auto; }",
  ".native-work-message-state { color: var(--native-muted); font-size: 10px; line-height: 1.5; margin-top: 8px; }",
  ".native-work-message-state.is-live { color: var(--native-accent); }",
  ".native-work-message-state.is-complete { color: var(--native-success); }",
  ".native-work-message-state.is-alert { color: var(--native-danger); }",
  ".native-work-message-time { color: var(--native-dim); font-size: 9px; font-weight: 400; letter-spacing: 0; }",
  ".native-work-message-reply { color: var(--native-muted); font-size: 10px; margin-top: 8px; }",
  ".native-work-message-reply:hover:not(:disabled) { color: var(--native-copy); }",
  ".native-work-message-result-card { margin-top: 10px; max-width: 560px; }",
  ".native-work-conversation-loading { color: var(--native-muted); margin: auto; text-align: center; }",
  ".native-work-conversation-empty { color: var(--native-muted); margin: auto; max-width: 420px; padding: 36px 22px; text-align: center; }",
  ".native-work-conversation-empty p { line-height: 1.7; margin: 9px 0 0; }",
  ".native-work-list { border-right: 1px solid var(--native-line); min-height: 0; overflow: auto; padding: 20px; }",
  ".native-work-list-heading { align-items: baseline; display: flex; justify-content: space-between; margin: 0 0 14px; }",
  ".native-work-list-heading h2, .native-work-detail-heading h2 { color: var(--native-copy); font-family: Avenir Next, Hiragino Sans, ui-sans-serif, sans-serif; font-size: 16px; font-weight: 600; letter-spacing: .01em; margin: 0; }",
  ".native-work-list-count { color: var(--native-dim); font-size: 10px; letter-spacing: .08em; }",
  ".native-work-list-items { display: grid; gap: 9px; list-style: none; margin: 0; padding: 0; }",
  ".native-work-card { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 10px; color: inherit; cursor: pointer; display: block; padding: 13px; text-align: left; transition: background 150ms ease, border-color 150ms ease, transform 150ms ease; width: 100%; }",
  ".native-work-card:hover:not(:disabled) { background: var(--native-panel); border-color: var(--native-line-strong); transform: translateY(-1px); }",
  ".native-work-card:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-card.is-selected { background: var(--native-accent-soft); border-color: var(--native-accent); box-shadow: inset 3px 0 0 var(--native-accent); }",
  ".native-work-card:disabled { cursor: default; }",
  ".native-work-card-top, .native-work-card-meta, .native-work-assignee-row, .native-work-control-row, .native-work-comment-head, .native-work-detail-actions { align-items: center; display: flex; gap: 8px; }",
  ".native-work-card-top { justify-content: space-between; }",
  ".native-work-card-title { color: var(--native-copy); font-size: 12px; font-weight: 650; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-card-objective { color: var(--native-muted); display: -webkit-box; font-size: 11px; line-height: 1.5; margin: 7px 0 10px; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }",
  ".native-work-card-meta { color: var(--native-dim); flex-wrap: wrap; font-size: 9px; justify-content: space-between; letter-spacing: .04em; }",
  ".native-work-status, .native-work-instruction-status, .native-work-control-status { border: 1px solid var(--native-line); border-radius: 999px; display: inline-flex; font-size: 9px; line-height: 1; padding: 5px 7px; white-space: nowrap; }",
  ".native-work-status.is-live, .native-work-instruction-status.is-live, .native-work-control-status.is-live { border-color: var(--native-accent); color: var(--native-accent); }",
  ".native-work-status.is-complete, .native-work-instruction-status.is-complete, .native-work-control-status.is-complete { border-color: var(--native-success); color: var(--native-success); }",
  ".native-work-status.is-stop { border-color: var(--native-danger); color: var(--native-danger); }",
  ".native-work-status.is-alert, .native-work-instruction-status.is-alert, .native-work-control-status.is-alert { border-color: var(--native-danger); color: var(--native-danger); }",
  ".native-work-status.is-neutral, .native-work-instruction-status.is-neutral, .native-work-control-status.is-neutral { color: var(--native-muted); }",
  ".native-work-assignee-row { color: var(--native-muted); flex-wrap: wrap; font-size: 10px; margin-top: 10px; }",
  ".native-work-assignee-chip { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 999px; color: var(--native-muted); padding: 4px 7px; }",
  ".native-work-empty { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 24px auto; max-width: 280px; text-align: center; }",
  ".native-work-detail { min-height: 0; overflow: auto; padding: 27px clamp(22px, 4vw, 62px) 36px; }",
  ".native-work-detail-heading { align-items: flex-start; display: flex; gap: 18px; justify-content: space-between; }",
  ".native-work-detail-heading p { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 10px 0 0; max-width: 720px; white-space: pre-wrap; }",
  ".native-work-detail-actions { flex-wrap: wrap; justify-content: flex-end; }",
  ".native-work-subheading { align-items: baseline; border-bottom: 1px solid var(--native-line); display: flex; justify-content: space-between; margin: 28px 0 12px; padding-bottom: 8px; }",
  ".native-work-subheading h3 { color: var(--native-copy); font-size: 11px; letter-spacing: .1em; margin: 0; text-transform: uppercase; }",
  ".native-work-subheading span { color: var(--native-dim); font-size: 9px; }",
  ".native-work-assignees { display: grid; gap: 8px; }",
  ".native-work-assignee-card { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 9px; padding: 11px; }",
  ".native-work-assignee-row { justify-content: space-between; margin: 0; }",
  ".native-work-assignee-main { align-items: center; display: flex; gap: 8px; min-width: 0; }",
  ".native-work-assignee-main strong { color: var(--native-copy); font-size: 11px; font-weight: 600; }",
  ".native-work-assignee-main span { color: var(--native-dim); font-size: 9px; }",
  ".native-work-assignee-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }",
  ".native-work-assignee-actions select { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 10px; min-height: 26px; padding: 0 6px; }",
  ".native-work-delegation { background: var(--native-panel-soft); border: 1px solid var(--native-line-strong); border-radius: 10px; display: grid; gap: 12px; padding: 14px; }",
  ".native-work-delegation-help { color: var(--native-muted); font-size: 10px; line-height: 1.6; margin: -4px 0 0; }",
  ".native-work-delegation-grid { display: grid; gap: 10px; grid-template-columns: minmax(150px, .85fr) minmax(210px, 1.15fr); }",
  ".native-work-delegation-field { display: grid; gap: 6px; }",
  ".native-work-delegation-field > span { color: var(--native-dim); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }",
  ".native-work-delegation-select { background: var(--native-panel); border: 1px solid var(--native-line-strong); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 11px; min-height: 29px; padding: 0 8px; width: 100%; }",
  ".native-work-delegation-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-delegation-agents, .native-work-delegation-dependencies { display: grid; gap: 7px; }",
  ".native-work-delegation-agents { grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }",
  ".native-work-delegation-check { align-items: flex-start; background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 7px; color: var(--native-copy); display: flex; font-size: 10px; gap: 7px; line-height: 1.4; padding: 8px; }",
  ".native-work-delegation-check:has(input:checked) { border-color: var(--native-accent); background: var(--native-accent-soft); }",
  ".native-work-delegation-check:has(input:disabled) { color: var(--native-dim); cursor: not-allowed; }",
  ".native-work-delegation-check input { accent-color: var(--native-accent); margin: 2px 0 0; }",
  ".native-work-delegation-dependency { align-items: center; color: var(--native-muted); display: flex; font-size: 10px; gap: 7px; }",
  ".native-work-delegation-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; justify-content: space-between; }",
  ".native-work-delegation-status { color: var(--native-muted); font-size: 10px; line-height: 1.5; }",
  ".native-work-delegation-status.is-complete { color: var(--native-success); }",
  ".native-work-delegation-status.is-alert { color: var(--native-danger); }",
  ".native-work-timeline { border-left: 1px solid var(--native-accent); display: grid; gap: 11px; margin-left: 7px; padding-left: 18px; }",
  ".native-work-instruction { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 9px; padding: 12px; position: relative; }",
  ".native-work-instruction::before { background: var(--native-accent); border: 3px solid var(--native-bg); border-radius: 50%; content: ''; height: 7px; left: -23px; position: absolute; top: 14px; width: 7px; }",
  ".native-work-instruction-head { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; justify-content: space-between; }",
  ".native-work-instruction-kind { color: var(--native-dim); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }",
  ".native-work-instruction-body { color: var(--native-copy); font-size: 12px; line-height: 1.7; margin: 8px 0 0; white-space: pre-wrap; }",
  ".native-work-instruction-foot { color: var(--native-dim); display: flex; flex-wrap: wrap; font-size: 9px; gap: 10px; margin-top: 8px; }",
  ".native-work-comments { display: grid; gap: 9px; }",
  ".native-work-comment { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 9px; padding: 12px; }",
  ".native-work-comment-head { justify-content: space-between; }",
  ".native-work-comment-author { color: var(--native-copy); font-size: 11px; font-weight: 600; }",
  ".native-work-comment-time { color: var(--native-dim); font-size: 9px; }",
  ".native-work-comment-body { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 8px 0 11px; white-space: pre-wrap; }",
  ".native-work-comment-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }",
  ".native-work-comment-actions select { background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 6px; color: var(--native-muted); font: inherit; font-size: 10px; min-height: 27px; padding: 0 6px; }",
  ".native-work-comment-applied { color: var(--native-success); font-size: 10px; }",
  ".native-work-controls { display: grid; gap: 7px; }",
  ".native-work-control-row { border-bottom: 1px solid var(--native-line); color: var(--native-muted); font-size: 10px; justify-content: space-between; padding: 7px 0; }",
  ".native-work-control-row:last-child { border-bottom: 0; }",
  ".native-work-control-row span:first-child { color: var(--native-copy); }",
  ".native-work-control-warning { color: var(--native-danger); font-size: 10px; line-height: 1.6; margin: 7px 0 0; }",
  ".native-work-composer-block { margin-top: 28px; }",
  ".native-work-composer-label { color: var(--native-accent); display: block; font-size: 10px; letter-spacing: .1em; margin-bottom: 9px; text-transform: uppercase; }",
  ".native-work-composer-help { color: var(--native-dim); font-size: 10px; line-height: 1.6; margin: 8px 0 0; }",
  ".native-work-attachments { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 3px; }",
  ".native-work-attachment { align-items: center; background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 7px; display: inline-flex; gap: 7px; max-width: 100%; padding: 6px 8px; }",
  ".native-work-attachment-name { color: var(--native-copy); font-size: 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-attachment-state { color: var(--native-dim); font-size: 9px; }",
  ".native-work-resource-list { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 3px; }",
  ".native-work-resource-item { align-items: center; background: var(--native-accent-soft); border: 1px solid var(--native-line-strong); border-radius: 7px; color: var(--native-copy); display: inline-flex; font-size: 10px; gap: 6px; max-width: 100%; padding: 6px 8px; }",
  ".native-work-resource-item > span:first-child { color: var(--native-accent); font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }",
  ".native-work-resource-version { color: var(--native-dim); font-size: 9px; }",
  ".native-work-result-cards { display: grid; gap: 9px; margin-top: 10px; }",
  ".native-work-result-card { align-items: center; background: var(--native-panel-soft); border: 1px solid var(--native-line); border-radius: 10px; color: inherit; cursor: pointer; display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; padding: 12px 13px; text-align: left; transition: background 150ms ease, border-color 150ms ease; width: 100%; }",
  ".native-work-result-card:hover { background: var(--native-panel); border-color: var(--native-line-strong); }",
  ".native-work-result-card:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-result-card-main { display: grid; gap: 5px; min-width: 0; }",
  ".native-work-result-card-title { color: var(--native-copy); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-result-card-meta { align-items: center; color: var(--native-muted); display: flex; flex-wrap: wrap; font-size: 9px; gap: 7px; }",
  ".native-work-result-card-state { border: 1px solid var(--native-success); border-radius: 999px; color: var(--native-success); font-size: 9px; padding: 5px 7px; white-space: nowrap; }",
  ".native-work-result-card-open { color: var(--native-accent); font-size: 10px; white-space: nowrap; }",
  ".native-work-resource-remove { background: transparent; border: 0; color: var(--native-muted); cursor: pointer; font: inherit; font-size: 12px; line-height: 1; padding: 0 0 0 2px; }",
  ".native-work-resource-remove:hover { color: var(--native-copy); }",
  ".native-work-attachment.is-ready { border-color: var(--native-success); }",
  ".native-work-attachment.is-ready .native-work-attachment-state { color: var(--native-success); }",
  ".native-work-attachment.is-failed { border-color: var(--native-danger); }",
  ".native-work-attachment.is-failed .native-work-attachment-state { color: var(--native-danger); }",
  ".native-work-attachment button { background: transparent; border: 0; color: var(--native-muted); cursor: pointer; font: inherit; font-size: 10px; padding: 2px; }",
  ".native-work-attachment button:hover { color: var(--native-copy); }",
  ".native-work-attachment-list { color: var(--native-muted); display: grid; gap: 5px; margin: 8px 0 0; }",
  ".native-work-attachment-item { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; font-size: 10px; }",
  ".native-work-attachment-item::before { color: var(--native-accent); content: '↳'; }",
  ".native-work-attachment-action { color: var(--native-accent); font-size: 9px; }",
  ".native-work-surface .native-composer-wrap { max-width: 920px; padding: 14px 24px 18px; }",
  ".native-work-surface .native-composer { background: var(--native-surface-raised); border: 0; border-radius: 28px; box-shadow: none; display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 14px 16px 12px; }",
  ".native-work-surface .native-composer:focus-within { border: 0; box-shadow: none; outline: 0; }",
  `.native-work-surface .native-composer .native-room-work-composer-input { background: transparent; border: 0; box-sizing: border-box; color: var(--native-copy); flex: 0 0 auto; font-size: 15px; line-height: 1.5; max-height: ${roomWorkComposerMaxHeight}px; min-height: 0; overflow-x: hidden; overflow-y: hidden; padding: 0 2px; resize: none; width: 100%; }`,
  ".native-work-surface .native-composer .native-room-work-composer-input:focus-visible { outline: 0; }",
  ".native-work-surface .native-composer-footer { align-items: center; display: flex; gap: 8px; min-height: 36px; padding: 0; }",
  ".native-work-attachment-button { align-items: center; background: transparent; border: 0; border-radius: 50%; color: var(--native-copy); cursor: pointer; display: inline-flex; font: inherit; font-size: 10px; height: 34px; justify-content: center; min-width: 34px; padding: 0; transition: color 120ms ease; width: 34px; }",
  ".native-work-attachment-button:hover:not(:disabled) { background: transparent; color: var(--native-copy); }",
  ".native-work-attachment-button:disabled { cursor: default; opacity: .55; }",
  ".native-composer-actions { align-items: center; display: inline-flex; flex: none; gap: 4px; }",
  ".native-work-surface .native-work-composer-add .native-work-composer-icon { height: 20px; width: 20px; }",
  ".native-work-surface .native-send-button { align-items: center; background: var(--native-panel-soft); border: 0; border-radius: 50%; color: var(--native-copy); display: inline-flex; height: 36px; justify-content: center; margin-left: auto; min-height: 36px; padding: 0; transition: color 120ms ease; width: 36px; }",
  ".native-work-surface .native-send-button:hover:not(:disabled) { background: var(--native-panel-soft); border: 0; color: var(--native-copy); }",
  ".native-work-reconnect { margin-left: auto; }",
  ".native-work-recovery { margin-left: 8px; }",
  ".native-work-header-action { align-items: center; background: transparent; border: 0; border-radius: 7px; color: var(--native-muted); cursor: pointer; display: inline-flex; font: inherit; font-size: 11px; gap: 6px; min-height: 32px; padding: 0 7px; }",
  ".native-work-header-action:hover { background: var(--native-hover, #ffffff12); color: var(--native-copy); }",
  ".native-work-header-action[aria-expanded='true'] { background: var(--native-panel-soft); color: var(--native-accent); }",
  ".native-work-header-controls { align-items: center; display: inline-flex; flex-wrap: nowrap; gap: var(--native-header-control-gap, 7px); justify-content: flex-end; position: relative; }",
  ".native-work-header-icon { display: block; height: 16px; width: 16px; }",
  ".native-work-participants-trigger { gap: 7px; }",
  ".native-work-participant-stack { align-items: center; display: inline-flex; padding-left: 4px; }",
  ".native-work-participant-avatar, .native-work-participant-overflow { align-items: center; background: var(--native-panel-soft); border: 2px solid var(--native-surface, var(--native-bg)); border-radius: 50%; color: var(--native-copy); display: inline-flex; font-size: 10px; font-weight: 650; height: 24px; justify-content: center; margin-left: -4px; width: 24px; }",
  ".native-work-participant-overflow { background: var(--native-surface-raised, var(--native-panel-soft)); color: var(--native-muted); font-size: 10px; }",
  ".native-work-participants-overflow-narrow { display: none; }",
  ".native-work-participants-label { font-size: 12px; white-space: nowrap; }",
  ".native-work-participant-status { color: var(--native-dim); font-size: 10px; white-space: nowrap; }",
  ".native-work-default-control { align-items: center; display: inline-flex; gap: 6px; }",
  ".native-work-agent-row { align-items: center; color: var(--native-muted); display: flex; flex: 1 1 160px; flex-wrap: nowrap; gap: 7px; min-height: 36px; min-width: 0; padding: 0; }",
  ".native-work-agent-row .native-work-default-avatar { background: var(--native-panel-soft); border-radius: 50%; flex: none; font-size: 10px; height: 24px; width: 24px; }",
  ".native-work-agent-row .native-work-default-label { display: none; }",
  ".native-work-agent-row .native-work-default-value { font-size: 13px; }",
  ".native-work-agent-select-wrap { align-items: center; display: inline-flex; gap: 3px; max-width: min(240px, 50vw); min-width: 0; }",
  ".native-work-agent-select { appearance: none; background: transparent; border: 0; border-radius: 0; color: var(--native-copy); cursor: pointer; font: inherit; font-size: 13px; font-weight: 500; max-width: 100%; min-height: 36px; overflow: hidden; padding: 0; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-agent-select:focus-visible { outline: 0; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }",
  ".native-work-agent-state { color: var(--native-accent); font-size: 12px; white-space: nowrap; }",
  ".native-work-composer-icon { display: block; height: 18px; width: 18px; }",
  ".native-work-composer-chevron { color: var(--native-dim); display: block; flex: none; height: 10px; pointer-events: none; width: 10px; }",
  ".native-work-header-popover { background: var(--native-panel, #18211c); border: 1px solid var(--native-line-strong); border-radius: 10px; box-shadow: 0 12px 28px var(--native-shadow, #0000003d); color: var(--native-copy); min-width: 245px; padding: 11px; position: absolute; right: 0; top: calc(100% + 8px); z-index: 20; }",
  ".native-work-header-popover h2 { color: var(--native-muted); font-size: 11px; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }",
  ".native-work-header-popover ul { display: grid; gap: 5px; list-style: none; margin: 0; padding: 0; }",
  ".native-work-header-participant { align-items: center; display: flex; gap: 8px; justify-content: space-between; padding: 5px 0; }",
  ".native-work-header-participant-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
  ".native-work-header-participant-state { color: var(--native-muted); font-size: 10px; white-space: nowrap; }",
  ".native-work-room-menu { display: grid; gap: 4px; }",
  ".native-work-room-menu button { background: transparent; border: 0; border-radius: 6px; color: inherit; cursor: pointer; font: inherit; padding: 7px; text-align: left; width: 100%; }",
  ".native-work-room-menu button:hover { background: var(--native-hover, #ffffff12); }",
  ".native-work-default-button { align-items: center; background: transparent; border: 0; border-radius: 7px; color: inherit; cursor: pointer; display: inline-flex; gap: 7px; padding: 3px 5px; }",
  ".native-work-default-button:hover { background: var(--native-hover, #ffffff12); }",
  ".native-work-surface .native-banner { margin-inline: clamp(22px, 5vw, 72px); }",
  "@media (max-width: 820px) { .native-work-header-meta { align-items: flex-start; min-width: 0; } .native-work-default, .native-work-private-note { justify-content: flex-start; text-align: left; } .native-work-thread-switcher { max-height: 112px; } .native-work-conversation-header { align-items: flex-start; flex-direction: column; } .native-work-conversation-actions { align-items: flex-start; flex-direction: row; } }",
  "@container (max-width: 560px) { .native-work-surface .native-chat-header { gap: 8px; } .native-work-header-meta { flex: 0 0 auto; } .native-work-participants-trigger { padding-inline: 4px; } .native-work-participants-label { display: none; } .native-work-participant-stack .native-work-participant-avatar:nth-of-type(4) { display: none; } .native-work-participants-overflow-wide { display: none; } .native-work-participants-overflow-narrow { display: inline-flex; } }",
  "@media (max-width: 560px) { .native-work-thread-switcher { padding-inline: 18px; } .native-work-conversation-header { padding-inline: 18px; } .native-work-message-list { padding-inline: 18px; } .native-work-surface .native-composer-wrap { padding: 12px 14px 14px; } .native-work-surface .native-composer { border-radius: 24px; padding: 12px 14px 10px; } .native-work-agent-row { flex-basis: 0; } .native-work-agent-select-wrap { max-width: min(190px, 46vw); } }"
].join("\n");

export function RoomWorkSurface({
  room,
  currentAccountId,
  agents,
  agentBackends,
  roomAgentMembers,
  agentLoading = false,
  agentError,
  works,
  workLoading = false,
  workDetailLoading = false,
  workError,
  workDetailError,
  selectedWork: selectedWorkProp,
  selectedWorkId,
  onSelectWork,
  replyWorkId,
  onSetReplyWorkId,
  workDraft,
  onSetWorkDraft,
  onClearWorkDraft,
  workCommentDraft,
  onSetWorkCommentDraft,
  onClearWorkCommentDraft,
  loading = false,
  sending = false,
  archived = false,
  readOnly = false,
  connectionState = "connected",
  onSend,
  workResourceRefs = [],
  onRemoveWorkResourceRef,
  onClearWorkResourceRefs,
  onCreateComment,
  onApplyComment,
  onReactComment,
  onStopWork,
  onStopAssignee,
  onReassignAssignee,
  onDelegateAssignee,
  onSetDefaultAgent,
  onOpenAgentDm,
  onOpenAgentSettings,
  participants = [],
  participantsLoading = false,
  participantsError,
  onOpenRoomParticipants,
  roomParticipantsOpen,
  onOpenRoomSettings,
  onOpenRoomKnowledge,
  onOpenRoomShare,
  roomKnowledgeShareAvailable = false,
  roomToolLinks,
  onOpenResultResource,
  onReconnect
}: RoomWorkSurfaceProps) {
  const [busyAction, setBusyAction] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [applyAssigneeId, setApplyAssigneeId] = useState("");
  const [reassignAgentIds, setReassignAgentIds] = useState<Record<string, string>>({});
  const [replyAssigneeId, setReplyAssigneeId] = useState("");
  const [replyOperation, setReplyOperation] = useState<PendingRoomWorkOperation>();
  const [applyOperationIds, setApplyOperationIds] = useState<Record<string, string>>({});
  const [delegateParentAssigneeId, setDelegateParentAssigneeId] = useState("");
  const [delegateAgentIds, setDelegateAgentIds] = useState<string[]>([]);
  const [delegateDependencyIds, setDelegateDependencyIds] = useState<string[]>([]);
  const [delegateInstruction, setDelegateInstruction] = useState("");
  const [delegateOperation, setDelegateOperation] = useState<PendingRoomWorkDelegation>();
  const [delegateReceipt, setDelegateReceipt] = useState<string>();
  const [workAttachmentDrafts, setWorkAttachmentDrafts] = useState<RoomAttachmentDraft[]>([]);
  const [commentAttachmentDrafts, setCommentAttachmentDrafts] = useState<RoomAttachmentDraft[]>([]);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const workAttachmentInputRef = useRef<HTMLInputElement>(null);
  const workComposerInputRef = useRef<HTMLTextAreaElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentContextRef = useRef("");
  const attachmentContextGenerationRef = useRef(0);

  const roomIsDm = room?.kind === "agent_dm";
  const roomWorks = (() => {
    if (!room) return [];
    const rows = new Map<string, NativeRoomWork>();
    for (const work of works) {
      if (work.roomId !== room.id) continue;
      const current = rows.get(work.id);
      if (!current || compareWorkSnapshot(work, current) > 0) rows.set(work.id, work);
    }
    return [...rows.values()];
  })();
  const selectedWorkSummary = selectedWorkId ? roomWorks.find((work) => work.id === selectedWorkId) : undefined;
  const selectedWork = room && selectedWorkProp
    && selectedWorkProp.roomId === room.id
    && (!selectedWorkId || selectedWorkProp.id === selectedWorkId)
    && (!selectedWorkSummary || compareWorkSnapshot(selectedWorkProp, selectedWorkSummary) >= 0)
    ? selectedWorkProp
    : selectedWorkSummary;
  const conversationWorks = nativeRoomWorkConversationWorks(roomWorks, room, selectedWork);
  const conversationWorkById = new Map(conversationWorks.map((work) => [work.id, work]));
  const replyTargetWork = replyWorkId
    ? conversationWorkById.get(replyWorkId) ?? (selectedWork?.id === replyWorkId ? selectedWork : undefined)
    : undefined;
  const defaultAgentId = room?.defaultAgentId;
  const defaultAgent = defaultAgentId ? agents.find((agent) => agent.id === defaultAgentId) : undefined;
  const defaultAgentKnown = Boolean(defaultAgentId && defaultAgent && defaultAgent.status !== undefined && (roomIsDm || roomCapabilityKnown(room, "canExecute")));
  const defaultAgentReady = Boolean(defaultAgentKnown && roomExecutionAllowed(room) && agentIsAvailable(defaultAgent, agentBackends, roomAgentMembers));
  const participantRows = participantsLoading || Boolean(participantsError) ? [] : [...participants];
  const participantCount = participantRows.length > 0 ? participantRows.length : undefined;
  const participantButtonLabel = participantsLoading
    ? "参加者を確認中…"
    : participantsError
      ? "参加者を確認できません"
      : participantCount === undefined
        ? "参加者"
        : `参加者 ${participantCount}`;
  const writeBlocked = archived || readOnly || connectionState === "offline";
  const executeBlocked = writeBlocked || !roomExecutionAllowed(room);
  const replyActive = Boolean(replyTargetWork);
  const replyEnabled = Boolean(replyTargetWork && roomWorkCanReceiveReply(replyTargetWork));
  const replyAllowed = Boolean(replyTargetWork && roomWorkControlAllowed(room, replyTargetWork, currentAccountId));
  const replyAssignees = replyActive ? (replyTargetWork?.assignees.filter((assignee) => !assigneeIsTerminal(assignee)) ?? []) : [];
  const replyAssigneeSignature = replyAssignees.map((assignee) => `${assignee.id}:${assignee.status}:${assignee.generation}`).join("|");
  const replyAssigneeRequired = replyAssignees.length > 1;
  const replyAssigneeSelected = replyAssignees.some((assignee) => assignee.id === replyAssigneeId);
  const replyAssigneeValid = !replyAssigneeRequired || replyAssigneeSelected;
  const applyAssignees = selectedWork?.assignees.filter((assignee) => !assigneeIsTerminal(assignee)) ?? [];
  const applyAssigneeSignature = applyAssignees.map((assignee) => `${assignee.id}:${assignee.status}:${assignee.generation}`).join("|");
  const applyAssigneeRequired = applyAssignees.length > 1;
  const applyAssigneeSelected = applyAssignees.some((assignee) => assignee.id === applyAssigneeId);
  const applyAssigneeValid = applyAssignees.length > 0 && (!applyAssigneeRequired || applyAssigneeSelected);
  const attachmentContextKey = `${room?.workspaceId ?? "none"}\n${room?.id ?? "none"}\n${replyWorkId ?? "new"}\n${selectedWorkId ?? "none"}`;
  const workAttachmentRefs = attachmentRefs(workAttachmentDrafts);
  const commentAttachmentRefs = attachmentRefs(commentAttachmentDrafts);
  const workResourceRefsForSend = workResourceRefs.filter((ref, index) => {
    if ((ref.kind !== "knowledge" && ref.kind !== "skill")
      || !/^[a-z][a-z0-9_:-]{0,127}$/.test(ref.id)
      || !Number.isSafeInteger(ref.version)
      || ref.version < 1) return false;
    const key = resourceRefKey(ref);
    return workResourceRefs.findIndex((candidate) => resourceRefKey(candidate) === key) === index;
  });
  const workAttachmentPending = workAttachmentDrafts.some((draft) => draft.status === "uploading");
  const workAttachmentFailed = workAttachmentDrafts.some((draft) => draft.status === "failed");
  const commentAttachmentPending = commentAttachmentDrafts.some((draft) => draft.status === "uploading");
  const commentAttachmentFailed = commentAttachmentDrafts.some((draft) => draft.status === "failed");
  const workAttachmentInvalid = workAttachmentDrafts.some((draft) => draft.status === "ready" && !safeAttachmentRef(draft.resourceRef));
  const commentAttachmentInvalid = commentAttachmentDrafts.some((draft) => draft.status === "ready" && !safeAttachmentRef(draft.resourceRef));
  const workComposerHasInput = Boolean(workDraft.trim()) || workAttachmentRefs.length > 0 || workResourceRefsForSend.length > 0;
  const commentComposerHasInput = Boolean(workCommentDraft.trim()) || commentAttachmentRefs.length > 0;
  const workAttachmentsBlocked = workAttachmentPending || workAttachmentFailed || workAttachmentInvalid;
  const commentAttachmentsBlocked = commentAttachmentPending || commentAttachmentFailed || commentAttachmentInvalid;
  const workAttachmentSignature = attachmentDraftKey(workAttachmentDrafts);
  const workResourceSignature = workResourceRefsForSend.map(resourceRefKey).join("|");
  const composerBlocked = executeBlocked || sending || loading || workAttachmentsBlocked || (!replyActive && !defaultAgentReady) || (replyActive && (!replyEnabled || !replyAllowed || !replyAssigneeValid));
  const commentsBlocked = writeBlocked || !roomCapability(room, "canEdit") || !selectedWork || commentAttachmentsBlocked;
  const applySelectionBlocked = writeBlocked || !roomCapability(room, "canExecute") || !selectedWork || !replyAllowed;
  const applyBlocked = writeBlocked || !roomCapability(room, "canExecute") || !selectedWork || !replyAllowed || !applyAssigneeValid;
  const stopBlocked = writeBlocked || !selectedWork || !workStopAllowed(room, selectedWork, currentAccountId);
  const delegateActiveAssignees = selectedWork?.assignees.filter((assignee) => !assigneeIsTerminal(assignee)) ?? [];
  const delegateParentAssignee = delegateActiveAssignees.find((assignee) => assignee.id === delegateParentAssigneeId) ?? delegateActiveAssignees[0];
  const assignedAgentIds = new Set(selectedWork?.assignees.map((assignee) => assignee.agentId) ?? []);
  const delegateAvailableAgents = selectedWork
    ? agents.filter((agent) => !assignedAgentIds.has(agent.id) && agentIsAvailable(agent, agentBackends, roomAgentMembers))
    : [];
  const delegateDependencyAssignees = delegateActiveAssignees.filter((assignee) => assignee.id !== delegateParentAssignee?.id);
  const delegateActiveAssigneeSignature = delegateActiveAssignees.map((assignee) => `${assignee.id}:${assignee.generation}:${assignee.status}`).join("|");
  const delegateAvailableAgentSignature = delegateAvailableAgents.map((agent) => agent.id).join("|");
  const delegateDependencySignature = delegateDependencyAssignees.map((assignee) => assignee.id).join("|");
  const delegateAllowed = Boolean(
    onDelegateAssignee
      && selectedWork
      && !roomIsDm
      && !workIsTerminal(selectedWork)
      && roomWorkControlAllowed(room, selectedWork, currentAccountId)
      && delegateParentAssignee
      && delegateAvailableAgents.length > 0
  );
  const delegateRequestKey = selectedWork && delegateParentAssignee
    ? [
      room?.workspaceId ?? "none",
      room?.id ?? "none",
      selectedWork.id,
      delegateParentAssignee.id,
      delegateParentAssignee.generation,
      [...delegateAgentIds].sort().join(","),
      [...delegateDependencyIds].sort().join(","),
      delegateInstruction.trim()
    ].join("\n")
    : "";
  const delegateSubmitBlocked = !delegateAllowed
    || Boolean(busyAction)
    || !delegateInstruction.trim()
    || delegateAgentIds.length === 0
    || !delegateDependencyIds.every((dependencyId) => delegateDependencyAssignees.some((assignee) => assignee.id === dependencyId));
  const conversationEntries = nativeRoomWorkConversationEntriesForRoom(conversationWorks, room, agents);
  const hasConversationEntries = conversationEntries.length > 0;

  if (attachmentContextRef.current !== attachmentContextKey) {
    attachmentContextRef.current = attachmentContextKey;
    attachmentContextGenerationRef.current += 1;
  }

  useEffect(() => {
    setReplyAssigneeId("");
  }, [replyAssigneeSignature, replyWorkId, room?.id, room?.workspaceId, selectedWork?.id]);

  useEffect(() => {
    setApplyAssigneeId("");
  }, [room?.id, room?.workspaceId, selectedWork?.id]);

  useEffect(() => {
    setReplyOperation(undefined);
  }, [replyWorkId, room?.id, room?.workspaceId, replyTargetWork?.id]);

  useEffect(() => {
    setApplyOperationIds({});
  }, [room?.id, room?.workspaceId, selectedWork?.id]);

  useEffect(() => {
    setWorkAttachmentDrafts([]);
    setCommentAttachmentDrafts([]);
  }, [attachmentContextKey]);

  useEffect(() => {
    const input = workComposerInputRef.current;
    if (!input) return;
    resizeRoomWorkComposer(input);
  }, [workDraft]);

  useEffect(() => {
    setDelegateParentAssigneeId((current) => delegateActiveAssignees.some((assignee) => assignee.id === current)
      ? current
      : (delegateActiveAssignees[0]?.id ?? ""));
    setDelegateDependencyIds((current) => current.filter((dependencyId) => delegateDependencyAssignees.some((assignee) => assignee.id === dependencyId)));
    setDelegateAgentIds((current) => current.filter((agentId) => delegateAvailableAgents.some((agent) => agent.id === agentId)));
  }, [delegateActiveAssigneeSignature, delegateAvailableAgentSignature, delegateDependencySignature]);

  useEffect(() => {
    setDelegateOperation(undefined);
    setDelegateReceipt(undefined);
    setDelegateAgentIds([]);
    setDelegateDependencyIds([]);
    setDelegateInstruction("");
  }, [room?.id, room?.workspaceId, selectedWork?.id]);

  const runAction = async <T,>(key: string, action: () => T | Promise<T>, onError?: (error: unknown) => void): Promise<RoomWorkActionOutcome<T>> => {
    setActionError(undefined);
    setBusyAction(key);
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Serverで処理結果を確認できませんでした。");
      onError?.(error);
      return { ok: false, error };
    } finally {
      setBusyAction((current) => current === key ? undefined : current);
    }
  };

  const uploadAttachment = async (
    draft: RoomAttachmentDraft,
    setDrafts: Dispatch<SetStateAction<RoomAttachmentDraft[]>>
  ): Promise<void> => {
    const requestContextKey = attachmentContextRef.current;
    const requestContextGeneration = attachmentContextGenerationRef.current;
    const requestContextIsCurrent = () => requestContextKey === attachmentContextRef.current
      && requestContextGeneration === attachmentContextGenerationRef.current;
    setDrafts((current) => current.map((item) => item.id === draft.id ? { ...item, status: "uploading", error: undefined } : item));
    try {
      if (draft.file.size > 8 * 1024 * 1024) throw new Error("attachment_too_large");
      const bridge = getWorkspaceClientBridge();
      if (!bridge?.writeWorkspaceAttachment) throw new Error("workspace_attachment_upload_unavailable");
      const state = bridge.listWorkspaceConnections ? await bridge.listWorkspaceConnections() : undefined;
      const target = state?.activeTarget;
      if (target && target.workspaceId !== room?.workspaceId) throw new Error("workspace_navigation_changed");
      if (!requestContextIsCurrent()) return;
      const contentBase64 = await fileToBase64(draft.file);
      if (!requestContextIsCurrent()) return;
      const uploaded: WorkspaceAttachmentUploadResult = await bridge.writeWorkspaceAttachment({
        roomId: room?.id ?? "",
        path: draft.path,
        contentBase64,
        expectedVersion: 0,
        operationId: draft.operationId,
        ...(target ? { target } : {})
      });
      const resourceRef = safeAttachmentRef(uploaded.resource_ref);
      if (!resourceRef) throw new Error("workspace_attachment_response_invalid");
      if (!requestContextIsCurrent()) return;
      setDrafts((current) => current.map((item) => item.id === draft.id
        ? { ...item, status: "ready", resourceRef, error: undefined }
        : item));
    } catch {
      if (!requestContextIsCurrent()) return;
      setDrafts((current) => current.map((item) => item.id === draft.id
        ? { ...item, status: "failed", error: attachmentErrorMessage() }
        : item));
    }
  };

  const selectAttachments = (
    event: ChangeEvent<HTMLInputElement>,
    setDrafts: Dispatch<SetStateAction<RoomAttachmentDraft[]>>
  ): void => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    for (const file of files) {
      const id = createIdempotencyKey();
      const name = safeAttachmentName(file.name);
      const draft: RoomAttachmentDraft = {
        id,
        name,
        size: file.size,
        file,
        path: attachmentPath(id, name),
        operationId: `room_attachment_${id}`,
        status: "uploading"
      };
      setDrafts((current) => [...current, draft]);
      void uploadAttachment(draft, setDrafts);
    }
  };

  const removeAttachment = (id: string, setDrafts: Dispatch<SetStateAction<RoomAttachmentDraft[]>>): void => {
    setDrafts((current) => current.filter((item) => item.id !== id));
  };

  const renderAttachmentDrafts = (
    drafts: RoomAttachmentDraft[],
    setDrafts: Dispatch<SetStateAction<RoomAttachmentDraft[]>>
  ) => drafts.length ? (
    <div className="native-work-attachments" aria-label="添付ファイル">
      {drafts.map((draft) => (
        <div className={`native-work-attachment is-${draft.status === "ready" && !safeAttachmentRef(draft.resourceRef) ? "failed" : draft.status}`} key={draft.id}>
          <span className="native-work-attachment-name" title={draft.name}>{draft.name}</span>
          <span className="native-work-attachment-state">
            {draft.status === "uploading" ? "アップロード中…" : draft.status === "ready" && !safeAttachmentRef(draft.resourceRef) ? "参照が無効" : draft.status === "ready" ? "添付済み" : "アップロード失敗"}
          </span>
          {draft.status === "failed" || (draft.status === "ready" && !safeAttachmentRef(draft.resourceRef)) ? <button type="button" onClick={() => void uploadAttachment(draft, setDrafts)}>再試行</button> : null}
          <button type="button" aria-label={`${draft.name}を外す`} onClick={() => removeAttachment(draft.id, setDrafts)}>外す</button>
        </div>
      ))}
    </div>
  ) : null;

  const handleSend = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const content = workDraft.trim();
    if (!workComposerHasInput || composerBlocked) return;
    const targetWorkId = replyActive ? replyWorkId : undefined;
    const targetAssigneeId = replyActive && replyAssigneeSelected ? replyAssigneeId : undefined;
    const operationKey = [room?.workspaceId ?? "none", room?.id ?? "none", targetWorkId ?? "new", targetAssigneeId ?? "auto", room?.defaultAgentId ?? "none", content, workAttachmentSignature, workResourceSignature].join("\n");
    const operationId = replyOperation?.key === operationKey ? replyOperation.operationId : createIdempotencyKey();
    if (replyOperation?.key !== operationKey) setReplyOperation({ key: operationKey, operationId });
    const outcome = await runAction("send", async () => {
      return onSend(content, targetWorkId, targetAssigneeId, operationId, workAttachmentRefs, workResourceRefsForSend);
    }, (error) => {
      if (nativeRoomWorkErrorIsExplicitServerFailure(error)) {
        setReplyOperation((current) => current?.key === operationKey ? undefined : current);
      }
    });
    if (!outcome.ok || roomWorkMutationNeedsRetry(outcome.value)) return;
    setReplyOperation((current) => current?.key === operationKey ? undefined : current);
    onClearWorkDraft();
    setWorkAttachmentDrafts([]);
    onClearWorkResourceRefs?.();
    if (targetWorkId) onSetReplyWorkId(undefined);
  };

  const handleDelegate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!selectedWork || !delegateParentAssignee || !onDelegateAssignee || delegateSubmitBlocked || !delegateRequestKey) return;
    const selectedAgentIds = [...delegateAgentIds];
    const existing = delegateOperation?.key === delegateRequestKey
      ? delegateOperation
      : { key: delegateRequestKey, operationIds: {}, completedAgentIds: [] } satisfies PendingRoomWorkDelegation;
    const operationIds = { ...existing.operationIds };
    const completedAgentIds = new Set(existing.completedAgentIds);
    setActionError(undefined);
    setDelegateReceipt(undefined);
    setBusyAction("delegate");
    try {
      for (const agentId of selectedAgentIds) {
        if (completedAgentIds.has(agentId)) continue;
        const operationId = operationIds[agentId] ?? createIdempotencyKey();
        operationIds[agentId] = operationId;
        try {
          const result = await onDelegateAssignee(
            selectedWork,
            delegateParentAssignee,
            agentId,
            delegateInstruction.trim(),
            delegateDependencyIds,
            operationId
          );
          if (roomWorkMutationNeedsRetry(result)) {
            setDelegateOperation({ key: delegateRequestKey, operationIds, completedAgentIds: [...completedAgentIds] });
            setDelegateReceipt("委譲は受付済みかもしれません。Serverの一覧を再取得できるまで、同じ操作で再試行できます。");
            return;
          }
          completedAgentIds.add(agentId);
          setDelegateOperation({ key: delegateRequestKey, operationIds, completedAgentIds: [...completedAgentIds] });
        } catch (error) {
          if (nativeRoomWorkErrorIsExplicitServerFailure(error)) delete operationIds[agentId];
          setDelegateOperation({ key: delegateRequestKey, operationIds, completedAgentIds: [...completedAgentIds] });
          throw error;
        }
      }
      setDelegateOperation(undefined);
      setDelegateReceipt(`${completedAgentIds.size}件の委譲をServerが受付済みです。担当一覧で進捗を確認できます。`);
      setDelegateAgentIds([]);
      setDelegateDependencyIds([]);
      setDelegateInstruction("");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "委譲の結果をServerで確認できませんでした。");
    } finally {
      setBusyAction((current) => current === "delegate" ? undefined : current);
    }
  };

  const handleComment = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const body = workCommentDraft.trim();
    if (!selectedWork || !commentComposerHasInput || commentsBlocked || busyAction) return;
    const workId = selectedWork.id;
    await runAction("comment", async () => {
      await onCreateComment(workId, body || undefined, commentAttachmentRefs);
      onClearWorkCommentDraft();
      setCommentAttachmentDrafts([]);
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!roomWorkShouldSubmitOnKeyDown({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing
    })) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const handleComposerChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    resizeRoomWorkComposer(event.currentTarget);
    onSetWorkDraft(event.currentTarget.value);
  };

  const handleComposerInput = (event: FormEvent<HTMLTextAreaElement>): void => {
    resizeRoomWorkComposer(event.currentTarget);
  };

  const renderDefaultAgentState = () => {
    if (!defaultAgentId) {
      return <span className="native-work-default-value is-missing">既定Agent未設定</span>;
    }
    if (!defaultAgentKnown) {
      return <span className="native-work-default-value is-invalid">実行可否を確認できません</span>;
    }
    if (!defaultAgentReady) {
      return <span className="native-work-default-value is-invalid">無効または実行不可</span>;
    }
    return <span className="native-work-default-value">{agentLabel(defaultAgentId, agents)}</span>;
  };

  const renderDefaultAgentSelector = () => {
    if (roomIsDm) return null;
    const canChangeDefaultAgent = Boolean(
      onSetDefaultAgent
        && roomCapability(room, "canManage")
        && roomCapability(room, "canExecute")
        && !writeBlocked
    );
    return (
      <div className="native-work-agent-row" aria-label="担当Agent">
        <span className="native-work-default-avatar" aria-hidden="true">{actorInitial(defaultAgent ? defaultAgent.displayName : "AI")}</span>
        <span className="native-work-default-label">担当Agent</span>
        {canChangeDefaultAgent ? (
          <label className="native-work-agent-select-wrap">
            <span className="native-visually-hidden">Roomの既定Agent</span>
            <select
              className="native-work-agent-select"
              value={defaultAgentId ?? ""}
              disabled={Boolean(busyAction?.startsWith("default-agent")) || agentLoading || agents.length === 0}
              onChange={(event) => {
                const agentId = event.currentTarget.value;
                if (!agentId || !onSetDefaultAgent) return;
                void runAction("default-agent:" + agentId, () => onSetDefaultAgent(agentId));
              }}
              aria-label="Roomの既定Agent"
            >
              <option value="" disabled>{agentLoading ? "Agentを確認中…" : defaultAgentId ? "Agentを選択" : "既定Agent未設定"}</option>
              {agents.map((agent) => {
                const selectable = agentIsAvailable(agent, agentBackends, roomAgentMembers);
                return <option key={agent.id} value={agent.id} disabled={!selectable}>{agent.displayName + (selectable ? "" : "（利用不可）")}</option>;
              })}
            </select>
            <RoomChevronIcon />
            {defaultAgentId && !defaultAgentReady ? <span className="native-work-agent-state">{renderDefaultAgentState()}</span> : null}
          </label>
        ) : (
          <span className="native-work-default-value">{renderDefaultAgentState()}</span>
        )}
      </div>
    );
  };

  const renderWarning = () => {
    const warning = (title: string, body: string, recovery = false) => (
      <div className="native-banner native-banner-warning" role="status">
        <strong>{title}</strong> {body}
        {recovery && onOpenRoomSettings ? <button type="button" className="native-button native-button-quiet native-work-recovery" onClick={onOpenRoomSettings}>Room設定を確認</button> : null}
      </div>
    );
    if (archived) return warning("このWorkspaceはアーカイブ済みです。", "履歴は確認できますが、仕事の書き込みはできません。");
    if (readOnly) return warning("このWorkspaceは読み取り専用です。", "仕事の書き込みはできません。");
    if (!roomIsDm && roomCapabilityKnown(room, "canExecute") && !roomCapability(room, "canExecute")) return warning("このRoomへの実行権限がありません。", "権限が付与されるまで新しい仕事を依頼できません。", true);
    if (!roomIsDm && !roomCapabilityKnown(room, "canExecute")) return warning("このRoomの実行権限を確認できません。", "Serverから権限を受け取るまで仕事の依頼・返信・反映はできません。", true);
    if (connectionState === "offline") return warning("Serverに接続できません。", "送信前に再接続してください。");
    return null;
  };

  const renderInstruction = (instruction: NativeRoomWorkInstruction) => (
    <article className="native-work-instruction" key={instruction.id}>
      <div className="native-work-instruction-head">
        <span className="native-work-instruction-kind">{instruction.kind === "comment_apply" ? "コメント反映" : instruction.kind === "reply" ? "返信" : instruction.kind === "delegated" ? "委任" : "新規依頼"}</span>
        <span className={"native-work-instruction-status " + instructionTone(instruction.status)}>{roomWorkInstructionStatusLabel(instruction.status)}</span>
      </div>
      <p className="native-work-instruction-body">
        {instruction.instruction
          || (instruction.attachments.length > 0 ? "添付のみの指示" : instruction.resourceRefs?.length ? "Knowledge/Skillのみの指示" : "本文なしの指示")}
      </p>
      {renderSavedAttachmentRefs(instruction.attachments)}
      {renderSavedRoomWorkResourceRefs(instruction.resourceRefs ?? [])}
      <div className="native-work-instruction-foot">
        <span>指示 v{instruction.version}</span>
        {instruction.assigneeId ? <span>担当 {agentLabel(selectedWork?.assignees.find((assignee) => assignee.id === instruction.assigneeId)?.agentId ?? instruction.assigneeId, agents)}</span> : null}
        {instruction.createdBy ? <span>作成者 {actorLabel(instruction.createdBy, currentAccountId)}</span> : null}
        {formatTimestamp(instruction.createdAt) ? <span>{formatTimestamp(instruction.createdAt)}</span> : null}
      </div>
    </article>
  );

  const renderDelegation = () => {
    if (!selectedWork || roomIsDm || !onDelegateAssignee) return null;
    const canControl = roomWorkControlAllowed(room, selectedWork, currentAccountId);
    const pendingAgentCount = delegateOperation
      ? delegateAgentIds.filter((agentId) => !delegateOperation.completedAgentIds.includes(agentId)).length
      : 0;
    return (
      <section className="native-work-delegation" aria-labelledby="native-work-delegation-heading">
        <div>
          <div className="native-work-subheading" style={{ borderBottom: 0, margin: 0, paddingBottom: 0 }}>
            <h3 id="native-work-delegation-heading">専門Agentへ明示委譲</h3>
            <span>{delegateAvailableAgents.length}件選択可能</span>
          </div>
          <p className="native-work-delegation-help">この仕事の担当として選んだAgentだけに、同じServerの公開Operationで委譲します。現在の担当・利用不可・実行権限のないAgentは選択肢に出ません。</p>
        </div>
        {!canControl ? <p className="native-work-delegation-status is-alert">この仕事を委譲する権限がありません。</p> : null}
        {workIsTerminal(selectedWork) ? <p className="native-work-delegation-status is-alert">終端した仕事には新しい委譲を追加できません。</p> : null}
        {canControl && !workIsTerminal(selectedWork) && delegateActiveAssignees.length === 0 ? <p className="native-work-delegation-status is-alert">委譲元になる実行中の担当がありません。</p> : null}
        {canControl && !workIsTerminal(selectedWork) && delegateActiveAssignees.length > 0 ? (
          <form onSubmit={(event) => void handleDelegate(event)}>
            <div className="native-work-delegation-grid">
              <label className="native-work-delegation-field">
                <span>委譲元担当</span>
                <select
                  className="native-work-delegation-select"
                  value={delegateParentAssignee?.id ?? ""}
                  disabled={Boolean(busyAction) || delegateActiveAssignees.length === 0}
                  onChange={(event) => {
                    const parentId = event.currentTarget.value;
                    setDelegateParentAssigneeId(parentId);
                    setDelegateDependencyIds((current) => current.filter((dependencyId) => dependencyId !== parentId));
                  }}
                  aria-label="委譲元担当"
                >
                  {delegateActiveAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{agentLabel(assignee.agentId, agents)} · {roomWorkStatusLabel(assignee.status)}</option>)}
                </select>
              </label>
              <div className="native-work-delegation-field">
                <span>委譲先Agent · 複数選択可</span>
                {delegateAvailableAgents.length === 0 ? <p className="native-work-delegation-status">このRoomで実行できる未割当Agentがありません。</p> : (
                  <div className="native-work-delegation-agents" role="group" aria-label="委譲先Agent">
                    {delegateAvailableAgents.map((agent) => (
                      <label className="native-work-delegation-check" key={agent.id}>
                        <input
                          type="checkbox"
                          value={agent.id}
                          checked={delegateAgentIds.includes(agent.id)}
                          disabled={Boolean(busyAction)}
                          onChange={(event) => {
                            const checked = event.currentTarget.checked;
                            setDelegateAgentIds((current) => checked
                              ? (current.includes(agent.id) ? current : [...current, agent.id])
                              : current.filter((id) => id !== agent.id));
                          }}
                        />
                        <span>{agent.displayName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {delegateDependencyAssignees.length > 0 ? (
              <div className="native-work-delegation-field">
                <span>完了を待つ担当 · 任意</span>
                <div className="native-work-delegation-dependencies" role="group" aria-label="委譲の依存対象">
                  {delegateDependencyAssignees.map((assignee) => (
                    <label className="native-work-delegation-dependency" key={assignee.id}>
                      <input
                        type="checkbox"
                        value={assignee.id}
                        checked={delegateDependencyIds.includes(assignee.id)}
                        disabled={Boolean(busyAction)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setDelegateDependencyIds((current) => checked
                            ? (current.includes(assignee.id) ? current : [...current, assignee.id])
                            : current.filter((id) => id !== assignee.id));
                        }}
                      />
                      <span>{agentLabel(assignee.agentId, agents)} · {roomWorkStatusLabel(assignee.status)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
            <label className="native-work-delegation-field">
              <span>指示</span>
              <textarea
                className="native-work-delegation-select"
                rows={3}
                value={delegateInstruction}
                disabled={Boolean(busyAction)}
                onChange={(event) => setDelegateInstruction(event.currentTarget.value)}
                placeholder="専門Agentに依頼する具体的な作業…"
                aria-label="委譲の指示"
              />
            </label>
            <div className="native-work-delegation-actions">
              <span className="native-work-delegation-status" role="status" aria-live="polite">
                {delegateReceipt ?? (pendingAgentCount > 0 ? `未確認の委譲 ${pendingAgentCount}件。再試行時は同じ操作IDを使います。` : "委譲結果は担当一覧と指示履歴で確認できます。")}
              </span>
              <button type="submit" className="native-button" disabled={delegateSubmitBlocked}>
                {busyAction === "delegate" ? "委譲受付を確認中…" : delegateAgentIds.length > 0 ? `${delegateAgentIds.length}件を委譲` : "Agentを選択"}
              </button>
            </div>
          </form>
        ) : null}
      </section>
    );
  };

  const renderComment = (comment: NativeRoomWorkComment) => {
    const applied = comment.appliedInstructionIds.length > 0;
    const actionKey = "comment:" + comment.id;
    const applyTargetAssigneeId = applyAssigneeSelected ? applyAssigneeId : undefined;
    const applyOperationKey = [room?.workspaceId ?? "none", room?.id ?? "none", comment.workId, comment.id, comment.version, applyTargetAssigneeId ?? "auto"].join("\n");
    return (
      <article className="native-work-comment" key={comment.id}>
        <div className="native-work-comment-head">
          <span className="native-work-comment-author">{actorLabel(comment.authorId, currentAccountId)}</span>
          <span className="native-work-comment-time">{formatTimestamp(comment.createdAt) || "時刻未確認"}</span>
        </div>
        <p className="native-work-comment-body">{comment.body || "添付のみのコメント"}</p>
        {renderSavedAttachmentRefs(comment.attachments)}
        <div className="native-work-comment-actions">
          <button
            type="button"
            className="native-text-button"
            disabled={!onReactComment || Boolean(busyAction) || commentsBlocked}
            onClick={() => onReactComment ? void runAction("like:" + comment.id, () => onReactComment(selectedWork?.id ?? comment.workId, comment.id)) : undefined}
          >
            いいね{comment.reactionCount === undefined ? "" : " · " + comment.reactionCount}
          </button>
          {applied ? <span className="native-work-comment-applied">Agentへの反映済みをServerが確認</span> : (
            <>
              {applyAssignees.length > 1 ? (
                <select value={applyAssigneeId} disabled={Boolean(busyAction) || applySelectionBlocked} onChange={(event) => setApplyAssigneeId(event.currentTarget.value)} aria-label="コメントの反映先">
                  <option value="">反映先を選択してください</option>
                  {applyAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{agentLabel(assignee.agentId, agents)} · {roomWorkStatusLabel(assignee.status)}</option>)}
                </select>
              ) : null}
              {applyAssignees.length === 0 ? <span className="native-work-reply-note is-required">未終端の担当がないため、コメントをAgentに反映できません。</span> : applyAssigneeRequired ? <span className="native-work-reply-note is-required">未終端の担当が複数あるため、反映先を指定してください。</span> : <span className="native-work-reply-note">反映先: Serverが自動選択（未終端担当 1件）</span>}
              <button
                type="button"
                className="native-button native-button-quiet"
                disabled={Boolean(busyAction) || applyBlocked}
                onClick={() => {
                  if (applyBlocked) return;
                  const operationId = applyOperationIds[applyOperationKey] ?? createIdempotencyKey();
                  if (!applyOperationIds[applyOperationKey]) setApplyOperationIds((current) => ({ ...current, [applyOperationKey]: operationId }));
                  void runAction(actionKey, () => onApplyComment(comment.workId, comment, applyTargetAssigneeId, operationId), (error) => {
                    if (nativeRoomWorkErrorIsExplicitServerFailure(error)) {
                      setApplyOperationIds((current) => {
                        if (current[applyOperationKey] !== operationId) return current;
                        const next = { ...current };
                        delete next[applyOperationKey];
                        return next;
                      });
                    }
                  }).then((outcome) => {
                    if (!outcome.ok || roomWorkMutationNeedsRetry(outcome.value)) return;
                    setApplyOperationIds((current) => {
                      if (current[applyOperationKey] !== operationId) return current;
                      const next = { ...current };
                      delete next[applyOperationKey];
                      return next;
                    });
                  });
                }}
              >
                {busyAction === actionKey ? "確認中…" : "Agentに反映"}
              </button>
            </>
          )}
        </div>
      </article>
    );
  };

  const renderControls = (work: NativeRoomWork) => {
    const controls = work.controls ?? [];
    const unconfirmed = new Set(controls.flatMap((control) => control.unconfirmedAssigneeIds));
    const unconfirmedLabels = Array.from(unconfirmed, (assigneeId) => {
      const assignee = work.assignees.find((item) => item.id === assigneeId);
      return assignee ? agentLabel(assignee.agentId, agents) : "担当 " + shortId(assigneeId);
    });
    if (controls.length === 0 && unconfirmed.size === 0) return <p className="native-work-empty">停止や担当変更の記録はありません。</p>;
    return (
      <>
        <div className="native-work-controls">
          {controls.map((control) => (
            <div className="native-work-control-row" key={control.id}>
              <span>{workActionLabel(control.action)}</span>
              <span className={"native-work-control-status " + controlTone(control.status)}>{roomWorkControlLabel(control)}</span>
            </div>
          ))}
        </div>
        {unconfirmed.size > 0 ? <p className="native-work-control-warning">停止未確認の担当: {unconfirmedLabels.join("、")}。停止の終端を確認できないため、Serverの確認結果を待っています。</p> : null}
      </>
    );
  };

  const renderConversationReply = (work: NativeRoomWork) => (
    <button
      type="button"
      className="native-text-button native-work-message-reply"
      data-work-id={work.id}
      disabled={Boolean(busyAction) || !roomWorkCanReceiveReply(work) || executeBlocked || !roomWorkControlAllowed(room, work, currentAccountId)}
      onClick={() => onSetReplyWorkId(work.id)}
    >
      {replyWorkId === work.id ? "返信対象" : "返信"}
    </button>
  );

  const renderConversationEntry = (entry: NativeRoomWorkConversationEntry) => {
    const isAgent = entry.side === "agent";
    const isSelf = !isAgent && Boolean(currentAccountId && entry.authorId === currentAccountId);
    if (entry.kind === "assignment-state" && entry.status === "completed") return null;
    const entryStatus = roomWorkConversationStatusLabel(entry);
    const author = isAgent
      ? agentLabel(entry.agentId ?? conversationWorkById.get(entry.workId)?.defaultAgentId ?? selectedWork?.defaultAgentId ?? "", agents)
      : actorLabel(entry.authorId, currentAccountId);
    return (
      <article
        className={`native-message native-work-message ${isSelf ? "native-message-user native-work-message-self" : isAgent ? "native-message-agent native-work-message-agent" : "native-message-agent native-work-message-peer"}`}
        data-work-id={entry.workId}
        data-conversation-entry-id={entry.id}
        {...(entry.authorId ? { "data-author-id": entry.authorId } : {})}
        key={entry.id}
      >
        {!isSelf ? <span className="native-work-message-avatar" aria-hidden="true">{actorInitial(author)}</span> : null}
        <div className="native-work-message-main">
          {!isSelf ? <div className="native-message-meta">
            <span>{author}</span>
            {entryStatus ? <span className="native-work-message-status">{entryStatus}</span> : null}
            {formatTimestamp(entry.createdAt) ? <span className="native-work-message-time">{formatTimestamp(entry.createdAt)}</span> : null}
          </div> : null}
          <div className="native-work-message-bubble">
            <div className="native-message-content">{entry.text}</div>
            {renderSavedAttachmentRefs(entry.attachments)}
            {renderSavedRoomWorkResourceRefs(entry.resourceRefs)}
            {entry.resultCards.length ? (
              <div className="native-work-result-cards native-work-message-result-card" aria-label="仕事の成果物">
                {entry.resultCards.map((card) => (
                  <button
                    key={`${entry.id}:${card.resource.kind}:${card.resource.id}`}
                    type="button"
                    className="native-work-result-card"
                    onClick={() => onOpenResultResource?.(card.resource)}
                    disabled={!onOpenResultResource}
                  >
                    <span className="native-work-result-card-main">
                      <strong className="native-work-result-card-title">{card.title}</strong>
                      <span className="native-work-result-card-meta"><span>{card.typeLabel}</span><span>同じRoomで開く</span></span>
                    </span>
                    <span className="native-work-result-card-state">{card.stateLabel}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        {conversationWorkById.get(entry.workId) ? renderConversationReply(conversationWorkById.get(entry.workId)!) : null}
      </article>
    );
  };

  return (
    <section className="native-chat-surface native-work-surface" aria-labelledby="native-work-heading">
      <style>{roomWorkStyles}</style>
      <header className="native-chat-header">
        <div className="native-room-heading">
          <div className="native-section-eyebrow">{roomIsDm ? "Private Agent DM" : "Room"}</div>
          <h1 id="native-work-heading">{room?.name ?? "Roomを選択"}</h1>
        </div>
        <div className="native-work-header-meta">
          {roomIsDm ? <div className="native-work-private-note">Private Room · あなたとこのAgentだけが参加できます</div> : null}
          {!roomIsDm ? (
            <div className="native-work-header-controls" aria-label="Room操作">
              <button
                type="button"
                className="native-work-header-action native-work-participants-trigger"
                onClick={() => {
                  setRoomMenuOpen(false);
                  onOpenRoomParticipants?.();
                }}
                {...(roomParticipantsOpen !== undefined ? { "aria-expanded": roomParticipantsOpen } : {})}
                aria-haspopup="dialog"
                aria-label={participantsLoading ? "参加者一覧を開く（確認中）" : participantsError ? "参加者一覧を開く（確認失敗）" : "参加者一覧を開く"}
                title={participantButtonLabel}
              >
                <span className="native-work-participant-stack" aria-hidden="true">
                  {participantRows.slice(0, 4).map((participant) => (
                    <span
                      className="native-work-participant-avatar"
                      data-participant-id={participant.id}
                      data-participant-kind={participant.kind}
                      key={`${participant.kind}:${participant.id}`}
                      title={participant.label}
                    >
                      {actorInitial(participant.label)}
                    </span>
                  ))}
                  {participantRows.length > 4 ? <span className="native-work-participant-overflow native-work-participants-overflow-wide">+{participantRows.length - 4}</span> : null}
                  {participantRows.length > 3 ? <span className="native-work-participant-overflow native-work-participants-overflow-narrow">+{participantRows.length - 3}</span> : null}
                </span>
                <span className="native-work-participants-label">{participantButtonLabel}</span>
              </button>
              <button
                type="button"
                className="native-work-header-action"
                onClick={() => setRoomMenuOpen((open) => !open)}
                aria-expanded={roomMenuOpen}
                aria-haspopup="menu"
                aria-label="Roomメニューを開く"
                title="Roomメニュー"
              ><RoomMenuIcon /></button>
              {roomMenuOpen ? (
                <div className="native-work-header-popover native-work-room-menu" role="menu" aria-label="Roomメニュー">
                  {onOpenRoomSettings ? <button type="button" role="menuitem" onClick={() => { setRoomMenuOpen(false); onOpenRoomSettings(); }}>Room設定</button> : null}
                  {onOpenRoomKnowledge ? <button type="button" role="menuitem" onClick={() => { setRoomMenuOpen(false); onOpenRoomKnowledge(); }}>Room Knowledge</button> : null}
                  {roomKnowledgeShareAvailable && onOpenRoomShare ? <button type="button" role="menuitem" onClick={() => { setRoomMenuOpen(false); onOpenRoomShare(); }}>Room Knowledgeを共有</button> : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {roomToolLinks}
        </div>
      </header>

      {renderWarning()}
      {agentError ? <div className="native-banner native-banner-error" role="alert"><span>{agentError}</span></div> : null}
      {workError || workDetailError || actionError ? (
        <div className="native-banner native-banner-error" role="alert">
          <span>{workError || workDetailError || actionError}</span>
          <button type="button" className="native-button native-button-quiet native-work-reconnect" onClick={() => void onReconnect()}>Serverを再確認</button>
        </div>
      ) : null}

      <div className="native-work-body">
        <div className="native-work-conversation">
          {workLoading || loading ? <div className="native-work-conversation-loading" role="status">仕事の会話を確認しています…</div> : null}
          {!workLoading && !loading && roomWorks.length === 0 ? (
            <div className="native-work-conversation-empty"><span className="native-placeholder-kicker">NO WORK YET</span><p>このRoomにはまだ仕事がありません。下の入力欄から新しい依頼を送れます。</p></div>
          ) : null}
          {roomWorks.length > 0 ? (
            <>
              {selectedWork && !hasConversationEntries ? <header className="native-work-conversation-header">
                <div className="native-work-conversation-heading">
                  <h2>{selectedWork.title}</h2>
                  <p>{selectedWork.objective}</p>
                </div>
              </header> : null}
              <div className="native-message-list native-work-message-list" aria-label="Roomの会話">
                {workDetailLoading ? <div className="native-work-conversation-loading" role="status">会話の詳細をServerから確認しています…</div> : null}
                {!workDetailLoading && !conversationEntries.length ? <div className="native-work-conversation-empty"><p>このRoomの会話詳細はまだServerから返されていません。</p></div> : null}
                {conversationEntries.map(renderConversationEntry)}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <footer className="native-composer-wrap">
        {sending ? <div className="native-streaming-row" role="status"><span className="native-streaming-bars" aria-hidden="true"><i /><i /><i /></span>Serverが依頼を受け付けています</div> : null}
        <form className="native-composer" onSubmit={(event) => void handleSend(event)}>
          <label className="native-visually-hidden" htmlFor="native-room-work-input">新しい依頼または同じ仕事への返信</label>
          {replyActive && replyTargetWork ? (
            <div className="native-work-reply-target" aria-live="polite">
              <span className="native-work-reply-icon" aria-hidden="true">↩</span>
              <span className="native-work-reply-context"><small>返信先</small><strong>{replyTargetWork.title}</strong></span>
              <button type="button" className="native-work-reply-clear" aria-label="返信対象を解除" onClick={() => onSetReplyWorkId(undefined)}>×</button>
              {replyAssigneeRequired ? (
                <label htmlFor="native-work-reply-assignee">
                  <span>返信先担当 · 必須</span>
                  <select
                    id="native-work-reply-assignee"
                    className="native-work-reply-select"
                    value={replyAssigneeId}
                    disabled={Boolean(busyAction) || executeBlocked || !replyEnabled || !replyAllowed}
                    onChange={(event) => setReplyAssigneeId(event.currentTarget.value)}
                    aria-describedby="native-work-reply-assignee-help"
                  >
                    <option value="">返信先を選択してください</option>
                    {replyAssignees.map((assignee) => <option key={assignee.id} value={assignee.id}>{agentLabel(assignee.agentId, agents)} · {roomWorkStatusLabel(assignee.status)}</option>)}
                  </select>
                </label>
              ) : (
                <span className="native-work-reply-note">
                  {replyAssignees.length > 0
                    ? `返信先担当: Serverが自動選択（未終端担当 ${replyAssignees.length}件）`
                    : "返信先担当: 前回の担当をServerが引き継ぎます（未終端担当なし）"}
                </span>
              )}
              {replyAssigneeRequired ? <span id="native-work-reply-assignee-help" className="native-work-reply-note is-required">未終端の担当が複数あるため、返信先を指定してから送信してください。</span> : null}
            </div>
          ) : null}
          <textarea ref={workComposerInputRef} className="native-room-work-composer-input" id="native-room-work-input" rows={1} value={workDraft} onInput={handleComposerInput} onChange={handleComposerChange} onKeyDown={handleComposerKeyDown} placeholder={replyActive ? "メッセージを入力…" : !defaultAgentReady ? "既定Agentを設定すると新しい依頼を送れます" : "メッセージを入力…"} disabled={composerBlocked} />
          {renderAttachmentDrafts(workAttachmentDrafts, setWorkAttachmentDrafts)}
          {workResourceRefsForSend.length ? (
            <div className="native-work-resource-list" aria-label="仕事で使うKnowledgeとSkill">
              {workResourceRefsForSend.map((ref) => (
                <span className="native-work-resource-item" key={resourceRefKey(ref)}>
                  <span>{ref.kind === "knowledge" ? "Knowledge" : "Skill"}</span>
                  {resourceRefDisplayLabel(ref)}
                  <span className="native-work-resource-version">v{ref.version}</span>
                  {onRemoveWorkResourceRef ? <button className="native-work-resource-remove" type="button" aria-label={`${resourceRefDisplayLabel(ref)}を仕事から外す`} onClick={() => onRemoveWorkResourceRef(ref)}>×</button> : null}
                </span>
              ))}
            </div>
          ) : null}
          <input
            ref={workAttachmentInputRef}
            className="native-visually-hidden"
            type="file"
            multiple
            onChange={(event) => selectAttachments(event, setWorkAttachmentDrafts)}
            aria-label="依頼に添付"
          />
          <div className="native-composer-footer">
            <span className="native-composer-actions">
              <button type="button" className="native-work-attachment-button native-work-composer-add" aria-label="ファイルを添付" title="ファイルを添付" disabled={writeBlocked || Boolean(busyAction) || sending} onClick={() => workAttachmentInputRef.current?.click()}><RoomComposerAddIcon /></button>
            </span>
            {renderDefaultAgentSelector()}
            <button className="native-send-button" type="submit" aria-label={busyAction === "send" ? "Server確認中" : replyActive ? "返信を送信" : "依頼を送信"} disabled={composerBlocked || !workComposerHasInput}><RoomSendIcon /></button>
          </div>
        </form>
      </footer>
    </section>
  );
}

export default RoomWorkSurface;
