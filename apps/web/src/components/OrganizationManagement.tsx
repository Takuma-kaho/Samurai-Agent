import { useMemo, useState, type FormEvent } from "react";
import type {
  NativeOrganization,
  NativeOrganizationInvitation,
  NativeOrganizationMember,
  NativeWorkspace,
  NativeWorkspaceBundleExport,
  NativeWorkspaceBundleRestoreResult,
  NativeWorkspaceMovePreview,
  NativeWorkspaceTransferPreflight,
  NativeWorkspaceTransferStatus,
  OrganizationRole
} from "../native-app/types";

export interface OrganizationManagementProps {
  /** Omit for the standalone Workspace management surface. */
  organization?: NativeOrganization;
  workspaceName?: string;
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
  /** Standalone association is explicit and separate from Bundle restore. */
  attachableWorkspaces?: NativeWorkspace[];
  onAttachWorkspace?: (workspace: NativeWorkspace, organizationId: string) => void | Promise<void>;
  onDetachWorkspace?: (workspace: NativeWorkspace) => void | Promise<void>;
  onDeleteOrganization?: () => void | Promise<void>;
  targetOrganizations?: NativeOrganization[];
  onPreviewWorkspaceMove?: (workspace: NativeWorkspace, targetOrganizationId: string) => Promise<NativeWorkspaceMovePreview>;
  onMoveWorkspace?: (workspace: NativeWorkspace, targetOrganizationId: string, preview: NativeWorkspaceMovePreview) => void | Promise<void>;
  /** Server-to-Server transfer is available only when the Desktop bridge has the full lifecycle. */
  transferTargets?: NativeWorkspace[];
  transferUnavailableReason?: string;
  transferPreflight?: NativeWorkspaceTransferPreflight;
  transferStatus?: NativeWorkspaceTransferStatus;
  onPreviewWorkspaceTransfer?: (workspace: NativeWorkspace, destination: NativeWorkspace) => Promise<NativeWorkspaceTransferPreflight>;
  onExecuteWorkspaceTransfer?: (workspace: NativeWorkspace, destination: NativeWorkspace, preflight: NativeWorkspaceTransferPreflight) => Promise<NativeWorkspaceTransferStatus>;
  onRefreshWorkspaceTransfer?: (workspace: NativeWorkspace, destination: NativeWorkspace, status: NativeWorkspaceTransferStatus) => Promise<NativeWorkspaceTransferStatus>;
  onCutoverWorkspaceTransfer?: (workspace: NativeWorkspace, destination: NativeWorkspace, status: NativeWorkspaceTransferStatus) => void | Promise<void>;
  onExportWorkspace: (workspace: NativeWorkspace) => Promise<NativeWorkspaceBundleExport>;
  /** Generic Bundle restore is always standalone; attach is a separate action. */
  onRestoreBundle: (bundleId: string) => Promise<NativeWorkspaceBundleRestoreResult>;
}

const roles: OrganizationRole[] = ["owner", "admin", "member", "guest"];

function workspaceTarget(workspace: NativeWorkspace): { connectionId: string; workspaceId: string } | undefined {
  if (workspace.target?.connectionId && workspace.target.workspaceId) return workspace.target;
  if (workspace.connectionId && workspace.id) return { connectionId: workspace.connectionId, workspaceId: workspace.id };
  return undefined;
}

function targetKey(target: { connectionId: string; workspaceId: string }): string {
  return `${target.connectionId}\n${target.workspaceId}`;
}

function workspaceTargetKey(workspace: NativeWorkspace): string {
  const target = workspaceTarget(workspace);
  return target ? targetKey(target) : workspace.id;
}

function transferStateLabel(state: NativeWorkspaceTransferStatus["state"]): string {
  if (state === "preflight") return "事前確認";
  if (state === "exported") return "Export済み";
  if (state === "restoring") return "移転先へ復元中";
  if (state === "verified") return "検証完了・切替待ち";
  if (state === "cutover") return "接続先を切替済み";
  if (state === "source_archived") return "移転元をArchive済み";
  return "失敗";
}

function invitationStateLabel(invitation: NativeOrganizationInvitation): string {
  if (invitation.state === "pending") return "保留中";
  if (invitation.state === "accepted") return "受諾済み";
  if (invitation.state === "expired") return "期限切れ";
  return "取り消し済み";
}

export function OrganizationManagement({
  organization,
  workspaceName,
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
  attachableWorkspaces = [],
  onAttachWorkspace,
  onDetachWorkspace,
  onDeleteOrganization,
  targetOrganizations = [],
  onPreviewWorkspaceMove,
  onMoveWorkspace,
  transferTargets = [],
  transferUnavailableReason,
  transferPreflight: currentTransferPreflight,
  transferStatus: currentTransferStatus,
  onPreviewWorkspaceTransfer,
  onExecuteWorkspaceTransfer,
  onRefreshWorkspaceTransfer,
  onCutoverWorkspaceTransfer,
  onExportWorkspace,
  onRestoreBundle
}: OrganizationManagementProps) {
  const [name, setName] = useState(organization?.name ?? workspaceName ?? "Workspace");
  const [description, setDescription] = useState(organization?.description ?? "");
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
  const [attachTarget, setAttachTarget] = useState<Record<string, string>>({});
  const [associationBusy, setAssociationBusy] = useState<string>();
  const [associationError, setAssociationError] = useState<string | null>(null);
  const [transferDestination, setTransferDestination] = useState<Record<string, string>>({});
  const [transferPreview, setTransferPreview] = useState<Record<string, NativeWorkspaceTransferPreflight | undefined>>({});
  const [transferStatus, setTransferStatus] = useState<Record<string, NativeWorkspaceTransferStatus | undefined>>({});
  const [transferBusy, setTransferBusy] = useState<string>();
  const [transferError, setTransferError] = useState<string | null>(null);
  const [exportedBundles, setExportedBundles] = useState<Record<string, NativeWorkspaceBundleExport>>({});
  const [restoreBundleId, setRestoreBundleId] = useState("");
  const [bundleBusy, setBundleBusy] = useState<string>();
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<NativeWorkspaceBundleRestoreResult>();
  const canManage = organization
    ? organization.role === "owner" || organization.role === "admin"
    : workspaces.some((workspace) => workspace.access === "granted" && (workspace.role === undefined || workspace.role === "owner" || workspace.role === "admin"));
  const isOwner = organization?.role === "owner";
  const activeOwners = useMemo(() => members.filter((member) => member.state === "active" && member.role === "owner").length, [members]);
  const restoreOrganizations = useMemo(() => {
    const byId = new Map<string, NativeOrganization>();
    [organization, ...targetOrganizations].filter((item): item is NativeOrganization => Boolean(item)).forEach((item) => {
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
  const attach = async (workspace: NativeWorkspace, requestedOrganizationId?: string): Promise<void> => {
    const organizationId = requestedOrganizationId ?? attachTarget[workspaceTargetKey(workspace)];
    if (!organizationId || !onAttachWorkspace) return;
    const target = restoreOrganizations.find((item) => item.id === organizationId);
    if (!target) return;
    if (!window.confirm(`${workspace.name}をOrganization「${target.name}」へ追加します。Workspaceの内容とMembershipは維持されます。続けますか？`)) return;
    setAssociationError(null);
    setAssociationBusy(`attach:${workspaceTargetKey(workspace)}`);
    try {
      await onAttachWorkspace(workspace, organizationId);
      setAttachTarget((current) => ({ ...current, [workspaceTargetKey(workspace)]: "" }));
    } catch (cause) {
      setAssociationError(cause instanceof Error ? cause.message : "WorkspaceをOrganizationへ追加できませんでした。");
    } finally {
      setAssociationBusy(undefined);
    }
  };
  const detach = async (workspace: NativeWorkspace): Promise<void> => {
    if (!onDetachWorkspace || !workspace.organizationId) return;
    if (!window.confirm(`${workspace.name}をOrganizationから解除します。Workspaceの内容とMembershipは維持され、Standaloneとして利用できます。続けますか？`)) return;
    setAssociationError(null);
    setAssociationBusy(`detach:${workspaceTargetKey(workspace)}`);
    try {
      await onDetachWorkspace(workspace);
    } catch (cause) {
      setAssociationError(cause instanceof Error ? cause.message : "WorkspaceをOrganizationから解除できませんでした。");
    } finally {
      setAssociationBusy(undefined);
    }
  };
  const transferDestinationFor = (workspace: NativeWorkspace): NativeWorkspace | undefined => {
    const sourceKey = workspaceTargetKey(workspace);
    const destinationKey = transferDestination[sourceKey]
      ?? (transferPreview[sourceKey]?.destination ? targetKey(transferPreview[sourceKey]!.destination) : undefined)
      ?? (currentTransferPreflight && targetKey(currentTransferPreflight.source) === sourceKey ? targetKey(currentTransferPreflight.destination) : undefined)
      ?? (currentTransferStatus && targetKey(currentTransferStatus.source) === sourceKey ? targetKey(currentTransferStatus.destination) : undefined);
    return transferTargets.find((candidate) => workspaceTargetKey(candidate) === destinationKey);
  };
  const transferPreviewFor = (workspace: NativeWorkspace): NativeWorkspaceTransferPreflight | undefined => {
    const sourceKey = workspaceTargetKey(workspace);
    const persisted = currentTransferPreflight && targetKey(currentTransferPreflight.source) === sourceKey ? currentTransferPreflight : undefined;
    return transferPreview[sourceKey] ?? persisted;
  };
  const transferStatusFor = (workspace: NativeWorkspace): NativeWorkspaceTransferStatus | undefined => {
    const sourceKey = workspaceTargetKey(workspace);
    const persisted = currentTransferStatus && targetKey(currentTransferStatus.source) === sourceKey ? currentTransferStatus : undefined;
    return transferStatus[sourceKey] ?? persisted;
  };
  const previewTransfer = async (workspace: NativeWorkspace): Promise<void> => {
    const sourceKey = workspaceTargetKey(workspace);
    const destination = transferDestinationFor(workspace);
    if (!destination || !onPreviewWorkspaceTransfer) return;
    setTransferError(null);
    setTransferBusy(`preview:${sourceKey}`);
    try {
      const preview = await onPreviewWorkspaceTransfer(workspace, destination);
      setTransferPreview((current) => ({ ...current, [sourceKey]: preview }));
      setTransferStatus((current) => ({ ...current, [sourceKey]: undefined }));
    } catch (cause) {
      setTransferPreview((current) => ({ ...current, [sourceKey]: undefined }));
      setTransferStatus((current) => ({ ...current, [sourceKey]: undefined }));
      setTransferError(cause instanceof Error ? cause.message : "Workspace移転の事前確認に失敗しました。");
    } finally {
      setTransferBusy(undefined);
    }
  };
  const executeTransfer = async (workspace: NativeWorkspace): Promise<void> => {
    const sourceKey = workspaceTargetKey(workspace);
    const destination = transferDestinationFor(workspace);
    const preview = transferPreviewFor(workspace);
    if (!destination || !preview || !onExecuteWorkspaceTransfer || preview.writeBlocked || preview.failureConditions.length > 0) return;
    if (preview.expiresAt && Date.parse(preview.expiresAt) <= Date.now()) {
      setTransferError("移転の事前確認が期限切れです。もう一度確認してください。");
      setTransferPreview((current) => ({ ...current, [sourceKey]: undefined }));
      return;
    }
    const destinationLabel = destination.serverLabel ?? destination.serverOrigin ?? destination.connectionId;
    if (!window.confirm(`${workspace.name}を${destinationLabel}へ移転します。書込みを停止し、検証後に移転元をArchiveします。続けますか？`)) return;
    setTransferError(null);
    setTransferBusy(`execute:${sourceKey}`);
    try {
      const status = await onExecuteWorkspaceTransfer(workspace, destination, preview);
      setTransferStatus((current) => ({ ...current, [sourceKey]: status }));
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Workspace移転を開始できませんでした。");
    } finally {
      setTransferBusy(undefined);
    }
  };
  const refreshTransfer = async (workspace: NativeWorkspace): Promise<void> => {
    const sourceKey = workspaceTargetKey(workspace);
    const destination = transferDestinationFor(workspace);
    const status = transferStatusFor(workspace);
    if (!destination || !status || !onRefreshWorkspaceTransfer) return;
    setTransferError(null);
    setTransferBusy(`status:${sourceKey}`);
    try {
      const next = await onRefreshWorkspaceTransfer(workspace, destination, status);
      setTransferStatus((current) => ({ ...current, [sourceKey]: next }));
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Workspace移転の状態を確認できませんでした。");
    } finally {
      setTransferBusy(undefined);
    }
  };
  const cutoverTransfer = async (workspace: NativeWorkspace): Promise<void> => {
    const sourceKey = workspaceTargetKey(workspace);
    const destination = transferDestinationFor(workspace);
    const status = transferStatusFor(workspace);
    if (!destination || !status || status.state !== "verified" || !onCutoverWorkspaceTransfer) return;
    if (!window.confirm(`${workspace.name}の検証結果を確認しました。移転先へ接続を切り替え、移転元をArchiveします。続けますか？`)) return;
    setTransferError(null);
    setTransferBusy(`cutover:${sourceKey}`);
    try {
      await onCutoverWorkspaceTransfer(workspace, destination, status);
      setTransferStatus((current) => ({ ...current, [sourceKey]: { ...status, state: "source_archived", sourceArchived: true } }));
      setTransferPreview((current) => ({ ...current, [sourceKey]: undefined }));
    } catch (cause) {
      setTransferError(cause instanceof Error ? cause.message : "Workspaceの接続先を切り替えられませんでした。");
    } finally {
      setTransferBusy(undefined);
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
    if (!canManage || !bundleId) return;
    const bundle = exportedBundles[bundleId];
    const sourceName = organizationName(bundle?.sourceOrganizationId);
    const workspaceName = bundle
      ? workspaces.find((workspace) => workspace.id === bundle.workspaceId)?.name ?? bundle.workspaceId
      : "Bundle内のWorkspace";
    const sourceDescription = bundle
      ? `Source: ${sourceName} / ${workspaceName}`
      : "Source: Bundle metadataをServerで検証";
    if (!window.confirm(`${sourceDescription}\nTarget: Standalone（Organizationなし）\nOrganizationへの追加は復元後のAccess操作で行います。\nこのBundleを復元しますか？`)) return;
    setBundleError(null);
    setRestoreResult(undefined);
    setBundleBusy("restore");
    try {
      const result = await onRestoreBundle(bundleId);
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
        <div><div className="native-section-eyebrow">{organization ? "Organization settings" : "Workspace settings"}</div><h1 id="native-management-heading">{organization?.name ?? workspaceName ?? "Workspace"}</h1></div>
        <button type="button" className="native-icon-button" onClick={onClose} aria-label="管理画面を閉じる">×</button>
      </header>
      {error ? <div className="native-banner native-banner-error" role="alert">{error}</div> : null}
      <div className="native-management-scroll">
        {organization ? <>
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
        </> : null}

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
                  {organization && canManage && workspace.state === "archived" ? <button type="button" className="native-text-button" disabled={loading} onClick={() => void onRestoreWorkspace(workspace)}>復元</button> : null}
                  {organization && canManage && workspace.state !== "archived" ? <button type="button" className="native-text-button" disabled={loading} onClick={() => void onArchiveWorkspace(workspace)}>Archive</button> : null}
                  {organization && canManage ? <button type="button" className="native-text-button is-danger" disabled={loading} onClick={() => { if (window.confirm(`${workspace.name} を削除しますか？この操作は戻せません。`)) void onDeleteWorkspace(workspace); }}>削除</button> : null}
                  {organization && canManage && onDetachWorkspace && workspace.organizationId ? <button type="button" className="native-text-button" disabled={loading || associationBusy === `detach:${workspaceTargetKey(workspace)}`} onClick={() => void detach(workspace)}>{associationBusy === `detach:${workspaceTargetKey(workspace)}` ? "解除中…" : "Standaloneへ解除"}</button> : null}
                  {!organization && canManage && onAttachWorkspace && !workspace.organizationId && targetOrganizations.length ? <>
                    <label className="native-visually-hidden" htmlFor={`attach-${workspaceTargetKey(workspace)}`}>追加先Organization</label>
                    <select id={`attach-${workspaceTargetKey(workspace)}`} value={attachTarget[workspaceTargetKey(workspace)] ?? ""} disabled={loading || associationBusy === `attach:${workspaceTargetKey(workspace)}`} onChange={(event) => { setAttachTarget((current) => ({ ...current, [workspaceTargetKey(workspace)]: event.currentTarget.value })); setAssociationError(null); }}>
                      <option value="">Organizationへ追加…</option>
                      {targetOrganizations.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                    </select>
                    <button type="button" className="native-text-button" disabled={loading || !attachTarget[workspaceTargetKey(workspace)] || associationBusy === `attach:${workspaceTargetKey(workspace)}`} onClick={() => void attach(workspace)}>{associationBusy === `attach:${workspaceTargetKey(workspace)}` ? "追加中…" : "追加"}</button>
                  </> : null}
                  {moveAvailable ? <>
                    <label className="native-visually-hidden" htmlFor={`move-${workspace.id}`}>移動先Organization</label>
                    <select id={`move-${workspace.id}`} value={moveTarget[workspace.id] ?? ""} disabled={loading || moveBusyWorkspaceId === workspace.id} onChange={(event) => { setMoveTarget((current) => ({ ...current, [workspace.id]: event.currentTarget.value })); setMovePreview((current) => ({ ...current, [workspace.id]: undefined })); }}>
                      <option value="">移動先…</option>
                      {targetOrganizations.filter((target) => target.id !== organization?.id).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
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
          {associationError ? <p className="native-inline-error" role="alert">Organizationとの関連付けを変更できませんでした: {associationError}</p> : null}
          {organization && attachableWorkspaces.length && onAttachWorkspace ? <div className="native-association-attach">
            <div className="native-card-heading"><div><span className="native-section-eyebrow">Attach</span><h3>Standalone Workspaceを追加</h3></div><span className="native-muted-note">{organization.name}</span></div>
            <p className="native-muted-note">追加は同じServer上のWorkspaceだけです。内容とWorkspace Membershipは維持されます。</p>
            <ul className="native-managed-workspace-list">{attachableWorkspaces.map((workspace) => <li key={`attachable-${workspaceTargetKey(workspace)}`}><span className="native-workspace-copy"><strong>{workspace.name}</strong><small>Standalone · {workspace.access === "granted" ? "利用可能" : "アクセス権限がありません"}</small></span><button type="button" className="native-text-button" disabled={loading || workspace.access !== "granted" || associationBusy === `attach:${workspaceTargetKey(workspace)}`} onClick={() => void attach(workspace, organization.id)}>{associationBusy === `attach:${workspaceTargetKey(workspace)}` ? "追加中…" : "このOrganizationへ追加"}</button></li>)}</ul>
          </div> : null}
        </section>

        {(transferTargets.length > 0 || transferUnavailableReason) ? <section className="native-management-card native-transfer-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Portability</span><h2>Server間移転</h2></div><span className="native-muted-note">Workspace管理</span></div>
          <p className="native-muted-note">移転先Serverを選び、事前確認・復元・整合性検証が終わるまで移転元は変更せず保持します。切替後は移転元をArchiveします。</p>
          {!onPreviewWorkspaceTransfer || !onExecuteWorkspaceTransfer || !onCutoverWorkspaceTransfer ? <p className="native-transfer-unavailable" role="status">{transferUnavailableReason ?? "Server間移転はDesktopの移転bridgeが必要です。Browserでは未対応です。"}</p> : <ul className="native-transfer-list">
            {workspaces.map((workspace) => {
              const source = workspaceTarget(workspace);
              const sourceKey = workspaceTargetKey(workspace);
              const destinations = source
                ? transferTargets.filter((candidate) => {
                  const target = workspaceTarget(candidate);
                  return Boolean(target && target.connectionId !== source.connectionId && target.workspaceId === source.workspaceId);
                })
                : [];
              const destination = transferDestinationFor(workspace);
              const preview = transferPreviewFor(workspace);
              const status = transferStatusFor(workspace);
              const busy = transferBusy?.endsWith(sourceKey) || transferBusy === `preview:${sourceKey}` || transferBusy === `execute:${sourceKey}` || transferBusy === `status:${sourceKey}` || transferBusy === `cutover:${sourceKey}`;
              return <li key={`transfer-${sourceKey}`} className="native-transfer-item">
                <div className="native-transfer-route"><strong>{workspace.name}</strong><span>{workspace.serverLabel ?? workspace.serverOrigin ?? source?.connectionId ?? "Source"} → {destination?.serverLabel ?? destination?.serverOrigin ?? "移転先を選択"}</span></div>
                <div className="native-management-actions">
                  <label className="native-visually-hidden" htmlFor={`transfer-target-${sourceKey}`}>移転先Server</label>
                  <select id={`transfer-target-${sourceKey}`} value={transferDestination[sourceKey] ?? (destination ? workspaceTargetKey(destination) : "")} disabled={loading || Boolean(busy) || Boolean(status && status.state !== "failed")} onChange={(event) => {
                    setTransferDestination((current) => ({ ...current, [sourceKey]: event.currentTarget.value }));
                    setTransferPreview((current) => ({ ...current, [sourceKey]: undefined }));
                    setTransferStatus((current) => ({ ...current, [sourceKey]: undefined }));
                    setTransferError(null);
                  }}>
                    <option value="">移転先Server…</option>
                    {destinations.map((candidate) => {
                      const target = workspaceTarget(candidate)!;
                      return <option key={targetKey(target)} value={targetKey(target)}>{candidate.serverLabel ?? candidate.serverOrigin ?? target.connectionId}{candidate.name !== workspace.name ? ` · ${candidate.name}` : ""}</option>;
                    })}
                  </select>
                  {!preview && !status ? <button type="button" className="native-text-button" disabled={loading || !destination || Boolean(busy)} onClick={() => void previewTransfer(workspace)}>{busy ? "確認中…" : "移転を確認"}</button> : null}
                  {preview && !status ? <button type="button" className="native-text-button" disabled={loading || Boolean(busy) || preview.writeBlocked || preview.failureConditions.length > 0} onClick={() => void executeTransfer(workspace)}>{busy ? "移転開始中…" : "移転を開始"}</button> : null}
                  {status && status.state !== "verified" && status.state !== "source_archived" && status.state !== "cutover" && onRefreshWorkspaceTransfer ? <button type="button" className="native-text-button" disabled={loading || Boolean(busy)} onClick={() => void refreshTransfer(workspace)}>{busy ? "確認中…" : "状態を更新"}</button> : null}
                  {status?.state === "verified" ? <button type="button" className="native-text-button native-button-primary" disabled={loading || Boolean(busy)} onClick={() => void cutoverTransfer(workspace)}>{busy ? "切替中…" : "切替を確定"}</button> : null}
                </div>
                {preview ? <div className={`native-transfer-preview${preview.writeBlocked || preview.failureConditions.length ? " is-blocked" : ""}`} role="status">
                  <strong>{preview.writeBlocked || preview.failureConditions.length ? "移転できません" : "移転の事前確認"}</strong>
                  <span>Source: {workspace.serverLabel ?? workspace.serverOrigin ?? source?.connectionId ?? "不明"} · Target: {destination?.serverLabel ?? destination?.serverOrigin ?? "不明"}</span>
                  <span>データ量: {preview.dataByteSize === undefined ? "未取得" : `${(preview.dataByteSize / (1024 * 1024)).toFixed(1)} MB`} · 書込み停止: {preview.writeBlocked ? "必要" : "移転開始時に停止"}</span>
                  <span>Organization所属: {preview.organizationReleased ? "解除してStandalone化" : "引き継がない"} · 移転元: {preview.sourceWillArchive ? "Archive保持" : "状態をServerで確認"}</span>
                  {preview.failureConditions.length ? <ul>{preview.failureConditions.map((condition) => <li key={condition}>{condition}</li>)}</ul> : null}
                </div> : null}
                {status ? <div className={`native-transfer-status is-${status.state}`} role="status"><strong>{transferStateLabel(status.state)}</strong>{status.message ? <span>{status.message}</span> : null}{status.integrityHash ? <small>Integrity: {status.integrityHash}</small> : null}{status.failureCode ? <span className="native-inline-error">{status.failureCode}</span> : null}</div> : null}
              </li>;
            })}
          </ul>}
          {transferError ? <p className="native-inline-error" role="alert">移転操作に失敗しました: {transferError}</p> : null}
        </section> : null}

        <section className="native-management-card native-bundle-card">
          <div className="native-card-heading"><div><span className="native-section-eyebrow">Portability</span><h2>Workspace Bundle</h2></div><span className="native-muted-note">Server検証付き</span></div>
          <p className="native-muted-note">Export・RestoreはWorkspace単位です。Bundle RestoreはStandalone専用で、Organizationへの追加は復元後の別操作です。</p>
          {Object.values(exportedBundles).length ? <ul className="native-bundle-list">
            {Object.values(exportedBundles).map((bundle) => <li key={bundle.bundleId} className="native-bundle-item">
              <div><strong>{bundle.bundleId}</strong><small>Source: {organizationName(bundle.sourceOrganizationId)} · Workspace: {bundle.workspaceId}</small></div>
              <span>{bundle.fileCount === undefined ? "ファイル数未取得" : `${bundle.fileCount} files`} · {formatBundleSize(bundle.byteSize)}{bundle.integrityHash ? ` · ${bundle.integrityHash}` : ""}</span>
            </li>)}
          </ul> : <p className="native-empty-copy">Export済みBundleはこの画面にまだありません。</p>}
          {canManage ? <form className="native-restore-form" onSubmit={restoreBundle}>
            <label><span>Bundle ID</span><input value={restoreBundleId} onChange={(event) => { setRestoreBundleId(event.currentTarget.value); setBundleError(null); setRestoreResult(undefined); }} placeholder="bundle_..." autoComplete="off" required /></label>
            <p className="native-bundle-route">{exportedBundles[restoreBundleId.trim()] ? `Source: ${organizationName(exportedBundles[restoreBundleId.trim()]?.sourceOrganizationId)} → Target: Standalone（Organizationなし）` : "Source: Bundle metadataをServerで検証 → Target: Standalone（Organizationなし）"}</p>
            <p className="native-muted-note">復元後のOrganizationへの追加は、Accessの「Organizationへ追加」から別途実行します。</p>
            <button type="submit" className="native-button native-button-primary" disabled={loading || bundleBusy === "restore" || !restoreBundleId.trim()}>{bundleBusy === "restore" ? "復元中…" : "Bundleを復元"}</button>
          </form> : <p className="native-muted-note">Owner / AdminだけがWorkspace BundleをExport・復元できます。</p>}
          {bundleError ? <p className="native-inline-error" role="alert">Bundle操作に失敗しました: {bundleError}</p> : null}
          {restoreResult && restoreResult.status === "restored" ? <p className="native-bundle-success" role="status">復元完了: Source {organizationName(restoreResult.sourceOrganizationId)} → Target Standalone（Organizationなし） / Workspace {restoreResult.workspaceId}。Organizationへの追加はAccessから別途行えます。</p> : null}
        </section>

        {onDeleteOrganization && organization && isOwner ? <section className="native-management-card native-danger-card"><div className="native-card-heading"><div><span className="native-section-eyebrow">Danger zone</span><h2>Organizationを削除</h2></div></div><p>削除すると所属中のWorkspaceは削除されず、すべてStandaloneへ解除されます。Organization固有のMember・招待だけが削除されます。</p><button type="button" className="native-button native-button-danger" disabled={loading} onClick={() => { if (window.confirm(`${organization.name}を削除しますか？\n所属中のWorkspaceはStandaloneへ解除されます。Workspaceの内容は削除されません。`)) void onDeleteOrganization(); }}>Organizationを削除</button></section> : null}
      </div>
    </section>
  );
}

export default OrganizationManagement;
