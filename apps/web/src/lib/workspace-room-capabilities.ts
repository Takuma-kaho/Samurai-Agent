export type WorkspaceRoomRole = "owner" | "admin" | "member" | "guest" | undefined;

export interface WorkspaceRoomActionItem {
  id: string;
  parentRoomId?: string;
  canManage?: boolean;
}

/** UI guidance only. PostgreSQL remains the authority for every operation. */
export function canCreateWorkspaceRootRoom(role: WorkspaceRoomRole): boolean {
  return role === "owner" || role === "admin" || role === "member";
}

export function canMoveRoomToWorkspaceRoot(role: WorkspaceRoomRole): boolean {
  return role === "owner" || role === "admin";
}

/** Returns visible, manageable destinations and omits the selected subtree. */
export function manageableMoveParents<T extends WorkspaceRoomActionItem>(rooms: readonly T[], selectedRoomId: string | undefined): T[] {
  if (!selectedRoomId) return [];
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);
  const descendants = new Set<string>();
  const children = new Map<string, string[]>();
  for (const room of rooms) {
    if (!room.parentRoomId) continue;
    const current = children.get(room.parentRoomId) ?? [];
    current.push(room.id);
    children.set(room.parentRoomId, current);
  }
  const pending = [selectedRoomId];
  while (pending.length > 0) {
    const roomId = pending.pop();
    if (!roomId || descendants.has(roomId)) continue;
    descendants.add(roomId);
    pending.push(...(children.get(roomId) ?? []));
  }
  return rooms.filter((room) =>
    room.canManage === true
    && !descendants.has(room.id)
    && room.id !== selectedRoom?.parentRoomId
  );
}
