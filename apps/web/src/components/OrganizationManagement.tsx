import { useMemo, useState, type FormEvent } from "react";
import type {
  NativeOrganization,
  NativeOrganizationInvitation,
  NativeOrganizationMember,
  NativeWorkspace,
  NativeWorkspaceBundleExport,
  NativeWorkspaceBundleRestoreResult,
  NativeWorkspaceMovePreview,
  OrganizationRole
} from "../native-app/types";

export interface OrganizationManagementProps {
  organization: NativeOrganization;
  workspaces: NativeWorkspace[];
  members: NativeOrganizationMember[];
  invitations: NativeOrganizationInvitation[];
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onSaveOrganization: (input: { name: string; description?: string }) => void | Promise<void>;
  onInvite: (input: { accountId?: string; role: OrganizationRole; workspaceGrants?: Array<{ workspaceId: string; role: OrganizationRole }>; expiresAt?: string }) => Promise<{ token?: string }>;
  onChangeMemberRole: (accountId: string, role: OrganizationRole) => void | Promise<void>;
  onRemoveMember: (accountId: string) => void | Promise<void>;
  onRevokeInvitation: (invitationId: string) => void | Promise<void>;
  onReissueInvitation: (invitationId: string) => Promise<{ token?: string }>;
  onExtendInvitation: (invitationId: string, expiresAt: string) => void | Promise<void>;
  onAcceptInvitation: (token: string) => void | Promise<void>;
  onArchiveWorkspace: (workspace: NativeWorkspace) => void | Promise<void>;
  onRestoreWorkspace: (workspace: NativeWorkspace) => void | Promise<void>;
  onDeleteWorkspace: (workspace: NativeWorkspace) => void | Promise<void>;
  onDeleteOrganization?: () => void | Promise<void>;
  targetOrganizations?: NativeOrganization[];
  onPreviewWorkspaceMove?: (workspace: NativeWorkspace, targetOrganizationId: string) => Promise<NativeWorkspaceMovePreview>;
  onMoveWorkspace?: (workspace: NativeWorkspace, targetOrganizationId: string, preview: NativeWorkspaceMovePreview) => void | Promise<void>;
  onExportWorkspace: (workspace: NativeWorkspace) => Promise<NativeWorkspaceBundleExport>;
  onRestoreBundle: (targetOrganizationId: string, bundleId: string) => Promise<NativeWorkspaceBundleRestoreResult>;
}

const roles: OrganizationRole[] = ["owner", "admin", "member", "guest"];

function invitationStateLabel(invitation: NativeOrganizationInvitation): string {
  if (invitation.state === "pending") return "保留中";
  if (invitation.state === "accepted") return "受諾済み";
  if (invitation.state === "expired") return "期限切れ";
  return "取り消し済み";
}

export function OrganizationManagement({
  organization,
  workspaces,
  members,
  invitations,
  loading = false,
  error,
  onClose,
  onSaveOrganization,
  onInvite,
  onChangeMemberRole,
  onRemoveMember,
  onRevokeInvitation,
  onReissueInvitation,
  onExtendInvitation,
  onAcceptInvitation,
  onArchiveWorkspace,
  onRestoreWorkspace,
  onDeleteWorkspace,
  onDeleteOrganization,
  targetOrganizations = [],
  onPreviewWorkspaceMove,
  onMoveWorkspace,
  onExportWorkspace,
  onRestoreBundle
}: OrganizationManagementProps) {
  const [name, setName] = useState(organization.name);
  const [description, setDescription] = useState(organization.description ?? "");
  const [inviteMode, setInviteMode] = useState<"account" | "token">("account");
  const [accountId, setAccountId] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const [inviteExpiry, setInviteExpiry] = useState("");
  const [workspaceGrants, setWorkspaceGrants] = useState<Record<string, OrganizationRole | "">>({});
  const [inviteToken, setInviteToken] = useState<string | undefined>();
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [acceptToken, setAcceptToken] = useState("");
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [invitationExpiry, setInvitationExpiry] = useState<Record<string, string>>({});
  const [invitationAction, setInvitationAction] = useState<string>();
  const [moveTarget, setMoveTarget] = useState<Record<string, string>>({});
  const [movePreview, setMovePreview] = useState<Record<string, NativeWorkspaceMovePreview | undefined>>({});
  const [moveBusyWorkspaceId, setMoveBusyWorkspaceId] = useState<string>();
  const [moveError, setMoveError] = useState<string | null>(null);
  const [exportedBundles, setExportedBundles] = useState<Record<string, NativeWorkspaceBundleExport>>({});
  const [restoreBundleId, setRestoreBundleId] = useState("");
  const [restoreTargetOrganizationId, setRestoreTargetOrganizationId] = useState(organization.id);
  const [bundleBusy, setBundleBusy] = useState<string>();
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<NativeWorkspaceBundleRestoreResult>();
  const canManage = organization.role === "owner" || organization.role === "admin";
  const isOwner = organization.role === "owner";
  const activeOwners = useMemo(() => members.filter((member) => member.state === "active" && member.role === "owner").length, [members]);
  const restoreOrganizations = useMemo(() => {
    const byId = new Map<string, NativeOrganization>();
    [organization, ...targetOrganizations].forEach((item) => {
      if (item.id && item.id !== "__legacy_connection__") byId.set(item.id, item);
    });
    return [...byId.values()];
  }, [organization, targetOrganizations]);
  const organizationName = (organizationId: string | undefined): string => {
    if (!organizationId) return "Serverで検証";
    return restoreOrganizations.find((item) => item.id === organizationId)?.name ?? organizationId;
  };
  const formatBundleSize = (byteSize: number | undefined): string => {
    if (byteSize === undefined) return "サイズ未取得";
    if (byteSize < 1024) return `${byteSize} B`;
    if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} KB`;
    return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) return;
    void onSaveOrganization({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
  };
  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inviteMode === "account" && !accountId.trim()) return;
    setInviteError(null);
    try {
      const grants = Object.entries(workspaceGrants)
        .filter((entry): entry is [string, OrganizationRole] => Boolean(entry[1]))
        .map(([workspaceId, grantRole]) => ({ workspaceId, role: grantRole }));
      const result = await onInvite({
        ...(inviteMode === "account" && accountId.trim() ? { accountId: accountId.trim() } : {}),
        role,
        ...(grants.length ? { workspaceGrants: grants } : {}),
        ...(inviteExpiry ? { expiresAt: new Date(inviteExpiry).toISOString() } : {})
      });
      setInviteToken(result.token);
      setAccountId("");
      setInviteExpiry("");
      setWorkspaceGrants({});
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "招待を作成できませんでした。");
    }
  };
  const accept = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = acceptToken.trim();
    if (!token) return;
    setAcceptError(null);
    setInvitationAction("accept");
    try {
      await onAcceptInvitation(token);
      setAcceptToken("");
    } catch (cause) {
      setAcceptError(cause instanceof Error ? cause.message : "招待を受諾できませんでした。");
    } finally {
      setInvitationAction(undefined);
    }
  };
  const reissue = async (invitationId: string): Promise<void> => {
    setInviteError(null);
    setInvitationAction(`reissue:${invitationId}`);
    try {
      const result = await onReissueInvitation(invitationId);
      setInviteToken(result.token);
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "招待を再発行できませんでした。");
    } finally {
      setInvitationAction(undefined);
    }
  };
  const extend = async (invitationId: string): Promise<void> => {
    const value = invitationExpiry[invitationId];
    if (!value) return;
    setInviteError(null);
    setInvitationAction(`extend:${invitationId}`);
    try {
      await onExtendInvitation(invitationId, new Date(value).toISOString());
      setInvitationExpiry((current) => ({ ...current, [invitationId]: "" }));
    } catch (cause) {
      setInviteError(cause instanceof Error ? cause.message : "招待の期限を延長できませんでした。");
    } finally {
      setInvitationAction(undefined);
    }
  };
  const previewMove = async (workspace: NativeWorkspace): Promise<void> => {
    const targetOrganizationId = moveTarget[workspace.id];
    if (!targetOrganizationId || !onPreviewWorkspaceMove) return;
    setMoveError(null);
    setMoveBusyWorkspaceId(workspace.id);
    try {
      const preview = await onPreviewWorkspaceMove(workspace, targetOrganizationId);
      setMovePreview((current) => ({ ...current, [workspace.id]: preview }));
    } catch (cause) {
      setMovePreview((current) => ({ ...current, [workspace.id]: undefined }));
      setMoveError(cause instanceof Error ? cause.message : "Workspace移動の事前確認に失敗しました。");
    } finally {
      setMoveBusyWorkspaceId(undefined);
    }
  };
  const commitMove = async (workspace: NativeWorkspace): Promise<void> => {
    const targetOrganizationId = moveTarget[workspace.id];
    const preview = movePreview[workspace.id];
    if (!targetOrganizationId || !preview || !onMoveWorkspace || preview.targetOrganizationId !== targetOrganizationId || preview.writeBlocked) return;
    if (preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now()) {
      setMoveError("移動の事前確認が期限切れです。もう一度Previewしてください。");
      setMovePreview((current) => ({ ...current, [workspace.id]: undefined }));
      return;
    }
    const guestCount = preview.missingMembers.filter((member) => member.willAddAsGuest).length;
    const prompt = guestCount > 0
      ? `${workspace.name}を移動し、${guestCount}人を移動先OrganizationのGuestとして追加します。続けますか？`
      : `${workspace.name}を移動します。続けますか？`;
    if (!window.confirm(prompt)) return;
    setMoveError(null);
    setMoveBusyWorkspaceId(workspace.id);
    try {
      await onMoveWorkspace(workspace, targetOrganizationId, preview);
      setMovePreview((current) => ({ ...current, [workspace.id]: undefined }));
      setMoveTarget((current) => ({ ...current, [workspace.id]: "" }));
    } catch (cause) {
      setMoveError(cause instanceof Error ? cause.message : "Workspaceを移動できませんでした。");
    } finally {
      setMoveBusyWorkspaceId(undefined);
    }
  };
  const exportWorkspace = async (workspace: NativeWorkspace): Promise<void> => {
    if (!canManage) return;
    setBundleError(null);
    setRestoreResult(undefined);
    setBundleBusy(`export:${workspace.id}`);
    try {
      const result = await onExportWorkspace(workspace);
      if (!result.bundleId) throw new Error("bundle_export_missing_id");
      setExportedBundles((current) => ({ ...current, [result.bundleId]: result }));
      setRestoreBundleId(result.bundleId);
    } catch (cause) {
      setBundleError(cause instanceof Error ? cause.message : "WorkspaceをExportできませんでした。");
    } finally {
      setBundleBusy(undefined);
    }
  };
  const restoreBundle = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const bundleId = restoreBundleId.trim();
    const targetOrganizationId = restoreTargetOrganizationId.trim();
    if (!canManage || !bundleId || !targetOrganizationId) return;
    const bundle = exportedBundles[bundleId];
    const targetName = organizationName(targetOrganizationId);
    const sourceName = organizationName(bundle?.sourceOrganizationId);
    const workspaceName = bundle
      ? workspaces.find((workspace) => workspace.id === bundle.workspaceId)?.name ?? bundle.workspaceId
      : "Bundle内のWorkspace";
    const sourceDescription = bundle
      ? `Source: ${sourceName} / ${workspaceName}`
      : "Source: Bundle metadataをServerで検証";
    if (!window.confirm(`${sourceDescription}\nTarget: ${targetName}\nこのBundleを復元しますか？`)) return;
    setBundleError(null);
    setRestoreResult(undefined);
    setBundleBusy("restore");
    try {
      const result = await onRestoreBundle(targetOrganizationId, bundleId);
      setRestoreResult(result);
      if (result.status === "failed") {
        setBundleError(result.failureCode ?? "workspace_bundle_restore_failed");
      } else {
        setRestoreBundleId("");
      }
    } catch (cause) {
      setBundleError(cause instanceof Error ? cause.message : "Workspace Bundleを復元できませんでした。");
    } finally {
      setBundleBusy(undefined);
    }
  };

  return (
    <section className="native-management" aria-labelledby="native-management-heading">
      <header className="native-management-header">
        <div><div className="native-section-eyebrow">Organization settings</div><h1 id="native-management-heading">{organization.name}</h1></div>
        <button type="button" className="native-icon-button" onClick={onClose} aria-label="管理画面を閉じる">×</button>
      </header>
      {error ? <div className="native-banner native-banner-error" role="alert">{error}</div> : null}
      <div className="native-management-scroll">
        <section className="native-management-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Profile</span><h2>Organization情報</h2></div><span className="native-role-chip">{organization.role}</span></div>
          <form onSubmit={save} className="native-form-grid">
            <label><span>名前</span><input value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={160} required disabled={!canManage || loading} /></label>
            <label><span>説明（任意）</span><textarea value={description} onChange={(event) => setDescription(event.currentTarget.value)} maxLength={1000} rows={3} disabled={!canManage || loading} /></label>
            {canManage ? <button className="native-button native-button-primary" type="submit" disabled={loading || !name.trim()}>変更を保存</button> : <p className="native-muted-note">Member / Guest はOrganization情報を変更できません。</p>}
          </form>
        </section>

        <section className="native-management-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">People</span><h2>Members</h2></div><span className="native-muted-note">{members.length}人</span></div>
          {members.length === 0 ? <p className="native-empty-copy">Member情報はまだありません。</p> : <ul className="native-member-list">
            {members.map((member) => {
              const lastOwner = member.role === "owner" && activeOwners <= 1;
              return <li key={member.id || member.accountId}>
                <span className="native-member-avatar" aria-hidden="true">{(member.displayName ?? member.accountId).slice(0, 1).toUpperCase()}</span>
                <span className="native-member-copy"><strong>{member.displayName || member.accountId}</strong><small>{member.accountId}</small></span>
                <label className="native-visually-hidden" htmlFor={`member-role-${member.accountId}`}>Member role</label>
                <select id={`member-role-${member.accountId}`} value={member.role} disabled={!canManage || loading || lastOwner} onChange={(event) => void onChangeMemberRole(member.accountId, event.currentTarget.value as OrganizationRole)}>{roles.map((item) => <option key={item} value={item}>{item}</option>)}</select>
                <button type="button" className="native-text-button is-danger" disabled={!canManage || loading || lastOwner} onClick={() => { if (window.confirm(lastOwner ? "最後のOwnerは削除できません。" : `${member.accountId} をOrganizationから削除しますか？`)) void onRemoveMember(member.accountId); }}>{lastOwner ? "最後のOwner" : "削除"}</button>
              </li>;
            })}
          </ul>}
          {activeOwners <= 1 ? <p className="native-muted-note">最後のOwnerは降格・削除できません。</p> : null}
        </section>

        <section className="native-management-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Invite</span><h2>Memberを招待</h2></div></div>
          {canManage ? <form onSubmit={invite} className="native-invite-form">
            <label><span>招待方法</span><select value={inviteMode} onChange={(event) => setInviteMode(event.currentTarget.value as "account" | "token")}><option value="account">既存Accountへ直接招待</option><option value="token">ワンタイムtokenを発行</option></select></label>
            {inviteMode === "account" ? <label><span>Account ID</span><input value={accountId} onChange={(event) => setAccountId(event.currentTarget.value)} placeholder="account_..." autoComplete="off" required /></label> : <div className="native-muted-note">受け手のAccountを指定せず、リンクやQRに渡せるtokenを発行します。</div>}
            <label><span>Organization role</span><select value={role} onChange={(event) => setRole(event.currentTarget.value as OrganizationRole)}>{roles.filter((item) => isOwner || item !== "owner").map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <label><span>期限（任意）</span><input type="datetime-local" value={inviteExpiry} min={new Date().toISOString().slice(0, 16)} onChange={(event) => setInviteExpiry(event.currentTarget.value)} /></label>
            <div className="native-invite-grants"><span className="native-form-label">Workspace grant（任意）</span>{workspaces.length ? workspaces.map((workspace) => <label key={workspace.id} className="native-grant-row"><input type="checkbox" checked={Boolean(workspaceGrants[workspace.id])} onChange={(event) => setWorkspaceGrants((current) => ({ ...current, [workspace.id]: event.currentTarget.checked ? "member" : "" }))} /><span>{workspace.name}</span>{workspaceGrants[workspace.id] ? <select aria-label={`${workspace.name}のWorkspace role`} value={workspaceGrants[workspace.id]} onChange={(event) => setWorkspaceGrants((current) => ({ ...current, [workspace.id]: event.currentTarget.value as OrganizationRole }))}>{roles.filter((item) => item !== "owner" && item !== "admin").map((item) => <option key={item} value={item}>{item}</option>)}</select> : null}</label>) : <p className="native-muted-note">Grant可能なWorkspaceはありません。</p>}</div>
            <button className="native-button native-button-primary" type="submit" disabled={loading || (inviteMode === "account" && !accountId.trim())}>招待を作成</button>
          </form> : <p className="native-muted-note">Owner / AdminだけがMemberを招待できます。</p>}
          {inviteError ? <p className="native-inline-error" role="alert">{inviteError}</p> : null}
          {inviteToken ? <div className="native-token-reveal" role="dialog" aria-labelledby="native-token-heading"><h3 id="native-token-heading">招待token（今回だけ表示）</h3><code>{inviteToken}</code><p>この画面を閉じるとtokenは再表示できません。必要なら新しい招待を発行してください。</p><button type="button" className="native-button" onClick={() => setInviteToken(undefined)}>閉じる</button></div> : null}
          {invitations.length ? <ul className="native-invitation-list">{invitations.map((invitation) => <li key={invitation.id}><span><strong>{invitation.recipientAccountId ?? "ワンタイム招待"}</strong><small>{invitation.role} · {invitationStateLabel(invitation)} · {new Date(invitation.expiresAt).toLocaleDateString("ja-JP")}</small></span>{canManage && invitation.state === "pending" ? <button type="button" className="native-text-button is-danger" disabled={loading || Boolean(invitationAction)} onClick={() => void onRevokeInvitation(invitation.id)}>取り消す</button> : null}{canManage && invitation.state !== "accepted" ? <><button type="button" className="native-text-button" disabled={loading || Boolean(invitationAction)} onClick={() => void reissue(invitation.id)}>再発行</button><label className="native-visually-hidden" htmlFor={`invitation-expiry-${invitation.id}`}>招待期限を延長</label><input id={`invitation-expiry-${invitation.id}`} type="datetime-local" value={invitationExpiry[invitation.id] ?? ""} min={new Date().toISOString().slice(0, 16)} onChange={(event) => setInvitationExpiry((current) => ({ ...current, [invitation.id]: event.currentTarget.value }))} /><button type="button" className="native-text-button" disabled={loading || !invitationExpiry[invitation.id] || Boolean(invitationAction)} onClick={() => void extend(invitation.id)}>期限延長</button></> : null}</li>)}</ul> : null}
          <form className="native-accept-form" onSubmit={accept}>
            <label><span>受け取った招待token</span><input value={acceptToken} onChange={(event) => setAcceptToken(event.currentTarget.value)} placeholder="tokenを貼り付け" autoComplete="off" /></label>
            <button type="submit" className="native-button" disabled={loading || !acceptToken.trim() || Boolean(invitationAction)}>招待を受諾</button>
          </form>
          {acceptError ? <p className="native-inline-error" role="alert">{acceptError}</p> : null}
        </section>

        <section className="native-management-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Access</span><h2>Workspaces</h2></div></div>
          <ul className="native-managed-workspace-list">
            {workspaces.map((workspace) => {
              const preview = movePreview[workspace.id];
              const moveAvailable = Boolean(onPreviewWorkspaceMove && onMoveWorkspace && isOwner && targetOrganizations.length);
              return <li key={workspace.id}>
                <span className="native-workspace-copy"><strong>{workspace.name}</strong><small>{workspace.access === "none" ? "アクセス権限がありません" : workspace.state === "archived" ? "アーカイブ済み · read-only" : "利用可能"}</small></span>
                <span className="native-management-actions">
                  {canManage ? <button type="button" className="native-text-button" disabled={loading || Boolean(bundleBusy)} onClick={() => void exportWorkspace(workspace)}>{bundleBusy === `export:${workspace.id}` ? "Export中…" : "Export"}</button> : null}
                  {canManage && workspace.state === "archived" ? <button type="button" className="native-text-button" disabled={loading} onClick={() => void onRestoreWorkspace(workspace)}>復元</button> : null}
                  {canManage && workspace.state !== "archived" ? <button type="button" className="native-text-button" disabled={loading} onClick={() => void onArchiveWorkspace(workspace)}>Archive</button> : null}
                  {canManage ? <button type="button" className="native-text-button is-danger" disabled={loading} onClick={() => { if (window.confirm(`${workspace.name} を削除しますか？この操作は戻せません。`)) void onDeleteWorkspace(workspace); }}>削除</button> : null}
                  {moveAvailable ? <>
                    <label className="native-visually-hidden" htmlFor={`move-${workspace.id}`}>移動先Organization</label>
                    <select id={`move-${workspace.id}`} value={moveTarget[workspace.id] ?? ""} disabled={loading || moveBusyWorkspaceId === workspace.id} onChange={(event) => { setMoveTarget((current) => ({ ...current, [workspace.id]: event.currentTarget.value })); setMovePreview((current) => ({ ...current, [workspace.id]: undefined })); }}>
                      <option value="">移動先…</option>
                      {targetOrganizations.filter((target) => target.id !== organization.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                    </select>
                    {!preview ? <button type="button" className="native-text-button" disabled={loading || !moveTarget[workspace.id] || moveBusyWorkspaceId === workspace.id} onClick={() => void previewMove(workspace)}>{moveBusyWorkspaceId === workspace.id ? "確認中…" : "Preview"}</button> : <button type="button" className="native-text-button" disabled={loading || moveBusyWorkspaceId === workspace.id || preview.writeBlocked} onClick={() => void commitMove(workspace)}>{moveBusyWorkspaceId === workspace.id ? "移動中…" : "移動"}</button>}
                  </> : null}
                </span>
                {preview ? <div className={`native-move-preview${preview.writeBlocked ? " is-blocked" : ""}`} role="status">
                  <strong>{preview.writeBlocked ? "移動できません" : "移動Preview"}</strong>
                  <span>既存Member {preview.existingMembers.length}人 · Guest追加 {preview.missingMembers.filter((member) => member.willAddAsGuest).length}人</span>
                  {preview.requiresGuestConfirmation ? <small>Guest追加の確認が必要です。</small> : null}
                  {preview.failureConditions.length ? <ul>{preview.failureConditions.map((condition) => <li key={condition}>{condition}</li>)}</ul> : null}
                </div> : null}
              </li>;
            })}
          </ul>
          {moveError ? <p className="native-inline-error" role="alert">{moveError}</p> : null}
          {workspaces.length ? <p className="native-muted-note">Organization削除前に、すべてのWorkspaceを移動または削除してください。</p> : null}
        </section>

        <section className="native-management-card native-bundle-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Portability</span><h2>Workspace Bundle</h2></div><span className="native-muted-note">Server検証付き</span></div>
          <p className="native-muted-note">ExportはWorkspaceのBundle metadataを取得します。復元時は毎回Serverが権限・integrity・target Organizationを再確認します。</p>
          {Object.values(exportedBundles).length ? <ul className="native-bundle-list">
            {Object.values(exportedBundles).map((bundle) => <li key={bundle.bundleId} className="native-bundle-item">
              <div><strong>{bundle.bundleId}</strong><small>Source: {organizationName(bundle.sourceOrganizationId)} · Workspace: {bundle.workspaceId}</small></div>
              <span>{bundle.fileCount === undefined ? "ファイル数未取得" : `${bundle.fileCount} files`} · {formatBundleSize(bundle.byteSize)}{bundle.integrityHash ? ` · ${bundle.integrityHash}` : ""}</span>
            </li>)}
          </ul> : <p className="native-empty-copy">Export済みBundleはこの画面にまだありません。</p>}
          {canManage ? <form className="native-restore-form" onSubmit={restoreBundle}>
            <label><span>Bundle ID</span><input value={restoreBundleId} onChange={(event) => { setRestoreBundleId(event.currentTarget.value); setBundleError(null); setRestoreResult(undefined); }} placeholder="bundle_..." autoComplete="off" required /></label>
            <label><span>Target Organization</span><select value={restoreTargetOrganizationId} onChange={(event) => { setRestoreTargetOrganizationId(event.currentTarget.value); setRestoreResult(undefined); }} disabled={bundleBusy === "restore"}>{restoreOrganizations.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.role}</option>)}</select></label>
            <p className="native-bundle-route">{exportedBundles[restoreBundleId.trim()] ? `Source: ${organizationName(exportedBundles[restoreBundleId.trim()]?.sourceOrganizationId)} → Target: ${organizationName(restoreTargetOrganizationId)}` : `Source: Bundle metadataをServerで検証 → Target: ${organizationName(restoreTargetOrganizationId)}`}</p>
            <button type="submit" className="native-button native-button-primary" disabled={loading || bundleBusy === "restore" || !restoreBundleId.trim() || !restoreTargetOrganizationId}>{bundleBusy === "restore" ? "復元中…" : "Bundleを復元"}</button>
          </form> : <p className="native-muted-note">Owner / AdminだけがWorkspace BundleをExport・復元できます。</p>}
          {bundleError ? <p className="native-inline-error" role="alert">Bundle操作に失敗しました: {bundleError}</p> : null}
          {restoreResult && restoreResult.status === "restored" ? <p className="native-bundle-success" role="status">復元完了: Source {organizationName(restoreResult.sourceOrganizationId)} → Target {organizationName(restoreResult.targetOrganizationId)} / Workspace {restoreResult.workspaceId}</p> : null}
        </section>

        {onDeleteOrganization && isOwner ? <section className="native-management-card native-danger-card"><div className="native-card-heading"><div><span className="native-section-eyebrow">Danger zone</span><h2>Organizationを削除</h2></div></div><p>Workspaceが残っている間は削除できません。削除後は自動再作成されません。</p><button type="button" className="native-button native-button-danger" disabled={loading || workspaces.length > 0} onClick={() => { if (window.confirm(`${organization.name}を削除しますか？`)) void onDeleteOrganization(); }}>Organizationを削除</button></section> : null}
      </div>
    </section>
  );
}

export default OrganizationManagement;
