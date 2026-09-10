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

/** Builds direct-open entries from validated Assignment result refs only. */
export function nativeRoomWorkResultCards(work: NativeRoomWork, room?: Pick<NativeRoom, "id" | "workspaceId">): NativeRoomWorkResultCard[] {
  const cards: NativeRoomWorkResultCard[] = [];
  const seen = new Set<string>();
  for (const assignee of work.assignees) {
    const result = assignee.result;
    if (!result?.resourceRefs?.length) continue;
    for (const ref of result.resourceRefs) {
      if (ref.kind !== "artifact" && ref.kind !== "generated_surface") continue;
      if ((ref.roomId && ref.roomId !== work.roomId) || (room && ref.workspaceId && ref.workspaceId !== room.workspaceId)) continue;
      const key = `${ref.kind}\n${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const typeLabel = ref.kind === "artifact" ? "Artifact" : "Generated Surface";
      const revisionRefs = result.resourceRefs.filter((candidate) => candidate.parentId === ref.id);
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
  ".native-work-surface { min-height: 0; }",
  ".native-work-surface .native-chat-header { gap: 20px; }",
  ".native-work-header-meta { align-items: flex-end; display: flex; flex-direction: column; gap: 7px; min-width: min(340px, 45%); }",
  ".native-work-default { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }",
  ".native-work-default-label { color: var(--native-dim); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; }",
  ".native-work-default-value { color: var(--native-copy); font-size: 12px; }",
  ".native-work-default-value.is-missing, .native-work-default-value.is-invalid { color: var(--native-accent); }",
  ".native-work-default-select { background: rgba(255,255,255,.055); border: 1px solid var(--native-line); border-radius: 7px; color: var(--native-copy); font: inherit; font-size: 11px; max-width: 180px; min-height: 28px; padding: 0 8px; }",
  ".native-work-default-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-reply-target { align-items: center; background: rgba(241,166,92,.065); border: 1px solid rgba(241,166,92,.24); border-radius: 9px; display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; padding: 10px 12px; }",
  ".native-work-reply-target label { align-items: center; color: var(--native-copy); display: flex; flex-wrap: wrap; font-size: 10px; gap: 8px; }",
  ".native-work-reply-target label span { color: var(--native-accent); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }",
  ".native-work-reply-select { background: rgba(0,0,0,.16); border: 1px solid var(--native-line-strong); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 11px; min-height: 28px; padding: 0 8px; }",
  ".native-work-reply-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-reply-note { color: var(--native-muted); font-size: 10px; line-height: 1.5; }",
  ".native-work-reply-note.is-required { color: var(--native-accent); }",
  ".native-work-private-note { color: var(--native-muted); font-size: 10px; line-height: 1.5; text-align: right; }",
  ".native-work-body { display: grid; flex: 1; grid-template-columns: minmax(225px, .76fr) minmax(360px, 1.34fr); min-height: 0; overflow: hidden; }",
  ".native-work-list { border-right: 1px solid var(--native-line); min-height: 0; overflow: auto; padding: 20px; }",
  ".native-work-list-heading { align-items: baseline; display: flex; justify-content: space-between; margin: 0 0 14px; }",
  ".native-work-list-heading h2, .native-work-detail-heading h2 { color: var(--native-copy); font-family: Georgia, Times New Roman, serif; font-size: 20px; font-weight: 400; letter-spacing: -.025em; margin: 0; }",
  ".native-work-list-count { color: var(--native-dim); font-size: 10px; letter-spacing: .08em; }",
  ".native-work-list-items { display: grid; gap: 9px; list-style: none; margin: 0; padding: 0; }",
  ".native-work-card { background: rgba(255,255,255,.028); border: 1px solid var(--native-line); border-radius: 10px; color: inherit; cursor: pointer; display: block; padding: 13px; text-align: left; transition: background 150ms ease, border-color 150ms ease, transform 150ms ease; width: 100%; }",
  ".native-work-card:hover:not(:disabled) { background: rgba(255,255,255,.06); border-color: var(--native-line-strong); transform: translateY(-1px); }",
  ".native-work-card:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-card.is-selected { background: linear-gradient(135deg, rgba(241,166,92,.12), rgba(255,255,255,.035)); border-color: rgba(241,166,92,.55); box-shadow: inset 3px 0 0 var(--native-accent); }",
  ".native-work-card:disabled { cursor: default; }",
  ".native-work-card-top, .native-work-card-meta, .native-work-assignee-row, .native-work-control-row, .native-work-comment-head, .native-work-detail-actions { align-items: center; display: flex; gap: 8px; }",
  ".native-work-card-top { justify-content: space-between; }",
  ".native-work-card-title { color: var(--native-copy); font-size: 12px; font-weight: 650; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-card-objective { color: var(--native-muted); display: -webkit-box; font-size: 11px; line-height: 1.5; margin: 7px 0 10px; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }",
  ".native-work-card-meta { color: var(--native-dim); flex-wrap: wrap; font-size: 9px; justify-content: space-between; letter-spacing: .04em; }",
  ".native-work-status, .native-work-instruction-status, .native-work-control-status { border: 1px solid var(--native-line); border-radius: 999px; display: inline-flex; font-size: 9px; line-height: 1; padding: 5px 7px; white-space: nowrap; }",
  ".native-work-status.is-live, .native-work-instruction-status.is-live, .native-work-control-status.is-live { border-color: rgba(241,166,92,.5); color: var(--native-accent); }",
  ".native-work-status.is-complete, .native-work-instruction-status.is-complete, .native-work-control-status.is-complete { border-color: rgba(123,190,147,.42); color: #9bd3ad; }",
  ".native-work-status.is-stop { border-color: rgba(238,137,129,.4); color: #efaaa2; }",
  ".native-work-status.is-alert, .native-work-instruction-status.is-alert, .native-work-control-status.is-alert { border-color: rgba(238,137,129,.5); color: var(--native-danger); }",
  ".native-work-status.is-neutral, .native-work-instruction-status.is-neutral, .native-work-control-status.is-neutral { color: var(--native-muted); }",
  ".native-work-assignee-row { color: var(--native-muted); flex-wrap: wrap; font-size: 10px; margin-top: 10px; }",
  ".native-work-assignee-chip { background: rgba(255,255,255,.045); border: 1px solid var(--native-line); border-radius: 999px; color: var(--native-muted); padding: 4px 7px; }",
  ".native-work-empty { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 24px auto; max-width: 280px; text-align: center; }",
  ".native-work-detail { min-height: 0; overflow: auto; padding: 27px clamp(22px, 4vw, 62px) 36px; }",
  ".native-work-detail-heading { align-items: flex-start; display: flex; gap: 18px; justify-content: space-between; }",
  ".native-work-detail-heading p { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 10px 0 0; max-width: 720px; white-space: pre-wrap; }",
  ".native-work-detail-actions { flex-wrap: wrap; justify-content: flex-end; }",
  ".native-work-subheading { align-items: baseline; border-bottom: 1px solid var(--native-line); display: flex; justify-content: space-between; margin: 28px 0 12px; padding-bottom: 8px; }",
  ".native-work-subheading h3 { color: var(--native-copy); font-size: 11px; letter-spacing: .1em; margin: 0; text-transform: uppercase; }",
  ".native-work-subheading span { color: var(--native-dim); font-size: 9px; }",
  ".native-work-assignees { display: grid; gap: 8px; }",
  ".native-work-assignee-card { background: rgba(255,255,255,.028); border: 1px solid var(--native-line); border-radius: 9px; padding: 11px; }",
  ".native-work-assignee-row { justify-content: space-between; margin: 0; }",
  ".native-work-assignee-main { align-items: center; display: flex; gap: 8px; min-width: 0; }",
  ".native-work-assignee-main strong { color: var(--native-copy); font-size: 11px; font-weight: 600; }",
  ".native-work-assignee-main span { color: var(--native-dim); font-size: 9px; }",
  ".native-work-assignee-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; justify-content: flex-end; }",
  ".native-work-assignee-actions select { background: rgba(255,255,255,.05); border: 1px solid var(--native-line); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 10px; min-height: 26px; padding: 0 6px; }",
  ".native-work-delegation { background: linear-gradient(135deg, rgba(241,166,92,.08), rgba(255,255,255,.022)); border: 1px solid rgba(241,166,92,.24); border-radius: 10px; display: grid; gap: 12px; padding: 14px; }",
  ".native-work-delegation-help { color: var(--native-muted); font-size: 10px; line-height: 1.6; margin: -4px 0 0; }",
  ".native-work-delegation-grid { display: grid; gap: 10px; grid-template-columns: minmax(150px, .85fr) minmax(210px, 1.15fr); }",
  ".native-work-delegation-field { display: grid; gap: 6px; }",
  ".native-work-delegation-field > span { color: var(--native-dim); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }",
  ".native-work-delegation-select { background: rgba(0,0,0,.16); border: 1px solid var(--native-line-strong); border-radius: 6px; color: var(--native-copy); font: inherit; font-size: 11px; min-height: 29px; padding: 0 8px; width: 100%; }",
  ".native-work-delegation-select:focus-visible { border-color: var(--native-accent); outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-delegation-agents, .native-work-delegation-dependencies { display: grid; gap: 7px; }",
  ".native-work-delegation-agents { grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); }",
  ".native-work-delegation-check { align-items: flex-start; background: rgba(255,255,255,.035); border: 1px solid var(--native-line); border-radius: 7px; color: var(--native-copy); display: flex; font-size: 10px; gap: 7px; line-height: 1.4; padding: 8px; }",
  ".native-work-delegation-check:has(input:checked) { border-color: rgba(241,166,92,.56); background: rgba(241,166,92,.1); }",
  ".native-work-delegation-check:has(input:disabled) { color: var(--native-dim); cursor: not-allowed; }",
  ".native-work-delegation-check input { accent-color: var(--native-accent); margin: 2px 0 0; }",
  ".native-work-delegation-dependency { align-items: center; color: var(--native-muted); display: flex; font-size: 10px; gap: 7px; }",
  ".native-work-delegation-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 9px; justify-content: space-between; }",
  ".native-work-delegation-status { color: var(--native-muted); font-size: 10px; line-height: 1.5; }",
  ".native-work-delegation-status.is-complete { color: #9bd3ad; }",
  ".native-work-delegation-status.is-alert { color: var(--native-danger); }",
  ".native-work-timeline { border-left: 1px solid rgba(241,166,92,.36); display: grid; gap: 11px; margin-left: 7px; padding-left: 18px; }",
  ".native-work-instruction { background: rgba(255,255,255,.028); border: 1px solid var(--native-line); border-radius: 9px; padding: 12px; position: relative; }",
  ".native-work-instruction::before { background: var(--native-accent); border: 3px solid var(--native-bg, #0e1110); border-radius: 50%; content: ''; height: 7px; left: -23px; position: absolute; top: 14px; width: 7px; }",
  ".native-work-instruction-head { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; justify-content: space-between; }",
  ".native-work-instruction-kind { color: var(--native-dim); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }",
  ".native-work-instruction-body { color: var(--native-copy); font-size: 12px; line-height: 1.7; margin: 8px 0 0; white-space: pre-wrap; }",
  ".native-work-instruction-foot { color: var(--native-dim); display: flex; flex-wrap: wrap; font-size: 9px; gap: 10px; margin-top: 8px; }",
  ".native-work-comments { display: grid; gap: 9px; }",
  ".native-work-comment { background: rgba(255,255,255,.04); border: 1px solid var(--native-line); border-radius: 9px; padding: 12px; }",
  ".native-work-comment-head { justify-content: space-between; }",
  ".native-work-comment-author { color: var(--native-copy); font-size: 11px; font-weight: 600; }",
  ".native-work-comment-time { color: var(--native-dim); font-size: 9px; }",
  ".native-work-comment-body { color: var(--native-muted); font-size: 12px; line-height: 1.7; margin: 8px 0 11px; white-space: pre-wrap; }",
  ".native-work-comment-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }",
  ".native-work-comment-actions select { background: rgba(255,255,255,.04); border: 1px solid var(--native-line); border-radius: 6px; color: var(--native-muted); font: inherit; font-size: 10px; min-height: 27px; padding: 0 6px; }",
  ".native-work-comment-applied { color: #9bd3ad; font-size: 10px; }",
  ".native-work-controls { display: grid; gap: 7px; }",
  ".native-work-control-row { border-bottom: 1px solid rgba(255,255,255,.045); color: var(--native-muted); font-size: 10px; justify-content: space-between; padding: 7px 0; }",
  ".native-work-control-row:last-child { border-bottom: 0; }",
  ".native-work-control-row span:first-child { color: var(--native-copy); }",
  ".native-work-control-warning { color: var(--native-danger); font-size: 10px; line-height: 1.6; margin: 7px 0 0; }",
  ".native-work-composer-block { margin-top: 28px; }",
  ".native-work-composer-label { color: var(--native-accent); display: block; font-size: 10px; letter-spacing: .1em; margin-bottom: 9px; text-transform: uppercase; }",
  ".native-work-composer-help { color: var(--native-dim); font-size: 10px; line-height: 1.6; margin: 8px 0 0; }",
  ".native-work-attachments { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 3px; }",
  ".native-work-attachment { align-items: center; background: rgba(255,255,255,.04); border: 1px solid var(--native-line); border-radius: 7px; display: inline-flex; gap: 7px; max-width: 100%; padding: 6px 8px; }",
  ".native-work-attachment-name { color: var(--native-copy); font-size: 10px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-attachment-state { color: var(--native-dim); font-size: 9px; }",
  ".native-work-resource-list { display: flex; flex-wrap: wrap; gap: 7px; margin: 9px 0 3px; }",
  ".native-work-resource-item { align-items: center; background: rgba(125,177,221,.08); border: 1px solid rgba(125,177,221,.32); border-radius: 7px; color: var(--native-copy); display: inline-flex; font-size: 10px; gap: 6px; max-width: 100%; padding: 6px 8px; }",
  ".native-work-resource-item > span:first-child { color: #a8cdec; font-size: 9px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }",
  ".native-work-resource-version { color: var(--native-dim); font-size: 9px; }",
  ".native-work-result-cards { display: grid; gap: 9px; margin-top: 10px; }",
  ".native-work-result-card { align-items: center; background: linear-gradient(135deg, rgba(123,190,147,.09), rgba(255,255,255,.028)); border: 1px solid rgba(123,190,147,.34); border-radius: 10px; color: inherit; cursor: pointer; display: grid; gap: 10px; grid-template-columns: minmax(0, 1fr) auto; padding: 12px 13px; text-align: left; transition: background 150ms ease, border-color 150ms ease, transform 150ms ease; width: 100%; }",
  ".native-work-result-card:hover { background: linear-gradient(135deg, rgba(123,190,147,.16), rgba(255,255,255,.05)); border-color: rgba(123,190,147,.58); transform: translateY(-1px); }",
  ".native-work-result-card:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }",
  ".native-work-result-card-main { display: grid; gap: 5px; min-width: 0; }",
  ".native-work-result-card-title { color: var(--native-copy); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
  ".native-work-result-card-meta { align-items: center; color: var(--native-muted); display: flex; flex-wrap: wrap; font-size: 9px; gap: 7px; }",
  ".native-work-result-card-state { border: 1px solid rgba(123,190,147,.46); border-radius: 999px; color: #9bd3ad; font-size: 9px; padding: 5px 7px; white-space: nowrap; }",
  ".native-work-result-card-open { color: var(--native-accent); font-size: 10px; white-space: nowrap; }",
  ".native-work-resource-remove { background: transparent; border: 0; color: var(--native-muted); cursor: pointer; font: inherit; font-size: 12px; line-height: 1; padding: 0 0 0 2px; }",
  ".native-work-resource-remove:hover { color: var(--native-copy); }",
  ".native-work-attachment.is-ready { border-color: rgba(123,190,147,.42); }",
  ".native-work-attachment.is-ready .native-work-attachment-state { color: #9bd3ad; }",
  ".native-work-attachment.is-failed { border-color: rgba(238,137,129,.5); }",
  ".native-work-attachment.is-failed .native-work-attachment-state { color: var(--native-danger); }",
  ".native-work-attachment button { background: transparent; border: 0; color: var(--native-muted); cursor: pointer; font: inherit; font-size: 10px; padding: 2px; }",
  ".native-work-attachment button:hover { color: var(--native-copy); }",
  ".native-work-attachment-list { color: var(--native-muted); display: grid; gap: 5px; margin: 8px 0 0; }",
  ".native-work-attachment-item { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; font-size: 10px; }",
  ".native-work-attachment-item::before { color: var(--native-accent); content: '↳'; }",
  ".native-work-attachment-action { color: var(--native-accent); font-size: 9px; }",
  ".native-work-attachment-button { background: rgba(255,255,255,.045); border: 1px solid var(--native-line); border-radius: 6px; color: var(--native-muted); cursor: pointer; font: inherit; font-size: 10px; min-height: 27px; padding: 0 9px; }",
  ".native-work-attachment-button:hover:not(:disabled) { border-color: var(--native-line-strong); color: var(--native-copy); }",
  ".native-work-attachment-button:disabled { cursor: default; opacity: .55; }",
  ".native-work-reconnect { margin-left: auto; }",
  ".native-work-surface .native-banner { margin-inline: clamp(22px, 5vw, 72px); }",
  "@media (max-width: 820px) { .native-work-header-meta { align-items: flex-start; min-width: 0; } .native-work-default, .native-work-private-note { justify-content: flex-start; text-align: left; } .native-work-body { grid-template-columns: 1fr; overflow: auto; } .native-work-list { border-bottom: 1px solid var(--native-line); border-right: 0; max-height: 38vh; } .native-work-detail { overflow: visible; } }",
  "@media (max-width: 560px) { .native-work-surface .native-chat-header { align-items: flex-start; flex-direction: column; } .native-work-detail-heading { flex-direction: column; } .native-work-detail-actions { justify-content: flex-start; } .native-work-list, .native-work-detail { padding-inline: 18px; } .native-work-delegation-grid { grid-template-columns: 1fr; } }"
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
  selectedWork,
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
  const workAttachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentContextRef = useRef("");
  const attachmentContextGenerationRef = useRef(0);

  const roomIsDm = room?.kind === "agent_dm";
  const defaultAgentId = room?.defaultAgentId;
  const defaultAgent = defaultAgentId ? agents.find((agent) => agent.id === defaultAgentId) : undefined;
  const defaultAgentKnown = Boolean(defaultAgentId && defaultAgent && defaultAgent.status !== undefined && (roomIsDm || roomCapabilityKnown(room, "canExecute")));
  const defaultAgentReady = Boolean(defaultAgentKnown && roomExecutionAllowed(room) && agentIsAvailable(defaultAgent, agentBackends, roomAgentMembers));
  const writeBlocked = archived || readOnly || connectionState === "offline";
  const executeBlocked = writeBlocked || !roomExecutionAllowed(room);
  const replyActive = Boolean(replyWorkId && selectedWork?.id === replyWorkId);
  const replyEnabled = Boolean(selectedWork && roomWorkCanReceiveReply(selectedWork));
  const replyAllowed = Boolean(selectedWork && roomWorkControlAllowed(room, selectedWork, currentAccountId));
  const replyAssignees = replyActive ? (selectedWork?.assignees.filter((assignee) => !assigneeIsTerminal(assignee)) ?? []) : [];
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
  const resultCards = selectedWork ? nativeRoomWorkResultCards(selectedWork, room) : [];

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
  }, [replyWorkId, room?.id, room?.workspaceId, selectedWork?.id]);

  useEffect(() => {
    setApplyOperationIds({});
  }, [room?.id, room?.workspaceId, selectedWork?.id]);

  useEffect(() => {
    setWorkAttachmentDrafts([]);
    setCommentAttachmentDrafts([]);
  }, [attachmentContextKey]);

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

  const statusText = connectionState === "reconnecting" ? "再接続中" : connectionState === "offline" ? "オフライン" : "接続済み";

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
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
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
    if (roomIsDm || !roomCapability(room, "canManage") || !roomCapability(room, "canExecute") || !onSetDefaultAgent) return null;
    return (
      <label className="native-work-default-control">
        <span className="native-work-default-label">既定Agent</span>
        <select
          className="native-work-default-select"
          value={defaultAgentId ?? ""}
          disabled={Boolean(busyAction?.startsWith("default-agent")) || agentLoading || agents.length === 0 || writeBlocked}
          onChange={(event) => {
            const agentId = event.currentTarget.value;
            if (!agentId) return;
            void runAction("default-agent:" + agentId, () => onSetDefaultAgent(agentId));
          }}
          aria-label="Roomの既定Agent"
        >
          <option value="" disabled>{agentLoading ? "Agentを確認中…" : "Agentを選択"}</option>
          {agents.map((agent) => {
            const selectable = agentIsAvailable(agent, agentBackends, roomAgentMembers);
            return <option key={agent.id} value={agent.id} disabled={!selectable}>{agent.displayName + (selectable ? "" : "（利用不可）")}</option>;
          })}
        </select>
      </label>
    );
  };

  const renderWarning = () => {
    if (archived) return <div className="native-banner native-banner-warning" role="status"><strong>このWorkspaceはアーカイブ済みです。</strong> 履歴は確認できますが、仕事の書き込みはできません。</div>;
    if (readOnly) return <div className="native-banner native-banner-warning" role="status"><strong>このWorkspaceは読み取り専用です。</strong> 仕事の書き込みはできません。</div>;
    if (!roomIsDm && roomCapabilityKnown(room, "canExecute") && !roomCapability(room, "canExecute")) return <div className="native-banner native-banner-warning" role="status"><strong>このRoomへの実行権限がありません。</strong> 権限が付与されるまで新しい仕事を依頼できません。</div>;
    if (!roomIsDm && !roomCapabilityKnown(room, "canExecute")) return <div className="native-banner native-banner-warning" role="status"><strong>このRoomの実行権限を確認できません。</strong> Serverから権限を受け取るまで仕事の依頼・返信・反映はできません。</div>;
    if (!defaultAgentId && !roomIsDm) return <div className="native-banner native-banner-warning" role="status"><strong>既定Agent未設定。</strong> Roomに既定Agentを設定すると新しい仕事を依頼できます。</div>;
    if (defaultAgentId && !defaultAgentKnown && !roomIsDm) return <div className="native-banner native-banner-warning" role="status"><strong>既定Agentの状態を確認できません。</strong> Serverから実行可否を受け取るまで送信できません。</div>;
    if (defaultAgentId && defaultAgentKnown && !defaultAgentReady) return <div className="native-banner native-banner-warning" role="status"><strong>既定Agentは無効または実行不可です。</strong> 別のAgentをRoomの既定に設定してください。</div>;
    if (connectionState === "offline") return <div className="native-banner native-banner-warning" role="status"><strong>Serverに接続できません。</strong> 送信前に再接続してください。</div>;
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

  return (
    <section className="native-chat-surface native-work-surface" aria-labelledby="native-work-heading">
      <style>{roomWorkStyles}</style>
      <header className="native-chat-header">
        <div>
          <div className="native-section-eyebrow">{roomIsDm ? "Private Agent DM" : "Room workbench"}</div>
          <h1 id="native-work-heading">{room?.name ?? "Roomを選択"}</h1>
        </div>
        <div className="native-work-header-meta">
          <div className={"native-connection-status is-" + connectionState} role="status">
            <span className="native-status-dot" aria-hidden="true" />
            {statusText}
          </div>
          <div className="native-work-default">
            <span className="native-work-default-label">{roomIsDm ? "担当Agent" : "既定Agent"}</span>
            {renderDefaultAgentState()}
            {renderDefaultAgentSelector()}
            {!roomIsDm && defaultAgentReady && onOpenAgentDm ? (
              <button
                type="button"
                className="native-text-button"
                disabled={Boolean(busyAction) || executeBlocked}
                onClick={() => {
                  if (!defaultAgentId) return;
                  void runAction("agent-dm:" + defaultAgentId, () => onOpenAgentDm(defaultAgentId));
                }}
              >
                {busyAction === "agent-dm:" + defaultAgentId ? "DMを開いています…" : "このAgentとDM"}
              </button>
            ) : null}
          </div>
          {roomIsDm ? <div className="native-work-private-note">Private Room · あなたとこのAgentだけが参加できます</div> : null}
          {!roomIsDm && onOpenAgentSettings ? <button type="button" className="native-text-button" onClick={onOpenAgentSettings}>Agent設定</button> : null}
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
        <aside className="native-work-list" aria-label="Roomの仕事一覧">
          <div className="native-work-list-heading">
            <h2>仕事</h2>
            <span className="native-work-list-count">{works.length}件</span>
          </div>
          {workLoading || loading ? <div className="native-work-empty" role="status">仕事の一覧を確認しています…</div> : null}
          {!workLoading && !loading && works.length === 0 ? <div className="native-work-empty"><span className="native-placeholder-kicker">NO WORK YET</span><p>このRoomにはまだ仕事がありません。下の入力欄から新しい依頼を送れます。</p></div> : null}
          <ul className="native-work-list-items">
            {works.map((work) => (
              <li key={work.id}>
                <button type="button" className={"native-work-card" + (work.id === selectedWorkId ? " is-selected" : "")} onClick={() => onSelectWork(work.id)} aria-current={work.id === selectedWorkId ? "true" : undefined}>
                  <div className="native-work-card-top">
                    <span className="native-work-card-title">{work.title}</span>
                    <span className={"native-work-status " + statusTone(workDisplayStatus(work))}>{roomWorkStatusLabel(workDisplayStatus(work))}</span>
                  </div>
                  <p className="native-work-card-objective">{work.objective}</p>
                  <div className="native-work-card-meta">
                    <span>依頼者 {actorLabel(work.requesterId, currentAccountId)}</span>
                    <span>指示 v{work.instructionVersion}</span>
                  </div>
                  <div className="native-work-assignee-row">
                    {work.assignees.length === 0 ? <span>担当未割当</span> : work.assignees.slice(0, 3).map((assignee) => <span className="native-work-assignee-chip" key={assignee.id}>{agentLabel(assignee.agentId, agents)}</span>)}
                    {work.assignees.length > 3 ? <span>+{work.assignees.length - 3}</span> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="native-work-detail">
          {!selectedWork ? (
            <div className="native-work-empty"><span className="native-placeholder-kicker">SELECT A WORK</span><p>左の仕事を選ぶと、担当・指示・コメントの履歴を確認できます。</p></div>
          ) : (
            <>
              <div className="native-work-detail-heading">
                <div>
                  <div className="native-section-eyebrow">Work detail</div>
                  <h2>{selectedWork.title}</h2>
                  <p>{selectedWork.objective}</p>
                </div>
                <div className="native-work-detail-actions">
                  <span className={"native-work-status " + statusTone(workDisplayStatus(selectedWork))}>{roomWorkStatusLabel(workDisplayStatus(selectedWork))}</span>
              <button
                type="button"
                className="native-button"
                disabled={Boolean(busyAction) || !replyEnabled || executeBlocked || !replyAllowed}
                onClick={() => onSetReplyWorkId(selectedWork.id)}
                  >
                    {replyActive ? "返信対象" : "この仕事に返信"}
                  </button>
              <button
                type="button"
                className="native-button native-button-danger"
                    disabled={Boolean(busyAction) || workIsTerminal(selectedWork) || stopBlocked}
                    onClick={() => void runAction("stop-work:" + selectedWork.id, () => onStopWork(selectedWork))}
                  >
                    {busyAction === "stop-work:" + selectedWork.id ? "停止要求中…" : "停止を要求"}
                  </button>
                </div>
              </div>
              {replyActive ? (
                <div className="native-work-reply-target" aria-live="polite">
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

              <div className="native-work-subheading"><h3>担当一覧</h3><span>{selectedWork.assignees.length}件</span></div>
              {selectedWork.assignees.length === 0 ? <p className="native-work-empty">担当Agentはまだ割り当てられていません。</p> : (
                <div className="native-work-assignees">
                  {selectedWork.assignees.map((assignee) => {
                    const actionKey = "assignee:" + assignee.id;
                    const selectableAgents = agents.filter((agent) => agentIsAvailable(agent, agentBackends, roomAgentMembers));
                    return (
                      <div className="native-work-assignee-card" key={assignee.id}>
                        <div className="native-work-assignee-row">
                          <div className="native-work-assignee-main">
                            <strong>{agentLabel(assignee.agentId, agents)}</strong>
                            <span>{roomWorkStatusLabel(assignee.status)} · 指示 v{assignee.instructionVersion}</span>
                          </div>
                          <div className="native-work-assignee-actions">
                            {selectableAgents.length > 0 ? (
                              <select
                                value={reassignAgentIds[assignee.id] ?? ""}
                                disabled={Boolean(busyAction) || assigneeIsTerminal(assignee) || executeBlocked || !replyAllowed}
                                onChange={(event) => {
                                  const agentId = event.currentTarget.value;
                                  setReassignAgentIds((current) => ({ ...current, [assignee.id]: agentId }));
                                  if (agentId) void runAction(actionKey + ":reassign", async () => {
                                    await onReassignAssignee(selectedWork, assignee, agentId);
                                    setReassignAgentIds((current) => ({ ...current, [assignee.id]: "" }));
                                  });
                                }}
                                aria-label={agentLabel(assignee.agentId, agents) + "の担当変更"}
                              >
                                <option value="">担当変更</option>
                                {selectableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
                              </select>
                            ) : null}
                            <button type="button" className="native-button native-button-danger native-button-quiet" disabled={Boolean(busyAction) || assigneeIsTerminal(assignee) || stopBlocked} onClick={() => void runAction(actionKey + ":stop", () => onStopAssignee(selectedWork, assignee))}>
                              {busyAction === actionKey + ":stop" ? "要求中…" : "担当停止"}
                            </button>
                          </div>
                        </div>
                        {selectedWork.controls?.filter((control) => control.assigneeId === assignee.id && (control.status === "requested" || control.status === "accepted" || control.status === "running" || control.status === "unconfirmed")).map((control) => <div className="native-work-control-warning" key={control.id}>{roomWorkControlLabel(control)}</div>)}
                      </div>
                    );
                  })}
                </div>
              )}

              {renderDelegation()}

              <div className="native-work-subheading"><h3>指示履歴</h3><span>{workDetailLoading ? "詳細を確認中…" : (selectedWork.instructions?.length ?? 0) + "件"}</span></div>
              {!workDetailLoading && !(selectedWork.instructions?.length) ? <p className="native-work-empty">指示履歴はServerからまだ返されていません。</p> : null}
              {selectedWork.instructions?.length ? <div className="native-work-timeline">{selectedWork.instructions.map(renderInstruction)}</div> : null}

              {selectedWork.resultSummary || resultCards.length ? (
                <>
                  <div className="native-work-subheading"><h3>結果</h3><span>Serverの記録</span></div>
                  {selectedWork.resultSummary ? <p className="native-work-instruction-body">{selectedWork.resultSummary}</p> : null}
                  {resultCards.length ? <div className="native-work-result-cards" aria-label="仕事の結果">
                    {resultCards.map((card) => <button
                      key={`${card.resource.kind}:${card.resource.id}`}
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
                    </button>)}
                  </div> : null}
                </>
              ) : null}

              <div className="native-work-subheading"><h3>コメント</h3><span>コメントは仕事の記録です</span></div>
              {workDetailLoading ? <p className="native-work-empty" role="status">コメントをServerから確認しています…</p> : !selectedWork.comments?.length ? <p className="native-work-empty">コメントはまだありません。コメント投稿だけではAgentは起動しません。</p> : <div className="native-work-comments">{selectedWork.comments.map(renderComment)}</div>}
              <form className="native-composer native-work-composer-block" onSubmit={handleComment}>
                <label className="native-work-composer-label" htmlFor="native-work-comment">コメントを投稿</label>
                <textarea id="native-work-comment" rows={2} value={workCommentDraft} onChange={(event) => onSetWorkCommentDraft(event.currentTarget.value)} placeholder="仕事に関するメモや確認事項…" disabled={commentsBlocked || Boolean(busyAction)} />
                {renderAttachmentDrafts(commentAttachmentDrafts, setCommentAttachmentDrafts)}
                <input
                  ref={commentAttachmentInputRef}
                  className="native-visually-hidden"
                  type="file"
                  multiple
                  onChange={(event) => selectAttachments(event, setCommentAttachmentDrafts)}
                  aria-label="コメントに添付"
                />
                <div className="native-composer-footer">
                  <span>
                    コメント投稿はAgentへの指示になりません
                    <button type="button" className="native-work-attachment-button" disabled={commentsBlocked || Boolean(busyAction)} onClick={() => commentAttachmentInputRef.current?.click()}>ファイルを添付</button>
                  </span>
                  <button className="native-send-button" type="submit" disabled={commentsBlocked || Boolean(busyAction) || !commentComposerHasInput}>{busyAction === "comment" ? "投稿中…" : "コメントを投稿"} <span aria-hidden="true">↗</span></button>
                </div>
              </form>

              <div className="native-work-subheading"><h3>制御の記録</h3><span>Serverの確認状態</span></div>
              {workDetailLoading ? <p className="native-work-empty" role="status">制御状態をServerから確認しています…</p> : renderControls(selectedWork)}
            </>
          )}
        </div>
      </div>

      <footer className="native-composer-wrap">
        {sending ? <div className="native-streaming-row" role="status"><span className="native-streaming-bars" aria-hidden="true"><i /><i /><i /></span>Serverが依頼を受け付けています</div> : null}
        <form className="native-composer" onSubmit={(event) => void handleSend(event)}>
          <label className="native-visually-hidden" htmlFor="native-room-work-input">新しい依頼または同じ仕事への返信</label>
          {replyActive ? <div className="native-work-composer-label">同じ仕事に返信 · {selectedWork?.title}</div> : null}
          <textarea id="native-room-work-input" rows={2} value={workDraft} onChange={(event) => onSetWorkDraft(event.currentTarget.value)} onKeyDown={handleComposerKeyDown} placeholder={replyActive ? "この仕事への追加指示…" : !defaultAgentReady ? "既定Agentを設定すると新しい依頼を送れます" : "新しい仕事をAgentに依頼する…"} disabled={composerBlocked} />
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
            <span>
              ⌘/Ctrl + Enter で送信 {replyActive ? <button type="button" className="native-text-button" onClick={() => onSetReplyWorkId(undefined)}>返信をやめる</button> : null}
              <button type="button" className="native-work-attachment-button" disabled={writeBlocked || Boolean(busyAction) || sending} onClick={() => workAttachmentInputRef.current?.click()}>ファイルを添付</button>
            </span>
            <button className="native-send-button" type="submit" disabled={composerBlocked || !workComposerHasInput}>{busyAction === "send" ? "Server確認中…" : replyActive ? "返信を送信" : "依頼を送信"} <span aria-hidden="true">↗</span></button>
          </div>
        </form>
      </footer>
    </section>
  );
}

export default RoomWorkSurface;
