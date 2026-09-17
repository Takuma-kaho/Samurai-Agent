import { useCallback, useEffect, useId, useRef } from "react";

export interface NativeProfileMenuProps {
  accountLabel: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** Opens the full-screen Account settings surface owned by the parent. */
  onOpenSettings?: () => void;
}

/**
 * The profile popup is intentionally a small Account entry point. Workspace
 * selection and theme choice live in their own surfaces so this menu cannot
 * accidentally mix account settings with Workspace-scoped actions.
 */
export function NativeProfileMenu({
  accountLabel,
  open,
  onToggle,
  onClose,
  onOpenSettings
}: NativeProfileMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const closeAndRestoreFocus = useCallback((restore = true): void => {
    onClose();
    // The parent keeps the trigger mounted while the popup closes. Restoring
    // focus on the next frame avoids focusing a stale menu item.
    if (restore && typeof window !== "undefined") {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    } else if (restore) {
      triggerRef.current?.focus();
    }
  }, [onClose]);

  const openSettings = useCallback((): void => {
    if (!onOpenSettings) return;
    closeAndRestoreFocus(false);
    onOpenSettings();
  }, [closeAndRestoreFocus, onOpenSettings]);

  useEffect(() => {
    if (!open) return;
    settingsButtonRef.current?.focus();
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
        data-native-profile-trigger="true"
        aria-label={`${accountLabel}の本人メニュー`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={onToggle}
      >
        <span className="native-profile-avatar" aria-hidden="true">{accountLabel.slice(0, 1) || "本"}</span>
        <span className="native-profile-copy">
          <strong>{accountLabel}</strong>
          <small>本人設定</small>
        </span>
        <span className="native-profile-chevron" aria-hidden="true">⌃</span>
      </button>
      {open ? <div id={menuId} className="native-profile-menu" role="menu" aria-label="本人メニューの内容">
        <div className="native-profile-menu-account">
          <span className="native-profile-avatar" aria-hidden="true">{accountLabel.slice(0, 1) || "本"}</span>
          <span><strong>{accountLabel}</strong><small>自分のプロフィール</small></span>
        </div>
        {onOpenSettings ? <button
            ref={settingsButtonRef}
            type="button"
            role="menuitem"
            className="native-profile-settings-entry"
            aria-label="本人設定を開く"
            onClick={openSettings}
          >
            <span aria-hidden="true">⚙</span>
            <span><strong>本人設定</strong><small>プロフィール・回答設定・外観</small></span>
            <span aria-hidden="true">↗</span>
          </button>
          : <p className="native-profile-menu-empty">Account接続後に本人設定を利用できます。</p>}
      </div> : null}
    </div>
  );
}

export default NativeProfileMenu;
