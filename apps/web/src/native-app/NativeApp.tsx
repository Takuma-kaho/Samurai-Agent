import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import RoomNavigator from "../components/RoomNavigator";
import ChatSurface from "../components/ChatSurface";
import RoomWorkSurface, { roomWorkCanReceiveReply, roomWorkControlAllowed } from "./RoomWorkSurface";
import { NativeInteractionRequests } from "./NativeInteractionRequests";
import NativeKnowledgeTools from "./NativeKnowledgeTools";
import NativeRoomAdministration from "./NativeRoomAdministration";
import NativeArtifactWorkspace, { nativeArtifactWorkspaceInitialResourceFromUnknown } from "./NativeArtifactWorkspace";
import NativeCollectionPanel from "./NativeCollectionPanel";
import NativeProfileMenu from "./NativeProfileMenu";
import type { ArtifactRevisionTarget } from "./ArtifactSurfacePanel";
import OrganizationManagement from "../components/OrganizationManagement";
import EvidenceInspector from "../components/EvidenceInspector";
import ConnectionRequired from "../components/ConnectionRequired";
import WorkspaceConnectionSettings from "../components/WorkspaceConnectionSettings";
import { createIdempotencyKey } from "../lib/api";
import { readNativeThemePreference, writeNativeThemePreference, type NativeTheme } from "../lib/native-app-theme-preferences";
import { nativeRoomAgentIsAvailable, nativeRoomCreateErrorIsExplicitServerFailure, useNativeApp } from "./use-native-app";
import { type NativeDraftNavigationController, type NativeDraftNavigationTarget } from "./use-native-draft-navigation";
import type { NativeRoomSearchResult } from "./use-native-knowledge-tools";
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
};

export interface NativeDraftNavigationControllerRegistry {
  register: (controller: NativeDraftNavigationController) => () => void;
  getCurrent: () => NativeDraftNavigationController | undefined;
}

/** Keeps cleanup scoped to the registration instance, including stacked overlays. */
export function createNativeDraftNavigationControllerRegistry(): NativeDraftNavigationControllerRegistry {
  const registrations: NativeDraftNavigationControllerRegistration[] = [];
  return {
    register: (controller) => {
      const registration: NativeDraftNavigationControllerRegistration = { controller };
      registrations.push(registration);
      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        const index = registrations.indexOf(registration);
        if (index >= 0) registrations.splice(index, 1);
      };
    },
    getCurrent: () => registrations[registrations.length - 1]?.controller
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
  onClose,
  onViewAgent,
  onOpenAgentDm
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
  }, [directoryScopeKey]);

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
        </section> : null}
      </div>
    </section>
  );
}

export function NativeApp() {
  const model = useNativeApp();
  const [theme, setTheme] = useState<NativeTheme>(() => readNativeThemePreference());
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(max-width: 700px)").matches === true);
  const [createKind, setCreateKind] = useState<"organization" | "workspace" | "room">();
  const [roomCreateMode, setRoomCreateMode] = useState<NativeRoomCreateMode>("full");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [managementScope, setManagementScope] = useState<"organization" | "workspace">("organization");
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);
  const [agentDirectoryOpen, setAgentDirectoryOpen] = useState(false);
 const [roomToolOpen, setRoomToolOpen] = useState<NativeRoomTool>();
 const [artifactWorkspaceInitialResource, setArtifactWorkspaceInitialResource] = useState<NativeArtifactWorkspaceInitialResource>();
 const [workResourceDrafts, setWorkResourceDrafts] = useState<Record<string, NativeRoomWorkResourceRefInput[]>>({});
  const draftNavigationControllerRegistryRef = useRef<NativeDraftNavigationControllerRegistry | undefined>(undefined);
  if (!draftNavigationControllerRegistryRef.current) {
    draftNavigationControllerRegistryRef.current = createNativeDraftNavigationControllerRegistry();
  }

  const roomToolTarget = nativeRoomToolTarget(model.selectedWorkspaceTarget, model.selectedRoom);

  const changeTheme = useCallback((nextTheme: NativeTheme): void => {
    // Keep the UI responsive even when localStorage is disabled or full. The
    // preference module normalizes the value and absorbs storage failures.
    setTheme(writeNativeThemePreference(nextTheme));
  }, []);

  const closeMobileSidebar = useCallback((): void => {
    setMobileSidebarOpen(false);
  }, []);

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

  const onDraftNavigationControllerChange = useCallback((controller: NativeDraftNavigationController | undefined): (() => void) | undefined => {
    if (!controller) return undefined;
    return draftNavigationControllerRegistryRef.current?.register(controller);
  }, []);

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

  const selectWorkspaceFromProfile = useCallback((workspace: NativeWorkspace): void => {
    requestNativeNavigation(() => {
      model.selectWorkspace(workspace);
      closeMobileSidebar();
    });
  }, [closeMobileSidebar, model.selectWorkspace, requestNativeNavigation]);

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
   setArtifactWorkspaceInitialResource(undefined);
 }, [model.selectedRoomId, model.selectedWorkspaceTargetKey]);

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
  const openRoomTool = (tool: NativeRoomTool): void => {
    requestNativeNavigation(() => {
      setArtifactWorkspaceInitialResource(undefined);
      setRoomToolOpen(tool);
      closeMobileSidebar();
    });
  };
  const openResultResource = (resource: NativeArtifactWorkspaceInitialResource): void => {
    requestNativeNavigation(() => {
      const scoped = nativeRoomResultResourceTarget(model.selectedWorkspaceTarget, model.selectedRoom, resource);
      if (!scoped) return;
      setArtifactWorkspaceInitialResource(scoped);
      setRoomToolOpen("artifacts");
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
      setRoomToolOpen("artifacts");
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

  // The artifact surface is the only Room tool that stays alongside the
  // conversation. Other Room tools continue to replace the main surface so
  // the existing workbench navigation and draft lifecycle remain unchanged.
  const artifactPanelTarget = model.connection
    && !model.managementOpen
    && !agentDirectoryOpen
    && roomToolOpen === "artifacts"
    ? roomToolTarget
    : undefined;

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
          onOpenAgentDm={model.openAgentDm}
        />
      : roomToolOpen === "knowledge" && roomToolTarget
        ? <NativeKnowledgeTools
          target={roomToolTarget}
          workspaceName={model.selectedWorkspace?.name}
          roomName={model.selectedRoom?.name}
          onClose={() => setRoomToolOpen(undefined)}
          onDraftNavigationControllerChange={onDraftNavigationControllerChange}
          onOpenSearchResult={openKnowledgeSearchResult}
          onUseResource={addWorkResourceRef}
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
      : roomToolOpen === "administration" && model.selectedWorkspace && model.selectedRoom && model.selectedWorkspaceTarget
        ? <NativeRoomAdministration
          rooms={model.rooms}
          target={model.selectedWorkspaceTarget}
          workspaceVersion={model.selectedWorkspace.version}
          currentRoom={model.selectedRoom}
          workspaceRole={model.selectedWorkspace.role}
          bridge={model.bridge}
         onSelectRoom={model.openRoom}
         onRefresh={model.refreshWorkspaceContent}
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
                onOpenAgentDm={model.openAgentDm}
                onOpenAgentSettings={() => requestNativeNavigation(() => setAgentDirectoryOpen(true))}
                roomToolLinks={<NativeRoomToolLinks target={roomToolTarget} onOpen={openRoomTool} />}
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
    <div className={`native-app-shell${model.evidenceOpen ? " has-evidence" : ""}${artifactPanelTarget ? " has-artifact-panel" : ""}`} data-native-theme={theme} data-theme={theme}>
      <div className="native-workspace-shell">
        <aside className={`native-sidebar${mobileSidebarOpen ? " is-mobile-open" : ""}`} aria-hidden={mobileViewport && !mobileSidebarOpen ? true : undefined} inert={mobileViewport && !mobileSidebarOpen} aria-label="Samurai navigation">
          <div className="native-brand"><span className="native-brand-mark" aria-hidden="true">S</span><div><strong>samurai</strong></div></div>
          {model.selectedWorkspace ? <button type="button" className="native-sidebar-agent-link" onClick={() => { requestNativeNavigation(() => { setAgentDirectoryOpen(true); closeMobileSidebar(); }); }} disabled={model.agentLoading}>✦<span>Agent</span></button> : null}
          <RoomNavigator rooms={model.rooms} selectedRoomId={model.selectedRoomId} loading={model.roomLoading} disabled={!model.connection || !model.selectedWorkspace} archived={model.selectedWorkspace?.state !== "active"} error={model.roomError} onSelect={(roomId) => { requestNativeNavigation(() => { model.openRoom(roomId); closeMobileSidebar(); }); }} onCreate={model.selectedWorkspace?.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room", "existing-only") : undefined} />
          <NativeProfileMenu
            accountLabel={accountLabel}
            open={profileMenuOpen}
            theme={theme}
            workspaces={model.workspaces}
            selectedWorkspaceTargetKey={model.selectedWorkspaceTargetKey}
            onToggle={() => setProfileMenuOpen((open) => !open)}
            onClose={() => setProfileMenuOpen(false)}
            onThemeChange={changeTheme}
            onSelectWorkspace={selectWorkspaceFromProfile}
          />
        </aside>
        <section className="native-main-window" aria-label="現在のRoom">
          <main className="native-main">{main}</main>
          {artifactPanelTarget ? <aside className="native-artifact-panel" aria-label="成果物">
            <NativeArtifactWorkspace
              target={artifactPanelTarget}
              initialResource={artifactWorkspaceInitialResource}
              canEdit={model.selectedRoom?.canEdit === true || model.selectedRoom?.capabilities?.canEdit === true}
              canExecute={model.selectedRoom?.canExecute === true || model.selectedRoom?.capabilities?.canExecute === true}
              bridge={model.bridge}
              onClose={() => { setArtifactWorkspaceInitialResource(undefined); setRoomToolOpen(undefined); }}
              onDraftNavigationControllerChange={onDraftNavigationControllerChange}
              onRequestAgentRevision={async (target) => {
                const sourceWork = target.sourceWorkId ? model.works.find((work) => work.id === target.sourceWorkId) : undefined;
                const replyWorkId = sourceWork && roomWorkCanReceiveReply(sourceWork) && roomWorkControlAllowed(model.selectedRoom, sourceWork, model.connection?.accountId)
                  ? sourceWork.id
                  : undefined;
                model.appendWorkDraft(artifactRevisionRequestDraft(target), replyWorkId);
                setRoomToolOpen(undefined);
              }}
            />
          </aside> : null}
        </section>
      </div>
      {mobileSidebarOpen ? <button type="button" className="native-mobile-nav-backdrop" aria-label="ナビゲーションを閉じる" onClick={closeMobileSidebar} /> : null}
      <button type="button" className="native-mobile-nav-toggle" aria-label="ナビゲーションを開く" aria-expanded={mobileSidebarOpen} onClick={() => setMobileSidebarOpen((open) => !open)}>☰</button>
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
