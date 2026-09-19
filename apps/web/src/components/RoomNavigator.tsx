import { useEffect, useRef, useState } from "react";
import type { NativeRoom } from "../native-app/types";
import type { CSSProperties, ReactElement } from "react";
import RoomContextMenu, { type RoomContextMenuAction, type RoomContextMenuPosition } from "./RoomContextMenu";

export interface RoomNavigatorProps {
  rooms: NativeRoom[];
  selectedRoomId?: string;
  loading?: boolean;
  disabled?: boolean;
  archived?: boolean;
  error?: string | null;
  onSelect: (room: NativeRoom) => void;
  onCreate?: () => void;
  /** Open the ordinary Room creation flow without selecting a Room. */
  onCreateChild?: (room: NativeRoom) => void;
  /** Open the existing Room move flow for this Room without selecting it. */
  onMove?: (room: NativeRoom) => void;
  /** Open the existing Room rename flow for this Room without selecting it. */
  onRename?: (room: NativeRoom) => void;
  /** Controlled expanded Room IDs. When omitted, the navigator starts fully expanded. */
  expandedRoomIds?: ReadonlySet<string>;
  /** Notify the parent so expanded state can be persisted by the owning screen. */
  onToggleExpanded?: (room: NativeRoom) => void;
}

function roomDepth(room: NativeRoom, byId: Map<string, NativeRoom>): number {
  let depth = 0;
  const visited = new Set<string>();
  let parentId = room.parentRoomId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentRoomId;
  }
  return depth;
}

function roomOrder(left: NativeRoom, right: NativeRoom): number {
  return left.name.localeCompare(right.name, "ja") || left.id.localeCompare(right.id);
}

/**
 * Keep children next to their parent instead of grouping every depth together.
 * The Server owns the hierarchy; this is only a deterministic display order.
 * Orphaned and cyclic rows are appended after valid roots so one malformed row
 * cannot make the rest of the authorized directory disappear.
 */
function orderedRooms(rooms: NativeRoom[], byId: Map<string, NativeRoom>): NativeRoom[] {
  const children = new Map<string, NativeRoom[]>();
  for (const room of rooms) {
    const parentId = room.parentRoomId;
    if (!parentId || !byId.has(parentId)) continue;
    const siblings = children.get(parentId) ?? [];
    siblings.push(room);
    children.set(parentId, siblings);
  }

  const roots = rooms
    .filter((room) => !room.parentRoomId || !byId.has(room.parentRoomId))
    .sort(roomOrder);
  const result: NativeRoom[] = [];
  const visited = new Set<string>();

  const visit = (room: NativeRoom): void => {
    if (visited.has(room.id)) return;
    visited.add(room.id);
    result.push(room);
    for (const child of (children.get(room.id) ?? []).sort(roomOrder)) visit(child);
  };

  for (const room of roots) visit(room);
  // A parent cycle has no root. Keep those rows visible rather than silently
  // dropping them from the navigation.
  for (const room of [...rooms].sort(roomOrder)) visit(room);
  return result;
}

export function RoomNavigator({
  rooms,
  selectedRoomId,
  loading = false,
  disabled = false,
  archived = false,
  error,
  onSelect,
  onCreate,
  onCreateChild,
  onMove,
  onRename,
  expandedRoomIds,
  onToggleExpanded
}: RoomNavigatorProps) {
  const [locallyCollapsedRoomIds, setLocallyCollapsedRoomIds] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<{ room: NativeRoom; position: RoomContextMenuPosition }>();
  const roomButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const contextMenuRoomId = useRef<string | undefined>(undefined);

  const closeContextMenu = (): void => {
    const roomId = contextMenuRoomId.current;
    contextMenuRoomId.current = undefined;
    setContextMenu(undefined);
    if (roomId) {
      window.setTimeout(() => roomButtonRefs.current.get(roomId)?.focus(), 0);
    }
  };

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeOnViewportChange = (): void => closeContextMenu();
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [contextMenu]);

  const openContextMenu = (room: NativeRoom, position: RoomContextMenuPosition): void => {
    if (room.kind === "agent_dm") return;
    contextMenuRoomId.current = room.id;
    setContextMenu({ room, position });
  };

  const handleContextMenuAction = (action: RoomContextMenuAction, room: NativeRoom): void => {
    closeContextMenu();
    if (action === "create" && onCreate) onCreate();
    if (action === "create-child" && onCreateChild) onCreateChild(room);
    if (action === "move" && onMove) onMove(room);
    if (action === "rename" && onRename) onRename(room);
  };
  const normalRooms = rooms.filter((room) => room.kind !== "agent_dm");
  const agentDmRooms = rooms.filter((room) => room.kind === "agent_dm");
  const byId = new Map(normalRooms.map((room) => [room.id, room]));
  const visibleRooms = orderedRooms(normalRooms, byId);
  const visibleAgentDmRooms = [...agentDmRooms].sort(roomOrder);

  const childrenById = new Map<string, NativeRoom[]>();
  for (const room of normalRooms) {
    if (!room.parentRoomId || !byId.has(room.parentRoomId)) continue;
    const children = childrenById.get(room.parentRoomId) ?? [];
    children.push(room);
    childrenById.set(room.parentRoomId, children);
  }
  for (const children of childrenById.values()) children.sort(roomOrder);

  const isRoomExpanded = (room: NativeRoom): boolean => expandedRoomIds
    ? expandedRoomIds.has(room.id)
    : !locallyCollapsedRoomIds.has(room.id);

  const toggleRoomExpanded = (room: NativeRoom): void => {
    if (expandedRoomIds === undefined) {
      setLocallyCollapsedRoomIds((current) => {
        const next = new Set(current);
        if (next.has(room.id)) next.delete(room.id);
        else next.add(room.id);
        return next;
      });
    }
    onToggleExpanded?.(room);
  };

  const renderRoomButton = (room: NativeRoom, hasChildren: boolean): ReactElement => {
    const active = room.id === selectedRoomId;
    // Viewing a Room and starting Agent work are separate capabilities.
    // Keep an authorized read-only Room reachable so its work history and
    // artifacts are not hidden just because execution is unavailable.
    const roomDisabled = disabled || archived || room.canView === false;
    const isAgentDm = room.kind === "agent_dm";
    const permissionLabel = room.canView === false ? "閲覧不可" : room.canExecute === false ? "読み取り専用" : undefined;
    const ariaLabel = `${room.name}${isAgentDm ? "（Agent DM・非公開）" : ""}${permissionLabel ? `・${permissionLabel}` : ""}`;
    const roomButton = <button
      ref={(element) => {
        if (element) roomButtonRefs.current.set(room.id, element);
        else roomButtonRefs.current.delete(room.id);
      }}
      className={`native-room-item native-room-item-${isAgentDm ? "dm" : "normal"}${hasChildren ? " native-room-item-parent" : ""}${active ? " is-selected" : ""}${roomDisabled ? " is-muted" : ""}`}
      type="button"
      onClick={() => onSelect(room)}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(room, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        openContextMenu(room, { x: rect.left, y: rect.bottom });
      }}
      disabled={roomDisabled}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      title={permissionLabel}
      style={{
        "--native-room-depth": isAgentDm ? 0 : roomDepth(room, byId),
        ...(hasChildren ? { flex: "1 1 auto", minWidth: 0, width: "auto" } : {})
      } as CSSProperties}
    >
      <span className={isAgentDm ? "native-room-dm-mark" : "native-room-mark"} aria-hidden="true">{isAgentDm ? "◉" : "#"}</span>
      <span className="native-room-name">{room.name}</span>
    </button>;

    if (!hasChildren) return roomButton;

    const expanded = isRoomExpanded(room);
    const toggleLabel = `${room.name}を${expanded ? "折りたたむ" : "展開する"}`;
    return <div className="native-room-item-row" style={{ display: "flex", minWidth: 0 }}>
      <button
        className="native-icon-button native-room-toggle"
        type="button"
        onClick={() => toggleRoomExpanded(room)}
        disabled={roomDisabled}
        aria-label={toggleLabel}
        aria-expanded={expanded}
        title={toggleLabel}
        style={{ flex: "0 0 27px", minWidth: "27px", height: "auto", padding: 0 }}
      >
        <span aria-hidden="true">{expanded ? "⌄" : "›"}</span>
      </button>
      {roomButton}
    </div>;
  };

  const renderRoomTree = (room: NativeRoom, rendered: Set<string>): ReactElement | null => {
    if (rendered.has(room.id)) return null;
    rendered.add(room.id);
    const children = childrenById.get(room.id) ?? [];
    const expanded = children.length === 0 || isRoomExpanded(room);
    if (!expanded) {
      const markHiddenDescendants = (parentId: string): void => {
        for (const child of childrenById.get(parentId) ?? []) {
          if (rendered.has(child.id)) continue;
          rendered.add(child.id);
          markHiddenDescendants(child.id);
        }
      };
      markHiddenDescendants(room.id);
    }
    const childElements = expanded
      ? children
        .map((child) => renderRoomTree(child, rendered))
        .filter((child): child is ReactElement => child !== null)
      : [];
    return (
      <li className={children.length ? "native-room-group" : undefined} key={room.id}>
        {renderRoomButton(room, children.length > 0)}
        {childElements.length ? <ul className="native-room-list native-room-children">{childElements}</ul> : null}
      </li>
    );
  };

  const rootRooms = visibleRooms.filter((room) => !room.parentRoomId || !byId.has(room.parentRoomId));
  const renderedRoomIds = new Set<string>();
  const roomTree = [...rootRooms, ...visibleRooms]
    .map((room) => renderRoomTree(room, renderedRoomIds))
    .filter((room): room is ReactElement => room !== null);
  const renderAgentDm = (room: NativeRoom): ReactElement => <li key={room.id}>{renderRoomButton(room, false)}</li>;

  return (
    <section className="native-room-navigator" aria-labelledby="native-room-heading">
      <div className="native-subsection-heading">
        <span className="native-section-eyebrow" id="native-room-heading">Room</span>
        {onCreate ? <button className="native-icon-button native-icon-button-small" type="button" onClick={onCreate} disabled={disabled || archived || loading} aria-label="Roomを作成">＋</button> : null}
      </div>
      {loading ? <div className="native-loading-line" role="status">Roomsを確認中…</div> : null}
      {!loading && normalRooms.length === 0 && agentDmRooms.length === 0 ? <div className="native-empty-copy">Roomがありません。新しいRoomを作成できます。</div> : null}
      {roomTree.length ? <ul className="native-room-list" aria-label="Room">{roomTree}</ul> : null}
      {visibleAgentDmRooms.length ? (
        <div className="native-room-dm-section">
          <div className="native-room-section-heading">ダイレクトメッセージ</div>
          <ul className="native-room-list native-room-dm-list" aria-label="ダイレクトメッセージ">{visibleAgentDmRooms.map(renderAgentDm)}</ul>
        </div>
      ) : null}
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
      {contextMenu ? <RoomContextMenu
        room={contextMenu.room}
        position={contextMenu.position}
        onAction={handleContextMenuAction}
        onClose={closeContextMenu}
      /> : null}
    </section>
  );
}

export default RoomNavigator;
