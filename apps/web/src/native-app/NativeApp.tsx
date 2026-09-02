import { useState, type FormEvent } from "react";
import OrganizationSwitcher from "../components/OrganizationSwitcher";
import WorkspaceNavigator from "../components/WorkspaceNavigator";
import RoomNavigator from "../components/RoomNavigator";
import ChatSurface from "../components/ChatSurface";
import OrganizationManagement from "../components/OrganizationManagement";
import EvidenceInspector from "../components/EvidenceInspector";
import ConnectionRequired from "../components/ConnectionRequired";
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

function EmptyMainState({ kind, onCreate }: { kind: "organization" | "workspace" | "room"; onCreate?: () => void }) {
  if (kind === "organization") return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">A QUIET START</span><h1 id="native-empty-heading">最初のOrganizationを作成しましょう</h1><p>OrganizationはMemberとWorkspaceを管理する単位です。作成後、必要な人だけを招待できます。</p>{onCreate ? <button type="button" className="native-button native-button-primary" onClick={onCreate}>Organizationを作成</button> : null}</section>;
  if (kind === "workspace") return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">NO ACCESS YET</span><h1 id="native-empty-heading">利用できるWorkspaceがありません</h1><p>Organizationには参加していますが、Workspaceへのアクセス権限が付与されていません。管理者にWorkspace / Room grantを依頼してください。</p></section>;
  return <section className="native-main-empty" aria-labelledby="native-empty-heading"><span className="native-placeholder-kicker">ONE ROOM AT A TIME</span><h1 id="native-empty-heading">Roomを選ぶと会話を始められます</h1><p>このWorkspaceにはまだRoomがありません。Roomを作成するか、管理者にアクセスを依頼してください。</p>{onCreate ? <button type="button" className="native-button native-button-primary" onClick={onCreate}>Roomを作成</button> : null}</section>;
}

export function NativeApp() {
  const model = useNativeApp();
  const [createKind, setCreateKind] = useState<"organization" | "workspace" | "room">();
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  const openManagement = () => model.setManagementOpen(true);
  const onInspect = (message: NativeChatMessage) => model.openEvidence(message);
  const targetOrganizations = model.organizations.filter((organization) => organization.id !== model.selectedOrganizationId && organization.id !== "__legacy_connection__");

  const main = !model.connection
    ? model.connectionLoading
      ? <section className="native-main-empty" role="status"><span className="native-loading-orbit" aria-hidden="true" /><h1>接続を確認しています</h1><p>ServerとAccountの状態を確認しています…</p></section>
      : <ConnectionRequired browserMode={model.browserMode} error={model.connectionError} onConnected={model.refreshConnections} />
    : model.managementOpen && model.selectedOrganization
      ? <OrganizationManagement
        organization={model.selectedOrganization}
        workspaces={model.workspaces}
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
        onDeleteOrganization={model.selectedOrganization.role === "owner" ? model.deleteOrganization : undefined}
        targetOrganizations={targetOrganizations}
        onPreviewWorkspaceMove={model.previewWorkspaceMove}
        onMoveWorkspace={model.moveWorkspace}
        onExportWorkspace={model.exportWorkspaceBundle}
        onRestoreBundle={model.restoreOrganizationBundle}
      />
      : model.organizations.length === 0
        ? <EmptyMainState kind="organization" onCreate={() => startCreate("organization")} />
        : model.workspaces.length > 0 && !model.workspaces.some((workspace) => workspace.access === "granted")
          ? <EmptyMainState kind="workspace" />
          : model.selectedWorkspace && !model.roomLoading && model.rooms.length === 0
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
        <OrganizationSwitcher organizations={model.organizations} selectedOrganizationId={model.selectedOrganizationId} loading={model.organizationLoading} disabled={!model.connection} error={model.organizationError} onSelect={model.selectOrganization} onCreate={() => startCreate("organization")} onManage={openManagement} />
        <WorkspaceNavigator workspaces={model.workspaces} selectedWorkspaceId={model.selectedWorkspaceId} organizationRole={model.selectedOrganization?.role} loading={model.workspaceLoading} disabled={!model.connection || !model.organizationApiAvailable} error={model.workspaceError} onSelect={model.selectWorkspace} onCreate={() => startCreate("workspace")} />
        <RoomNavigator rooms={model.rooms} selectedRoomId={model.selectedRoomId} loading={model.roomLoading} disabled={!model.connection || !model.selectedWorkspace} archived={model.selectedWorkspace?.state !== "active"} error={model.roomError} onSelect={model.openRoom} onCreate={model.selectedWorkspace?.access === "granted" && model.selectedWorkspace.state === "active" ? () => startCreate("room") : undefined} />
        <footer className="native-sidebar-footer"><span className={`native-connection-pip is-${model.transportState}`} aria-hidden="true" /><span>{model.connection ? model.connection.label : "未接続"}</span>{model.connection ? <button type="button" className="native-text-button" onClick={() => void model.reconnect()}>再確認</button> : null}</footer>
      </aside>
      <main className="native-main">{main}</main>
      {model.evidenceOpen ? <EvidenceInspector message={model.evidenceMessage} evidence={model.evidence} onClose={() => model.setEvidenceOpen(false)} /> : null}
      {createKind ? <CreateDialog kind={createKind} onClose={() => setCreateKind(undefined)} onSubmit={submitCreate} busy={createBusy} error={createError} /> : null}
    </div>
  );
}

export default NativeApp;
