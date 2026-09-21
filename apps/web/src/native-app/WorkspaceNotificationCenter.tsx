import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountInvitationNotificationListInput,
  AccountWorkspaceNotificationSummaries,
  AccountWorkspaceNotificationSummariesInput,
  DesktopWorkspaceTarget,
  WorkspaceContextTarget,
  WorkspaceNotification,
  WorkspaceNotificationListInput,
  WorkspaceNotificationMarkReadResult,
  WorkspaceNotificationPage,
  WorkspaceNotificationSummary
} from "../lib/api";
import {
  contextTargetRoomId,
  isWorkspaceNotificationUnread,
  mergeWorkspaceNotifications,
  workspaceContextDateLabel,
  workspaceContextTargetKey,
  workspaceNotificationViewState,
  workspaceNotificationKindLabel,
  workspaceNotificationReadOperationId
} from "./workspace-context-ui-helpers";

export interface WorkspaceNotificationCenterProps {
  /** The parent owns the bridge/API connection and supplies the selected target. */
  target?: DesktopWorkspaceTarget;
  workspaceName?: string;
  workspaceIds?: readonly string[];
  workspaceLabels?: Readonly<Record<string, string>>;
  open?: boolean;
  onClose?: () => void;
  /** Only authorized Room navigation is exposed; invitations have no accept action here. */
  onOpenRoom?: (roomId: string) => void;
  /** Optional richer target navigation supplied by the parent; invitation targets are never sent here. */
  onOpenTarget?: (target: WorkspaceContextTarget) => void;
  listWorkspaceNotifications?: (input?: WorkspaceNotificationListInput) => Promise<WorkspaceNotificationPage>;
  getWorkspaceNotificationSummary?: (input?: { target?: DesktopWorkspaceTarget }) => Promise<WorkspaceNotificationSummary>;
  markWorkspaceNotificationsRead?: (input: {
    notificationIds: string[];
    operationId: string;
    target?: DesktopWorkspaceTarget;
  }) => Promise<WorkspaceNotificationMarkReadResult>;
  getAccountWorkspaceNotificationSummaries?: (
    input: AccountWorkspaceNotificationSummariesInput
  ) => Promise<AccountWorkspaceNotificationSummaries>;
  listAccountInvitationNotifications?: (
    input?: AccountInvitationNotificationListInput
  ) => Promise<WorkspaceNotificationPage>;
  markAccountInvitationNotificationsRead?: (input: {
    notificationIds: string[];
    operationId: string;
    target?: DesktopWorkspaceTarget;
  }) => Promise<WorkspaceNotificationMarkReadResult>;
}

type NotificationScope = "workspace" | "account";
type NotificationSummaryState = "available" | "unknown" | "not_requested";

const emptyWorkspaceIds: readonly string[] = [];

export function WorkspaceNotificationCenter({
  target,
  workspaceName = "現在のWorkspace",
  workspaceIds = emptyWorkspaceIds,
  workspaceLabels,
  open = true,
  onClose,
  onOpenRoom,
  onOpenTarget,
  listWorkspaceNotifications,
  getWorkspaceNotificationSummary,
  markWorkspaceNotificationsRead,
  getAccountWorkspaceNotificationSummaries,
  listAccountInvitationNotifications,
  markAccountInvitationNotificationsRead
}: WorkspaceNotificationCenterProps) {
  const [workspaceItems, setWorkspaceItems] = useState<WorkspaceNotification[]>([]);
  const [workspaceNextCursor, setWorkspaceNextCursor] = useState<string | null>(null);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceNotificationSummary | null>(null);
  const [summaryState, setSummaryState] = useState<NotificationSummaryState>("not_requested");
  const [accountSummaries, setAccountSummaries] = useState<AccountWorkspaceNotificationSummaries["items"]>([]);
  const [invitationItems, setInvitationItems] = useState<WorkspaceNotification[]>([]);
  const [invitationNextCursor, setInvitationNextCursor] = useState<string | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKeys, setBusyKeys] = useState<Set<string>>(() => new Set());
  const loadSequence = useRef(0);
  const targetKey = workspaceContextTargetKey(target);
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const workspaceIdsKey = useMemo(() => workspaceIds.join("\n"), [workspaceIds]);
  const workspaceIdsForLoad = useMemo(() => [...workspaceIds], [workspaceIdsKey]);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    const requestTargetKey = targetKey;
    setLoading(true);
    setError(null);
    setNotice(null);
    setWorkspaceItems([]);
    setWorkspaceNextCursor(null);
    setWorkspaceSummary(null);
    setSummaryState(target && getWorkspaceNotificationSummary ? "unknown" : "not_requested");
    setAccountSummaries([]);
    setInvitationItems([]);
    setInvitationNextCursor(null);

    const workspacePromise: Promise<WorkspaceNotificationPage | null> = target && listWorkspaceNotifications
      ? listWorkspaceNotifications({ unreadOnly, limit: 50, target })
      : Promise.resolve(null);
    const summaryPromise: Promise<WorkspaceNotificationSummary | null> = target && getWorkspaceNotificationSummary
      ? getWorkspaceNotificationSummary({ target })
      : Promise.resolve(null);
    const accountPromise: Promise<AccountWorkspaceNotificationSummaries | null> = getAccountWorkspaceNotificationSummaries && workspaceIdsForLoad.length > 0
      ? getAccountWorkspaceNotificationSummaries({
        workspaceIds: workspaceIdsForLoad,
        ...(target ? { target } : {})
      })
      : Promise.resolve(null);
    const invitationPromise: Promise<WorkspaceNotificationPage | null> = listAccountInvitationNotifications
      ? listAccountInvitationNotifications({ limit: 50, ...(target ? { target } : {}) })
      : Promise.resolve(null);

    const [workspaceResult, summaryResult, accountResult, invitationResult] = await Promise.allSettled([
      workspacePromise,
      summaryPromise,
      accountPromise,
      invitationPromise
    ]);
    if (sequence !== loadSequence.current || targetKeyRef.current !== requestTargetKey) return;

    const failures = [workspaceResult, summaryResult, accountResult, invitationResult]
      .filter((result) => result.status === "rejected").length;
    if (workspaceResult.status === "fulfilled" && workspaceResult.value) {
      setWorkspaceItems(workspaceResult.value.items);
      setWorkspaceNextCursor(workspaceResult.value.nextCursor);
    }
    if (summaryResult.status === "fulfilled" && summaryResult.value) {
      setWorkspaceSummary(summaryResult.value);
      setSummaryState("available");
    }
    if (accountResult.status === "fulfilled" && accountResult.value) setAccountSummaries(accountResult.value.items);
    if (invitationResult.status === "fulfilled" && invitationResult.value) {
      setInvitationItems(invitationResult.value.items);
      setInvitationNextCursor(invitationResult.value.nextCursor);
    }
    if (failures > 0) {
      setError("通知を取得できませんでした。接続と権限を確認して、もう一度お試しください。");
    }
    setLoading(false);
  }, [
    getAccountWorkspaceNotificationSummaries,
    getWorkspaceNotificationSummary,
    listAccountInvitationNotifications,
    listWorkspaceNotifications,
    target,
    targetKey,
    unreadOnly,
    workspaceIdsKey,
    workspaceIdsForLoad
  ]);

  useEffect(() => {
    if (!open) {
      loadSequence.current += 1;
      return;
    }
    void load();
  }, [load, open]);

  const loadMoreWorkspace = useCallback(async (): Promise<void> => {
    if (!target || !listWorkspaceNotifications || !workspaceNextCursor || loading) return;
    const sequence = ++loadSequence.current;
    const requestTargetKey = targetKey;
    setLoading(true);
    try {
      const response = await listWorkspaceNotifications({
        unreadOnly,
        limit: 50,
        cursor: workspaceNextCursor,
        target
      });
      if (sequence !== loadSequence.current || targetKeyRef.current !== requestTargetKey) return;
      setWorkspaceItems((current) => mergeWorkspaceNotifications(current, response.items));
      setWorkspaceNextCursor(response.nextCursor);
    } catch {
      if (sequence === loadSequence.current && targetKeyRef.current === requestTargetKey) {
        setError("通知を追加で取得できませんでした。");
      }
    } finally {
      if (sequence === loadSequence.current && targetKeyRef.current === requestTargetKey) setLoading(false);
    }
  }, [listWorkspaceNotifications, loading, target, targetKey, unreadOnly, workspaceNextCursor]);

  const loadMoreInvitations = useCallback(async (): Promise<void> => {
    if (!listAccountInvitationNotifications || !invitationNextCursor || loading) return;
    const sequence = ++loadSequence.current;
    const requestTargetKey = targetKey;
    setLoading(true);
    try {
      const response = await listAccountInvitationNotifications({
        limit: 50,
        cursor: invitationNextCursor,
        ...(target ? { target } : {})
      });
      if (sequence !== loadSequence.current || targetKeyRef.current !== requestTargetKey) return;
      setInvitationItems((current) => mergeWorkspaceNotifications(current, response.items));
      setInvitationNextCursor(response.nextCursor);
    } catch {
      if (sequence === loadSequence.current && targetKeyRef.current === requestTargetKey) {
        setError("招待通知を追加で取得できませんでした。");
      }
    } finally {
      if (sequence === loadSequence.current && targetKeyRef.current === requestTargetKey) setLoading(false);
    }
  }, [invitationNextCursor, listAccountInvitationNotifications, loading, target, targetKey]);

  const markRead = useCallback(async (scope: NotificationScope, notifications: readonly WorkspaceNotification[]): Promise<boolean> => {
    const unread = notifications.filter(isWorkspaceNotificationUnread);
    if (unread.length === 0) return true;
    const ids = [...new Set(unread.map((notification) => notification.id))];
    const mark = scope === "workspace" ? markWorkspaceNotificationsRead : markAccountInvitationNotificationsRead;
    if (!mark) {
      setError(scope === "workspace" ? "このWorkspaceでは既読操作を利用できません。" : "招待通知の既読操作を利用できません。");
      return false;
    }
    const busyPrefix = `${scope}:`;
    const busyIds = ids.map((id) => `${busyPrefix}${id}`);
    const requestTargetKey = targetKey;
    setBusyKeys((current) => new Set([...current, ...busyIds]));
    try {
      const result = await mark({
        notificationIds: ids,
        operationId: workspaceNotificationReadOperationId(scope),
        ...(target ? { target } : {})
      });
      if (targetKeyRef.current !== requestTargetKey) return false;
      const readIds = new Set([...result.updatedIds, ...result.alreadyReadIds]);
      if (scope === "workspace") {
        setWorkspaceItems((current) => current.map((notification) => readIds.has(notification.id)
          ? { ...notification, readAt: result.readAt }
          : notification));
        const newlyRead = workspaceItems.filter((notification) => readIds.has(notification.id) && isWorkspaceNotificationUnread(notification)).length;
        setWorkspaceSummary((current) => current
          ? { ...current, unreadCount: Math.max(0, current.unreadCount - newlyRead), asOf: result.readAt }
          : current);
      } else {
        setInvitationItems((current) => current.map((notification) => readIds.has(notification.id)
          ? { ...notification, readAt: result.readAt }
          : notification));
      }
      setNotice(`${ids.length}件を既読にしました。`);
      setError(null);
      return true;
    } catch {
      if (targetKeyRef.current === requestTargetKey) {
        setError(scope === "workspace" ? "通知を既読にできませんでした。" : "招待通知を既読にできませんでした。");
      }
      return false;
    } finally {
      setBusyKeys((current) => {
        const next = new Set(current);
        busyIds.forEach((id) => next.delete(id));
        return next;
      });
    }
  }, [markAccountInvitationNotificationsRead, markWorkspaceNotificationsRead, target, targetKey, workspaceItems]);

  const markAllWorkspaceRead = () => void markRead("workspace", workspaceItems);
  const markAllInvitationsRead = () => void markRead("account", invitationItems);

  const openWorkspaceNotification = async (notification: WorkspaceNotification) => {
    if (isWorkspaceNotificationUnread(notification) && !(await markRead("workspace", [notification]))) return;
    if (notification.target && notification.target.kind !== "invitation" && onOpenTarget) {
      onOpenTarget(notification.target);
      return;
    }
    const roomId = contextTargetRoomId(notification.target);
    if (roomId && onOpenRoom) onOpenRoom(roomId);
  };

  const markInvitation = (notification: WorkspaceNotification) => void markRead("account", [notification]);

  if (!open) return null;

  const currentUnreadCount = workspaceSummary?.unreadCount ?? workspaceItems.filter(isWorkspaceNotificationUnread).length;
  const unreadLabel = summaryState === "unknown" && target ? "未確認" : `${currentUnreadCount}件`;
  const hasWorkspaceApi = Boolean(target && listWorkspaceNotifications);
  const hasAccountContent = Boolean(getAccountWorkspaceNotificationSummaries && workspaceIds.length) || Boolean(listAccountInvitationNotifications);
  const workspaceViewState = workspaceNotificationViewState({
    loading,
    error,
    itemCount: workspaceItems.length
  });

  return <>
    <style>{workspaceNotificationCenterStyles}</style>
    <section className="native-workspace-notification-center" role="dialog" aria-modal="true" aria-labelledby="native-workspace-notification-center-title" aria-busy={loading}>
      <div className="native-workspace-notification-center__header">
        <div>
          <span className="native-section-eyebrow">Workspace context</span>
          <h2 id="native-workspace-notification-center-title">通知 — {workspaceName}</h2>
          <p className="native-workspace-notification-center__scope">{workspaceName}</p>
        </div>
        {onClose ? <button className="native-icon-button" type="button" onClick={onClose} aria-label="通知を閉じる">×</button> : null}
      </div>

      <div className="native-workspace-notification-center__status" aria-live="polite">
        {loading ? <p role="status">通知を読み込んでいます…</p> : null}
        {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
      </div>

      <section className="native-workspace-notification-center__section" aria-labelledby="native-workspace-notification-center-workspace-title">
        <div className="native-workspace-notification-center__section-header">
          <div>
            <h3 id="native-workspace-notification-center-workspace-title">このWorkspace</h3>
            <span className="native-workspace-notification-center__count">未読 {unreadLabel}</span>
          </div>
          <div className="native-workspace-notification-center__actions">
            <button type="button" className="native-button native-button-quiet" aria-pressed={unreadOnly} onClick={() => setUnreadOnly((current) => !current)} disabled={!hasWorkspaceApi}>
              {unreadOnly ? "すべて表示" : "未読のみ"}
            </button>
            <button type="button" className="native-button native-button-quiet" onClick={markAllWorkspaceRead} disabled={!workspaceItems.some(isWorkspaceNotificationUnread) || busyKeys.size > 0}>
              すべて既読
            </button>
          </div>
        </div>
        {!target ? <p className="native-workspace-notification-center__note" role="status">Workspaceを選択するとWorkspace通知を表示できます。</p> : null}
        {target && !listWorkspaceNotifications ? <p className="native-workspace-notification-center__note" role="status">Workspace通知はまだ利用できません。</p> : null}
        {target && listWorkspaceNotifications && workspaceViewState === "empty" ? <p className="native-workspace-notification-center__note" role="status">通知はありません。</p> : null}
        {workspaceItems.length > 0 ? <ul className="native-workspace-notification-center__list" aria-label="Workspace通知一覧">
          {workspaceItems.map((notification) => {
            const unread = isWorkspaceNotificationUnread(notification);
            const roomId = contextTargetRoomId(notification.target);
            const busy = busyKeys.has(`workspace:${notification.id}`);
            return <li className={unread ? "native-workspace-notification-center__item is-unread" : "native-workspace-notification-center__item"} key={notification.id}>
              <button
                type="button"
                className="native-workspace-notification-center__notification"
                onClick={() => void openWorkspaceNotification(notification)}
                aria-label={`${notification.title}${unread ? "（未読）" : ""}${roomId ? "をRoomで開く" : ""}`}
                disabled={busy}
              >
                <span className="native-workspace-notification-center__kind">{workspaceNotificationKindLabel(notification.kind)}</span>
                <strong>{notification.title}</strong>
                <span>{notification.summary}</span>
                <time dateTime={notification.createdAt}>{workspaceContextDateLabel(notification.createdAt)}</time>
                {notification.actionState === "resolved" ? <span className="native-workspace-notification-center__state">対応済み</span> : null}
              </button>
              {unread ? <button type="button" className="native-workspace-notification-center__read" onClick={() => void markRead("workspace", [notification])} disabled={busy}>既読にする</button> : null}
            </li>;
          })}
        </ul> : null}
        {workspaceNextCursor ? <button type="button" className="native-button native-workspace-notification-center__more" onClick={() => void loadMoreWorkspace()} disabled={loading}>さらに表示</button> : null}
      </section>

      {hasAccountContent ? <section className="native-workspace-notification-center__section" aria-labelledby="native-workspace-notification-center-account-title">
        <div className="native-workspace-notification-center__section-header">
          <div>
            <h3 id="native-workspace-notification-center-account-title">Account横断</h3>
            <span className="native-workspace-notification-center__count">Workspace別の未読</span>
          </div>
        </div>
        {accountSummaries.length > 0 ? <ul className="native-workspace-notification-center__summary-list" aria-label="Workspace別通知の未読件数">
          {accountSummaries.map((summary) => <li key={summary.workspaceId}>
            <span>{workspaceLabels?.[summary.workspaceId] ?? "別のWorkspace"}</span>
            <strong>{summary.unreadCount}件</strong>
            <time dateTime={summary.asOf}>{workspaceContextDateLabel(summary.asOf)}</time>
          </li>)}
        </ul> : <p className="native-workspace-notification-center__note">横断通知はありません。</p>}
      </section> : null}

      {listAccountInvitationNotifications ? <section className="native-workspace-notification-center__section" aria-labelledby="native-workspace-notification-center-invitation-title">
        <div className="native-workspace-notification-center__section-header">
          <div>
            <h3 id="native-workspace-notification-center-invitation-title">招待</h3>
            <span className="native-workspace-notification-center__count">別セクションで安全に表示</span>
          </div>
          <button type="button" className="native-button native-button-quiet" onClick={markAllInvitationsRead} disabled={!invitationItems.some(isWorkspaceNotificationUnread) || busyKeys.size > 0}>すべて既読</button>
        </div>
        {invitationItems.length > 0 ? <ul className="native-workspace-notification-center__list" aria-label="Account招待通知一覧">
          {invitationItems.map((notification) => {
            const unread = isWorkspaceNotificationUnread(notification);
            const busy = busyKeys.has(`account:${notification.id}`);
            return <li className={unread ? "native-workspace-notification-center__item is-unread" : "native-workspace-notification-center__item"} key={notification.id}>
              <div className="native-workspace-notification-center__notification native-workspace-notification-center__invitation">
                <span className="native-workspace-notification-center__kind">{workspaceNotificationKindLabel(notification.kind)}</span>
                <strong>{notification.title}</strong>
                <span>{notification.summary}</span>
                <time dateTime={notification.createdAt}>{workspaceContextDateLabel(notification.createdAt)}</time>
              </div>
              {unread ? <button type="button" className="native-workspace-notification-center__read" onClick={() => markInvitation(notification)} disabled={busy}>既読にする</button> : null}
            </li>;
          })}
        </ul> : <p className="native-workspace-notification-center__note">招待通知はありません。</p>}
        {invitationNextCursor ? <button type="button" className="native-button native-workspace-notification-center__more" onClick={() => void loadMoreInvitations()} disabled={loading}>招待をさらに表示</button> : null}
      </section> : null}
    </section>
  </>;
}

const workspaceNotificationCenterStyles = `
.native-workspace-notification-center { width: min(720px, calc(100vw - 32px)); max-height: min(800px, calc(100vh - 32px)); overflow: auto; padding: 20px 24px; border: 1px solid var(--native-line, rgba(255,255,255,.09)); border-radius: 10px; background: var(--native-surface, #171717); color: var(--native-copy, #eeeeee); box-shadow: none; }
.native-workspace-notification-center__header, .native-workspace-notification-center__section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.native-workspace-notification-center h2 { margin: 5px 0 4px; font-size: 18px; font-weight: 600; line-height: 1.3; }
.native-workspace-notification-center h3 { margin: 0; font-size: 14px; }
.native-workspace-notification-center__scope, .native-workspace-notification-center__note, .native-workspace-notification-center__count { color: var(--native-muted, #b2b2b2); font-size: 12px; }
.native-workspace-notification-center__scope { margin: 0; }
.native-workspace-notification-center__status { min-height: 26px; margin-top: 15px; }
.native-workspace-notification-center__status p { margin: 0; }
.native-workspace-notification-center__section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--native-line, rgba(255,255,255,.09)); }
.native-workspace-notification-center__section-header { align-items: center; }
.native-workspace-notification-center__section-header > div:first-child { display: grid; gap: 4px; }
.native-workspace-notification-center__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.native-workspace-notification-center__list, .native-workspace-notification-center__summary-list { display: grid; gap: 8px; padding: 0; margin: 14px 0 0; list-style: none; }
.native-workspace-notification-center__item { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 10px; border: 1px solid var(--native-line, rgba(255,255,255,.09)); border-radius: 9px; background: var(--native-surface-soft, #1c1c1c); }
.native-workspace-notification-center__item.is-unread { border-color: rgba(var(--native-accent-rgb, 214, 214, 214), .32); background: rgba(var(--native-accent-rgb, 214, 214, 214), .08); }
.native-workspace-notification-center__notification { display: grid; gap: 5px; width: 100%; padding: 0; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.native-workspace-notification-center__notification:focus-visible, .native-workspace-notification-center__read:focus-visible, .native-workspace-notification-center__more:focus-visible { outline: 2px solid var(--native-accent, #d6d6d6); outline-offset: 2px; }
.native-workspace-notification-center__notification:hover strong { color: var(--native-accent, #d6d6d6); }
.native-workspace-notification-center__invitation { cursor: default; }
.native-workspace-notification-center__kind { color: var(--native-accent, #d6d6d6); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.native-workspace-notification-center__notification > span:not(.native-workspace-notification-center__kind), .native-workspace-notification-center__notification time { color: var(--native-muted, #b2b2b2); font-size: 12px; }
.native-workspace-notification-center__state { color: var(--native-dim, #858585); font-size: 12px; }
.native-workspace-notification-center__read { align-self: center; min-height: 32px; padding: 6px 8px; border: 1px solid var(--native-line-strong, rgba(255,255,255,.18)); border-radius: 7px; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
.native-workspace-notification-center__summary-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: baseline; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.04); }
.native-workspace-notification-center__summary-list strong, .native-workspace-notification-center__summary-list time { font-size: 12px; color: var(--native-muted, #b2b2b2); }
.native-workspace-notification-center__more { width: 100%; margin-top: 12px; }
@media (max-width: 620px) { .native-workspace-notification-center { padding: 16px; border-radius: 9px; } .native-workspace-notification-center__section-header { align-items: flex-start; flex-direction: column; } .native-workspace-notification-center__actions { justify-content: flex-start; } .native-workspace-notification-center__item { grid-template-columns: 1fr; } .native-workspace-notification-center__read { justify-self: start; } .native-workspace-notification-center__summary-list li { grid-template-columns: 1fr auto; } }
`;

export default WorkspaceNotificationCenter;
