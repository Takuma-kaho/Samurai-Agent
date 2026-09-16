import type { NativeRoom } from "../native-app/types";
import type { CSSProperties, ReactElement } from "react";

export interface RoomNavigatorProps {
  rooms: NativeRoom[];
  selectedRoomId?: string;
  loading?: boolean;
  disabled?: boolean;
  archived?: boolean;
  error?: string | null;
  onSelect: (room: NativeRoom) => void;
  onCreate?: () => void;
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
  onCreate
}: RoomNavigatorProps) {
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

  const renderRoomButton = (room: NativeRoom, hasChildren: boolean): ReactElement => {
    const active = room.id === selectedRoomId;
    // Viewing a Room and starting Agent work are separate capabilities.
    // Keep an authorized read-only Room reachable so its work history and
    // artifacts are not hidden just because execution is unavailable.
    const roomDisabled = disabled || archived || room.canView === false;
    const isAgentDm = room.kind === "agent_dm";
    const permissionLabel = room.canView === false ? "閲覧不可" : room.canExecute === false ? "読み取り専用" : undefined;
    const ariaLabel = `${room.name}${isAgentDm ? "（Agent DM・非公開）" : ""}${permissionLabel ? `・${permissionLabel}` : ""}`;
    return <button
      className={`native-room-item native-room-item-${isAgentDm ? "dm" : "normal"}${hasChildren ? " native-room-item-parent" : ""}${active ? " is-selected" : ""}${roomDisabled ? " is-muted" : ""}`}
      type="button"
      onClick={() => onSelect(room)}
      disabled={roomDisabled}
      aria-current={active ? "page" : undefined}
      aria-label={ariaLabel}
      aria-expanded={hasChildren ? true : undefined}
      title={permissionLabel}
      style={{ "--native-room-depth": isAgentDm ? 0 : roomDepth(room, byId) } as CSSProperties}
    >
      <span className={isAgentDm ? "native-room-dm-mark" : "native-room-mark"} aria-hidden="true">{isAgentDm ? "◉" : "#"}</span>
      <span className="native-room-name">{room.name}</span>
      {hasChildren ? <span className="native-room-children-mark" aria-hidden="true">⌄</span> : null}
    </button>;
  };

  const renderRoomTree = (room: NativeRoom, rendered: Set<string>): ReactElement | null => {
    if (rendered.has(room.id)) return null;
    rendered.add(room.id);
    const children = childrenById.get(room.id) ?? [];
    const childElements = children
      .map((child) => renderRoomTree(child, rendered))
      .filter((child): child is ReactElement => child !== null);
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
    </section>
  );
}

export default RoomNavigator;
