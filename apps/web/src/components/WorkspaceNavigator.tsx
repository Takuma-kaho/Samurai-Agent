import type { NativeWorkspace, OrganizationRole } from "../native-app/types";

export interface WorkspaceNavigatorProps {
  workspaces: NativeWorkspace[];
  selectedWorkspaceId?: string;
  organizationRole?: OrganizationRole;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  onSelect: (workspace: NativeWorkspace) => void;
  onCreate: () => void;
}

function workspaceStateLabel(workspace: NativeWorkspace): string {
  if (workspace.state === "archived") return "アーカイブ済み";
  if (workspace.state === "read_only") return "読み取り専用";
  return workspace.access === "none" ? "アクセス権限なし" : "利用可能";
}

export function WorkspaceNavigator({
  workspaces,
  selectedWorkspaceId,
  organizationRole,
  loading = false,
  disabled = false,
  error,
  onSelect,
  onCreate
}: WorkspaceNavigatorProps) {
  const canCreate = organizationRole === "owner" || organizationRole === "admin";

  return (
    <section className="native-workspace-navigator" aria-labelledby="native-workspace-heading">
      <div className="native-subsection-heading">
        <span className="native-section-eyebrow" id="native-workspace-heading">Workspace</span>
        {canCreate ? <button className="native-icon-button native-icon-button-small" type="button" onClick={onCreate} disabled={disabled || loading} aria-label="Workspaceを作成">＋</button> : null}
      </div>
      {loading ? <div className="native-loading-line" role="status">Workspacesを確認中…</div> : null}
      {!loading && workspaces.length === 0 ? (
        <div className="native-empty-copy">このOrganizationにWorkspaceはありません。</div>
      ) : null}
      <ul className="native-workspace-list">
        {workspaces.map((workspace) => {
          const accessible = workspace.access === "granted";
          const active = workspace.id === selectedWorkspaceId;
          return (
            <li key={workspace.id}>
              {accessible ? (
                <button
                  className={`native-workspace-item${active ? " is-selected" : ""}`}
                  type="button"
                  onClick={() => onSelect(workspace)}
                  disabled={disabled || loading}
                  aria-current={active ? "page" : undefined}
                >
                  <span className="native-workspace-glyph" aria-hidden="true">{workspace.state === "archived" ? "◌" : "◈"}</span>
                  <span className="native-workspace-copy">
                    <strong>{workspace.name}</strong>
                    <small>{workspaceStateLabel(workspace)}</small>
                  </span>
                  {workspace.state === "archived" ? <span className="native-status-dot is-warn" aria-label="アーカイブ済み">!</span> : null}
                </button>
              ) : (
                <div className="native-workspace-item is-locked" aria-label={`${workspace.name}: アクセス権限がありません`}>
                  <span className="native-workspace-glyph" aria-hidden="true">⌁</span>
                  <span className="native-workspace-copy">
                    <strong>{workspace.name}</strong>
                    <small>アクセス権限がありません</small>
                  </span>
                  <span className="native-lock" aria-hidden="true">⌕</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default WorkspaceNavigator;
