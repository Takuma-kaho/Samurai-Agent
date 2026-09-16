import { useCallback, useEffect, useId, useRef } from "react";
import type { NativeWorkspace } from "./types";
import { nativeThemes, type NativeTheme } from "../lib/native-app-theme-preferences";

export interface NativeProfileMenuProps {
  accountLabel: string;
  open: boolean;
  theme: NativeTheme;
  workspaces: NativeWorkspace[];
  selectedWorkspaceTargetKey?: string;
  onToggle: () => void;
  onClose: () => void;
  onThemeChange: (theme: NativeTheme) => void;
  onSelectWorkspace: (workspace: NativeWorkspace) => void;
}

function workspaceTargetKey(workspace: NativeWorkspace): string | undefined {
  const connectionId = workspace.target?.connectionId ?? workspace.connectionId;
  if (!connectionId || !workspace.id) return undefined;
  return `${connectionId}\n${workspace.target?.workspaceId ?? workspace.id}`;
}

/**
 * The only theme entry point in the Native App. The wrapper owns the trigger
 * and popup together so outside-click handling cannot close a menu while the
 * trigger itself is being clicked.
 */
export function NativeProfileMenu({
  accountLabel,
  open,
  theme,
  workspaces,
  selectedWorkspaceTargetKey,
  onToggle,
  onClose,
  onThemeChange,
  onSelectWorkspace
}: NativeProfileMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstThemeButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const selectedWorkspace = workspaces.find((workspace) => workspaceTargetKey(workspace) === selectedWorkspaceTargetKey);
  const selectedWorkspaceLabel = selectedWorkspace?.name ?? "Workspace未選択";

  const closeAndRestoreFocus = useCallback((): void => {
    onClose();
    // The parent keeps the trigger mounted while the popup closes. Restoring
    // focus on the next frame avoids focusing a stale menu item.
    if (typeof window !== "undefined") {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    } else {
      triggerRef.current?.focus();
    }
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    firstThemeButtonRef.current?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      closeAndRestoreFocus();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAndRestoreFocus, open]);

  return (
    <div className="native-profile-menu-wrap" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="native-profile-trigger"
        aria-label={`${accountLabel}の本人メニュー`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={onToggle}
      >
        <span className="native-profile-avatar" aria-hidden="true">{accountLabel.slice(0, 1) || "本"}</span>
        <span className="native-profile-copy">
          <strong>{accountLabel}</strong>
          <small className="native-profile-workspace-name"><span className="native-profile-workspace-icon" aria-hidden="true">◎</span>{selectedWorkspaceLabel}</small>
        </span>
        <span className="native-profile-chevron" aria-hidden="true">⌃</span>
      </button>
      {open ? <div id={menuId} className="native-profile-menu" role="menu" aria-label="本人メニューの内容">
        <div className="native-profile-menu-account">
          <span className="native-profile-avatar" aria-hidden="true">{accountLabel.slice(0, 1) || "本"}</span>
          <span><strong>{accountLabel}</strong><small>自分のプロフィール</small></span>
        </div>
        <div className="native-profile-menu-heading">WORKSPACE</div>
        <div className="native-profile-workspaces" role="group" aria-label="Workspaceを選択">
          {workspaces.length ? workspaces.map((workspace) => {
            const targetKey = workspaceTargetKey(workspace);
            const selected = Boolean(targetKey && targetKey === selectedWorkspaceTargetKey);
            // Archived/read-only Workspaces can still be opened for their
            // permitted history. Only a missing Workspace grant is blocked.
            const available = workspace.access === "granted";
            return <button
              key={`${targetKey ?? workspace.id}:${workspace.id}`}
              type="button"
              role="menuitemradio"
              className={`native-profile-workspace${selected ? " is-selected" : ""}`}
              aria-checked={selected}
              aria-label={`${workspace.name}${available ? "" : "（利用不可）"}`}
              disabled={!available}
              onClick={() => { onSelectWorkspace(workspace); closeAndRestoreFocus(); }}
            >
              <span className="native-profile-workspace-mark" aria-hidden="true">{selected ? "✓" : ""}</span>
              <span><strong>{workspace.name}</strong>{workspace.serverLabel ? <small>{workspace.serverLabel}</small> : null}</span>
            </button>;
          }) : <p className="native-profile-menu-empty">Workspaceがありません</p>}
        </div>
        <div className="native-profile-menu-divider" />
        <div className="native-profile-menu-heading">テーマ</div>
        <div className="native-profile-themes" role="group" aria-label="テーマを選択">
          {nativeThemes.map((item, index) => <button
            key={item.id}
            ref={index === 0 ? firstThemeButtonRef : undefined}
            type="button"
            role="menuitemradio"
            className={`native-profile-theme${theme === item.id ? " is-selected" : ""}`}
            aria-checked={theme === item.id}
            aria-pressed={theme === item.id}
            title={item.description}
            onClick={() => onThemeChange(item.id)}
          >
            <span className={`native-profile-theme-dot is-${item.id}`} aria-hidden="true" />
            <span><strong>{item.code} · {item.label}</strong><small>{item.description}</small></span>
            {theme === item.id ? <span className="native-profile-theme-check" aria-hidden="true">✓</span> : null}
          </button>)}
        </div>
      </div> : null}
    </div>
  );
}

export default NativeProfileMenu;
