import type {
  DesktopWorkspaceTarget,
  WorkspaceContextSearchType,
  WorkspaceContextTarget,
  WorkspaceNotification
} from "../lib/api";

export const workspaceContextSearchTypes: readonly WorkspaceContextSearchType[] = [
  "room",
  "conversation",
  "knowledge"
];

/** Keep async UI requests bound to the full selected Server/Workspace target. */
export function workspaceContextTargetKey(target: DesktopWorkspaceTarget | undefined): string {
  if (!target) return "none";
  return [target.connectionId, target.workspaceId, target.roomId ?? "", target.selectionGeneration ?? ""].join("\n");
}

/** Search and notification targets may open a Room, but never accept an invitation. */
export function contextTargetRoomId(target: WorkspaceContextTarget | null | undefined): string | undefined {
  if (!target || target.kind === "invitation") return undefined;
  return target.roomId;
}

export function isWorkspaceNotificationUnread(notification: Pick<WorkspaceNotification, "readAt" | "actionState">): boolean {
  return notification.readAt === null && notification.actionState !== "resolved";
}

export function workspaceNotificationKindLabel(kind: string): string {
  switch (kind) {
    case "work_completed": return "仕事の完了";
    case "work_failed": return "仕事の失敗";
    case "approval_required": return "承認待ち";
    case "input_required": return "入力待ち";
    case "workspace_invitation": return "Workspace招待";
    case "organization_invitation": return "Organization招待";
    default: return "通知";
  }
}

export function workspaceContextDateLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

/** `undefined` means all types, matching the public bridge contract. */
export function toggleWorkspaceContextSearchType(
  current: readonly WorkspaceContextSearchType[] | undefined,
  type: WorkspaceContextSearchType
): WorkspaceContextSearchType[] {
  const selected = current ? [...current] : [...workspaceContextSearchTypes];
  const next = selected.includes(type)
    ? selected.filter((candidate) => candidate !== type)
    : [...selected, type];
  return next.length === 0 ? [...workspaceContextSearchTypes] : next;
}

export function searchTypesAreAllSelected(types: readonly WorkspaceContextSearchType[] | undefined): boolean {
  return types === undefined || workspaceContextSearchTypes.every((type) => types.includes(type));
}

export type WorkspaceContextSearchViewState = "idle" | "loading" | "empty" | "error" | "ready";

export function workspaceContextSearchViewState(input: {
  loading: boolean;
  error: string | null;
  query: string;
  hasTarget: boolean;
  itemCount: number;
}): WorkspaceContextSearchViewState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (!input.hasTarget || !input.query.trim()) return "idle";
  if (input.itemCount === 0) return "empty";
  return "ready";
}

export type WorkspaceNotificationViewState = "loading" | "error" | "empty" | "ready";

export function workspaceNotificationViewState(input: {
  loading: boolean;
  error: string | null;
  itemCount: number;
}): WorkspaceNotificationViewState {
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.itemCount === 0) return "empty";
  return "ready";
}

export function mergeWorkspaceNotifications(
  current: readonly WorkspaceNotification[],
  next: readonly WorkspaceNotification[]
): WorkspaceNotification[] {
  const merged = new Map(current.map((notification) => [notification.id, notification]));
  next.forEach((notification) => merged.set(notification.id, notification));
  return [...merged.values()];
}

let readOperationSequence = 0;

/** Generates a transport id only; it never encodes a target or notification body. */
export function workspaceNotificationReadOperationId(scope: "workspace" | "account" = "workspace"): string {
  readOperationSequence = (readOperationSequence + 1) % 1_000_000;
  return `native-${scope}-notification-read-${Date.now()}-${readOperationSequence}`;
}
