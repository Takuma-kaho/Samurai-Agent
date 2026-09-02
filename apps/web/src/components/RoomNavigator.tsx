import type { NativeRoom } from "../native-app/types";
import type { CSSProperties } from "react";

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
  while (parentId && !visited.has(parentId) && depth < 6) {
    visited.add(parentId);
    depth += 1;
    parentId = byId.get(parentId)?.parentRoomId;
  }
  return depth;
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
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const orderedRooms = [...rooms].sort((left, right) => {
    const depthDifference = roomDepth(left, byId) - roomDepth(right, byId);
    return depthDifference || left.name.localeCompare(right.name, "ja");
  });

  return (
    <section className="native-room-navigator" aria-labelledby="native-room-heading">
      <div className="native-subsection-heading">
        <span className="native-section-eyebrow" id="native-room-heading">Room</span>
        {onCreate ? <button className="native-icon-button native-icon-button-small" type="button" onClick={onCreate} disabled={disabled || archived || loading} aria-label="Roomを作成">＋</button> : null}
      </div>
      {loading ? <div className="native-loading-line" role="status">Roomsを確認中…</div> : null}
      {!loading && rooms.length === 0 ? <div className="native-empty-copy">Roomがありません。新しいRoomを作成できます。</div> : null}
      <ul className="native-room-list">
        {orderedRooms.map((room) => {
          const active = room.id === selectedRoomId;
          const roomDisabled = disabled || archived || room.canExecute === false;
          return (
            <li key={room.id}>
              <button
                className={`native-room-item${active ? " is-selected" : ""}${roomDisabled ? " is-muted" : ""}`}
                type="button"
                onClick={() => onSelect(room)}
                disabled={roomDisabled}
                aria-current={active ? "page" : undefined}
                style={{ "--native-room-depth": roomDepth(room, byId) } as CSSProperties}
              >
                <span className="native-room-mark" aria-hidden="true">{active ? "●" : "○"}</span>
                <span>{room.name}</span>
                {room.canExecute === false ? <span className="native-room-permission">権限なし</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    </section>
  );
}

export default RoomNavigator;
