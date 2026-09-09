import { useId } from "react";
import type { FormEvent } from "react";
import { useNativeRoomAdministration, WORKSPACE_ROOT_VALUE, type NativeRoomAdministrationRole, type UseNativeRoomAdministrationOptions } from "./use-native-room-administration";
import type { NativeRoom } from "./types";

export interface NativeRoomAdministrationProps extends UseNativeRoomAdministrationOptions {
  /** Returns to the Room without replacing the Room Work draft. */
  onClose?: () => void;
}

const roleLabels: Record<NativeRoomAdministrationRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest"
};

function flattenRooms(rooms: readonly NativeRoom[]): Array<{ room: NativeRoom; depth: number }> {
  const children = new Map<string | undefined, NativeRoom[]>();
  for (const room of rooms) {
    const list = children.get(room.parentRoomId) ?? [];
    list.push(room);
    children.set(room.parentRoomId, list);
  }
  const flattened: Array<{ room: NativeRoom; depth: number }> = [];
  const pending = (children.get(undefined) ?? []).slice().reverse().map((room) => ({ room, depth: 0 }));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || visited.has(item.room.id)) continue;
    visited.add(item.room.id);
    flattened.push(item);
    const childRooms = children.get(item.room.id) ?? [];
    for (let index = childRooms.length - 1; index >= 0; index -= 1) {
      const childRoom = childRooms[index];
      if (childRoom) pending.push({ room: childRoom, depth: item.depth + 1 });
    }
  }
  // Keep a granted Room visible even when an incomplete projection omitted its parent.
  for (const room of rooms) {
    if (!visited.has(room.id)) flattened.push({ room, depth: 0 });
  }
  return flattened;
}

function roomName(rooms: readonly NativeRoom[], targetWorkspaceId: string | undefined, roomId: string): string {
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

export function NativeRoomAdministration(props: NativeRoomAdministrationProps) {
  const admin = useNativeRoomAdministration(props);
  const id = useId().replace(/:/g, "");
  const currentRoom = admin.activeRoom;
  const normalRoom = Boolean(currentRoom && !admin.currentRoomIsDm);
  const flattenedRooms = flattenRooms(props.rooms);
  const destinationValue = admin.moveParentId ?? WORKSPACE_ROOT_VALUE;
  const canEdit = Boolean(normalRoom && admin.roomCanManage && admin.target && admin.currentRoomId);
  const movePreview = admin.movePreview;
  const memberPreview = admin.memberPreview;

  return (
    <section className="native-room-administration" aria-labelledby={`${id}-title`}>
      <style>{`
        .native-room-administration { color: var(--native-copy, #edf2eb); display: grid; gap: 14px; margin: 0 auto; max-width: 1160px; padding: clamp(18px, 3vw, 36px); }
        .native-room-administration *, .native-room-administration *::before, .native-room-administration *::after { box-sizing: border-box; }
        .native-room-administration__header, .native-room-administration__card { background: rgba(20, 28, 24, .8); border: 1px solid var(--native-line, rgba(204, 218, 209, .14)); border-radius: 15px; padding: clamp(15px, 2.2vw, 23px); }
        .native-room-administration__header { background: radial-gradient(circle at 94% 5%, rgba(241, 166, 92, .14), transparent 18rem), linear-gradient(135deg, rgba(28, 37, 32, .96), rgba(16, 22, 19, .97)); display: flex; gap: 16px; justify-content: space-between; }
        .native-room-administration__eyebrow { color: var(--native-accent, #f1a65c); font-size: 10px; font-weight: 800; letter-spacing: .14em; margin: 0 0 7px; text-transform: uppercase; }
        .native-room-administration h1, .native-room-administration h2 { margin: 0; }
        .native-room-administration h1 { font-family: Georgia, "Times New Roman", serif; font-size: clamp(25px, 3.2vw, 34px); letter-spacing: -.035em; line-height: 1; }
        .native-room-administration h2 { font-size: 14px; letter-spacing: .01em; }
        .native-room-administration p { line-height: 1.55; margin: 8px 0 0; }
        .native-room-administration__context { color: var(--native-muted, #a4afa7); font-size: 13px; }
        .native-room-administration__grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); }
        .native-room-administration__room-list, .native-room-administration__member-list { display: grid; gap: 5px; list-style: none; margin: 12px 0 0; padding: 0; }
        .native-room-administration__room-row { align-items: center; display: flex; gap: 8px; min-height: 35px; }
        .native-room-administration__room-row button { background: rgba(255, 255, 255, .025); border: 1px solid var(--native-line, rgba(204, 218, 209, .14)); border-radius: 9px; color: inherit; min-height: 35px; padding: 8px 10px; text-align: left; width: 100%; }
        .native-room-administration__room-row button:hover { background: rgba(255, 255, 255, .06); }
        .native-room-administration__room-row button[aria-current="true"] { background: rgba(241, 166, 92, .13); border-color: rgba(241, 166, 92, .46); color: var(--native-accent, #f1a65c); font-weight: 750; }
        .native-room-administration label, .native-room-administration legend { color: var(--native-muted, #a4afa7); font-size: 11px; font-weight: 700; }
        .native-room-administration input, .native-room-administration select { background: rgba(0, 0, 0, .2); border: 1px solid var(--native-line-strong, rgba(204, 218, 209, .26)); border-radius: 8px; color: inherit; font: inherit; margin-top: 5px; padding: 9px 10px; width: 100%; }
        .native-room-administration button { cursor: pointer; font: inherit; }
        .native-room-administration button:disabled { cursor: not-allowed; opacity: .55; }
        .native-room-administration button:focus-visible, .native-room-administration input:focus-visible, .native-room-administration select:focus-visible { outline: 2px solid var(--native-accent, #f1a65c); outline-offset: 2px; }
        .native-room-administration__close { align-items: center; background: transparent; border: 1px solid var(--native-line, rgba(204, 218, 209, .14)); border-radius: 9px; color: var(--native-muted, #a4afa7); display: inline-flex; flex: 0 0 auto; font-size: 20px; height: 34px; justify-content: center; line-height: 1; width: 34px; }
        .native-room-administration__close:hover { background: rgba(255, 255, 255, .06); color: inherit; }
        .native-room-administration__primary { background: var(--native-accent, #f1a65c); border: 1px solid var(--native-accent, #f1a65c); border-radius: 8px; color: #2b190b; font-weight: 800; margin-top: 12px; padding: 9px 12px; }
        .native-room-administration__secondary { background: rgba(255, 255, 255, .035); border: 1px solid var(--native-line-strong, rgba(204, 218, 209, .26)); border-radius: 8px; color: var(--native-copy, #edf2eb); font-weight: 700; margin-top: 12px; padding: 9px 12px; }
        .native-room-administration__secondary:hover { background: rgba(255, 255, 255, .08); }
        .native-room-administration__stack { display: grid; gap: 11px; margin-top: 12px; }
        .native-room-administration__member-row { border-bottom: 1px solid var(--native-line, rgba(204, 218, 209, .14)); display: flex; font-size: 12px; gap: 12px; justify-content: space-between; padding: 9px 0; }
        .native-room-administration__member-row:last-child { border-bottom: 0; }
        .native-room-administration__muted { color: var(--native-muted, #a4afa7); font-size: 12px; }
        .native-room-administration__status, .native-room-administration__error, .native-room-administration__warning { border-left: 3px solid; font-size: 12px; padding: 1px 0 1px 10px; }
        .native-room-administration__status { border-color: var(--native-success, #8ad8b2); }
        .native-room-administration__error { border-color: var(--native-danger, #ee8981); color: var(--native-danger, #ee8981); }
        .native-room-administration__warning { border-color: var(--native-accent, #f1a65c); color: var(--native-accent, #f1a65c); }
        .native-room-administration fieldset { border: 0; margin: 0; padding: 0; }
        @media (max-width: 580px) { .native-room-administration { padding: 15px; } .native-room-administration__header { padding: 16px; } .native-room-administration__member-row { align-items: flex-start; flex-direction: column; gap: 3px; } }
      `}</style>

      <header className="native-room-administration__header">
        <div>
          <p className="native-room-administration__eyebrow">Room administration</p>
          <h1 id={`${id}-title`}>Room管理</h1>
          {currentRoom ? (
            <p className="native-room-administration__context">
              現在のRoom: <strong>{currentRoom.name}</strong>。現在のWorkspace targetに固定して操作します。
            </p>
          ) : (
            <p role="alert">現在のRoomとWorkspace targetを確認してください。</p>
          )}
        </div>
        {props.onClose ? <button className="native-room-administration__close" type="button" onClick={props.onClose} aria-label="Room管理を閉じる">×</button> : null}
      </header>

      {admin.actionError ? <p className="native-room-administration__error" role="alert">Server: {admin.actionError}</p> : null}

      {!currentRoom || !admin.target ? (
        <div className="native-room-administration__card">
          <p role="alert">Room管理には現在のRoomとWorkspace targetが必要です。</p>
        </div>
      ) : admin.currentRoomIsDm ? (
        <div className="native-room-administration__card">
          <h2>Agent DM</h2>
          <p>Agent DMではRoomの階層管理と人間membershipの操作は利用できません。</p>
        </div>
      ) : (
        <>
          <div className="native-room-administration__card">
            <h2 id={`${id}-rooms-title`}>Room</h2>
            <p className="native-room-administration__muted">親子Roomや既存Chatへ自動で混ぜず、このRoomを明示して操作します。</p>
            <ul className="native-room-administration__room-list" aria-labelledby={`${id}-rooms-title`}>
              {flattenedRooms.map(({ room, depth }) => (
                <li className="native-room-administration__room-row" key={room.id}>
                  <button
                    type="button"
                    aria-current={room.id === admin.currentRoomId ? "true" : undefined}
                    style={{ paddingLeft: `${0.65 + depth * 1.15}rem` }}
                    onClick={() => void props.onSelectRoom?.(room)}
                  >
                    {room.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="native-room-administration__grid">
            <section className="native-room-administration__card" aria-labelledby={`${id}-create-title`}>
              <h2 id={`${id}-create-title`}>子Roomを作成</h2>
              <p className="native-room-administration__muted">作成先は現在のRoomです。Workspace versionを添えてServerに確認します。</p>
              {canEdit && admin.workspaceVersion ? (
                <form className="native-room-administration__stack" onSubmit={(event) => submit(event, () => void admin.createChildRoom())}>
                  <label htmlFor={`${id}-create-name`}>子Room名</label>
                  <input
                    id={`${id}-create-name`}
                    value={admin.createName}
                    onChange={(event) => admin.setCreateName(event.currentTarget.value)}
                    autoComplete="off"
                  />
                  <button className="native-room-administration__primary" type="submit" disabled={admin.busy || !admin.createName.trim()}>
                    作成
                  </button>
                </form>
              ) : (
                <p className="native-room-administration__muted">このRoomでは作成権限、target、またはWorkspace versionが確認できません。</p>
              )}
            </section>

            <section className="native-room-administration__card" aria-labelledby={`${id}-move-title`}>
              <h2 id={`${id}-move-title`}>Roomを移動</h2>
              <p className="native-room-administration__muted">移動先と影響を先に確認します。Knowledgeとmembershipは自動変更しません。</p>
              {canEdit && admin.hasMoveDestination ? (
                <div className="native-room-administration__stack">
                  <label htmlFor={`${id}-move-parent`}>移動先</label>
                  <select
                    id={`${id}-move-parent`}
                    value={destinationValue}
                    onChange={(event) => admin.setMoveParentId(event.currentTarget.value === WORKSPACE_ROOT_VALUE ? undefined : event.currentTarget.value)}
                  >
                    {admin.canMoveToRoot ? <option value={WORKSPACE_ROOT_VALUE}>Workspace直下</option> : null}
                    {admin.parentRooms.map((room) => <option value={room.id} key={room.id}>{room.name}</option>)}
                  </select>
                  <button className="native-room-administration__secondary" type="button" onClick={() => void admin.previewRoomMove()} disabled={admin.busy}>
                    条件を確認
                  </button>
                  {movePreview ? (
                    movePreview.allowed ? (
                      <div className="native-room-administration__status" role="status" aria-live="polite">
                        <p>移動できます。Knowledgeとmembershipは変えません。</p>
                        <p className="native-room-administration__muted">影響する下位Room: {roomListText(props.rooms, admin.target.workspaceId, movePreview.requiredAncestorRoomIds)}</p>
                        <button className="native-room-administration__primary" type="button" onClick={() => void admin.moveCurrentRoom()} disabled={admin.busy}>
                          この場所へ移動
                        </button>
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
              ) : (
                <p className="native-room-administration__muted">移動先、管理権限、target、またはRoom versionが確認できません。</p>
              )}
            </section>
          </div>

          <section className="native-room-administration__card" aria-labelledby={`${id}-members-title`}>
            <h2 id={`${id}-members-title`}>現在の人間membership</h2>
            <p className="native-room-administration__muted">参加・解除・role変更はServerの権限と最後のOwner保護に従います。</p>
            {admin.membersLoading ? <p role="status" aria-live="polite">読み込み中…</p> : null}
            {admin.membersError ? <p className="native-room-administration__error" role="alert">Server: {admin.membersError}</p> : null}
            {!admin.roomCanManage ? <p className="native-room-administration__muted">membershipを表示する管理権限がありません。</p> : null}
            {admin.roomCanManage && !admin.membersLoading && !admin.membersError && admin.members.length === 0 ? <p className="native-room-administration__muted">membershipはありません。</p> : null}
            <ul className="native-room-administration__member-list" aria-label="現在の人間membership">
              {admin.members.map((member) => (
                <li className="native-room-administration__member-row" key={member.accountId}>
                  <span>{member.accountId}</span>
                  <span>{roleLabels[member.role]}・{member.state === "active" ? "参加中" : "解除済み"}</span>
                </li>
              ))}
            </ul>

            {canEdit ? (
              <form className="native-room-administration__stack" onSubmit={(event) => submit(event, () => void admin.previewMemberChange())}>
                <label htmlFor={`${id}-member-account`}>Account ID</label>
                <input
                  id={`${id}-member-account`}
                  value={admin.memberAccountId}
                  onChange={(event) => admin.setMemberAccountId(event.currentTarget.value)}
                  autoComplete="off"
                />
                <label htmlFor={`${id}-member-role`}>role</label>
                <select id={`${id}-member-role`} value={admin.memberRole} onChange={(event) => admin.setMemberRole(event.currentTarget.value as NativeRoomAdministrationRole)}>
                  {Object.entries(roleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                </select>
                <label htmlFor={`${id}-member-state`}>membership状態</label>
                <select id={`${id}-member-state`} value={admin.memberState} onChange={(event) => admin.setMemberState(event.currentTarget.value as "active" | "revoked")}>
                  <option value="active">参加</option>
                  <option value="revoked">解除</option>
                </select>
                <button className="native-room-administration__secondary" type="submit" disabled={admin.busy || !admin.memberAccountId.trim()}>
                  影響を確認
                </button>
                {memberPreview ? (
                  <div className={memberPreview.allowed ? "native-room-administration__status" : "native-room-administration__error"} role={memberPreview.allowed ? "status" : "alert"} aria-live="polite">
                    <p>{memberPreview.allowed ? "この変更はServer確認済みです。" : `変更できません: ${memberPreview.reason ?? "Serverが許可しませんでした。"}`}</p>
                    <p>影響するRoom: {roomListText(props.rooms, admin.target.workspaceId, memberPreview.affectedRoomIds)}</p>
                    {memberPreview.blockingOwnerRoomIds.length > 0 ? <p className="native-room-administration__warning">最後のOwner保護により確認が必要なRoom: {roomListText(props.rooms, admin.target.workspaceId, memberPreview.blockingOwnerRoomIds)}</p> : null}
                    {memberPreview.allowed ? <button className="native-room-administration__primary" type="button" onClick={() => void admin.saveMemberChange()} disabled={admin.busy}>変更を保存</button> : null}
                  </div>
                ) : null}
              </form>
            ) : (
              <p className="native-room-administration__muted">このRoomのmembershipを変更する管理権限がありません。</p>
            )}
          </section>
        </>
      )}
    </section>
  );
}

export default NativeRoomAdministration;
