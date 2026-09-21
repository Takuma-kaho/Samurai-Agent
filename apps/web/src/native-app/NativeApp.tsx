import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import RoomNavigator from "../components/RoomNavigator";
import ChatSurface from "../components/ChatSurface";
import RoomWorkSurface, { roomWorkCanReceiveReply, roomWorkControlAllowed, type NativeRoomPanelState } from "./RoomWorkSurface";
import { NativeInteractionRequests } from "./NativeInteractionRequests";
import NativeKnowledgeTools from "./NativeKnowledgeTools";
import NativeAgentResources, { type NativeAgentResource, type NativeAgentResourceArchiveInput, type NativeAgentResourceDetail, type NativeAgentResourceSelection, type NativeAgentResourceUpdateInput, type NativeAgentResourceWriteInput } from "./NativeAgentResources";
import NativeRoomAdministration from "./NativeRoomAdministration";
import NativeArtifactWorkspace, { nativeArtifactWorkspaceInitialResourceFromUnknown } from "./NativeArtifactWorkspace";
import NativeCollectionPanel from "./NativeCollectionPanel";
import NativeProfileMenu from "./NativeProfileMenu";
import NativeAccountSettings from "./NativeAccountSettings";
import NativeTopChrome, { NativePanelToggleIcon } from "./NativeTopChrome";
import WorkspaceContextSearch from "./WorkspaceContextSearch";
import WorkspaceNotificationCenter from "./WorkspaceNotificationCenter";
import WorkspaceShareDialog from "./WorkspaceShareDialog";
import WorkspaceShareImport from "./WorkspaceShareImport";
import type { ArtifactRevisionTarget } from "./ArtifactSurfacePanel";
import OrganizationManagement from "../components/OrganizationManagement";
import EvidenceInspector from "../components/EvidenceInspector";
import ConnectionRequired from "../components/ConnectionRequired";
import WorkspaceConnectionSettings from "../components/WorkspaceConnectionSettings";
import type {
  AccountInvitationNotificationListInput,
  AccountWorkspaceNotificationSummaries,
  AccountWorkspaceNotificationSummariesInput,
  DesktopWorkspaceTarget,
  WorkspaceContextSearchInput,
  WorkspaceContextSearchPage,
  WorkspaceNotificationListInput,
  WorkspaceNotificationMarkReadResult,
  WorkspaceNotificationPage,
  WorkspaceNotificationSummary
} from "../lib/api";
import { createIdempotencyKey } from "../lib/api";
import { loadNativeAccountPreferences, saveNativeAccountPreferences } from "../lib/native-account-preferences";
import { readNativeThemePreference, writeNativeThemePreference, type NativeTheme } from "../lib/native-app-theme-preferences";
import { nativeRoomAgentIsAvailable, nativeRoomCreateErrorIsExplicitServerFailure, useNativeApp } from "./use-native-app";
import { type NativeDraftNavigationController, type NativeDraftNavigationTarget } from "./use-native-draft-navigation";
import { nativeKnowledgeResourcesErrorKind, nativeRoomKnowledgeShareResources, nativeRoomKnowledgeShareSelection, type NativeRoomKnowledgeShareSelection, type NativeKnowledgeShareAvailability, type NativeRoomSearchResult } from "./use-native-knowledge-tools";
import { useNativeShareState } from "./use-native-share-state";
import { useNativeRoomExpansion } from "./use-native-room-expansion";
import { useNativeSidebarWidth } from "./use-native-sidebar-width";
import { useNativeArtifactPanelWidth } from "./use-native-artifact-panel-width";
import { useNativeRoomParticipants } from "./use-native-room-participants";
import { useNativeWorkspaceNavigationHistory, type NativeWorkspaceNavigationEntry } from "./use-native-workspace-navigation-history";
import { nativeWorkspaceTargetKey } from "./types";
import type { NativeAgent, NativeAgentBackend, NativeArtifactWorkspaceInitialResource, NativeChatMessage, NativeRoom, NativeRoomAgentMember, NativeRoomAgentPermission, NativeRoomNewAgentInput, NativeRoomWorkResourceRefInput, NativeWorkspace, NativeWorkspaceTarget } from "./types";

export interface NativeCreateDialogValue {
  name: string;
  description?: string;
  target?: NativeWorkspaceTarget;
  operationId?: string;
  defaultAgentId?: string;
  defaultAgentVersion?: number;
  newAgent?: NativeRoomNewAgentInput;
  agentPermission?: NativeRoomAgentPermission;
}

export type NativeRoomCreateMode = "existing-only" | "full";

export type NativeRoomTool = "knowledge" | "administration" | "artifacts" | "collections" | "interactions";
export type NativeRoomToolTarget = NativeWorkspaceTarget & { roomId: string };

type NativeDraftNavigationControllerRegistration = {
  controller: NativeDraftNavigationController;
  isActive?: () => boolean;
};

type NativeAccountSettingsReturnContext = {
  targetKey?: string;
  roomId?: string;
  roomPanelState: NativeRoomPanelState;
  roomSettingsTab: "basic" | "participants" | "agent" | "knowledge" | "learning" | "sharing";
};

export interface NativeDraftNavigationControllerRegistry {
  register: (controller: NativeDraftNavigationController, isActive?: () => boolean) => () => void;
  getCurrent: () => NativeDraftNavigationController | undefined;
}

/** Keeps cleanup scoped to the registration instance, including stacked overlays. */
export function createNativeDraftNavigationControllerRegistry(): NativeDraftNavigationControllerRegistry {
  const registrations: NativeDraftNavigationControllerRegistration[] = [];
  return {
    register: (controller, isActive) => {
      const registration: NativeDraftNavigationControllerRegistration = { controller, isActive };
      registrations.push(registration);
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    getCurrent: () => {
      const latestActive = registrations.slice().reverse().find((registration) => {
        try {
          return registration.isActive?.() !== false;
        } catch {
          return false;
        }
      })?.controller;
      if (latestActive) return latestActive;
      // A hidden Room panel can still contain an unsaved editor. Navigation
      // must not silently bypass that draft merely because the panel closed.
      return registrations.slice().reverse().find((registration) => {
        try {
          const state = registration.controller.getState();
          return state.dirty || state.saving || Boolean(state.saveError) || state.pending;
        } catch {
          return false;
        }
      })?.controller;
    }
  };
}

/** A Room tool is visible only when its Room belongs to the selected Workspace target. */
export function nativeRoomToolTarget(
  target: NativeWorkspaceTarget | undefined,
  room: Pick<NativeRoom, "id" | "workspaceId"> | undefined
): NativeRoomToolTarget | undefined {
  if (!target || !room || room.workspaceId !== target.workspaceId) return undefined;
  if (target.roomId !== undefined && target.roomId !== room.id) return undefined;
  return { ...target, roomId: room.id };
}

/** Adds the currently selected target to a result ref and rejects a stale Room/Workspace. */
export function nativeRoomResultResourceTarget(
  target: NativeWorkspaceTarget | undefined,
  room: Pick<NativeRoom, "id" | "workspaceId"> | undefined,
  resource: NativeArtifactWorkspaceInitialResource
): NativeArtifactWorkspaceInitialResource | undefined {
  const roomTarget = nativeRoomToolTarget(target, room);
  if (!roomTarget) return undefined;
  if ((resource.roomId && resource.roomId !== roomTarget.roomId)
    || (resource.workspaceId && resource.workspaceId !== roomTarget.workspaceId)
    || (resource.connectionId && resource.connectionId !== roomTarget.connectionId)) return undefined;
  return nativeArtifactWorkspaceInitialResourceFromUnknown({
    ...resource,
    connectionId: roomTarget.connectionId,
    workspaceId: roomTarget.workspaceId,
    roomId: roomTarget.roomId
  }, roomTarget);
}

export function NativeRoomToolLinks({ target, onOpen }: {
  target?: NativeRoomToolTarget;
  onOpen: (tool: NativeRoomTool) => void;
}) {
  if (!target) return null;
  return <div className="native-room-tool-links native-work-header-artifact-link" aria-label="現在のRoomの成果物操作">
    <button type="button" className="native-text-button" onClick={() => onOpen("artifacts")}>成果物</button>
  </div>;
}

function SidebarSearchIcon() {
  return <svg className="native-sidebar-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>;
}

function SidebarNotificationIcon() {
  return <svg className="native-sidebar-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.5 6.5a4.5 4.5 0 0 1 9 0c0 3 1.25 3.2 1.25 4.25H2.25C2.25 9.7 3.5 9.5 3.5 6.5Z" /><path d="M6.25 13h3.5" /></svg>;
}

function SidebarAgentIcon() {
  return <svg className="native-sidebar-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3" y="4.5" width="10" height="8" rx="2" /><path d="M8 2v2.5M5.5 8h.01M10.5 8h.01M5.75 10.5h4.5" /></svg>;
}

function SidebarChevronIcon({ direction = "down" }: { direction?: "down" | "right" }) {
  return <svg className="native-sidebar-chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d={direction === "down" ? "m2.5 4 3.5 3.5L9.5 4" : "m4 2.5 3.5 3.5L4 9.5"} /></svg>;
}

/**
 * Keeps an Artifact revision request on the existing Room Work path. The
 * renderer supplies only the selected Artifact/revision/location; the person
 * still reviews and sends the resulting Work instruction themselves.
 */
export function artifactRevisionRequestDraft(target: ArtifactRevisionTarget): string {
  const location = target.location
    ? target.location.kind === "text"
      ? `選択箇所（${target.location.start}-${target.location.end}）: ${target.location.text}`
      : `表のセル: 行 ${target.location.rowId} / 列 ${target.location.columnId} / 現在値 ${String(target.location.value)}`
    : "指定箇所: 成果物全体";
  return [
    "[成果物の修正依頼]",
    `成果物: ${target.artifact.title || target.artifact.id} (${target.artifact.id})`,
    `対象版: ${target.revisionId ?? "最新版"}`,
    ...(target.sourceWorkId ? [`元の仕事: ${target.sourceWorkId}`] : []),
    location,
    "依頼内容:",
    target.request.trim()
  ].join("\n");
}

/** A Room Work draft belongs to one selected Server, Workspace, Room, and Work. */
export function nativeRoomWorkResourceDraftKey(
  target: NativeWorkspaceTarget | undefined,
  roomId: string | undefined,
  workId: string | undefined
): string | undefined {
  if (!target || !roomId) return undefined;
  return `${target.connectionId}\n${target.workspaceId}\n${roomId}\n${workId ?? "new"}`;
}

/** Keep one immutable Knowledge/Skill version per draft without trusting its label. */
export function appendNativeRoomWorkResourceRef(
  current: readonly NativeRoomWorkResourceRefInput[],
  next: NativeRoomWorkResourceRefInput
): NativeRoomWorkResourceRefInput[] {
  if ((next.kind !== "knowledge" && next.kind !== "skill")
    || !/^[a-z][a-z0-9_:-]{0,127}$/.test(next.id)
    || !Number.isSafeInteger(next.version)
    || next.version < 1) {
    return [...current];
  }
  const key = `${next.kind}\n${next.id}\n${next.version}`;
  if (current.some((ref) => `${ref.kind}\n${ref.id}\n${ref.version}` === key)) return [...current];
  return [
    ...current,
    {
      kind: next.kind,
      id: next.id,
      version: next.version,
      ...(next.label?.trim() ? { label: next.label.trim().slice(0, 4_096) } : {})
    }
  ];
}

export function CreateDialog({
  kind,
  onClose,
  onSubmit,
  busy,
  error,
  agents = [],
  agentBackends = [],
  agentLoading = false,
  agentBackendLoading = false,
  agentError,
  agentBackendError,
  workspaceTarget,
  roomCreateMode = "full"
}: {
  kind: "organization" | "workspace" | "room";
  onClose: () => void;
  onSubmit: (value: NativeCreateDialogValue) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  agents?: NativeAgent[];
  agentBackends?: NativeAgentBackend[];
  agentLoading?: boolean;
  agentBackendLoading?: boolean;
  agentError?: string | null;
  agentBackendError?: string | null;
  workspaceTarget?: NativeWorkspaceTarget;
  /** The ordinary Room navigator intentionally exposes only existing Agents. */
  roomCreateMode?: NativeRoomCreateMode;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentMode, setAgentMode] = useState<"existing" | "new">(roomCreateMode === "existing-only" || agents.length ? "existing" : "new");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [newAgentName, setNewAgentName] = useState("");
  const [newAgentRole, setNewAgentRole] = useState("");
  const [newAgentInstructions, setNewAgentInstructions] = useState("");
  const [newAgentBackendId, setNewAgentBackendId] = useState(agentBackends[0]?.id ?? "");
  const [roomOperationId, setRoomOperationId] = useState(() => createIdempotencyKey());
  const [roomTarget] = useState<NativeWorkspaceTarget | undefined>(() => workspaceTarget ? { ...workspaceTarget } : undefined);
  const [agentPermission, setAgentPermission] = useState<NativeRoomAgentPermission>({ canView: true, canEdit: true, canExecute: true });
  const [validationError, setValidationError] = useState<string | null>(null);
  const availableBackends = useMemo(() => agentBackends.filter((backend) => backend.configured && backend.enabled && backend.connectionState === "ready"), [agentBackends]);
  const availableAgents = useMemo(() => agents.filter((agent) => nativeRoomAgentIsAvailable(agent, availableBackends)), [agents, availableBackends]);
  useEffect(() => {
    if (kind !== "room") return;
    if (!availableAgents.length) {
      setAgentMode(roomCreateMode === "existing-only" ? "existing" : "new");
    } else if (!defaultAgentId || !availableAgents.some((agent) => agent.id === defaultAgentId)) {
      setDefaultAgentId(availableAgents[0]?.id ?? "");
    }
    if (!newAgentBackendId || !availableBackends.some((backend) => backend.id === newAgentBackendId)) {
      setNewAgentBackendId(availableBackends[0]?.id ?? "");
    }
  }, [availableAgents, availableBackends, defaultAgentId, kind, newAgentBackendId, roomCreateMode]);
  const title = kind === "organization" ? "Organizationを作成" : kind === "workspace" ? "Workspaceを作成" : "Roomを作成";
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidationError(null);
    if (!name.trim()) {
      setValidationError("名前を入力してください。");
      if (kind === "room") setRoomOperationId(createIdempotencyKey());
      return;
    }
    if (kind !== "room") {
      await onSubmit({ name: name.trim(), ...(kind === "organization" && description.trim() ? { description: description.trim() } : {}) });
      return;
    }
    if (!roomTarget) {
      setValidationError("Workspaceの接続先を確認してから、もう一度お試しください。");
      setRoomOperationId(createIdempotencyKey());
      return;
    }
    if (agentMode === "existing") {
      const selectedAgent = availableAgents.find((agent) => agent.id === defaultAgentId);
      if (!selectedAgent) {
        setValidationError("利用できる既存Agentを選択してください。");
        setRoomOperationId(createIdempotencyKey());
        return;
      }
      if (roomCreateMode === "full" && (!agentPermission.canView || !agentPermission.canExecute)) {
        setValidationError("既定Agentには閲覧と実行権限が必要です。");
        setRoomOperationId(createIdempotencyKey());
        return;
      }
      try {
        await onSubmit({
          name: name.trim(),
          target: roomTarget,
          operationId: roomOperationId,
          defaultAgentId: selectedAgent.id,
          ...(selectedAgent.version === undefined ? {} : { defaultAgentVersion: selectedAgent.version }),
          ...(roomCreateMode === "full" ? { agentPermission } : {})
        });
      } catch (error) {
        if (nativeRoomCreateErrorIsExplicitServerFailure(error)) setRoomOperationId(createIdempotencyKey());
      }
      return;
    }
    if (!newAgentName.trim() || !newAgentRole.trim() || !newAgentInstructions.trim()) {
      setValidationError("新規Agentの名前、役割、指示を入力してください。");
      setRoomOperationId(createIdempotencyKey());
      return;
    }
    if (!newAgentBackendId || !availableBackends.some((backend) => backend.id === newAgentBackendId)) {
      setValidationError("利用可能なBackendを選択してください。");
      setRoomOperationId(createIdempotencyKey());
      return;
    }
    if (!agentPermission.canView || !agentPermission.canExecute) {
      setValidationError("既定Agentには閲覧と実行権限が必要です。");
      setRoomOperationId(createIdempotencyKey());
      return;
    }
    try {
      await onSubmit({
        name: name.trim(),
        target: roomTarget,
        operationId: roomOperationId,
        newAgent: {
          name: newAgentName.trim(),
          role: newAgentRole.trim(),
          instructions: newAgentInstructions.trim(),
          backendId: newAgentBackendId,
          enabled: true
        },
        agentPermission
      });
    } catch (error) {
      if (nativeRoomCreateErrorIsExplicitServerFailure(error)) setRoomOperationId(createIdempotencyKey());
    }
  };
  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section className="native-dialog" role="dialog" aria-modal="true" aria-labelledby="native-create-dialog-title">
        <div className="native-card-heading"><div><span className="native-section-eyebrow">New space</span><h2 id="native-create-dialog-title">{title}</h2></div><button className="native-icon-button" type="button" onClick={onClose} aria-label="閉じる">×</button></div>
        <form onSubmit={submit} className="native-form-grid">
          <label><span>名前</span><input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={160} required /></label>
          {kind === "organization" ? <label><span>説明（任意）</span><textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} rows={3} maxLength={1000} /></label> : null}
          {kind === "room" ? <>
            <fieldset className="native-form-fieldset">
              <legend>既定Agent</legend>
              <label className="native-radio-label"><input type="radio" name="room-agent-mode" checked={agentMode === "existing"} disabled={!availableAgents.length || agentLoading} onChange={() => setAgentMode("existing")} /><span>既存Agentを選ぶ</span></label>
              {agentMode === "existing" ? <label><span>Agent</span><select value={defaultAgentId} onChange={(event) => setDefaultAgentId(event.currentTarget.value)} disabled={!availableAgents.length || agentLoading} required><option value="">選択してください</option>{availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}{agent.backendId ? ` · ${agent.backendId}` : ""}</option>)}</select></label> : null}
            </fieldset>
            {roomCreateMode === "full" ? <label className="native-radio-label"><input type="radio" name="room-agent-mode" checked={agentMode === "new"} onChange={() => setAgentMode("new")} /><span>新しいAgentを同時に作る</span></label> : null}
            {roomCreateMode === "existing-only" && !availableAgents.length ? <p className="native-inline-error">利用できる既存Agentがないため、Roomを作成できません。</p> : null}
            {roomCreateMode === "full" && agentMode === "new" ? <div className="native-form-subsection">
              <label><span>Agent名</span><input value={newAgentName} onChange={(event) => setNewAgentName(event.currentTarget.value)} maxLength={200} required /></label>
              <label><span>役割</span><input value={newAgentRole} onChange={(event) => setNewAgentRole(event.currentTarget.value)} maxLength={500} required /></label>
              <label><span>指示</span><textarea value={newAgentInstructions} onChange={(event) => setNewAgentInstructions(event.currentTarget.value)} rows={4} maxLength={20_000} required /></label>
              <label><span>Backend</span><select value={newAgentBackendId} onChange={(event) => setNewAgentBackendId(event.currentTarget.value)} disabled={agentBackendLoading || !availableBackends.length} required><option value="">選択してください</option>{availableBackends.map((backend) => <option key={backend.id} value={backend.id}>{backend.label}</option>)}</select></label>
              {agentBackendLoading ? <p className="native-inline-note">Backendを確認しています…</p> : null}
              {!agentBackendLoading && !availableBackends.length ? <p className="native-inline-error">利用可能なBackendがありません。Server設定を確認してください。</p> : null}
              {agentBackendError ? <p className="native-inline-error">{agentBackendError}</p> : null}
            </div> : null}
            {roomCreateMode === "full" ? <fieldset className="native-form-fieldset">
              <legend>Room権限</legend>
              <label className="native-checkbox-label"><input type="checkbox" checked={agentPermission.canView} onChange={(event) => { const checked = event.currentTarget.checked; setAgentPermission((current) => ({ ...current, canView: checked })); }} /><span>閲覧</span></label>
              <label className="native-checkbox-label"><input type="checkbox" checked={agentPermission.canEdit} onChange={(event) => { const checked = event.currentTarget.checked; setAgentPermission((current) => ({ ...current, canEdit: checked })); }} /><span>編集</span></label>
              <label className="native-checkbox-label"><input type="checkbox" checked={agentPermission.canExecute} onChange={(event) => { const checked = event.currentTarget.checked; setAgentPermission((current) => ({ ...current, canExecute: checked })); }} /><span>実行</span></label>
            </fieldset> : null}
            {agentLoading && agentMode === "existing" ? <p className="native-inline-note">Agent一覧を確認しています…</p> : null}
            {agentError ? <p className="native-inline-error">{agentError}</p> : null}
          </> : null}
          {validationError ? <p className="native-inline-error" role="alert">{validationError}</p> : null}
          {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
          <div className="native-dialog-actions"><button className="native-button" type="button" onClick={onClose}>キャンセル</button><button className="native-button native-button-primary" type="submit" disabled={busy || !name.trim()}>{busy ? "作成中…" : "作成"}</button></div>
        </form>
      </section>
    </div>
  );
}

export function EmptyMainState({ kind, onCreate, hasWorkspaces = false }: { kind: "workspace" | "room"; onCreate?: () => void; hasWorkspaces?: boolean }) {
  if (kind === "workspace" && hasWorkspaces) return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">CHOOSE A WORKSPACE</span><h1 id="native-empty-heading">左の一覧からWorkspaceを選択してください</h1><p>Workspaceを選ぶと、Roomと会話を表示できます。</p></section>;
  if (kind === "workspace") return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">WORKSPACE FIRST</span><h1 id="native-empty-heading">利用できるWorkspaceがありません</h1><p>WorkspaceはOrganizationに参加していなくても利用できます。新しく作成するか、別のServerの接続を確認してください。</p>{onCreate ? <button type="button" className="native-button native-button-primary" onClick={onCreate}>Workspaceを作成</button> : null}</section>;
  return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">ONE ROOM AT A TIME</span><h1 id="native-empty-heading">Roomを選ぶと会話を始められます</h1><p>このWorkspaceにはまだRoomがありません。Roomを作成するか、管理者にアクセスを依頼してください。</p>{onCreate ? <button type="button" className="native-button native-button-primary" onClick={onCreate}>Roomを作成</button> : null}</section>;
}

function agentOperationError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.includes("workspace_default_agent_remove_required") || message.includes("default_agent_remove_required")) {
    return "既定Agentは解除できません。別のAgentを既定に設定してから解除してください。";
  }
  if (message.includes("workspace_agent_room_permission_version_conflict")) return "Room権限が更新されています。最新状態を確認してから再度保存してください。";
  if (message.includes("workspace_agent_backend_unavailable") || message.includes("room_agent_backend_unavailable")) return "このBackendは未準備です。Serverで準備済みのBackendを選択してください。";
  return message || fallback;
}

/** Keep an opened profile tied to the authorized Workspace/Room and Agent list scope. */
export function nativeAgentDirectoryScopeKey(
  workspaceTargetKey: string | undefined,
  workspaceName: string | undefined,
  roomId: string | undefined,
  agents: readonly Pick<NativeAgent, "id" | "version">[]
): string {
  return JSON.stringify([
    workspaceTargetKey ?? null,
    workspaceName ?? null,
    roomId ?? null,
    agents.map((agent) => JSON.stringify([agent.id, agent.version ?? null])).sort()
  ]);
}

/** Do not render a profile fetched for a previous navigation/list scope. */
export function nativeAgentProfileForScope(
  profile: NativeAgent | undefined,
  profileScopeKey: string | undefined,
  scopeKey: string
): NativeAgent | undefined {
  return profile && profileScopeKey === scopeKey ? profile : undefined;
}

export function AgentDirectoryPanel({
  workspaceName,
  workspaceTargetKey,
  agents,
  agentBackends,
  agentLoading,
  agentError,
  agentResources,
  agentResourceSelectedId,
  agentResourceLoading,
  agentResourceError,
  agentResourceCanManage,
  onClose,
  onViewAgent,
  onOpenAgentDm,
  onSelectAgentResources,
  onSelectAgentResource,
  onLoadAgentResource,
  onCreateAgentResource,
  onUpdateAgentResource,
  onArchiveAgentResource,
  onOpenAgentShare
}: {
  workspaceName?: string;
  workspaceTargetKey?: string;
  /** Kept in the public props for the parent wiring; management is intentionally not rendered here. */
  readOnly?: boolean;
  room?: NativeRoom;
  agents: NativeAgent[];
  agentBackends: NativeAgentBackend[];
  agentLoading?: boolean;
  agentError?: string | null;
  agentResources?: readonly NativeAgentResource[];
  agentResourceSelectedId?: string;
  agentResourceLoading?: boolean;
  agentResourceError?: string | null;
  agentResourceCanManage?: boolean;
  roomAgentMembers?: NativeRoomAgentMember[];
  roomAgentMembersLoading?: boolean;
  roomAgentMembersError?: string | null;
  onClose: () => void;
  onViewAgent: (agentId: string) => Promise<NativeAgent>;
  onCreateAgent?: (input: { name: string; role: string; instructions: string; backendId: string; enabled: boolean }) => Promise<NativeAgent>;
  onPatchAgent?: (input: { agentId: string; name?: string; role?: string; instructions?: string; enabled?: boolean; expectedVersion?: number }) => Promise<NativeAgent>;
  onBindBackend?: (input: { agentId: string; backendId: string; expectedVersion?: number }) => Promise<NativeAgent>;
  onSetRoomAgentPermission?: (input: { agentId: string; canView: boolean; canEdit: boolean; canExecute: boolean }) => Promise<NativeRoomAgentMember>;
  onRemoveRoomAgent?: (agentId: string) => Promise<NativeRoomAgentMember>;
  onSetDefaultAgent?: (agentId: string) => Promise<void> | void;
  onOpenAgentDm?: (agentId: string) => Promise<void> | void;
  onSelectAgentResources?: (agentId?: string) => void;
  onSelectAgentResource?: (selection: NativeAgentResourceSelection) => void;
  onLoadAgentResource?: (selection: NativeAgentResourceSelection) => Promise<NativeAgentResourceDetail>;
  onCreateAgentResource?: (input: NativeAgentResourceWriteInput) => Promise<NativeAgentResource>;
  onUpdateAgentResource?: (input: NativeAgentResourceUpdateInput) => Promise<NativeAgentResource>;
  onArchiveAgentResource?: (input: NativeAgentResourceArchiveInput) => Promise<NativeAgentResource>;
  onOpenAgentShare?: (selection: NativeAgentResourceSelection & { kind: "knowledge" | "skill" }) => void | Promise<void>;
  onDraftNavigationControllerChange?: (controller: NativeDraftNavigationController | undefined) => void;
}) {
  const backendLabels = useMemo(() => new Map(agentBackends.map((backend) => [backend.id, backend.label])), [agentBackends]);
  const availableAgent = (agent: NativeAgent): boolean => nativeRoomAgentIsAvailable(agent, agentBackends);
  const directoryScopeKey = nativeAgentDirectoryScopeKey(workspaceTargetKey, workspaceName, undefined, agents);
  const [profile, setProfile] = useState<NativeAgent>();
  const [profileScopeKey, setProfileScopeKey] = useState<string>();
  const [profileLoadingId, setProfileLoadingId] = useState<string>();
  const [profileLoadingScopeKey, setProfileLoadingScopeKey] = useState<string>();
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileErrorScopeKey, setProfileErrorScopeKey] = useState<string>();
  const [dmLoadingId, setDmLoadingId] = useState<string>();
  const [dmError, setDmError] = useState<string | null>(null);
  const profileRequestGenerationRef = useRef(0);
  const currentProfileScopeRef = useRef(directoryScopeKey);
  currentProfileScopeRef.current = directoryScopeKey;
  const visibleProfile = nativeAgentProfileForScope(profile, profileScopeKey, directoryScopeKey);
  const visibleProfileError = profileErrorScopeKey === directoryScopeKey ? profileError : null;
  const visibleProfileLoadingId = profileLoadingScopeKey === directoryScopeKey ? profileLoadingId : undefined;

  useEffect(() => {
    profileRequestGenerationRef.current += 1;
    setProfile(undefined);
    setProfileScopeKey(undefined);
    setProfileError(null);
    setProfileErrorScopeKey(undefined);
    setProfileLoadingId(undefined);
    setProfileLoadingScopeKey(undefined);
    onSelectAgentResources?.(undefined);
  }, [directoryScopeKey, onSelectAgentResources]);

  const loadAgentProfile = async (agent: NativeAgent): Promise<void> => {
    const requestGeneration = profileRequestGenerationRef.current + 1;
    const requestScopeKey = directoryScopeKey;
    profileRequestGenerationRef.current = requestGeneration;
    setProfile(undefined);
    setProfileScopeKey(undefined);
    setProfileError(null);
    setProfileErrorScopeKey(undefined);
    setProfileLoadingId(agent.id);
    setProfileLoadingScopeKey(requestScopeKey);
    onSelectAgentResources?.(agent.id);
    const isCurrentRequest = (): boolean => profileRequestGenerationRef.current === requestGeneration
      && currentProfileScopeRef.current === requestScopeKey;
    try {
      const detail = await onViewAgent(agent.id);
      if (!isCurrentRequest()) return;
      setProfile(detail);
      setProfileScopeKey(requestScopeKey);
    } catch (error) {
      if (!isCurrentRequest()) return;
      setProfileError(agentOperationError(error, "Agentのプロフィールを取得できませんでした。"));
      setProfileErrorScopeKey(requestScopeKey);
    } finally {
      if (isCurrentRequest()) {
        setProfileLoadingId(undefined);
        setProfileLoadingScopeKey(undefined);
      }
    }
  };

  const openAgentDm = async (agentId: string): Promise<void> => {
    if (!onOpenAgentDm) return;
    setDmLoadingId(agentId);
    setDmError(null);
    try {
      await onOpenAgentDm(agentId);
    } catch (error) {
      setDmError(agentOperationError(error, "Agent DMを開けませんでした。"));
    } finally {
      setDmLoadingId(undefined);
    }
  };

  return (
    <section className="native-chat-surface native-agent-directory" aria-labelledby="native-agent-directory-heading">
      <style>{[
        ".native-agent-directory { min-height: 100%; overflow: auto; }",
        ".native-agent-directory-inner { max-width: 1080px; margin: 0 auto; padding: clamp(24px, 4vw, 54px); }",
        ".native-agent-directory-header { align-items: flex-start; display: flex; gap: 20px; justify-content: space-between; margin-bottom: 28px; }",
        ".native-agent-directory-header h1 { margin: 4px 0 7px; }",
        ".native-agent-directory-header p { color: var(--native-muted); margin: 0; }",
        ".native-agent-directory-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }",
        ".native-agent-directory-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }",
        ".native-agent-directory-row { align-items: center; border: 1px solid var(--native-line); border-radius: 14px; display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) auto auto auto auto; padding: 15px 17px; }",
        ".native-agent-directory-name { font-weight: 700; min-width: 0; }",
        ".native-agent-directory-name small { color: var(--native-muted); display: block; font-weight: 500; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
        ".native-agent-directory-meta { color: var(--native-muted); font-size: .88rem; }",
        ".native-agent-directory-status { border-radius: 999px; font-size: .76rem; padding: 4px 8px; white-space: nowrap; }",
        ".native-agent-directory-status.is-ready { background: color-mix(in srgb, var(--native-success) 16%, transparent); color: var(--native-success); }",
        ".native-agent-directory-status.is-unavailable { background: color-mix(in srgb, var(--native-warning-copy) 16%, transparent); color: var(--native-warning-copy); }",
        ".native-agent-profile { border: 1px solid var(--native-line); border-radius: 14px; margin-top: 20px; padding: 18px 20px; }",
        ".native-agent-profile h2 { margin: 0 0 14px; }",
        ".native-agent-profile dl { display: grid; gap: 9px 16px; grid-template-columns: minmax(100px, max-content) minmax(0, 1fr); margin: 0; }",
        ".native-agent-profile dt { color: var(--native-muted); }",
        ".native-agent-profile dd { margin: 0; min-width: 0; }",
        ".native-agent-profile-description, .native-agent-profile-instructions { color: var(--native-muted); margin: 16px 0 0; white-space: pre-wrap; }",
        "@media (max-width: 760px) { .native-agent-directory-header { flex-direction: column; } .native-agent-directory-actions { justify-content: flex-start; } .native-agent-directory-row { grid-template-columns: minmax(0, 1fr) auto; } .native-agent-directory-meta { grid-column: 1 / -1; } .native-agent-directory-row > .native-agent-directory-status { grid-column: 2; grid-row: 1; } }",
        "@media (max-width: 460px) { .native-agent-directory-inner { padding: 20px 17px; } .native-agent-directory-row { align-items: start; } }"
      ].join("\n")}</style>
      <div className="native-agent-directory-inner">
        <header className="native-agent-directory-header">
          <div><h1 id="native-agent-directory-heading">Agent</h1><p>{workspaceName ?? "現在のWorkspace"}</p></div>
          <div className="native-agent-directory-actions"><button type="button" className="native-button" onClick={onClose}>戻る</button></div>
        </header>

        {agentLoading ? <p className="native-inline-note" role="status">Agent一覧を確認しています…</p> : null}
        {agentError ? <p className="native-inline-error" role="alert">{agentError}</p> : null}
        {dmError ? <p className="native-inline-error" role="alert">{dmError}</p> : null}
        {!agentLoading && agents.length === 0 ? <p className="native-inline-note">このWorkspaceにはAgentがありません。</p> : null}
        <ul className="native-agent-directory-list" aria-label="Agent一覧">
          {agents.map((agent) => {
            const ready = availableAgent(agent);
            return <li className="native-agent-directory-row" key={agent.id}>
              <div className="native-agent-directory-name">{agent.displayName}<small>{agent.role ?? "役割未設定"}</small></div>
              <span className="native-agent-directory-meta">{agent.backendId ? (backendLabels.get(agent.backendId) ?? agent.backendId) : "Backend未設定"}</span>
              <span className={`native-agent-directory-status ${ready ? "is-ready" : "is-unavailable"}`}>{ready ? "利用可能" : agent.enabled ? "利用不可" : "無効"}</span>
              {onOpenAgentDm ? <button type="button" className="native-text-button" onClick={() => void openAgentDm(agent.id)} disabled={!ready || Boolean(dmLoadingId)}>{dmLoadingId === agent.id ? "DMを開いています…" : "DM"}</button> : null}
              <button type="button" className="native-text-button" onClick={() => void loadAgentProfile(agent)} disabled={visibleProfileLoadingId === agent.id || Boolean(dmLoadingId)} aria-controls={visibleProfile ? "native-agent-profile-heading" : undefined}>{visibleProfileLoadingId === agent.id ? "読込中…" : "プロフィール"}</button>
            </li>;
          })}
        </ul>

        {visibleProfileError ? <p className="native-inline-error" role="alert">{visibleProfileError}</p> : null}
        {visibleProfile ? <section className="native-agent-profile" aria-labelledby="native-agent-profile-heading">
          <h2 id="native-agent-profile-heading">{visibleProfile.displayName}</h2>
          <dl>
            <dt>役割</dt><dd>{visibleProfile.role ?? "役割未設定"}</dd>
            <dt>Backend</dt><dd>{visibleProfile.backendId ? (backendLabels.get(visibleProfile.backendId) ?? visibleProfile.backendId) : "Backend未設定"}</dd>
            <dt>利用可否</dt><dd>{availableAgent(visibleProfile) ? "利用可能" : visibleProfile.enabled ? "利用不可" : "無効"}</dd>
          </dl>
          {visibleProfile.description ? <p className="native-agent-profile-description">{visibleProfile.description}</p> : null}
          {visibleProfile.instructions ? <p className="native-agent-profile-instructions">{visibleProfile.instructions}</p> : null}
          <NativeAgentResources
            agentId={visibleProfile.id}
            agentLabel={visibleProfile.displayName}
            resources={agentResources ?? []}
            selectedResourceId={agentResourceSelectedId}
            canManage={agentResourceCanManage}
            loading={agentResourceLoading}
            error={agentResourceError}
            onSelectResource={onSelectAgentResource}
            onLoadResource={onLoadAgentResource}
            onCreateResource={onCreateAgentResource}
            onUpdateResource={onUpdateAgentResource}
            onArchiveResource={onArchiveAgentResource}
            onOpenShare={onOpenAgentShare}
          />
        </section> : null}
      </div>
    </section>
  );
}

/** Search and notification requests are scoped to the selected Workspace only. */
export function nativeWorkspaceContextTarget(target: NativeWorkspaceTarget | undefined): DesktopWorkspaceTarget | undefined {
  if (!target?.connectionId || !target.workspaceId) return undefined;
  return {
    connectionId: target.connectionId,
    workspaceId: target.workspaceId,
    ...(target.selectionGeneration === undefined ? {} : { selectionGeneration: target.selectionGeneration })
  };
}

/** Keep the sidebar switcher limited to authorized, target-addressable rows. */
export function nativeWorkspaceSwitcherEntries(workspaces: readonly NativeWorkspace[]): Array<{ key: string; workspace: NativeWorkspace }> {
  const entries: Array<{ key: string; workspace: NativeWorkspace }> = [];
  const seen = new Set<string>();
  for (const workspace of workspaces) {
    if (workspace.access !== "granted") continue;
    const target = workspace.target
      ?? (workspace.connectionId ? { connectionId: workspace.connectionId, workspaceId: workspace.id } : undefined);
    if (!target) continue;
    const key = nativeWorkspaceTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, workspace });
  }
  return entries;
}

const nativeKnownWorkspaceNotificationKinds = new Set([
  "work_completed",
  "work_failed",
  "approval_required",
  "input_required",
  "workspace_invitation",
  "organization_invitation"
]);

/** Keep an unrecognized notification kind visible in the safe text projection. */
export function nativeWorkspaceNotificationPageForDisplay(page: WorkspaceNotificationPage): WorkspaceNotificationPage {
  return {
    ...page,
    items: page.items.map((notification) => {
      if (nativeKnownWorkspaceNotificationKinds.has(notification.kind)) return notification;
      const kind = notification.kind.trim() || "unknown";
      return {
        ...notification,
        summary: `未認識の通知種別: ${kind}。${notification.summary}`
      };
    })
  };
}

export function NativeApp() {
  const model = useNativeApp();
  const macDesktop = typeof window !== "undefined" && Boolean(window.samuraiDesktop) && /Mac/.test(window.navigator.platform);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [theme, setTheme] = useState<NativeTheme>(() => readNativeThemePreference());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const sidebarWidth = useNativeSidebarWidth(() => setDesktopSidebarOpen(false), () => setDesktopSidebarOpen(true));
  const [mobileViewport, setMobileViewport] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 700px)").matches === true);
  const [createKind, setCreateKind] = useState<"organization" | "workspace" | "room">();
  const [roomCreateMode, setRoomCreateMode] = useState<NativeRoomCreateMode>("full");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [managementScope, setManagementScope] = useState<"organization" | "workspace">("organization");
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);
  const [agentDirectoryOpen, setAgentDirectoryOpen] = useState(false);
  const [roomToolOpen, setRoomToolOpen] = useState<NativeRoomTool>();
  const [roomPanelState, setRoomPanelState] = useState<NativeRoomPanelState>("closed");
  const [artifactPanelExpanded, setArtifactPanelExpanded] = useState(false);
  const [artifactPanelRestoreWidth, setArtifactPanelRestoreWidth] = useState<number>();
  const [roomSettingsTab, setRoomSettingsTab] = useState<"basic" | "participants" | "agent" | "knowledge" | "learning" | "sharing">("basic");
  const [roomAdministrationTarget, setRoomAdministrationTarget] = useState<NativeRoom>();
  const [roomAdministrationView, setRoomAdministrationView] = useState<"menu" | "participants" | "create" | "move" | "rename">("menu");
  const [knowledgeToolsInitialTab, setKnowledgeToolsInitialTab] = useState<"knowledge" | "search" | "settings" | "automation">("knowledge");
  const [artifactWorkspaceInitialResource, setArtifactWorkspaceInitialResource] = useState<NativeArtifactWorkspaceInitialResource>();
  const [artifactWorkspaceLastResource, setArtifactWorkspaceLastResource] = useState<NativeArtifactWorkspaceInitialResource>();
  const [workResourceDrafts, setWorkResourceDrafts] = useState<Record<string, NativeRoomWorkResourceRefInput[]>>({});
  const [contextSurface, setContextSurface] = useState<"search" | "notifications">();
  const [sidebarSearchQuery, setSidebarSearchQuery] = useState("");
  const [workspacePopoverOpen, setWorkspacePopoverOpen] = useState(false);
  const [accountSettingsRestoreError, setAccountSettingsRestoreError] = useState<string | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const contextSearchTriggerRef = useRef<HTMLButtonElement>(null);
  const contextNotificationTriggerRef = useRef<HTMLButtonElement>(null);
  const contextReturnTriggerRef = useRef<HTMLElement | null>(null);
  const contextWasMobileSidebarOpenRef = useRef(false);
  const accountSettingsWasMobileSidebarOpenRef = useRef(false);
  const accountSettingsReturnContextRef = useRef<NativeAccountSettingsReturnContext | undefined>(undefined);
  const accountSettingsPendingRestoreRef = useRef<NativeAccountSettingsReturnContext | undefined>(undefined);
  const accountSettingsRestoreSelectionRequestedRef = useRef(false);
  const workspaceNavigationRestoreRef = useRef<NativeWorkspaceNavigationEntry | undefined>(undefined);
  const draftNavigationControllerRegistryRef = useRef<NativeDraftNavigationControllerRegistry | undefined>(undefined);
  const mainWindowRef = useRef<HTMLElement>(null);
  const panelCloseRequestRef = useRef<(() => void) | undefined>(undefined);
  const roomPanelStateRef = useRef(roomPanelState);
  roomPanelStateRef.current = roomPanelState;
  const expandArtifactPanel = useCallback((restoreWidth: number): void => {
    setArtifactPanelRestoreWidth(Math.round(restoreWidth));
    setArtifactPanelExpanded(true);
  }, []);
  const artifactPanelWidth = useNativeArtifactPanelWidth(
    mainWindowRef,
    () => panelCloseRequestRef.current?.(),
    expandArtifactPanel,
    () => setRoomPanelState("artifacts"),
    (restoreWidth) => {
      setArtifactPanelRestoreWidth(Math.round(restoreWidth));
      setArtifactPanelExpanded(false);
    }
  );
  const collapseArtifactPanel = useCallback((): void => {
    setArtifactPanelExpanded(false);
    if (artifactPanelRestoreWidth !== undefined) artifactPanelWidth.setWidth(artifactPanelRestoreWidth);
  }, [artifactPanelRestoreWidth, artifactPanelWidth.setWidth]);
  useEffect(() => {
    sidebarWidth.cancelResize();
    artifactPanelWidth.cancelResize();
  }, [artifactPanelWidth.cancelResize, model.selectedRoomId, model.selectedWorkspaceTargetKey, sidebarWidth.cancelResize]);
  const toggleArtifactPanelExpanded = useCallback((): void => {
    if (artifactPanelExpanded) {
      collapseArtifactPanel();
      return;
    }
    expandArtifactPanel(artifactPanelWidth.width);
  }, [artifactPanelExpanded, artifactPanelWidth.width, collapseArtifactPanel, expandArtifactPanel]);
  useEffect(() => {
    if (!artifactPanelExpanded || artifactPanelRestoreWidth === undefined) return;
    if (artifactPanelRestoreWidth > artifactPanelWidth.maxWidth) setArtifactPanelRestoreWidth(artifactPanelWidth.maxWidth);
  }, [artifactPanelExpanded, artifactPanelRestoreWidth, artifactPanelWidth.maxWidth]);
  if (!draftNavigationControllerRegistryRef.current) {
    draftNavigationControllerRegistryRef.current = createNativeDraftNavigationControllerRegistry();
  }

  const roomToolTarget = nativeRoomToolTarget(model.selectedWorkspaceTarget, model.selectedRoom);
  const workspaceNavigationHistory = useNativeWorkspaceNavigationHistory();

  useEffect(() => {
    if (!macDesktop || typeof window === "undefined") return;
    const desktop = window.samuraiDesktop;
    if (!desktop?.getWindowFullscreen) return;

    let active = true;
    void desktop.getWindowFullscreen()
      .then((fullscreen) => {
        if (active) setNativeFullscreen(fullscreen);
      })
      .catch(() => {
        // Older preload builds do not expose this display-only capability.
      });
    const unsubscribe = desktop.onWindowFullscreenChange?.((fullscreen) => {
      if (active) setNativeFullscreen(fullscreen);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [macDesktop]);

  const changeTheme = useCallback((nextTheme: NativeTheme): void => {
    // Keep the UI responsive even when localStorage is disabled or full. The
    // preference module normalizes the value and absorbs storage failures.
    setTheme(writeNativeThemePreference(nextTheme));
  }, []);

  const closeMobileSidebar = useCallback((): void => {
    setMobileSidebarOpen(false);
  }, []);

  const currentContextTarget = useMemo(
    () => nativeWorkspaceContextTarget(model.selectedWorkspaceTarget),
    [model.selectedWorkspaceTarget?.connectionId, model.selectedWorkspaceTarget?.workspaceId]
  );
  const searchApiAvailable = Boolean(model.bridge?.searchWorkspaceContext && currentContextTarget);
  const [accountPreferencesDisplayName, setAccountPreferencesDisplayName] = useState<string>();
  useEffect(() => {
    const accountId = model.connection?.accountId;
    if (!accountId) {
      setAccountPreferencesDisplayName(undefined);
      return undefined;
    }
    let active = true;
    void loadNativeAccountPreferences(accountId, "本人")
      .then((preferences) => {
        if (active) setAccountPreferencesDisplayName(preferences.display_name.trim() || undefined);
      })
      .catch(() => {
        if (active) setAccountPreferencesDisplayName(undefined);
      });
    return () => { active = false; };
  }, [model.connection?.accountId]);
  const roomAccountDisplayNames = useMemo(() => {
    const displayNames: Record<string, string> = {};
    for (const member of model.members) {
      const displayName = member.displayName?.trim();
      if (displayName) displayNames[member.accountId] = displayName;
    }
    const accountId = model.connection?.accountId;
    if (accountId && accountPreferencesDisplayName && !displayNames[accountId]) {
      displayNames[accountId] = accountPreferencesDisplayName;
    }
    return displayNames;
  }, [accountPreferencesDisplayName, model.connection?.accountId, model.members]);
  const roomExpansion = useNativeRoomExpansion(model.selectedWorkspaceTargetKey);
  const roomParticipantsBridge = useMemo(() => {
    const listWorkspaceRoomMembers = model.bridge?.listWorkspaceRoomMembers;
    if (!listWorkspaceRoomMembers) return undefined;
    return {
      listWorkspaceRoomMembers: (roomId: string, target?: DesktopWorkspaceTarget) => listWorkspaceRoomMembers(roomId, target)
    };
  }, [model.bridge]);
  const roomParticipants = useNativeRoomParticipants({
    room: model.selectedRoom,
    target: currentContextTarget,
    agents: model.agents,
    roomAgentMembers: model.roomAgentMembers,
    bridge: roomParticipantsBridge,
    accountDisplayNames: roomAccountDisplayNames
  });
  const [roomKnowledgeShareAvailability, setRoomKnowledgeShareAvailability] = useState<NativeKnowledgeShareAvailability>("loading");
  const [roomKnowledgeShareSelection, setRoomKnowledgeShareSelection] = useState<NativeRoomKnowledgeShareSelection>();
  useEffect(() => {
    const target = roomToolTarget;
    const method = model.bridge?.listWorkspaceCompletionResources;
    if (!target || !method) {
      setRoomKnowledgeShareAvailability("no_resources");
      setRoomKnowledgeShareSelection(undefined);
      return;
    }
    let active = true;
    setRoomKnowledgeShareAvailability("loading");
    setRoomKnowledgeShareSelection(undefined);
    void method({ scopeKind: "room", roomId: target.roomId, kind: "knowledge", includeArchived: true, target })
      .then((response) => {
        if (!active) return;
        const resources = nativeRoomKnowledgeShareResources(response.resources, target);
        setRoomKnowledgeShareAvailability(resources.length > 0 ? "ready" : "no_resources");
        setRoomKnowledgeShareSelection(resources.length > 0 ? nativeRoomKnowledgeShareSelection(target, model.selectedRoom?.name, resources) : undefined);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRoomKnowledgeShareAvailability(nativeKnowledgeResourcesErrorKind(error) === "permission" ? "permission_denied" : "retrieval_failed");
        setRoomKnowledgeShareSelection(undefined);
      });
    return () => { active = false; };
  }, [model.bridge, model.selectedRoom?.name, roomToolTarget?.connectionId, roomToolTarget?.selectionGeneration, roomToolTarget?.roomId, roomToolTarget?.workspaceId]);
  const roomParentIds = useMemo(() => {
    const roomIds = new Set(model.rooms.map((room) => room.id));
    return new Set(model.rooms.filter((room) => model.rooms.some((child) => child.parentRoomId === room.id && roomIds.has(child.id))).map((room) => room.id));
  }, [model.rooms]);
  const toggleRoomExpanded = useCallback((room: NativeRoom): void => {
    roomExpansion.toggleExpanded(room.id, roomParentIds);
  }, [roomExpansion, roomParentIds]);
  const workspaceSwitcherEntries = useMemo(
    () => nativeWorkspaceSwitcherEntries(model.workspaces),
    [model.workspaces]
  );
  const accountPreferencesStore = useMemo(() => ({
    load: loadNativeAccountPreferences,
    save: saveNativeAccountPreferences
  }), []);
  const accountConnectionId = model.connection?.id ?? model.connectionState.activeConnectionId;
  const accountWorkspaceEntries = useMemo(() => model.workspaces
    .filter((workspace) => {
      if (workspace.access !== "granted") return false;
      const connectionId = workspace.target?.connectionId ?? workspace.connectionId;
      return !accountConnectionId || !connectionId || connectionId === accountConnectionId;
    })
    .map((workspace) => ({
      id: workspace.target?.workspaceId ?? workspace.id,
      label: workspace.name
    }))
    .filter((entry, index, entries) => entries.findIndex((candidate) => candidate.id === entry.id) === index),
  [accountConnectionId, model.workspaces]);
  const accountWorkspaceIds = useMemo(
    () => accountWorkspaceEntries.map((entry) => entry.id),
    [accountWorkspaceEntries]
  );
  const accountWorkspaceLabels = useMemo(
    () => Object.fromEntries(accountWorkspaceEntries.map((entry) => [entry.id, entry.label])),
    [accountWorkspaceEntries]
  );
  const searchWorkspaceContext = useCallback(async (input: WorkspaceContextSearchInput): Promise<WorkspaceContextSearchPage> => {
    const method = model.bridge?.searchWorkspaceContext;
    if (!method || !currentContextTarget) throw new Error("workspace_context_search_unavailable");
    return method({ ...input, target: currentContextTarget });
  }, [currentContextTarget, model.bridge]);
  const listWorkspaceNotifications = useCallback(async (input?: WorkspaceNotificationListInput): Promise<WorkspaceNotificationPage> => {
    const method = model.bridge?.listWorkspaceNotifications;
    if (!method) throw new Error("workspace_notification_list_unavailable");
    return nativeWorkspaceNotificationPageForDisplay(await method({ ...(input ?? {}), ...(currentContextTarget ? { target: currentContextTarget } : {}) }));
  }, [currentContextTarget, model.bridge]);
  const getWorkspaceNotificationSummary = useCallback(async (input?: { target?: DesktopWorkspaceTarget }): Promise<WorkspaceNotificationSummary> => {
    const method = model.bridge?.getWorkspaceNotificationSummary;
    if (!method) throw new Error("workspace_notification_summary_unavailable");
    return method(currentContextTarget ? { target: currentContextTarget } : input);
  }, [currentContextTarget, model.bridge]);
  const markWorkspaceNotificationsRead = useCallback(async (input: {
    notificationIds: string[];
    operationId: string;
    target?: DesktopWorkspaceTarget;
  }): Promise<WorkspaceNotificationMarkReadResult> => {
    const method = model.bridge?.markWorkspaceNotificationsRead;
    if (!method) throw new Error("workspace_notification_read_unavailable");
    return method({ ...input, ...(currentContextTarget ? { target: currentContextTarget } : {}) });
  }, [currentContextTarget, model.bridge]);
  const getAccountWorkspaceNotificationSummaries = useCallback(async (input: AccountWorkspaceNotificationSummariesInput): Promise<AccountWorkspaceNotificationSummaries> => {
    const method = model.bridge?.getAccountWorkspaceNotificationSummaries;
    if (!method) throw new Error("account_workspace_notification_summary_unavailable");
    return method({ ...input, workspaceIds: accountWorkspaceIds, ...(currentContextTarget ? { target: currentContextTarget } : {}) });
  }, [accountWorkspaceIds, currentContextTarget, model.bridge]);
  const listAccountInvitationNotifications = useCallback(async (input?: AccountInvitationNotificationListInput): Promise<WorkspaceNotificationPage> => {
    const method = model.bridge?.listAccountInvitationNotifications;
    if (!method) throw new Error("account_invitation_notification_list_unavailable");
    return nativeWorkspaceNotificationPageForDisplay(await method({ ...(input ?? {}), ...(currentContextTarget ? { target: currentContextTarget } : {}) }));
  }, [currentContextTarget, model.bridge]);
  const markAccountInvitationNotificationsRead = useCallback(async (input: {
    notificationIds: string[];
    operationId: string;
    target?: DesktopWorkspaceTarget;
  }): Promise<WorkspaceNotificationMarkReadResult> => {
    const method = model.bridge?.markAccountInvitationNotificationsRead;
    if (!method) throw new Error("account_invitation_notification_read_unavailable");
    return method({ ...input, ...(currentContextTarget ? { target: currentContextTarget } : {}) });
  }, [currentContextTarget, model.bridge]);

  const openContextSurface = useCallback((surface: "search" | "notifications"): void => {
    contextReturnTriggerRef.current = surface === "search"
      ? contextSearchTriggerRef.current
      : contextNotificationTriggerRef.current;
    contextWasMobileSidebarOpenRef.current = mobileSidebarOpen;
    setProfileMenuOpen(false);
    setMobileSidebarOpen(false);
    setContextSurface(surface);
  }, [mobileSidebarOpen]);

  useEffect(() => {
    if (contextSurface !== "search") return undefined;
    const focusSearchInput = (): void => {
      document.getElementById("native-workspace-context-search-input")?.focus();
    };
    const timer = window.setTimeout(focusSearchInput, 0);
    return () => window.clearTimeout(timer);
  }, [contextSurface]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (!searchApiAvailable) return;
      event.preventDefault();
      openContextSurface("search");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openContextSurface, searchApiAvailable]);
  const closeContextSurface = useCallback((restoreFocus = true): void => {
    const restoreMobileSidebar = contextWasMobileSidebarOpenRef.current;
    setContextSurface(undefined);
    if (restoreMobileSidebar) setMobileSidebarOpen(true);
    if (!restoreFocus) return;
    if (typeof window !== "undefined") {
      window.setTimeout(() => contextReturnTriggerRef.current?.focus(), 0);
    } else {
      contextReturnTriggerRef.current?.focus();
    }
  }, []);

  const openAccountSettings = useCallback((): void => {
    if (!model.connection?.accountId) return;
    accountSettingsReturnContextRef.current = {
      targetKey: model.selectedWorkspaceTargetKey,
      roomId: model.selectedRoomId,
      roomPanelState,
      roomSettingsTab
    };
    setAccountSettingsRestoreError(null);
    accountSettingsWasMobileSidebarOpenRef.current = mobileSidebarOpen;
    setProfileMenuOpen(false);
    setMobileSidebarOpen(false);
    setAccountSettingsOpen(true);
  }, [mobileSidebarOpen, model.connection?.accountId, model.selectedRoomId, model.selectedWorkspaceTargetKey, roomPanelState, roomSettingsTab]);
  const closeAccountSettings = useCallback((): void => {
    const restoreMobileSidebar = accountSettingsWasMobileSidebarOpenRef.current;
    const returnContext = accountSettingsReturnContextRef.current;
    accountSettingsReturnContextRef.current = undefined;
    if (returnContext) accountSettingsPendingRestoreRef.current = returnContext;
    setAccountSettingsOpen(false);
    if (restoreMobileSidebar) setMobileSidebarOpen(true);
    if (typeof window !== "undefined") {
      window.setTimeout(() => document.querySelector<HTMLButtonElement>("[data-native-profile-trigger='true']")?.focus(), 0);
    }
  }, []);

  useEffect(() => {
    const pending = accountSettingsPendingRestoreRef.current;
    if (!pending || accountSettingsOpen) return;
    if (pending.targetKey && model.selectedWorkspaceTargetKey !== pending.targetKey) {
      const entry = workspaceSwitcherEntries.find((candidate) => candidate.key === pending.targetKey);
      if (!entry) {
        accountSettingsPendingRestoreRef.current = undefined;
        accountSettingsRestoreSelectionRequestedRef.current = false;
        setRoomPanelState("closed");
        setAccountSettingsRestoreError("設定を開く前のWorkspaceは、現在の権限では利用できません。安全のためRoomパネルを閉じました。");
        return;
      }
      if (!accountSettingsRestoreSelectionRequestedRef.current) {
        accountSettingsRestoreSelectionRequestedRef.current = true;
        model.selectWorkspace(entry.workspace);
      }
      return;
    }
    accountSettingsRestoreSelectionRequestedRef.current = false;
    if (pending.roomId && (model.roomLoading || !model.selectedWorkspaceTargetKey)) return;
    if (pending.roomId) {
      const room = model.rooms.find((candidate) => candidate.id === pending.roomId && candidate.workspaceId === model.selectedWorkspaceTarget?.workspaceId);
      if (!room) {
        accountSettingsPendingRestoreRef.current = undefined;
        accountSettingsRestoreSelectionRequestedRef.current = false;
        setRoomPanelState("closed");
        setAccountSettingsRestoreError("設定を開く前のRoomは、現在の権限では利用できません。安全のためRoomパネルを閉じました。");
        return;
      }
      if (model.selectedRoomId !== room.id) {
        void model.openRoom(room);
        return;
      }
    }
    accountSettingsPendingRestoreRef.current = undefined;
    setAccountSettingsRestoreError(null);
    setRoomSettingsTab(pending.roomSettingsTab);
    setRoomPanelState(pending.roomPanelState);
  }, [accountSettingsOpen, model.openRoom, model.roomLoading, model.rooms, model.selectedRoomId, model.selectedWorkspaceTarget, model.selectedWorkspaceTargetKey, model.selectWorkspace, workspaceSwitcherEntries]);

  const copyAccountId = useCallback(async (accountId: string): Promise<void> => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) throw new Error("account_id_copy_unavailable");
    await navigator.clipboard.writeText(accountId);
  }, []);

  const connectionReflections = useMemo(() => model.connectionState.connections.map((connection) => {
    if (connection.id === model.connection?.id && model.connectionLoading) {
      return { connectionId: connection.id, state: "pending" as const };
    }
    if (connection.id === model.connection?.id && model.connectionError) {
      return { connectionId: connection.id, state: "failed" as const, error: model.connectionError };
    }
    // There is no renderer-side write for the Server display name. Keep the
    // status explicitly unverified rather than claiming that a local save was
    // reflected remotely.
    return { connectionId: connection.id, state: "unknown" as const };
  }), [model.connection?.id, model.connectionError, model.connectionLoading, model.connectionState.connections]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 700px)");
    const syncViewport = (): void => setMobileViewport(query.matches);
    syncViewport();
    query.addEventListener("change", syncViewport);
    return () => query.removeEventListener("change", syncViewport);
  }, []);

  useEffect(() => {
    if (!mobileViewport) setMobileSidebarOpen(false);
  }, [mobileViewport]);

  const onDraftNavigationControllerChange = useCallback((controller: NativeDraftNavigationController | undefined, isActive?: () => boolean): (() => void) | undefined => {
    if (!controller) return undefined;
    return draftNavigationControllerRegistryRef.current?.register(controller, isActive);
  }, []);

  const onRoomPanelDraftNavigationControllerChange = useCallback((controller: NativeDraftNavigationController | undefined): (() => void) | undefined => {
    return onDraftNavigationControllerChange(controller, () => roomPanelStateRef.current === "room_settings");
  }, [onDraftNavigationControllerChange]);

  const onArtifactPanelDraftNavigationControllerChange = useCallback((controller: NativeDraftNavigationController | undefined): (() => void) | undefined => {
    return onDraftNavigationControllerChange(controller, () => roomPanelStateRef.current === "artifacts");
  }, [onDraftNavigationControllerChange]);

  const requestNativeNavigation = useCallback((target: NativeDraftNavigationTarget): boolean => {
    const controller = draftNavigationControllerRegistryRef.current?.getCurrent();
    if (controller) return controller.requestNavigation(target);
    try {
      void target();
    } catch {
      // Destination-specific navigation errors are handled by the existing model.
    }
    return true;
  }, []);

  const closeArtifactPanel = useCallback((): void => {
    requestNativeNavigation(() => {
      collapseArtifactPanel();
      setRoomPanelState("closed");
      setRoomToolOpen(undefined);
    });
  }, [collapseArtifactPanel, requestNativeNavigation]);
  panelCloseRequestRef.current = closeArtifactPanel;

  const primaryWorkspaceNavigationEntry = useMemo<NativeWorkspaceNavigationEntry | undefined>(() => {
    const workspaceTargetKey = model.selectedWorkspaceTargetKey;
    if (!workspaceTargetKey) return undefined;
    if (agentDirectoryOpen) return { workspaceTargetKey, kind: "agents" };
    if (!model.selectedRoomId) return undefined;
    return { workspaceTargetKey, kind: "room", roomId: model.selectedRoomId };
  }, [agentDirectoryOpen, model.selectedRoomId, model.selectedWorkspaceTargetKey]);

  const restoreWorkspaceNavigation = useCallback((entry: NativeWorkspaceNavigationEntry): void => {
    if (entry.workspaceTargetKey !== model.selectedWorkspaceTargetKey) return;
    workspaceNavigationRestoreRef.current = entry;
    if (entry.kind === "agents") {
      setAgentDirectoryOpen(true);
      return;
    }
    const room = model.rooms.find((candidate) => candidate.id === entry.roomId);
    if (!room) {
      workspaceNavigationRestoreRef.current = undefined;
      return;
    }
    setAgentDirectoryOpen(false);
    void model.openRoom(room);
  }, [model.openRoom, model.rooms, model.selectedWorkspaceTargetKey]);

  const goBackInWorkspace = useCallback((): void => {
    const target = workspaceNavigationHistory.backTarget;
    if (!target) return;
    requestNativeNavigation(() => {
      workspaceNavigationHistory.moveBack();
      restoreWorkspaceNavigation(target);
    });
  }, [requestNativeNavigation, restoreWorkspaceNavigation, workspaceNavigationHistory.backTarget, workspaceNavigationHistory.moveBack]);

  const goForwardInWorkspace = useCallback((): void => {
    const target = workspaceNavigationHistory.forwardTarget;
    if (!target) return;
    requestNativeNavigation(() => {
      workspaceNavigationHistory.moveForward();
      restoreWorkspaceNavigation(target);
    });
  }, [requestNativeNavigation, restoreWorkspaceNavigation, workspaceNavigationHistory.forwardTarget, workspaceNavigationHistory.moveForward]);

  useEffect(() => {
    workspaceNavigationRestoreRef.current = undefined;
    workspaceNavigationHistory.reset();
  }, [model.selectedWorkspaceTargetKey, workspaceNavigationHistory.reset]);

  useEffect(() => {
    const entry = primaryWorkspaceNavigationEntry;
    if (!entry) return;
    const pending = workspaceNavigationRestoreRef.current;
    if (pending) {
      if (pending.workspaceTargetKey === entry.workspaceTargetKey
        && pending.kind === entry.kind
        && pending.roomId === entry.roomId) {
        workspaceNavigationRestoreRef.current = undefined;
      }
      return;
    }
    workspaceNavigationHistory.record(entry);
  }, [primaryWorkspaceNavigationEntry, workspaceNavigationHistory.record]);

  const shareState = useNativeShareState({
    bridge: model.bridge,
    target: model.selectedWorkspaceTarget,
    selectedRoom: model.selectedRoom,
    selectedWorkspace: model.selectedWorkspace,
    workspaces: model.workspaces,
    rooms: model.rooms,
    agents: model.agents,
    agentResources: model.agentResources,
    selectedAgentId: model.agentResourceAgentId,
    members: model.members,
    accountId: model.connection?.accountId,
    authenticated: Boolean(model.connection?.accountId),
    requestNavigation: requestNativeNavigation,
    refreshConnections: model.refreshConnections
  });

  const selectWorkspaceFromSidebar = useCallback((targetKey: string): void => {
    const entry = workspaceSwitcherEntries.find((candidate) => candidate.key === targetKey);
    if (!entry) return;
    requestNativeNavigation(() => {
      model.selectWorkspace(entry.workspace);
      setAgentDirectoryOpen(false);
      workspaceNavigationHistory.reset();
      setWorkspacePopoverOpen(false);
      closeMobileSidebar();
    });
  }, [closeMobileSidebar, model.selectWorkspace, requestNativeNavigation, workspaceNavigationHistory.reset, workspaceSwitcherEntries]);

  useEffect(() => {
    const preventDraftLoss = (event: BeforeUnloadEvent): void => {
      const state = draftNavigationControllerRegistryRef.current?.getCurrent()?.getState();
      if (!state || (!state.dirty && !state.saving && !state.saveError)) return;
     event.preventDefault();
     event.returnValue = "";
   };
    window.addEventListener("beforeunload", preventDraftLoss);
    return () => window.removeEventListener("beforeunload", preventDraftLoss);
  }, []);

 // A Room-scoped panel must never quietly carry its target into a newly
 // selected Room. Drafts live in the Room Work model, so closing this panel
 // does not discard an in-progress instruction or comment.
 useEffect(() => {
   setRoomToolOpen(undefined);
   setRoomPanelState("closed");
   setArtifactPanelExpanded(false);
   setRoomSettingsTab("basic");
   setRoomAdministrationTarget(undefined);
   setRoomAdministrationView("menu");
   setArtifactWorkspaceInitialResource(undefined);
   setArtifactWorkspaceLastResource(undefined);
 }, [model.selectedRoomId, model.selectedWorkspaceTargetKey]);

 // Search terms belong to the selected Workspace. Clear the shared sidebar
 // input when navigation changes its authorized search scope.
 useEffect(() => {
   setSidebarSearchQuery("");
 }, [model.selectedWorkspaceTargetKey]);

  const startCreate = (kind: "organization" | "workspace" | "room", nextRoomCreateMode: NativeRoomCreateMode = "full") => {
    requestNativeNavigation(() => {
      setCreateError(null);
      setRoomCreateMode(kind === "room" ? nextRoomCreateMode : "full");
      setCreateKind(kind);
    });
  };
  const submitCreate = async (value: NativeCreateDialogValue) => {
    if (!createKind) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (createKind === "organization") await model.createOrganization(value);
      else if (createKind === "workspace") await model.createWorkspace({ name: value.name });
      else {
        if (!value.target) throw new Error("workspace_navigation_changed");
        await model.createRoom({
          name: value.name,
          target: value.target,
          operationId: value.operationId ?? createIdempotencyKey(),
          ...(value.defaultAgentId ? { defaultAgentId: value.defaultAgentId } : {}),
          ...(value.defaultAgentVersion === undefined ? {} : { defaultAgentVersion: value.defaultAgentVersion }),
          ...(value.newAgent ? { newAgent: value.newAgent } : {}),
          ...(value.agentPermission ? { agentPermission: value.agentPermission } : {})
        });
      }
      setCreateKind(undefined);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "作成できませんでした。");
      if (createKind === "room") throw error;
    } finally {
      setCreateBusy(false);
    }
  };

  const openManagement = () => {
    requestNativeNavigation(() => {
      setManagementScope("organization");
      model.setManagementOpen(true);
    });
  };
  const openWorkspaceManagement = () => {
    requestNativeNavigation(() => {
      const attachedOrganizationId = model.selectedWorkspace?.organizationId;
      if (attachedOrganizationId && attachedOrganizationId !== model.selectedOrganizationId) {
        model.selectOrganization(attachedOrganizationId);
      }
      setManagementScope("workspace");
      model.setManagementOpen(true);
    });
  };
  const onInspect = (message: NativeChatMessage) => model.openEvidence(message);
  const targetOrganizations = model.organizations.filter((organization) => organization.id !== model.selectedOrganizationId && organization.id !== "__legacy_connection__");
  const selectedOrganization = model.selectedOrganization;
  const accountLabel = model.members.find((member) => member.accountId === model.connection?.accountId)?.displayName?.trim()
    || "本人";
  const selectedWorkspaceConnectionId = model.selectedWorkspace?.target?.connectionId ?? model.selectedWorkspace?.connectionId;
  const organizationForCurrentTarget = selectedOrganization
    && (!selectedWorkspaceConnectionId || !selectedOrganization.connectionId || selectedOrganization.connectionId === selectedWorkspaceConnectionId)
    ? selectedOrganization
    : undefined;
  const managementOrganization = managementScope === "workspace" && model.selectedWorkspace?.organizationId
    ? model.organizations.find((organization) => organization.id === model.selectedWorkspace?.organizationId
      && (!organization.connectionId || !selectedWorkspaceConnectionId || organization.connectionId === selectedWorkspaceConnectionId))
    : managementScope === "workspace"
      ? undefined
      : organizationForCurrentTarget;
  const managedWorkspaces = managementOrganization
    ? model.workspaces.filter((workspace) => workspace.organizationId === managementOrganization.id
      && (!managementOrganization.connectionId || workspace.connectionId === managementOrganization.connectionId))
    : [];
  const standaloneManagementWorkspace = managementScope === "workspace" && !managementOrganization ? model.selectedWorkspace : undefined;
  const attachableWorkspaces = managementOrganization
    ? model.workspaces.filter((workspace) => !workspace.organizationId
      && workspace.access === "granted"
      && (!managementOrganization.connectionId || workspace.connectionId === managementOrganization.connectionId))
    : [];
  const managementTargetOrganizations = standaloneManagementWorkspace
    ? model.organizations.filter((organization) => organization.id !== "__legacy_connection__"
      && (!standaloneManagementWorkspace.connectionId || !organization.connectionId || organization.connectionId === standaloneManagementWorkspace.connectionId))
    : targetOrganizations;
  // A transfer destination is a connection + the source Workspace ID. It may
  // not exist on the destination Server yet; preflight is responsible for
  // checking capacity, schema compatibility, and ID collisions.
  const transferTargets = (() => {
    const rows = [...model.workspaces];
    const keys = new Set(rows.flatMap((workspace) => {
      const target = workspace.target ?? (workspace.connectionId ? { connectionId: workspace.connectionId, workspaceId: workspace.id } : undefined);
      return target ? [`${target.connectionId}\n${target.workspaceId}`] : [];
    }));
    for (const workspace of model.workspaces) {
      const sourceTarget = workspace.target ?? (workspace.connectionId ? { connectionId: workspace.connectionId, workspaceId: workspace.id } : undefined);
      if (!sourceTarget) continue;
      for (const candidate of model.connectionState.connections) {
        if (candidate.id === sourceTarget.connectionId) continue;
        const key = `${candidate.id}\n${sourceTarget.workspaceId}`;
        if (keys.has(key)) continue;
        keys.add(key);
        rows.push({
          id: sourceTarget.workspaceId,
          name: workspace.name,
          state: "active",
          access: "granted",
          target: { connectionId: candidate.id, workspaceId: sourceTarget.workspaceId },
          connectionId: candidate.id,
          serverOrigin: candidate.serverUrl,
          serverLabel: candidate.label,
          accountId: candidate.accountId,
          availability: "unknown"
        });
      }
    }
    return rows;
  })();
  const transferUnavailableReason = model.browserMode
    ? "BrowserではServer間移転に対応していません。Desktopで移転bridgeが利用可能になるまで、移転元を変更せず保持します。"
    : model.workspaceTransferSupported
      ? undefined
      : "このDesktopは移転の事前確認・実行bridgeに対応していません。移転元を変更せず保持してください。";
  const openRoomAdministrationFor = useCallback((room: NativeRoom, view: "menu" | "participants" | "create" | "move" | "rename" = "menu"): void => {
    requestNativeNavigation(() => {
      setRoomAdministrationTarget({ ...room });
      setRoomAdministrationView(view);
      setRoomToolOpen(undefined);
      setArtifactPanelExpanded(false);
      setRoomSettingsTab("basic");
      setRoomPanelState("room_settings");
      closeMobileSidebar();
    });
  }, [closeMobileSidebar, requestNativeNavigation]);
  const openKnowledgeSurface = useCallback((initialTab: "knowledge" | "search" | "settings" | "automation" = "knowledge"): void => {
    requestNativeNavigation(() => {
      setKnowledgeToolsInitialTab(initialTab);
      setRoomAdministrationTarget(undefined);
      setArtifactPanelExpanded(false);
      setRoomPanelState("closed");
      setRoomToolOpen("knowledge");
      closeMobileSidebar();
    });
  }, [closeMobileSidebar, requestNativeNavigation]);
  const openRoomTool = (tool: NativeRoomTool): void => {
    requestNativeNavigation(() => {
      if (tool === "artifacts") {
        setArtifactWorkspaceInitialResource(artifactWorkspaceLastResource);
        setRoomToolOpen(undefined);
        setRoomPanelState("artifacts");
      } else if (tool === "administration") {
        if (model.selectedRoom) openRoomAdministrationFor(model.selectedRoom, "menu");
      } else {
        setArtifactPanelExpanded(false);
        setRoomToolOpen(tool);
      }
      closeMobileSidebar();
    });
  };
  const openRoomSettings = useCallback((tab: "basic" | "participants" | "agent" | "knowledge" | "learning" | "sharing" = "basic"): void => {
    if (!model.selectedRoom) return;
    if (tab === "knowledge") {
      openKnowledgeSurface("knowledge");
      return;
    }
    if (tab === "learning") {
      openKnowledgeSurface("settings");
      return;
    }
    if (tab === "sharing") {
      if (roomKnowledgeShareSelection) void shareState.openRoomShare(roomKnowledgeShareSelection);
      return;
    }
    openRoomAdministrationFor(model.selectedRoom, tab === "participants" || tab === "agent" ? "participants" : "menu");
  }, [model.selectedRoom, openKnowledgeSurface, openRoomAdministrationFor, roomKnowledgeShareSelection, shareState]);
  const toggleRoomPanel = useCallback((): void => {
    requestNativeNavigation(() => {
      if (roomPanelState === "artifacts") {
        collapseArtifactPanel();
        setRoomPanelState("closed");
      } else {
        setArtifactWorkspaceInitialResource(artifactWorkspaceLastResource);
        setRoomPanelState("artifacts");
      }
      setRoomToolOpen(undefined);
    });
  }, [artifactWorkspaceLastResource, collapseArtifactPanel, requestNativeNavigation, roomPanelState]);
  const openResultResource = (resource: NativeArtifactWorkspaceInitialResource): void => {
    requestNativeNavigation(() => {
      const scoped = nativeRoomResultResourceTarget(model.selectedWorkspaceTarget, model.selectedRoom, resource);
      if (!scoped) return;
      setArtifactWorkspaceInitialResource(scoped);
      setArtifactWorkspaceLastResource(scoped);
      setRoomToolOpen(undefined);
      setRoomPanelState("artifacts");
    });
  };
  const openKnowledgeSearchResult = async (result: NativeRoomSearchResult): Promise<void> => {
    if (!roomToolTarget) throw new Error("search_result_target_unavailable");
    requestNativeNavigation(() => {
    if (result.kind === "artifact") {
      const scoped = nativeRoomResultResourceTarget(model.selectedWorkspaceTarget, model.selectedRoom, {
        kind: "artifact",
        id: result.id,
        uri: `artifacts/${result.id}`,
        label: result.title
      });
      if (!scoped) throw new Error("search_result_target_unavailable");
      setArtifactWorkspaceInitialResource(scoped);
      setRoomToolOpen(undefined);
      setRoomPanelState("artifacts");
      return;
    }
    if ((result.kind === "session" || result.kind === "message") && result.work_id) {
      model.setSelectedWorkId(result.work_id);
      setRoomToolOpen(undefined);
      return;
    }
    throw new Error("search_result_work_unavailable");
    });
  };
  const resourceDraftReplyWork = model.replyWorkId
    ? model.works.find((work) => work.id === model.replyWorkId)
    : undefined;
  const resourceDraftWorkId = resourceDraftReplyWork
    && roomWorkCanReceiveReply(resourceDraftReplyWork)
    && roomWorkControlAllowed(model.selectedRoom, resourceDraftReplyWork, model.connection?.accountId)
    ? resourceDraftReplyWork.id
    : undefined;
  const workResourceDraftKey = nativeRoomWorkResourceDraftKey(model.selectedWorkspaceTarget, model.selectedRoom?.id, resourceDraftWorkId);
  const workResourceRefs = workResourceDraftKey ? workResourceDrafts[workResourceDraftKey] ?? [] : [];
  const addWorkResourceRef = (resource: {
    resourceId: string;
    kind: "knowledge" | "skill";
    title: string;
    version: number;
    scopeKind: "workspace" | "room";
    roomId?: string;
  }): void => {
    requestNativeNavigation(() => {
    if (!workResourceDraftKey || !model.selectedRoom || !model.selectedWorkspaceTarget) return;
    if (resource.scopeKind === "room" && resource.roomId !== model.selectedRoom.id) return;
    setWorkResourceDrafts((current) => ({
      ...current,
      [workResourceDraftKey]: appendNativeRoomWorkResourceRef(current[workResourceDraftKey] ?? [], {
        kind: resource.kind,
        id: resource.resourceId,
        version: resource.version,
        label: resource.title
      })
    }));
    setRoomToolOpen(undefined);
    });
  };
  const removeWorkResourceRef = (resource: NativeRoomWorkResourceRefInput): void => {
    if (!workResourceDraftKey) return;
    const key = `${resource.kind}\n${resource.id}\n${resource.version}`;
    setWorkResourceDrafts((current) => {
      const nextRefs = (current[workResourceDraftKey] ?? []).filter((candidate) => `${candidate.kind}\n${candidate.id}\n${candidate.version}` !== key);
      return { ...current, [workResourceDraftKey]: nextRefs };
    });
  };
  const clearWorkResourceRefs = (): void => {
    if (!workResourceDraftKey) return;
    setWorkResourceDrafts((current) => {
      if (!current[workResourceDraftKey]?.length) return current;
      return { ...current, [workResourceDraftKey]: [] };
    });
  };

  // Room panels stay alongside the conversation. The work surface remains
  // mounted so its stream, editor and drafts survive panel navigation.
  const roomAdministrationRoom = roomAdministrationTarget ?? model.selectedRoom;
  const roomAdministrationToolTarget = nativeRoomToolTarget(model.selectedWorkspaceTarget, roomAdministrationRoom);
  const artifactPanelTarget = model.connection
    && !model.managementOpen
    && !agentDirectoryOpen
    ? roomToolTarget
    : undefined;
  const roomSettingsPanelTarget = model.connection
    && !model.managementOpen
    && !agentDirectoryOpen
    ? roomAdministrationToolTarget
    : undefined;
  const artifactPanelOpenTarget = artifactPanelTarget && roomPanelState === "artifacts" ? artifactPanelTarget : undefined;

  const openRoomFromContext = useCallback((roomId: string): void => {
    const normalizedRoomId = roomId.trim();
    if (!normalizedRoomId || !currentContextTarget) return;
    const room = model.rooms.find((candidate) => candidate.id === normalizedRoomId
      && candidate.workspaceId === currentContextTarget.workspaceId);
    // Search and notification projections never become a second authority for
    // navigation. Only a Room already present in the current signed list may
    // be opened from this surface.
    if (!room) return;
    requestNativeNavigation(() => {
      closeContextSurface(false);
      closeMobileSidebar();
      return model.openRoom(room);
    });
  }, [closeContextSurface, closeMobileSidebar, currentContextTarget, model.openRoom, model.rooms, requestNativeNavigation]);
  const notificationApiAvailable = Boolean(
    model.bridge?.listWorkspaceNotifications
      || model.bridge?.listAccountInvitationNotifications
      || model.bridge?.getAccountWorkspaceNotificationSummaries
  );

  const main = !model.connection
    ? model.connectionLoading
      ? <section className="native-main-empty" role="status"><span className="native-loading-orbit" aria-hidden="true" /><h1>接続を確認しています</h1><p>ServerとAccountの状態を確認しています…</p></section>
      : <ConnectionRequired browserMode={model.browserMode} error={model.connectionError} onConnected={model.refreshConnections} onOpenSettings={!model.browserMode ? () => setConnectionSettingsOpen(true) : undefined} />
    : model.managementOpen && (managementOrganization || model.selectedWorkspace)
      ? <OrganizationManagement
        organization={managementOrganization}
        workspaceName={model.selectedWorkspace?.name}
        workspaces={managementOrganization ? managedWorkspaces : model.selectedWorkspace ? [model.selectedWorkspace] : []}
        attachableWorkspaces={attachableWorkspaces}
        members={model.members}
        invitations={model.invitations}
        loading={model.organizationLoading || model.workspaceLoading}
        error={model.managementError}
        onClose={() => model.setManagementOpen(false)}
        onSaveOrganization={model.saveOrganization}
        onInvite={model.inviteMember}
        onChangeMemberRole={model.changeMemberRole}
        onRemoveMember={model.removeMember}
        onRevokeInvitation={model.revokeInvitation}
        onReissueInvitation={model.reissueInvitation}
        onExtendInvitation={model.extendInvitation}
        onAcceptInvitation={model.acceptInvitation}
        onArchiveWorkspace={model.archiveWorkspace}
        onRestoreWorkspace={model.restoreWorkspace}
        onDeleteWorkspace={model.deleteWorkspace}
        onDeleteOrganization={managementOrganization && managementOrganization.id === model.selectedOrganizationId && managementOrganization.role === "owner" ? model.deleteOrganization : undefined}
        onAttachWorkspace={model.attachWorkspace}
        onDetachWorkspace={model.detachWorkspace}
        targetOrganizations={managementTargetOrganizations}
        onPreviewWorkspaceMove={model.previewWorkspaceMove}
        onMoveWorkspace={model.moveWorkspace}
        transferTargets={transferTargets}
        transferUnavailableReason={transferUnavailableReason}
        transferPreflight={model.workspaceTransferPreflight}
        transferStatus={model.workspaceTransferStatus}
        onPreviewWorkspaceTransfer={model.workspaceTransferSupported ? model.preflightWorkspaceTransfer : undefined}
        onExecuteWorkspaceTransfer={model.workspaceTransferSupported ? model.executeWorkspaceTransfer : undefined}
        onRefreshWorkspaceTransfer={model.bridge?.getWorkspaceTransferStatus ? model.refreshWorkspaceTransfer : undefined}
        onCutoverWorkspaceTransfer={model.bridge?.cutoverWorkspaceTarget ? model.cutoverWorkspaceTransfer : undefined}
        onExportWorkspace={model.exportWorkspaceBundle}
        onRestoreBundle={model.restoreWorkspaceBundle}
      />
      : agentDirectoryOpen && model.selectedWorkspace
        ? <AgentDirectoryPanel
          workspaceName={model.selectedWorkspace.name}
          workspaceTargetKey={model.selectedWorkspaceTargetKey}
          room={model.selectedRoom}
          readOnly
          agents={model.agents}
          agentBackends={model.agentBackends}
          agentLoading={model.agentLoading}
          agentError={model.agentError}
          agentResources={model.agentResources}
          agentResourceSelectedId={model.agentResourceSelectedId}
          agentResourceLoading={model.agentResourceLoading}
          agentResourceError={model.agentResourceError}
          agentResourceCanManage={model.agentResourceCanManage}
          roomAgentMembers={model.roomAgentMembers}
          roomAgentMembersLoading={model.roomAgentMembersLoading}
          roomAgentMembersError={model.roomAgentMembersError}
          onClose={() => setAgentDirectoryOpen(false)}
        onDraftNavigationControllerChange={onDraftNavigationControllerChange}
          onViewAgent={model.viewWorkspaceAgent}
          onCreateAgent={model.createWorkspaceAgent}
          onPatchAgent={model.patchWorkspaceAgent}
          onBindBackend={model.bindWorkspaceAgentBackend}
          onSetRoomAgentPermission={model.setRoomAgentPermission}
          onRemoveRoomAgent={model.removeRoomAgent}
          onSetDefaultAgent={model.setRoomDefaultAgent}
          onOpenAgentDm={async (agentId) => {
            await model.openAgentDm(agentId);
            setAgentDirectoryOpen(false);
          }}
          onSelectAgentResources={model.selectAgentResources}
          onSelectAgentResource={model.selectAgentResource}
          onLoadAgentResource={model.loadAgentResource}
          onCreateAgentResource={model.createAgentResource}
          onUpdateAgentResource={model.updateAgentResource}
          onArchiveAgentResource={model.archiveAgentResource}
          onOpenAgentShare={(selection) => {
            if (selection.kind !== "knowledge" && selection.kind !== "skill") return;
            void shareState.openAgentShare(selection);
          }}
        />
      : roomToolOpen === "knowledge" && roomToolTarget
        ? <NativeKnowledgeTools
          target={roomToolTarget}
          workspaceName={model.selectedWorkspace?.name}
          roomName={model.selectedRoom?.name}
          initialTab={knowledgeToolsInitialTab}
          onClose={() => setRoomToolOpen(undefined)}
          onDraftNavigationControllerChange={onDraftNavigationControllerChange}
          onOpenSearchResult={openKnowledgeSearchResult}
          onUseResource={addWorkResourceRef}
          onOpenShare={shareState.openRoomShare}
          bridge={model.bridge}
        />
      : roomToolOpen === "interactions" && roomToolTarget
        ? <NativeInteractionRequests
          roomId={roomToolTarget.roomId}
          target={roomToolTarget}
          bridge={model.bridge}
          onClose={() => setRoomToolOpen(undefined)}
          onDraftNavigationControllerChange={onDraftNavigationControllerChange}
        />
      : roomToolOpen === "collections" && roomToolTarget
        ? <NativeCollectionPanel
          target={roomToolTarget}
          bridge={model.bridge}
          canEdit={model.selectedRoom?.canEdit === true || model.selectedRoom?.capabilities?.canEdit === true}
          canExecute={model.selectedRoom?.canExecute === true || model.selectedRoom?.capabilities?.canExecute === true}
          onClose={() => setRoomToolOpen(undefined)}
          onDraftNavigationControllerChange={onDraftNavigationControllerChange}
        />
      : model.workspaceLoading && !model.selectedWorkspace
        ? <section className="native-main-empty" role="status"><span className="native-loading-orbit" aria-hidden="true" /><h1>Workspaceを確認しています</h1><p>接続済みServerのWorkspaceを確認しています…</p></section>
        : !model.selectedWorkspace
          ? <EmptyMainState kind="workspace" hasWorkspaces={model.workspaces.length > 0} onCreate={() => startCreate("workspace")} />
          : model.selectedWorkspace && !model.roomLoading && model.rooms.length === 0 && !model.roomError
            ? <EmptyMainState kind="room" onCreate={model.selectedWorkspace.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room", "existing-only") : undefined} />
            : model.roomWorkSupported
              ? <RoomWorkSurface
                room={model.selectedRoom}
                workspaceTarget={model.selectedWorkspaceTarget && model.selectedRoom
                  ? { ...model.selectedWorkspaceTarget, roomId: model.selectedRoom.id }
                  : model.selectedWorkspaceTarget}
                currentAccountId={model.connection?.accountId}
                agents={model.agents}
                agentBackends={model.agentBackends}
                roomAgentMembers={model.roomAgentMembers}
                agentLoading={model.agentLoading}
                agentError={model.agentError}
                works={model.works}
                workLoading={model.workLoading}
                workDetailLoading={model.workDetailLoading}
                workError={model.workError}
                workDetailError={model.workDetailError}
                selectedWork={model.selectedWork}
                selectedWorkId={model.selectedWorkId}
                onSelectWork={(workId) => model.setSelectedWorkId(workId)}
                replyWorkId={model.replyWorkId}
                onSetReplyWorkId={model.setReplyWorkId}
                workDraft={model.workDraft}
                onSetWorkDraft={model.setWorkDraft}
                onClearWorkDraft={model.clearWorkDraft}
                workCommentDraft={model.workCommentDraft}
                onSetWorkCommentDraft={model.setWorkCommentDraft}
                onClearWorkCommentDraft={model.clearWorkCommentDraft}
                loading={model.chatLoading}
                sending={model.sending}
                archived={model.selectedWorkspace?.state === "archived"}
                readOnly={model.selectedWorkspace?.state === "read_only"}
                connectionState={model.transportState}
                onSend={model.sendRoomWork}
                workResourceRefs={workResourceRefs}
                onRemoveWorkResourceRef={removeWorkResourceRef}
                onClearWorkResourceRefs={clearWorkResourceRefs}
                onCreateComment={model.createRoomWorkComment}
                onApplyComment={model.applyRoomWorkComment}
                onReactComment={model.likeRoomWorkComment}
                onStopWork={model.stopRoomWork}
                onStopAssignee={model.stopRoomWorkAssignee}
                onReassignAssignee={model.reassignRoomWorkAssignee}
                onDelegateAssignee={model.delegateRoomWorkAssignee}
                onSetDefaultAgent={model.setRoomDefaultAgent}
                onOpenAgentDm={async (agentId) => {
                  await model.openAgentDm(agentId);
                  setAgentDirectoryOpen(false);
                }}
                onOpenAgentSettings={() => requestNativeNavigation(() => setAgentDirectoryOpen(true))}
                participants={roomParticipants.participants}
                participantsLoading={roomParticipants.loading}
                participantsError={roomParticipants.error}
                participantsLoaded={roomParticipants.loaded}
                onOpenRoomParticipants={() => { if (model.selectedRoom) openRoomAdministrationFor(model.selectedRoom, "participants"); }}
                roomParticipantsOpen={roomPanelState === "room_settings" && roomAdministrationView === "participants"}
                onOpenRoomSettings={() => openRoomSettings("basic")}
                onOpenRoomKnowledge={() => openRoomSettings("knowledge")}
                onOpenRoomShare={roomKnowledgeShareSelection ? () => { void shareState.openRoomShare(roomKnowledgeShareSelection); } : undefined}
                roomKnowledgeShareAvailable={roomKnowledgeShareAvailability === "ready"}
                onOpenResultResource={openResultResource}
                onReconnect={model.reconnect}
              />
              : <ChatSurface
                roomName={model.selectedRoom?.name}
                messages={model.messages}
                loading={model.chatLoading}
                sending={model.sending}
                archived={model.selectedWorkspace?.state === "archived"}
                readOnly={model.selectedWorkspace?.state === "read_only"}
                canExecute={Boolean(model.selectedRoom && model.selectedWorkspace?.access === "granted" && model.selectedRoom.canExecute !== false)}
                connectionState={model.transportState}
                error={model.chatError ?? model.roomError}
                onSend={model.sendMessage}
                onStop={model.stopMessage}
                onRetry={model.retryMessage}
                onInspectEvidence={onInspect}
                onReconnect={model.reconnect}
              />;

  return (
    <div className={`native-app-shell${model.evidenceOpen ? " has-evidence" : ""}${artifactPanelTarget ? " has-artifact-panel-toggle" : ""}${artifactPanelOpenTarget ? " has-artifact-panel" : ""}`} data-native-theme={theme} data-theme={theme}>
      <NativeTopChrome
        sidebarOpen={mobileViewport ? mobileSidebarOpen : desktopSidebarOpen}
        macDesktop={macDesktop}
        isFullscreen={nativeFullscreen}
        canGoBack={workspaceNavigationHistory.canGoBack}
        canGoForward={workspaceNavigationHistory.canGoForward}
        onToggleSidebar={() => {
          if (mobileViewport) {
            setMobileSidebarOpen((open) => !open);
          } else {
            setDesktopSidebarOpen((open) => !open);
          }
        }}
        onGoBack={goBackInWorkspace}
        onGoForward={goForwardInWorkspace}
      />
      <div
        className={`native-workspace-shell${!mobileViewport && !desktopSidebarOpen && !sidebarWidth.isResizing ? " is-sidebar-collapsed" : ""}`}
        style={{ "--native-sidebar-width": `${sidebarWidth.width}px` } as CSSProperties}
      >
        <aside className={`native-sidebar${mobileSidebarOpen ? " is-mobile-open" : ""}${!mobileViewport && !desktopSidebarOpen && !sidebarWidth.isResizing ? " is-desktop-collapsed" : ""}`} aria-hidden={(mobileViewport && !mobileSidebarOpen) || (!mobileViewport && !desktopSidebarOpen && !sidebarWidth.isResizing) || accountSettingsOpen || contextSurface !== undefined ? true : undefined} inert={(mobileViewport && !mobileSidebarOpen && !sidebarWidth.isResizing) || (!mobileViewport && !desktopSidebarOpen && !sidebarWidth.isResizing) || accountSettingsOpen || contextSurface !== undefined} aria-label="Workspace navigation">
          {!mobileViewport && (desktopSidebarOpen || sidebarWidth.isResizing) ? <button
            type="button"
            className={`native-sidebar-resize-handle${sidebarWidth.isResizing ? " is-resizing" : ""}`}
            role="separator"
            aria-label="サイドバーの幅を変更"
            aria-orientation="vertical"
            aria-valuemin={220}
            aria-valuemax={420}
            aria-valuenow={sidebarWidth.width}
            tabIndex={0}
            onPointerDown={sidebarWidth.onPointerDown}
            onKeyDown={sidebarWidth.onKeyDown}
            onDoubleClick={sidebarWidth.resetWidth}
          /> : null}
          <div className="native-sidebar-context-tools" aria-label="Workspaceコンテキスト">
            <div className="native-workspace-picker">
              <button
                type="button"
                className="native-sidebar-workspace-trigger"
                aria-label="Workspaceを切り替え"
                aria-expanded={workspacePopoverOpen}
                aria-haspopup="dialog"
                onClick={() => setWorkspacePopoverOpen((open) => !open)}
                disabled={workspaceSwitcherEntries.length === 0 || model.workspaceLoading}
              >
                <span>{model.selectedWorkspace?.name ?? (workspaceSwitcherEntries.length ? "Workspaceを選択" : "Workspaceなし")}</span>
                <SidebarChevronIcon />
              </button>
              {workspacePopoverOpen ? (
                <div className="native-workspace-popover" role="dialog" aria-label="Workspaceを選択">
                  <ul>
                    {workspaceSwitcherEntries.map(({ key, workspace }) => {
                      return <li key={key}>
                        <button type="button" className="native-workspace-popover-row" aria-current={key === model.selectedWorkspaceTargetKey ? "true" : undefined} onClick={() => selectWorkspaceFromSidebar(key)}>
                          <span className="native-workspace-popover-row-main"><strong>{workspace.name}</strong></span>
                        </button>
                      </li>;
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
            {contextSurface !== "search" ? <button
              ref={(element) => {
                contextSearchTriggerRef.current = element;
                if (element) contextReturnTriggerRef.current = element;
              }}
              type="button"
              className="native-sidebar-search"
              aria-label="現在のWorkspaceを検索"
              onClick={() => openContextSurface("search")}
              disabled={!searchApiAvailable}
              title={searchApiAvailable ? "現在のWorkspaceを検索（⌘K / Ctrl+K）" : "Workspace検索は利用できません"}
            >
              <SidebarSearchIcon />
              <span>検索</span>
              <kbd>⌘K</kbd>
            </button> : null}
            <div className="native-sidebar-context-links">
              <button
                ref={contextNotificationTriggerRef}
                type="button"
                className="native-sidebar-quick-button"
                aria-label="Workspace通知を開く"
                onClick={() => openContextSurface("notifications")}
                disabled={!notificationApiAvailable}
                title={notificationApiAvailable ? "Workspace通知を開く" : "通知は利用できません"}
              ><SidebarNotificationIcon /><span>通知</span></button>
            </div>
          </div>
          {model.selectedWorkspace ? <button
            type="button"
            className={`native-sidebar-agent-link${agentDirectoryOpen ? " is-selected" : ""}`}
            aria-current={agentDirectoryOpen ? "page" : undefined}
            onClick={() => { requestNativeNavigation(() => { setAgentDirectoryOpen(true); closeMobileSidebar(); }); }}
            disabled={model.agentLoading}
          ><SidebarAgentIcon /><span>Agents</span></button> : null}
          <RoomNavigator
            rooms={model.rooms}
            selectedRoomId={model.selectedRoomId}
            loading={model.roomLoading}
            disabled={!model.connection || !model.selectedWorkspace}
            archived={model.selectedWorkspace?.state !== "active"}
            error={model.roomError}
            expandedRoomIds={roomExpansion.expandedRoomIds ?? roomParentIds}
            onToggleExpanded={toggleRoomExpanded}
            onSelect={(room) => { requestNativeNavigation(() => { setAgentDirectoryOpen(false); void model.openRoom(room); closeMobileSidebar(); }); }}
            onCreate={model.selectedWorkspace?.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room", "existing-only") : undefined}
          />
          <NativeProfileMenu
            accountLabel={accountLabel}
            open={profileMenuOpen}
            onToggle={() => setProfileMenuOpen((open) => !open)}
            onClose={() => setProfileMenuOpen(false)}
            onOpenSettings={model.connection?.accountId ? openAccountSettings : undefined}
          />
        </aside>
        {!mobileViewport && (!desktopSidebarOpen || sidebarWidth.isResizing) ? <button
          type="button"
          className={`native-sidebar-edge-resize-handle${sidebarWidth.isResizing ? " is-resizing" : ""}`}
          role="separator"
          aria-label="閉じたサイドバーを開く"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={sidebarWidth.onClosedPointerDown}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "ArrowRight") {
              event.preventDefault();
              setDesktopSidebarOpen(true);
            }
          }}
        /> : null}
        <section ref={mainWindowRef} className="native-main-window" aria-label="現在のRoom">
          <main className="native-main">
            {main}
            {shareState.dialog ? <div className="native-main-share-overlay" role="presentation">
              <div className="native-main-share-dialog" onMouseDown={(event) => event.stopPropagation()}>
                {shareState.dialog.loading ? <p className="native-inline-note" role="status">共有情報を確認しています…</p> : null}
                {shareState.dialog.error ? <p className="native-inline-error" role="alert">{shareState.dialog.error}</p> : null}
                <WorkspaceShareDialog
                  source={shareState.dialog.source}
                  resources={shareState.dialog.resources}
                  recipientOptions={shareState.dialog.recipientOptions}
                  draft={shareState.dialog.draft}
                  publishedShares={shareState.dialog.publishedShares}
                  initialStage={shareState.dialog.initialStage}
                  onCreateDraft={shareState.onCreateDraft}
                  onUpdateDraft={shareState.onUpdateDraft}
                  onDiscardDraft={shareState.onDiscardDraft}
                  onPublishDraft={shareState.onPublishDraft}
                  onRevokeShare={shareState.onRevokeShare}
                  onClose={shareState.closeDialog}
                  onPublished={shareState.onPublished}
                />
              </div>
            </div> : null}
            {shareState.import ? <div className="native-main-share-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) shareState.closeImport(); }}>
              <div className="native-main-share-dialog" onMouseDown={(event) => event.stopPropagation()}>
                {shareState.import.loading ? <section className="native-share-loading" role="dialog" aria-modal="true" aria-labelledby="native-share-loading-title"><h2 id="native-share-loading-title">共有内容を確認しています</h2><p role="status">共有元から表示用の固定コピーを取得しています…</p></section> : null}
                {shareState.import.error ? <section className="native-share-error" role="dialog" aria-modal="true" aria-labelledby="native-share-error-title"><h2 id="native-share-error-title">共有内容を表示できません</h2><p role="alert">{shareState.import.error}</p><button type="button" className="native-button" onClick={shareState.closeImport}>閉じる</button></section> : null}
                {shareState.import.view ? <WorkspaceShareImport
                  view={shareState.import.view}
                  source={shareState.import.source}
                  authenticated={shareState.importAuthenticated}
                  authenticating={shareState.importAuthenticating}
                  workspaces={shareState.importWorkspaces}
                  rooms={shareState.importRooms}
                  initialStatus={shareState.import.status}
                  onAuthenticate={shareState.onAuthenticateImport}
                  onStartImport={shareState.onStartImport}
                  onGetStatus={shareState.onGetImportStatus}
                  onClose={shareState.closeImport}
                /> : null}
              </div>
            </div> : null}
            {!shareState.import && shareState.importRouteError ? <div className="native-main-share-overlay" role="presentation">
              <section className="native-share-error" role="dialog" aria-modal="true" aria-labelledby="native-share-route-error-title">
                <h2 id="native-share-route-error-title">共有リンクを開けません</h2>
                <p role="alert">{shareState.importRouteError}</p>
                <button type="button" className="native-button" onClick={shareState.closeImport}>閉じる</button>
              </section>
            </div> : null}
            {contextSurface === "search" && searchApiAvailable ? <div className="native-main-context-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeContextSurface(); }}>
              <div className="native-main-context-dialog" onMouseDown={(event) => event.stopPropagation()}>
                <WorkspaceContextSearch
                  search={searchWorkspaceContext}
                  target={currentContextTarget}
                  workspaceName={model.selectedWorkspace?.name}
                  query={sidebarSearchQuery}
                  onQueryChange={setSidebarSearchQuery}
                  open
                  onClose={closeContextSurface}
                  onOpenRoom={openRoomFromContext}
                />
              </div>
            </div> : null}
            {contextSurface === "notifications" && notificationApiAvailable ? <div className="native-main-context-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeContextSurface(); }}>
              <div className="native-main-context-dialog" onMouseDown={(event) => event.stopPropagation()}>
                <WorkspaceNotificationCenter
                  target={currentContextTarget}
                  workspaceName={model.selectedWorkspace?.name}
                  workspaceIds={accountWorkspaceIds}
                  workspaceLabels={accountWorkspaceLabels}
                  open
                  onClose={closeContextSurface}
                  onOpenRoom={openRoomFromContext}
                  listWorkspaceNotifications={model.bridge?.listWorkspaceNotifications ? listWorkspaceNotifications : undefined}
                  getWorkspaceNotificationSummary={model.bridge?.getWorkspaceNotificationSummary ? getWorkspaceNotificationSummary : undefined}
                  markWorkspaceNotificationsRead={model.bridge?.markWorkspaceNotificationsRead ? markWorkspaceNotificationsRead : undefined}
                  getAccountWorkspaceNotificationSummaries={model.bridge?.getAccountWorkspaceNotificationSummaries ? getAccountWorkspaceNotificationSummaries : undefined}
                  listAccountInvitationNotifications={model.bridge?.listAccountInvitationNotifications ? listAccountInvitationNotifications : undefined}
                  markAccountInvitationNotificationsRead={model.bridge?.markAccountInvitationNotificationsRead ? markAccountInvitationNotificationsRead : undefined}
                />
              </div>
            </div> : null}
          </main>
          {artifactPanelTarget && !artifactPanelOpenTarget ? <div className="native-artifact-panel-toggle-slot">
            <button
              type="button"
              className="native-artifact-panel-toggle-fixed"
              aria-expanded={false}
              aria-label="成果物パネルを開く"
              title="成果物を開く"
              onClick={toggleRoomPanel}
            ><NativePanelToggleIcon className="native-artifact-panel-toggle-icon" dataIcon="artifacts-toggle" mirrored open={false} /></button>
          </div> : null}
          {accountSettingsRestoreError ? <div className="native-main-context-restore-error" role="alert">{accountSettingsRestoreError}</div> : null}
          {accountSettingsOpen && model.connection?.accountId ? <div className="native-main-surface-overlay native-account-settings-overlay">
            <NativeAccountSettings
              accountId={model.connection.accountId}
              registeredDisplayName={accountLabel}
              preferencesStore={accountPreferencesStore}
              theme={theme}
              onThemeChange={changeTheme}
              connections={model.connectionState.connections}
              connectionReflections={connectionReflections}
              connectionsLoading={model.connectionLoading}
              connectionsError={model.connectionError}
              onRetryConnection={() => model.refreshConnections()}
              onManageConnection={() => {
                setAccountSettingsOpen(false);
                setConnectionSettingsOpen(true);
              }}
              onCopyAccountId={copyAccountId}
              onBack={closeAccountSettings}
            />
          </div> : null}
          {roomSettingsPanelTarget && model.selectedWorkspace && roomAdministrationRoom ? <aside className="native-room-panel" aria-label="Roomメニュー" data-panel-mode="split" style={{ width: `${artifactPanelWidth.width}px` }} hidden={roomPanelState !== "room_settings"} inert={roomPanelState !== "room_settings"}>
            <NativeRoomAdministration
              rooms={model.rooms}
              target={roomSettingsPanelTarget}
              workspaceVersion={model.selectedWorkspace.version}
              currentRoom={roomAdministrationRoom}
              workspaceRole={model.selectedWorkspace.role}
              bridge={model.bridge}
              view={roomAdministrationView}
              initialTab={roomSettingsTab}
              onTabChange={setRoomSettingsTab}
              onSelectRoom={roomAdministrationTarget ? undefined : model.openRoom}
              onRefresh={model.refreshWorkspaceContent}
              participants={roomParticipants.participants}
              participantsLoading={roomParticipants.loading}
              participantsError={roomParticipants.error}
              accountDisplayNames={roomAccountDisplayNames}
              onClose={() => { setRoomPanelState("closed"); setRoomAdministrationTarget(undefined); setRoomAdministrationView("menu"); }}
              onOpenShare={() => { if (roomKnowledgeShareSelection) void shareState.openRoomShare(roomKnowledgeShareSelection); }}
              onOpenKnowledge={() => openKnowledgeSurface("knowledge")}
              onOpenLearning={() => openKnowledgeSurface("settings")}
              onOpenSharing={() => { if (roomKnowledgeShareSelection) void shareState.openRoomShare(roomKnowledgeShareSelection); }}
              onDraftNavigationControllerChange={onRoomPanelDraftNavigationControllerChange}
              agentPanel={(
                <div>
                  <h2>Room Agent</h2>
                  <p className="native-room-administration__muted">このRoomで認可済みのAgentだけを表示します。既定Agentは自動変更しません。</p>
                  {model.roomAgentMembersLoading ? <p role="status">Agent membershipを確認しています…</p> : null}
                  {model.roomAgentMembersError ? <p className="native-room-administration__error" role="alert">{model.roomAgentMembersError}</p> : null}
                  {!model.roomAgentMembersLoading && !model.roomAgentMembersError && model.roomAgentMembers.filter((member) => !member.removed).length === 0 ? <p className="native-room-administration__muted">認可済みAgentはありません。</p> : null}
                  <ul className="native-room-administration__member-list" aria-label="RoomのAgent membership">
                    {model.roomAgentMembers.filter((member) => !member.removed).map((member) => {
                      const agent = model.agents.find((candidate) => candidate.id === member.agentId);
                      return <li className="native-room-administration__member-row" key={member.id}><span>{agent?.displayName ?? "Agent"}</span><span>{member.canExecute ? "実行可" : "実行不可"}</span></li>;
                    })}
                  </ul>
                  <button type="button" className="native-room-administration__secondary" onClick={() => { setRoomPanelState("closed"); requestNativeNavigation(() => setAgentDirectoryOpen(true)); }}>Agent詳細を開く</button>
                </div>
              )}
              knowledgePanel={roomAdministrationToolTarget ? (
                <NativeKnowledgeTools
                  target={roomAdministrationToolTarget}
                  workspaceName={model.selectedWorkspace.name}
                  roomName={roomAdministrationRoom.name}
                  initialTab="knowledge"
                  onClose={() => setRoomPanelState("closed")}
                  onDraftNavigationControllerChange={onRoomPanelDraftNavigationControllerChange}
                  onOpenSearchResult={openKnowledgeSearchResult}
                  onUseResource={addWorkResourceRef}
                  onOpenShare={shareState.openRoomShare}
                  bridge={model.bridge}
                />
              ) : undefined}
              learningPanel={roomAdministrationToolTarget ? (
                <NativeKnowledgeTools
                  target={roomAdministrationToolTarget}
                  workspaceName={model.selectedWorkspace.name}
                  roomName={roomAdministrationRoom.name}
                  initialTab="settings"
                  onClose={() => setRoomPanelState("closed")}
                  onDraftNavigationControllerChange={onRoomPanelDraftNavigationControllerChange}
                  bridge={model.bridge}
                />
              ) : undefined}
              sharingPanel={(
                <div>
                  <h2>Room Knowledge共有</h2>
                  <p className="native-room-administration__muted">共有可能なRoom Knowledgeが確認できた場合だけ、Knowledge画面から共有を開始できます。Workspace Knowledgeや未確定資源は対象外です。</p>
                  <button type="button" className="native-room-administration__secondary" onClick={() => setRoomSettingsTab("knowledge")}>Knowledgeを確認</button>
                </div>
              )}
            />
          </aside> : null}
          {artifactPanelTarget ? <aside
            className={`native-artifact-panel${artifactPanelWidth.isResizing ? " is-resizing" : ""}`}
            aria-label="成果物"
            data-panel-mode="split"
            data-expanded={artifactPanelExpanded ? "true" : "false"}
            hidden={roomPanelState !== "artifacts" && !artifactPanelWidth.isResizing}
            inert={roomPanelState !== "artifacts" && !artifactPanelWidth.isResizing}
            style={{ width: `${artifactPanelWidth.width}px` }}
          >
            {(roomPanelState === "artifacts" || artifactPanelWidth.isResizing) && (!artifactPanelExpanded || artifactPanelWidth.isResizing) ? <button
              type="button"
              className="native-artifact-panel-resize-handle"
              role="separator"
              aria-label="成果物パネルの幅を変更"
              aria-orientation="vertical"
              aria-valuemin={artifactPanelWidth.minWidth}
              aria-valuemax={artifactPanelWidth.maxWidth}
              aria-valuenow={artifactPanelWidth.width}
              tabIndex={0}
              onPointerDown={artifactPanelWidth.onPointerDown}
              onKeyDown={artifactPanelWidth.onKeyDown}
              onDoubleClick={artifactPanelWidth.resetWidth}
              title="ドラッグで幅を変更。ダブルクリックで初期幅に戻す"
            ><span aria-hidden="true" /></button> : null}
            <NativeArtifactWorkspace
              target={artifactPanelTarget}
              initialResource={artifactWorkspaceInitialResource}
              canEdit={model.selectedRoom?.canEdit === true || model.selectedRoom?.capabilities?.canEdit === true}
              canExecute={model.selectedRoom?.canExecute === true || model.selectedRoom?.capabilities?.canExecute === true}
              bridge={model.bridge}
              onToggleExpanded={toggleArtifactPanelExpanded}
              isExpanded={artifactPanelExpanded}
              onTogglePanel={toggleRoomPanel}
              panelOpen={roomPanelState === "artifacts"}
              onDraftNavigationControllerChange={onArtifactPanelDraftNavigationControllerChange}
              onResourceSelectionChange={setArtifactWorkspaceLastResource}
              onRequestAgentRevision={async (target) => {
                const sourceWork = target.sourceWorkId ? model.works.find((work) => work.id === target.sourceWorkId) : undefined;
                const replyWorkId = sourceWork && roomWorkCanReceiveReply(sourceWork) && roomWorkControlAllowed(model.selectedRoom, sourceWork, model.connection?.accountId)
                  ? sourceWork.id
                  : undefined;
                model.appendWorkDraft(artifactRevisionRequestDraft(target), replyWorkId);
                collapseArtifactPanel();
                setRoomPanelState("closed");
              }}
            />
          </aside> : null}
          {artifactPanelTarget && !mobileViewport && (roomPanelState === "closed" || artifactPanelExpanded || artifactPanelWidth.isResizing) ? <button
            type="button"
            className={`native-artifact-panel-edge-handle${artifactPanelWidth.isResizing ? " is-resizing" : ""}${artifactPanelExpanded ? " is-expanded" : ""}`}
            role="separator"
            aria-label={artifactPanelExpanded ? "成果物パネルを分割表示に戻す" : "閉じた成果物パネルを開く"}
            aria-orientation="vertical"
            tabIndex={0}
            onPointerDown={artifactPanelExpanded ? artifactPanelWidth.onExpandedPointerDown : artifactPanelWidth.onClosedPointerDown}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              if (artifactPanelExpanded) collapseArtifactPanel();
              else setRoomPanelState("artifacts");
            }}
            onDoubleClick={() => { if (artifactPanelExpanded) collapseArtifactPanel(); else artifactPanelWidth.resetWidth(); }}
          /> : null}
        </section>
      </div>
      {mobileSidebarOpen ? <button type="button" className="native-mobile-nav-backdrop" aria-label="ナビゲーションを閉じる" onClick={closeMobileSidebar} /> : null}
      {model.evidenceOpen ? <EvidenceInspector message={model.evidenceMessage} evidence={model.evidence} onClose={() => model.setEvidenceOpen(false)} /> : null}
      {createKind ? <CreateDialog
        kind={createKind}
        onClose={() => setCreateKind(undefined)}
        onSubmit={submitCreate}
        busy={createBusy}
        error={createError}
        agents={model.agents}
        agentBackends={model.agentBackends}
        agentLoading={model.agentLoading}
        agentBackendLoading={model.agentBackendLoading}
        agentError={model.agentError}
        agentBackendError={model.agentBackendError}
        workspaceTarget={model.selectedWorkspaceTarget}
        roomCreateMode={roomCreateMode}
      /> : null}
      {connectionSettingsOpen && !model.browserMode ? <WorkspaceConnectionSettings
        connections={model.connectionState.connections}
        activeConnectionId={model.connectionState.activeConnectionId}
        loading={model.connectionLoading}
        error={model.connectionError}
        onClose={() => setConnectionSettingsOpen(false)}
        onDraftNavigationControllerChange={onDraftNavigationControllerChange}
        onSave={model.saveWorkspaceConnection}
        onSelect={model.selectWorkspaceConnection}
        onImportIdentity={model.importActiveWorkspaceIdentity}
        onRegisterAccount={model.registerWorkspaceServerAccount}
      /> : null}
    </div>
  );
}

export default NativeApp;
