/**
 * Renderer-local navigation state shared by the Browser bridge and Native
 * application.  It is deliberately not an authority: the Server still
 * authenticates every request and checks the Room on the signed call.
 */
let activeWorkspaceRoomId: string | undefined;
let roomSelectionGeneration = 0;

export function updateActiveWorkspaceRoomId(roomId: string | undefined): void {
  activeWorkspaceRoomId = roomId;
  roomSelectionGeneration += 1;
}

/**
 * Reserves a generation for an asynchronous Room selection.  Selection is
 * last-write-wins: a slower request from an older click must not publish a
 * state snapshot after a newer Room has already been selected.
 */
export function beginActiveWorkspaceRoomSelection(roomId: string): number {
  activeWorkspaceRoomId = roomId;
  roomSelectionGeneration += 1;
  return roomSelectionGeneration;
}

export function isCurrentActiveWorkspaceRoomSelection(generation: number): boolean {
  return generation === roomSelectionGeneration;
}

export function currentActiveWorkspaceRoomId(): string | undefined {
  return activeWorkspaceRoomId;
}
