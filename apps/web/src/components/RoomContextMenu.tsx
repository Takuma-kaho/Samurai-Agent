import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { NativeRoom } from "../native-app/types";

export type RoomContextMenuAction = "create" | "create-child" | "move" | "rename";

export interface RoomContextMenuPosition {
  x: number;
  y: number;
}

export interface RoomContextMenuProps {
  room: NativeRoom;
  position: RoomContextMenuPosition;
  /** Actions are intentionally opt-in while their Server connections are pending. */
  enabledActions?: Partial<Record<RoomContextMenuAction, boolean>>;
  onAction: (action: RoomContextMenuAction, room: NativeRoom) => void;
  onClose: () => void;
}

/**
 * Small, target-scoped Room actions. The menu deliberately does not select a
 * Room; callers decide whether an existing operation or a follow-up form is
 * appropriate for the action.
 */
export function RoomContextMenu({ room, position, enabledActions = {}, onAction, onClose }: RoomContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [resolvedPosition, setResolvedPosition] = useState(position);

  useEffect(() => {
    setResolvedPosition(position);
  }, [position]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || typeof window === "undefined") return;
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const x = Math.max(margin, Math.min(position.x, window.innerWidth - rect.width - margin));
    const y = Math.max(margin, Math.min(position.y, window.innerHeight - rect.height - margin));
    if (x !== resolvedPosition.x || y !== resolvedPosition.y) setResolvedPosition({ x, y });
  }, [position, resolvedPosition.x, resolvedPosition.y]);

  useEffect(() => {
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']");
    firstItem?.focus();
    const handlePointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const menuStyle = {
    left: `${resolvedPosition.x}px`,
    top: `${resolvedPosition.y}px`
  } satisfies CSSProperties;

  const actions: Array<{ action: RoomContextMenuAction; label: string }> = [
    { action: "create", label: "Roomを作成" },
    { action: "create-child", label: "子Roomを作成" },
    { action: "move", label: "Roomを移動" },
    { action: "rename", label: "名前を変更" }
  ];

  return (
    <div
      ref={menuRef}
      className="native-room-context-menu"
      role="menu"
      aria-label={`${room.name}のRoom操作`}
      style={menuStyle}
    >
      {actions.map(({ action, label }) => (
        <button
          key={action}
          type="button"
          role="menuitem"
          className="native-room-context-menu__item"
          disabled={enabledActions[action] !== true}
          aria-disabled={enabledActions[action] === true ? undefined : true}
          title={enabledActions[action] === true ? undefined : "この操作はまだ利用できません"}
          onClick={() => {
            if (enabledActions[action] === true) onAction(action, room);
          }}
        >
          {label}{enabledActions[action] === true ? "" : "（準備中）"}
        </button>
      ))}
    </div>
  );
}

export default RoomContextMenu;
