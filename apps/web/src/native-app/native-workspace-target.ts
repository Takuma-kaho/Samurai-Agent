import type {
  DesktopWorkspaceConnectionState,
  DesktopWorkspaceTarget
} from "../lib/api";
import type { NativeWorkspaceTarget } from "./types";

export { nativeWorkspaceTargetKey } from "./types";

/** The smallest Desktop bridge surface needed to guard an asynchronous call. */
export interface NativeWorkspaceTargetGuardBridge {
  listWorkspaceConnections?: () => Promise<DesktopWorkspaceConnectionState>;
}

/**
 * Returns the authenticated Desktop target, including support for the older
 * connection-only connection-state projection.  A caller must still compare
 * this result with its own captured target before using an async response.
 */
export function activeNativeWorkspaceTarget(
  state: DesktopWorkspaceConnectionState
): NativeWorkspaceTarget | undefined {
  if (state.activeTarget?.connectionId && state.activeTarget.workspaceId) {
    return workspaceTarget(state.activeTarget);
  }
  if (!state.activeConnectionId) return undefined;
  const connection = state.connections.find((candidate) => candidate.id === state.activeConnectionId);
  return connection?.workspaceId
    ? { connectionId: connection.id, workspaceId: connection.workspaceId }
    : undefined;
}

/**
 * Existing Browser/Desktop bridge calls resolve against the active target.
 * Check before and after every scoped request so a response cannot be
 * rendered into a Room that was selected while it was in flight.
 */
export async function assertNativeWorkspaceTarget(
  bridge: NativeWorkspaceTargetGuardBridge,
  target: NativeWorkspaceTarget
): Promise<void> {
  if (!bridge.listWorkspaceConnections) throw new Error("workspace_target_guard_unavailable");
  const active = activeNativeWorkspaceTarget(await bridge.listWorkspaceConnections());
  if (!active) throw new Error("workspace_target_unavailable");
  if (active.connectionId !== target.connectionId || active.workspaceId !== target.workspaceId) {
    throw new Error("workspace_navigation_changed");
  }
}

export async function withNativeWorkspaceTarget<T>(
  bridge: NativeWorkspaceTargetGuardBridge,
  target: NativeWorkspaceTarget,
  task: () => Promise<T>
): Promise<T> {
  await assertNativeWorkspaceTarget(bridge, target);
  const result = await task();
  await assertNativeWorkspaceTarget(bridge, target);
  return result;
}

function workspaceTarget(target: DesktopWorkspaceTarget): NativeWorkspaceTarget {
  return { connectionId: target.connectionId, workspaceId: target.workspaceId };
}
