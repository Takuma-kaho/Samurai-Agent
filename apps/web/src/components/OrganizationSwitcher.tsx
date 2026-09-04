import type { ChangeEvent } from "react";
import type { NativeOrganization } from "../native-app/types";

export interface OrganizationSwitcherProps {
  organizations: NativeOrganization[];
  selectedOrganizationId?: string;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  onSelect: (organizationId: string) => void;
  onCreate: () => void;
  onManage: () => void;
}

function initials(organization: NativeOrganization): string {
  const value = organization.name.trim();
  return value.slice(0, 2).toUpperCase() || "O";
}

export function OrganizationSwitcher({
  organizations,
  selectedOrganizationId,
  loading = false,
  disabled = false,
  error,
  onSelect,
  onCreate,
  onManage
}: OrganizationSwitcherProps) {
  const selected = organizations.find((organization) => organization.id === selectedOrganizationId);
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (event.currentTarget.value === "__create__") {
      event.currentTarget.value = selectedOrganizationId ?? "";
      onCreate();
      return;
    }
    if (event.currentTarget.value) onSelect(event.currentTarget.value);
  };

  return (
    <section className="native-org-switcher" aria-labelledby="native-org-heading">
      <div className="native-section-eyebrow" id="native-org-heading">Organization（管理）</div>
      <div className="native-org-control-row">
        <span className="native-org-avatar" aria-hidden="true">{selected ? initials(selected) : "—"}</span>
        <label className="native-visually-hidden" htmlFor="native-organization-select">Organizationを選択</label>
        <select
          id="native-organization-select"
          className="native-org-select"
          value={selectedOrganizationId ?? ""}
          onChange={handleChange}
          disabled={disabled || loading}
          aria-busy={loading}
        >
          <option value="" disabled>{loading ? "読み込み中…" : "Organizationを選択"}</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name} · {organization.role}
            </option>
          ))}
          <option value="__create__">＋ Organizationを作成</option>
        </select>
        <button className="native-icon-button" type="button" onClick={onManage} disabled={disabled || !selected} aria-label="Organization管理を開く" title="Organization管理">
          <span aria-hidden="true">⚙</span>
        </button>
      </div>
      {selected ? (
        <div className="native-org-meta">
          <span className="native-role-chip">{selected.role}</span>
          <span>{selected.workspaceCount ?? selected.workspaces?.length ?? 0} Workspaces</span>
        </div>
      ) : (
        <div className="native-org-empty">
          <p className="native-empty-copy">Workspace利用にOrganizationは必須ではありません。</p>
          <button className="native-inline-action" type="button" onClick={onCreate} disabled={disabled || loading}>＋ 作成または参加</button>
        </div>
      )}
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default OrganizationSwitcher;
