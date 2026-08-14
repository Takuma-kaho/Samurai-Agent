export interface RoomEventEmitter {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

export function workspaceSocketRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function roomSocketRoom(workspaceId: string, roomId: string): string {
  return `workspace:${workspaceId}:room:${roomId}`;
}

/** Delivering to the Room only prevents Workspace-wide notification leakage. */
export function emitRoomWorkspaceEvent(
  io: RoomEventEmitter,
  event: { workspaceId: string; roomId: string }
): void {
  io.to(roomSocketRoom(event.workspaceId, event.roomId)).emit("workspace:event", event);
}
