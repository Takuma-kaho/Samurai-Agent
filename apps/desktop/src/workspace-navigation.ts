/**
 * A signed Desktop request is tied to a Workspace target and, when supplied,
 * to the Room the user was viewing when the request began.
 *
 * Room changes must invalidate Room-scoped requests, but they must not make a
 * Workspace-wide query (such as the Agent directory) fail while the initial
 * Room is being selected. Workspace target changes always invalidate every
 * request, including a switch away and back to the same target.
 */
export interface WorkspaceNavigationSnapshot {
  connectionId: string;
  workspaceId: string;
  /** Advances only when the active connection/workspace target changes. */
  workspaceTargetGeneration: number;
  /** Advances for each authorized navigation, including a Room change. */
  selectionGeneration: number;
  roomId?: string;
}

export interface ActiveWorkspaceNavigation {
  connectionId?: string;
  workspaceId?: string;
  workspaceTargetGeneration: number;
  selectionGeneration: number;
  roomId?: string;
}

/**
 * Returns whether a request captured before an asynchronous boundary still
 * belongs to the active navigation. A missing `roomId` deliberately denotes
 * a Workspace-scoped request, not an unspecified Room request.
 */
export function workspaceNavigationSnapshotIsCurrent(
  snapshot: WorkspaceNavigationSnapshot,
  active: ActiveWorkspaceNavigation
): boolean {
  if (active.connectionId !== snapshot.connectionId
    || active.workspaceId !== snapshot.workspaceId
    || active.workspaceTargetGeneration !== snapshot.workspaceTargetGeneration) {
    return false;
  }
  return snapshot.roomId === undefined
    || (active.selectionGeneration === snapshot.selectionGeneration && active.roomId === snapshot.roomId);
}
