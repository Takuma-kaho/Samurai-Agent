import { useId, useMemo, type FormEvent, type ReactNode, type ReactElement } from "react";
import {
  useNativeRoomAdministration,
  WORKSPACE_ROOT_VALUE,
  type NativeRoomAdministrationDraftState,
  type NativeRoomAdministrationRole,
  type UseNativeRoomAdministrationOptions
} from "./use-native-room-administration";
import type { NativeRoom } from "./types";
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";
import { useNativeDraftNavigation, type NativeDraftNavigationController } from "./use-native-draft-navigation";
import type { NativeRoomParticipant } from "./use-native-room-participants";

export type NativeRoomAdministrationView = "menu" | "participants" | "create" | "move" | "rename";

export interface NativeRoomAdministrationProps extends UseNativeRoomAdministrationOptions {
  /** Returns to the Room without replacing the Room Work draft. */
  onClose?: () => void;
  /** Parent navigation guard receives this panel's draft and saving state. */
  onDraftStateChange?: (state: NativeRoomAdministrationDraftState) => void;
  onDraftNavigationControllerChange?: (controller: NativeDraftNavigationController | undefined) => void;
  /** The compact panel mode opened by the shell. */
  view?: NativeRoomAdministrationView;
  /** Kept for callers that still persist the former selection. No tab UI is rendered. */
  initialTab?: NativeRoomAdministrationTab;
  /** Kept for source compatibility with the former tabbed panel. */
  onTabChange?: (tab: NativeRoomAdministrationTab) => void;
  /** Parent Room for a context-menu child creation flow. */
  createParentRoomId?: string;
  /** Existing Room actions opened by the shell. */
  onOpenShare?: () => void;
  onOpenKnowledge?: () => void;
  onOpenLearning?: () => void;
  onOpenSharing?: () => void;
  /** Existing Agent management surface; it is shown inside the unified participant view. */
  agentPanel?: ReactNode;
  /** Legacy panel props remain accepted while the shell migrates to callbacks. */
  knowledgePanel?: ReactNode;
  learningPanel?: ReactNode;
  sharingPanel?: ReactNode;
  /** Authorized participant projection from the Room header. */
  participants?: readonly NativeRoomParticipant[];
  participantsLoading?: boolean;
  participantsError?: string | null;
  /** Account display names must come from an authorized query. IDs are never used as the label fallback. */
  accountDisplayNames?: Readonly<Record<string, string | undefined>>;
}

export type NativeRoomAdministrationTab = "basic" | "participants" | "agent" | "knowledge" | "learning" | "sharing";

const roleLabels: Record<NativeRoomAdministrationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest"
};

function roomName(rooms: readonly NativeRoom[], targetWorkspaceId: string | undefined, roomId: string | undefined): string {
  if (!roomId) return "Workspace直下";
  const room = rooms.find((candidate) => candidate.id === roomId && candidate.workspaceId === targetWorkspaceId);
  return room?.name ?? "表示権限のあるRoom";
}

function roomListText(rooms: readonly NativeRoom[], workspaceId: string | undefined, roomIds: readonly string[]): string {
  if (roomIds.length === 0) return "なし";
  return roomIds.map((roomId) => roomName(rooms, workspaceId, roomId)).join("、");
}

function submit(event: FormEvent<HTMLFormElement>, action: () => void): void {
  event.preventDefault();
  action();
}

function MenuIcon({ kind }: { kind: "share" | "knowledge" | "learning" | "close" }): ReactElement {
  if (kind === "close") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
        <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "share") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
        <path d="M8 10V2m0 0L5 5m3-3 3 3M3.5 8.5v4A1.5 1.5 0 0 0 5 14h6a1.5 1.5 0 0 0 1.5-1.5v-4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "knowledge") {
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
        <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5A1.5 1.5 0 0 0 11.5 11h-7A1.5 1.5 0 0 0 3 12.5v-9Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <path d="M3 12.5A1.5 1.5 0 0 0 4.5 14H13" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
      <path d="M3 12.5h10M4 10V6m4 4V4m4 6V7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function PanelAction({
  icon,
  label,
  onClick
}: {
  icon: "share" | "knowledge" | "learning";
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button className="native-room-administration__action" type="button" onClick={onClick}>
      <MenuIcon kind={icon} />
      <span>{label}</span>
      <span className="native-room-administration__action-chevron" aria-hidden="true">›</span>
    </button>
  );
}

function participantLabel(
  accountId: string,
  index: number,
  displayNames: Readonly<Record<string, string | undefined>> | undefined
): { label: string; reason?: string } {
  const displayName = displayNames?.[accountId]?.trim();
  if (displayName) return { label: displayName };
  return { label: `参加者${index + 1}`, reason: "表示名未取得" };
}

function participantStateLabel(participant: NativeRoomParticipant): string {
  if (participant.kind === "agent") {
    return participant.state === "available" ? "Agent・利用可能" : participant.state === "revoked" ? "Agent・解除済み" : "Agent・利用不可";
  }
  return participant.state === "active" ? `${participant.role ?? "参加者"}・参加中` : "参加者・解除済み";
}

export function NativeRoomAdministration(props: NativeRoomAdministrationProps) {
  const admin = useNativeRoomAdministration({ ...props, createParentRoomId: props.createParentRoomId });
  const id = useId().replace(/:/g, "");
  const view = props.view ?? "menu";
  const currentRoom = admin.activeRoom;
  const normalRoom = Boolean(currentRoom && !admin.currentRoomIsDm);
  const destinationValue = admin.moveParentId ?? WORKSPACE_ROOT_VALUE;
  const canEdit = Boolean(normalRoom && admin.roomCanManage && admin.target && admin.currentRoomId);
  const movePreview = admin.movePreview;
  const memberPreview = admin.memberPreview;
  const draftNavigation = useNativeDraftNavigation({
    scopeKey: `room-administration\n${view}\n${admin.contextKey}`,
    label: "Roomメニュー",
    dirty: admin.draftDirty,
    saving: admin.saving,
    canSave: false,
    saveUnavailableMessage: "Room操作は確認後に個別保存されます。",
    discard: admin.discardDraft,
    onControllerChange: props.onDraftNavigationControllerChange
  });
  const requestClose = () => {
    if (props.onClose) draftNavigation.requestNavigation(props.onClose);
  };

  const participantRows = useMemo<NativeRoomParticipant[]>(() => {
    const memberById = new Map(admin.members.map((member) => [member.accountId, member]));
    const rows = new Map<string, NativeRoomParticipant>();
    let fallbackIndex = 0;
    for (const participant of props.participants ?? []) {
      if (participant.kind === "account") {
        const member = memberById.get(participant.id);
        const fallback = participantLabel(participant.id, fallbackIndex++, props.accountDisplayNames);
        const providedLabel = participant.label.trim();
        const authorizedLabel = props.accountDisplayNames?.[participant.id]?.trim();
        const safeLabel = authorizedLabel || (providedLabel && providedLabel !== participant.id ? providedLabel : fallback.label);
        rows.set(`account:${participant.id}`, {
          ...participant,
          label: safeLabel,
          ...(participant.reason || fallback.reason ? { reason: participant.reason ?? fallback.reason } : {}),
          ...(member?.role ? { role: member.role } : {})
        });
      } else {
        rows.set(`agent:${participant.id}`, participant);
      }
    }
    for (const member of admin.members) {
      if (rows.has(`account:${member.accountId}`)) continue;
      const fallback = participantLabel(member.accountId, fallbackIndex++, props.accountDisplayNames);
      rows.set(`account:${member.accountId}`, {
        id: member.accountId,
        kind: "account",
        label: props.accountDisplayNames?.[member.accountId]?.trim() || fallback.label,
        ...(fallback.reason ? { reason: fallback.reason } : {}),
        role: member.role,
        state: member.state
      });
    }
    return [...rows.values()];
  }, [admin.members, props.accountDisplayNames, props.participants]);

  return (
    <section className="native-room-administration" aria-labelledby={`${id}-title`}>
      <style>{`
        .native-room-administration { color: var(--native-copy, #e8e8e8); display: grid; gap: 12px; margin: 0 auto; max-width: 680px; padding: 16px; font-size: 14px; line-height: 1.45; }
        .native-room-administration *, .native-room-administration *::before, .native-room-administration *::after { box-sizing: border-box; }
        .native-room-administration__header, .native-room-administration__card { background: var(--native-surface, #171717); border: 1px solid var(--native-line, rgba(255, 255, 255, .12)); border-radius: 12px; padding: 16px; }
        .native-room-administration__header { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
        .native-room-administration__eyebrow { color: var(--native-muted, #9c9c9c); font-size: 12px; margin: 0; }
        .native-room-administration h1, .native-room-administration h2, .native-room-administration p { margin: 0; }
        .native-room-administration h1 { font: inherit; font-size: 18px; font-weight: 600; line-height: 1.25; }
        .native-room-administration h2 { font-size: 14px; font-weight: 600; }
        .native-room-administration p + p { margin-top: 6px; }
        .native-room-administration__context, .native-room-administration__muted { color: var(--native-muted, #9c9c9c); font-size: 13px; }
        .native-room-administration__context { margin-top: 4px !important; }
        .native-room-administration__close { align-items: center; background: transparent; border: 0; border-radius: 8px; color: var(--native-muted, #9c9c9c); display: inline-flex; flex: 0 0 auto; height: 32px; justify-content: center; width: 32px; }
        .native-room-administration__close:hover { background: var(--native-surface-raised, rgba(255, 255, 255, .08)); color: var(--native-copy, #e8e8e8); }
        .native-room-administration button { cursor: pointer; font: inherit; }
        .native-room-administration button:disabled { cursor: not-allowed; opacity: .55; }
        .native-room-administration button:focus-visible, .native-room-administration input:focus-visible, .native-room-administration select:focus-visible { outline: 2px solid var(--native-accent, #b8b8b8); outline-offset: 2px; }
        .native-room-administration__action-list { display: grid; gap: 2px; }
        .native-room-administration__action { align-items: center; background: transparent; border: 0; border-radius: 8px; color: var(--native-copy, #e8e8e8); display: flex; gap: 10px; min-height: 36px; padding: 8px 10px; text-align: left; width: 100%; }
        .native-room-administration__action:hover { background: var(--native-surface-raised, rgba(255, 255, 255, .08)); }
        .native-room-administration__action svg { color: var(--native-muted, #9c9c9c); flex: 0 0 auto; }
        .native-room-administration__action-chevron { color: var(--native-muted, #9c9c9c); margin-left: auto; }
        .native-room-administration__legacy-panel { border-top: 1px solid var(--native-line, rgba(255, 255, 255, .12)); margin-top: 8px; padding: 12px 10px 0; }
        .native-room-administration__stack { display: grid; gap: 9px; margin-top: 12px; }
        .native-room-administration label, .native-room-administration legend { color: var(--native-muted, #9c9c9c); font-size: 12px; }
        .native-room-administration input, .native-room-administration select { background: var(--native-surface-soft, rgba(255, 255, 255, .04)); border: 1px solid var(--native-line-strong, rgba(255, 255, 255, .2)); border-radius: 8px; color: inherit; font: inherit; margin-top: 3px; min-height: 34px; padding: 7px 9px; width: 100%; }
        .native-room-administration__primary, .native-room-administration__secondary { border-radius: 8px; font-size: 13px; font-weight: 600; min-height: 34px; padding: 7px 11px; }
        .native-room-administration__primary { background: var(--native-copy, #e8e8e8); border: 1px solid var(--native-copy, #e8e8e8); color: var(--native-frame, #171717); }
        .native-room-administration__secondary { background: var(--native-surface-soft, rgba(255, 255, 255, .04)); border: 1px solid var(--native-line-strong, rgba(255, 255, 255, .2)); color: var(--native-copy, #e8e8e8); }
        .native-room-administration__secondary:hover { background: var(--native-surface-raised, rgba(255, 255, 255, .08)); }
        .native-room-administration__member-list { display: grid; gap: 2px; list-style: none; margin: 12px 0 0; padding: 0; }
        .native-room-administration__member-row { align-items: center; border-bottom: 1px solid var(--native-line, rgba(255, 255, 255, .1)); display: flex; gap: 10px; justify-content: space-between; min-height: 40px; padding: 7px 0; }
        .native-room-administration__member-row:last-child { border-bottom: 0; }
        .native-room-administration__member-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .native-room-administration__member-kind, .native-room-administration__member-reason { color: var(--native-muted, #9c9c9c); font-size: 12px; }
        .native-room-administration__member-reason { display: block; }
        .native-room-administration__status, .native-room-administration__error, .native-room-administration__warning { border-left: 2px solid; font-size: 13px; padding: 2px 0 2px 9px; }
        .native-room-administration__status { border-color: var(--native-success, #8ac7a4); }
        .native-room-administration__error { border-color: var(--native-danger, #e48b8b); color: var(--native-danger, #e48b8b); }
        .native-room-administration__warning { border-color: var(--native-warning, #c9ad76); color: var(--native-warning, #c9ad76); }
        .native-room-administration__agent-panel { border-top: 1px solid var(--native-line, rgba(255, 255, 255, .12)); margin-top: 16px; padding-top: 16px; }
        .native-room-administration__disabled { cursor: not-allowed; opacity: .62; }
        @media (max-width: 580px) { .native-room-administration { padding: 12px; } .native-room-administration__member-row { align-items: flex-start; flex-direction: column; gap: 2px; } }
      `}</style>

      <header className="native-room-administration__header">
        <div>
          <p className="native-room-administration__eyebrow">Room</p>
          <h1 id={`${id}-title`}>{currentRoom?.name ?? "Room"}</h1>
          {currentRoom ? <p className="native-room-administration__context">{view === "menu" ? "Roomメニュー" : view === "participants" ? "参加者" : view === "create" ? "子Roomを作成" : view === "move" ? "Roomを移動" : "名前変更"}</p> : <p role="alert">現在のRoomとWorkspace targetを確認してください。</p>}
        </div>
        {props.onClose ? <button className="native-room-administration__close" type="button" onClick={requestClose} aria-label="Roomメニューを閉じる"><MenuIcon kind="close" /></button> : null}
      </header>
      <NativeDraftNavigationPrompt controller={draftNavigation} />
      {admin.actionError ? <p className="native-room-administration__error" role="alert">Server: {admin.actionError}</p> : null}

      {!currentRoom || !admin.target ? (
        <div className="native-room-administration__card"><p role="alert">Room操作には現在のRoomとWorkspace targetが必要です。</p></div>
      ) : view === "menu" ? (
        <section className="native-room-administration__card" aria-label="Roomメニュー">
          <div className="native-room-administration__action-list">
            {props.onOpenShare ? <PanelAction icon="share" label="共有" onClick={props.onOpenShare} /> : null}
            {props.onOpenKnowledge ? <PanelAction icon="knowledge" label="Knowledge" onClick={props.onOpenKnowledge} /> : null}
            {props.onOpenLearning ? <PanelAction icon="learning" label="学習" onClick={props.onOpenLearning} /> : null}
            {props.onOpenSharing ? <PanelAction icon="share" label="共有設定" onClick={props.onOpenSharing} /> : null}
          </div>
          {!props.onOpenKnowledge && props.knowledgePanel ? <details className="native-room-administration__legacy-panel"><summary>Knowledge</summary>{props.knowledgePanel}</details> : null}
          {!props.onOpenLearning && props.learningPanel ? <details className="native-room-administration__legacy-panel"><summary>学習</summary>{props.learningPanel}</details> : null}
          {!props.onOpenSharing && props.sharingPanel ? <details className="native-room-administration__legacy-panel"><summary>共有設定</summary>{props.sharingPanel}</details> : null}
          {!props.onOpenShare && !props.onOpenKnowledge && !props.onOpenLearning && !props.onOpenSharing && !props.knowledgePanel && !props.learningPanel && !props.sharingPanel ? <p className="native-room-administration__muted">利用できるRoom操作はありません。</p> : null}
        </section>
      ) : admin.currentRoomIsDm ? (
        <div className="native-room-administration__card">
          <h2>Agent DM</h2>
          <p className="native-room-administration__muted">Agent DMでは人間membershipの操作は利用できません。</p>
          {props.agentPanel ? <div className="native-room-administration__agent-panel">{props.agentPanel}</div> : null}
        </div>
      ) : view === "participants" ? (
        <section className="native-room-administration__card" aria-labelledby={`${id}-participants-title`}>
          <h2 id={`${id}-participants-title`}>参加者</h2>
          <p className="native-room-administration__muted">人とAgentを同じ一覧で確認できます。変更は既存のServer権限とOwner保護に従います。</p>
          {props.participantsLoading || admin.membersLoading ? <p role="status" aria-live="polite">読み込み中…</p> : null}
          {props.participantsError ? <p className="native-room-administration__error" role="alert">Server: {props.participantsError}</p> : null}
          {admin.membersError ? <p className="native-room-administration__error" role="alert">Server: {admin.membersError}</p> : null}
          {!props.participantsLoading && !admin.membersLoading && !props.participantsError && !admin.membersError && participantRows.length === 0 ? <p className="native-room-administration__muted">参加者を確認できません。</p> : null}
          <ul className="native-room-administration__member-list" aria-label="Roomの参加者">
            {participantRows.map((participant) => (
              <li className="native-room-administration__member-row" key={`${participant.kind}:${participant.id}`}>
                <span className="native-room-administration__member-name">
                  {participant.label}
                  {participant.reason ? <span className="native-room-administration__member-reason">{participant.reason}</span> : null}
                </span>
                <span className="native-room-administration__member-kind">{participantStateLabel(participant)}</span>
              </li>
            ))}
          </ul>
          {props.agentPanel ? <div className="native-room-administration__agent-panel"><h2>Agent操作</h2>{props.agentPanel}</div> : null}
          {canEdit ? (
            <form className="native-room-administration__stack" onSubmit={(event) => submit(event, () => void admin.previewMemberChange())}>
              <label htmlFor={`${id}-member-account`}>Account ID</label>
              <input id={`${id}-member-account`} value={admin.memberAccountId} onChange={(event) => admin.setMemberAccountId(event.currentTarget.value)} autoComplete="off" />
              <label htmlFor={`${id}-member-role`}>role</label>
              <select id={`${id}-member-role`} value={admin.memberRole} onChange={(event) => admin.setMemberRole(event.currentTarget.value as NativeRoomAdministrationRole)}>
                {Object.entries(roleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
              <label htmlFor={`${id}-member-state`}>membership状態</label>
              <select id={`${id}-member-state`} value={admin.memberState} onChange={(event) => admin.setMemberState(event.currentTarget.value as "active" | "revoked")}>
                <option value="active">参加</option>
                <option value="revoked">解除</option>
              </select>
              <button className="native-room-administration__secondary" type="submit" disabled={admin.busy || !admin.memberAccountId.trim()}>影響を確認</button>
              {memberPreview ? (
                <div className={memberPreview.allowed ? "native-room-administration__status" : "native-room-administration__error"} role={memberPreview.allowed ? "status" : "alert"} aria-live="polite">
                  <p>{memberPreview.allowed ? "この変更はServer確認済みです。" : `変更できません: ${memberPreview.reason ?? "Serverが許可しませんでした。"}`}</p>
                  <p>影響するRoom: {roomListText(props.rooms, admin.target.workspaceId, memberPreview.affectedRoomIds)}</p>
                  {memberPreview.blockingOwnerRoomIds.length > 0 ? <p className="native-room-administration__warning">最後のOwner保護により確認が必要なRoom: {roomListText(props.rooms, admin.target.workspaceId, memberPreview.blockingOwnerRoomIds)}</p> : null}
                  {memberPreview.allowed ? <button className="native-room-administration__primary" type="button" onClick={() => void admin.saveMemberChange()} disabled={admin.busy}>変更を保存</button> : null}
                </div>
              ) : null}
            </form>
          ) : <p className="native-room-administration__muted">このRoomのmembershipを変更する管理権限がありません。</p>}
        </section>
      ) : view === "create" ? (
        <section className="native-room-administration__card" aria-labelledby={`${id}-create-title`}>
          <h2 id={`${id}-create-title`}>子Roomを作成</h2>
          <p className="native-room-administration__muted">作成先: {roomName(props.rooms, admin.target.workspaceId, admin.createParentRoomId ?? admin.currentRoomId)}</p>
          {canEdit && admin.workspaceVersion && admin.createParentRoomId ? (
            <form className="native-room-administration__stack" onSubmit={(event) => submit(event, () => void admin.createChildRoom())}>
              <label htmlFor={`${id}-create-name`}>子Room名</label>
              <input id={`${id}-create-name`} value={admin.createName} onChange={(event) => admin.setCreateName(event.currentTarget.value)} autoComplete="off" />
              <button className="native-room-administration__primary" type="submit" disabled={admin.busy || !admin.createName.trim()}>作成</button>
            </form>
          ) : <p className="native-room-administration__muted">作成権限、作成先、target、またはWorkspace versionが確認できません。</p>}
        </section>
      ) : view === "move" ? (
        <section className="native-room-administration__card" aria-labelledby={`${id}-move-title`}>
          <h2 id={`${id}-move-title`}>Roomを移動</h2>
          <p className="native-room-administration__muted">移動先と影響を先に確認します。Knowledgeとmembershipは自動変更しません。</p>
          {canEdit && admin.hasMoveDestination ? (
            <div className="native-room-administration__stack">
              <label htmlFor={`${id}-move-parent`}>移動先</label>
              <select id={`${id}-move-parent`} value={destinationValue} onChange={(event) => admin.setMoveParentId(event.currentTarget.value === WORKSPACE_ROOT_VALUE ? undefined : event.currentTarget.value)}>
                {admin.canMoveToRoot ? <option value={WORKSPACE_ROOT_VALUE}>Workspace直下</option> : null}
                {admin.parentRooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}
              </select>
              <button className="native-room-administration__secondary" type="button" onClick={() => void admin.previewRoomMove()} disabled={admin.busy}>条件を確認</button>
              {movePreview ? (
                movePreview.allowed ? (
                  <div className="native-room-administration__status" role="status" aria-live="polite">
                    <p>移動できます。Knowledgeとmembershipは変えません。</p>
                    <p className="native-room-administration__muted">影響する下位Room: {roomListText(props.rooms, admin.target.workspaceId, movePreview.requiredAncestorRoomIds)}</p>
                    <button className="native-room-administration__primary" type="button" onClick={() => void admin.moveCurrentRoom()} disabled={admin.busy}>この場所へ移動</button>
                  </div>
                ) : (
                  <div className="native-room-administration__error" role="alert" aria-live="polite">
                    <p>移動できません: {movePreview.reason ?? "Serverが許可しませんでした。"}</p>
                    {movePreview.blockingAccountIds.length > 0 ? <p>不足しているAccount: {movePreview.blockingAccountIds.join("、")}</p> : null}
                    {movePreview.requiredAncestorRoomIds.length > 0 ? <p>確認が必要な上位Room: {roomListText(props.rooms, admin.target.workspaceId, movePreview.requiredAncestorRoomIds)}</p> : null}
                  </div>
                )
              ) : null}
            </div>
          ) : <p className="native-room-administration__muted">移動先、管理権限、target、またはRoom versionが確認できません。</p>}
        </section>
      ) : (
        <section className="native-room-administration__card" aria-labelledby={`${id}-rename-title`}>
          <h2 id={`${id}-rename-title`}>Room名を変更</h2>
          <p className="native-room-administration__muted">この操作はUIだけ表示します。保存機能は後続で接続します。</p>
          <label htmlFor={`${id}-rename-name`}>Room名</label>
          <input id={`${id}-rename-name`} value={currentRoom.name} readOnly disabled />
          <button className="native-room-administration__secondary native-room-administration__disabled" type="button" disabled>保存</button>
        </section>
      )}
    </section>
  );
}

export default NativeRoomAdministration;
