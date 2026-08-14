export interface WorkspaceRoomTreeItem {
  id: string;
  parentRoomId?: string;
  name: string;
}

export interface WorkspaceRoomTreeNode<T extends WorkspaceRoomTreeItem = WorkspaceRoomTreeItem> {
  room: T;
  children: WorkspaceRoomTreeNode<T>[];
}

/**
 * The server returns only Rooms the Account can read.  This helper never
 * creates placeholder parents or hidden-count markers from missing rows.
 */
export function buildWorkspaceRoomTree<T extends WorkspaceRoomTreeItem>(rooms: readonly T[]): WorkspaceRoomTreeNode<T>[] {
  const nodes = new Map<string, WorkspaceRoomTreeNode<T>>();
  for (const room of rooms) nodes.set(room.id, { room, children: [] });
  const roots: WorkspaceRoomTreeNode<T>[] = [];
  for (const room of rooms) {
    const node = nodes.get(room.id);
    if (!node) continue;
    const parent = room.parentRoomId ? nodes.get(room.parentRoomId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const compare = (left: WorkspaceRoomTreeNode<T>, right: WorkspaceRoomTreeNode<T>): number =>
    left.room.name.localeCompare(right.room.name) || left.room.id.localeCompare(right.room.id);
  roots.sort(compare);
  // Use an explicit stack so UI presentation adds no smaller artificial
  // hierarchy cap than the Room model itself.
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    node.children.sort(compare);
    pending.push(...node.children);
  }
  return roots;
}

export function workspaceRoomPath<T extends WorkspaceRoomTreeItem>(rooms: readonly T[], roomId: string | undefined): T[] {
  if (!roomId) return [];
  const byId = new Map(rooms.map((room) => [room.id, room]));
  const path: T[] = [];
  const visited = new Set<string>();
  let current = byId.get(roomId);
  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentRoomId ? byId.get(current.parentRoomId) : undefined;
  }
  return path;
}
