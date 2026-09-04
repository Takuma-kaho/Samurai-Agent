import { nativeWorkspaceTargetKey, type NativeWorkspace, type NativeWorkspaceDirectoryError, type NativeWorkspaceTarget, type OrganizationRole } from "../native-app/types";

export interface WorkspaceNavigatorProps {
  workspaces: NativeWorkspace[];
  selectedWorkspaceId?: string;
  selectedWorkspaceTargetKey?: string;
  organizationRole?: OrganizationRole;
  /** The Server remains the final authority; this only controls the affordance. */
  canCreate?: boolean;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  directoryErrors?: NativeWorkspaceDirectoryError[];
  onSelect: (workspace: NativeWorkspace) => void;
  onCreate: () => void;
  onManage?: () => void;
}

function workspaceStateLabel(workspace: NativeWorkspace): string {
  if (workspace.state === "archived") return "アーカイブ済み";
  if (workspace.state === "read_only") return "読み取り専用";
  if (workspace.availability === "offline") return "Serverに接続できません";
  if (workspace.availability === "reconnecting") return "Serverを再確認中";
  return workspace.access === "none" ? "アクセス権限なし" : "利用可能";
}

function workspaceTarget(workspace: NativeWorkspace): NativeWorkspaceTarget | undefined {
  return workspace.target
    ?? (workspace.connectionId ? { connectionId: workspace.connectionId, workspaceId: workspace.id } : undefined);
}

export function WorkspaceNavigator({
  workspaces,
  selectedWorkspaceId,
  selectedWorkspaceTargetKey,
  organizationRole,
  canCreate: canCreateOverride,
  loading = false,
  disabled = false,
  error,
  directoryErrors = [],
  onSelect,
  onCreate,
  onManage
}: WorkspaceNavigatorProps) {
  const canCreate = canCreateOverride ?? (organizationRole === undefined || organizationRole === "owner" || organizationRole === "admin");

  return (
    <section className="native-workspace-navigator" aria-labelledby="native-workspace-heading">
      <div className="native-subsection-heading">
        <span className="native-section-eyebrow" id="native-workspace-heading">Workspace</span>
        <span className="native-management-actions">
          {onManage ? <button className="native-icon-button native-icon-button-small" type="button" onClick={onManage} disabled={disabled || loading || (!selectedWorkspaceId && !selectedWorkspaceTargetKey)} aria-label="Workspace管理を開く" title="Workspace管理">⚙</button> : null}
          {canCreate ? <button className="native-icon-button native-icon-button-small" type="button" onClick={onCreate} disabled={disabled || loading} aria-label="Workspaceを作成">＋</button> : null}
        </span>
      </div>
      {loading ? <div className="native-loading-line" role="status">Workspacesを確認中…</div> : null}
      {!loading && workspaces.length === 0 ? <div className="native-empty-copy">利用できるWorkspaceがありません。</div> : null}
      <ul className="native-workspace-list">
        {workspaces.map((workspace) => {
          const accessible = workspace.access === "granted";
          const identityRequired = workspace.connectionError === "workspace_identity_required";
          const unavailableLabel = identityRequired
            ? "本人確認（秘密鍵の読み込み）が必要です"
            : "アクセス権限がありません";
          const target = workspaceTarget(workspace);
          const targetKey = target ? nativeWorkspaceTargetKey(target) : undefined;
          const active = selectedWorkspaceTargetKey ? targetKey === selectedWorkspaceTargetKey : workspace.id === selectedWorkspaceId;
          const unavailable = workspace.availability === "offline" || workspace.availability === "reconnecting";
          return (
            <li key={targetKey ?? workspace.id}>
              {accessible ? (
                <button
                  className={`native-workspace-item${active ? " is-selected" : ""}${unavailable ? " is-muted" : ""}`}
                  type="button"
                  onClick={() => onSelect(workspace)}
                  disabled={disabled || loading || unavailable}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="native-workspace-glyph" aria-hidden="true">{workspace.state === "archived" ? "◌" : "◈"}</span>
                  <span className="native-workspace-copy">
                    <strong>{workspace.name}</strong>
                    <small>{workspaceStateLabel(workspace)}</small>
                    {workspace.serverLabel ? <small className="native-workspace-server">{workspace.serverLabel}</small> : null}
                  </span>
                  {workspace.state === "archived" ? <span className="native-status-dot is-warn" aria-label="アーカイブ済み">!</span> : null}
                </button>
              ) : (
                <div className={`native-workspace-item is-locked${identityRequired ? " is-identity-required" : ""}`} aria-label={`${workspace.name}: ${unavailableLabel}`}>
                  <span className="native-workspace-glyph" aria-hidden="true">⌁</span>
                  <span className="native-workspace-copy">
                    <strong>{workspace.name}</strong>
                    <small>{unavailableLabel}</small>
                    {identityRequired ? <small>接続設定から読み込んでください。</small> : null}
                  </span>
                  <span className="native-lock" aria-hidden="true">⌕</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {directoryErrors.map((directoryError) => (
        <p className="native-inline-error native-workspace-directory-error" role="alert" key={`${directoryError.connectionId}:${directoryError.code}`}>
          {directoryError.serverLabel ?? directoryError.serverOrigin ?? "Workspace Server"}: {directoryError.message}
        </p>
      ))}
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default WorkspaceNavigator;
