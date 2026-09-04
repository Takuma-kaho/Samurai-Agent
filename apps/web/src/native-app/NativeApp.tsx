import { useState, type FormEvent } from "react";
import OrganizationSwitcher from "../components/OrganizationSwitcher";
import WorkspaceNavigator from "../components/WorkspaceNavigator";
import RoomNavigator from "../components/RoomNavigator";
import ChatSurface from "../components/ChatSurface";
import OrganizationManagement from "../components/OrganizationManagement";
import EvidenceInspector from "../components/EvidenceInspector";
import ConnectionRequired from "../components/ConnectionRequired";
import WorkspaceConnectionSettings from "../components/WorkspaceConnectionSettings";
import { useNativeApp } from "./use-native-app";
import type { NativeChatMessage } from "./types";

function CreateDialog({
  kind,
  onClose,
  onSubmit,
  busy,
  error
}: {
  kind: "organization" | "workspace" | "room";
  onClose: () => void;
  onSubmit: (value: { name: string; description?: string }) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const title = kind === "organization" ? "Organizationを作成" : kind === "workspace" ? "Workspaceを作成" : "Roomを作成";
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    void onSubmit({ name: name.trim(), ...(kind === "organization" && description.trim() ? { description: description.trim() } : {}) });
  };
  return (
    <div className="native-dialog-backdrop" role="presentation">
      <section className="native-dialog" role="dialog" aria-modal="true" aria-labelledby="native-create-dialog-title">
        <div className="native-card-heading"><div><span className="native-section-eyebrow">New space</span><h2 id="native-create-dialog-title">{title}</h2></div><button className="native-icon-button" type="button" onClick={onClose} aria-label="閉じる">×</button></div>
        <form onSubmit={submit} className="native-form-grid">
          <label><span>名前</span><input autoFocus value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={160} required /></label>
          {kind === "organization" ? <label><span>説明（任意）</span><textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} rows={3} maxLength={1000} /></label> : null}
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

export function NativeApp() {
  const model = useNativeApp();
  const [createKind, setCreateKind] = useState<"organization" | "workspace" | "room">();
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [managementScope, setManagementScope] = useState<"organization" | "workspace">("organization");
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);

  const startCreate = (kind: "organization" | "workspace" | "room") => {
    setCreateError(null);
    setCreateKind(kind);
  };
  const submitCreate = async (value: { name: string; description?: string }) => {
    if (!createKind) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      if (createKind === "organization") await model.createOrganization(value);
      else if (createKind === "workspace") await model.createWorkspace({ name: value.name });
      else await model.createRoom(value.name);
      setCreateKind(undefined);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "作成できませんでした。");
    } finally {
      setCreateBusy(false);
    }
  };

  const openManagement = () => {
    setManagementScope("organization");
    model.setManagementOpen(true);
  };
  const openWorkspaceManagement = () => {
    const attachedOrganizationId = model.selectedWorkspace?.organizationId;
    if (attachedOrganizationId && attachedOrganizationId !== model.selectedOrganizationId) {
      model.selectOrganization(attachedOrganizationId);
    }
    setManagementScope("workspace");
    model.setManagementOpen(true);
  };
  const onInspect = (message: NativeChatMessage) => model.openEvidence(message);
  const targetOrganizations = model.organizations.filter((organization) => organization.id !== model.selectedOrganizationId && organization.id !== "__legacy_connection__");
  const selectedOrganization = model.selectedOrganization;
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
      : model.workspaceLoading && !model.selectedWorkspace
        ? <section className="native-main-empty" role="status"><span className="native-loading-orbit" aria-hidden="true" /><h1>Workspaceを確認しています</h1><p>接続済みServerのWorkspaceを確認しています…</p></section>
        : !model.selectedWorkspace
          ? <EmptyMainState kind="workspace" hasWorkspaces={model.workspaces.length > 0} onCreate={() => startCreate("workspace")} />
          : model.selectedWorkspace && !model.roomLoading && model.rooms.length === 0 && !model.roomError
            ? <EmptyMainState kind="room" onCreate={model.selectedWorkspace.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room") : undefined} />
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
    <div className={`native-app-shell${model.evidenceOpen ? " has-evidence" : ""}`}>
      <aside className="native-sidebar" aria-label="Samurai navigation">
        <div className="native-brand"><span className="native-brand-mark" aria-hidden="true">S</span><div><strong>Samurai</strong><small>WORKSPACE</small></div></div>
        <WorkspaceNavigator workspaces={model.workspaces} selectedWorkspaceId={model.selectedWorkspaceId} selectedWorkspaceTargetKey={model.selectedWorkspaceTargetKey} organizationRole={model.selectedOrganization?.role} canCreate={Boolean(model.connection)} loading={model.workspaceLoading} disabled={!model.connection} error={model.workspaceError} directoryErrors={model.workspaceDirectoryErrors} onSelect={model.selectWorkspace} onCreate={() => startCreate("workspace")} onManage={openWorkspaceManagement} />
        <RoomNavigator rooms={model.rooms} selectedRoomId={model.selectedRoomId} loading={model.roomLoading} disabled={!model.connection || !model.selectedWorkspace} archived={model.selectedWorkspace?.state !== "active"} error={model.roomError} onSelect={model.openRoom} onCreate={model.selectedWorkspace?.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room") : undefined} />
        <OrganizationSwitcher organizations={model.organizations} selectedOrganizationId={model.selectedOrganizationId} loading={model.organizationLoading} disabled={!model.connection} error={model.organizationError} onSelect={model.selectOrganization} onCreate={() => startCreate("organization")} onManage={openManagement} />
        <footer className="native-sidebar-footer"><span className={`native-connection-pip is-${model.transportState}`} aria-hidden="true" /><span>{model.connection ? model.connection.label : "未接続"}</span>{model.connection ? <button type="button" className="native-text-button" onClick={() => void model.reconnect()}>再確認</button> : null}{!model.browserMode ? <button type="button" className="native-text-button" onClick={() => setConnectionSettingsOpen(true)}>接続設定</button> : null}</footer>
      </aside>
      <main className="native-main">{main}</main>
      {model.evidenceOpen ? <EvidenceInspector message={model.evidenceMessage} evidence={model.evidence} onClose={() => model.setEvidenceOpen(false)} /> : null}
      {createKind ? <CreateDialog kind={createKind} onClose={() => setCreateKind(undefined)} onSubmit={submitCreate} busy={createBusy} error={createError} /> : null}
      {connectionSettingsOpen && !model.browserMode ? <WorkspaceConnectionSettings
        connections={model.connectionState.connections}
        activeConnectionId={model.connectionState.activeConnectionId}
        loading={model.connectionLoading}
        error={model.connectionError}
        onClose={() => setConnectionSettingsOpen(false)}
        onSave={model.saveWorkspaceConnection}
        onSelect={model.selectWorkspaceConnection}
        onImportIdentity={model.importActiveWorkspaceIdentity}
        onRegisterAccount={model.registerWorkspaceServerAccount}
      /> : null}
    </div>
  );
}

export default NativeApp;
