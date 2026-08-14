<script setup lang="ts">
import { computed, ref, watch } from "vue";
import ChevronDown from "lucide-vue-next/dist/esm/icons/chevron-down.js";
import ChevronRight from "lucide-vue-next/dist/esm/icons/chevron-right.js";
import FolderPlus from "lucide-vue-next/dist/esm/icons/folder-plus.js";
import MoveRight from "lucide-vue-next/dist/esm/icons/move-right.js";
import Users from "lucide-vue-next/dist/esm/icons/users.js";
import type {
  DesktopRoomMemberPreview,
  DesktopRoomMovePreview,
  DesktopWorkspaceRoom,
  DesktopWorkspaceRoomMembership
} from "../lib/api";
import { buildWorkspaceRoomTree, workspaceRoomPath, type WorkspaceRoomTreeNode } from "../lib/workspace-room-tree";
import {
  canCreateWorkspaceRootRoom,
  canMoveRoomToWorkspaceRoot,
  manageableMoveParents
} from "../lib/workspace-room-capabilities";

const props = defineProps<{
  available: boolean;
  loading: boolean;
  error: string | null;
  workspaceVersion?: number;
  workspaceRole?: "owner" | "admin" | "member" | "guest";
  rooms: DesktopWorkspaceRoom[];
  selectedRoomId?: string;
  selectRoom: (roomId: string) => void | Promise<void>;
  createRoom: (input: { name: string; parentRoomId?: string; expectedWorkspaceVersion: number; operationId: string }) => Promise<void>;
  previewMove: (input: { roomId: string; parentRoomId: string | null }) => Promise<DesktopRoomMovePreview>;
  moveRoom: (input: { roomId: string; parentRoomId: string | null; expectedRoomVersion: number; expectedWorkspaceVersion: number; operationId: string }) => Promise<void>;
  listMembers: (roomId: string) => Promise<DesktopWorkspaceRoomMembership[]>;
  previewMember: (input: { roomId: string; accountId: string; role: "owner" | "admin" | "member" | "guest"; state: "active" | "revoked" }) => Promise<DesktopRoomMemberPreview>;
  setMember: (input: { roomId: string; accountId: string; role: "owner" | "admin" | "member" | "guest"; state: "active" | "revoked"; expectedVersion: number; operationId: string }) => Promise<void>;
}>();

const expanded = ref(new Set<string>());
const createName = ref("");
const createAtRoot = ref(false);
const moveParentValue = ref("__workspace_root__");
const movePreview = ref<DesktopRoomMovePreview | null>(null);
const members = ref<DesktopWorkspaceRoomMembership[]>([]);
const memberAccountId = ref("");
const memberRole = ref<"owner" | "admin" | "member" | "guest">("member");
const memberState = ref<"active" | "revoked">("active");
const memberPreview = ref<DesktopRoomMemberPreview | null>(null);
const actionError = ref<string | null>(null);
const busy = ref(false);

const tree = computed(() => buildWorkspaceRoomTree(props.rooms));
const selectedRoom = computed(() => props.rooms.find((room) => room.id === props.selectedRoomId));
const currentPath = computed(() => workspaceRoomPath(props.rooms, props.selectedRoomId));
const selectedMember = computed(() => members.value.find((member) => member.accountId === memberAccountId.value));
const selectedRoomCanManage = computed(() => selectedRoom.value?.canManage === true);
const canCreateAtRoot = computed(() => canCreateWorkspaceRootRoom(props.workspaceRole));
const canMoveToRoot = computed(() => canMoveRoomToWorkspaceRoot(props.workspaceRole));
const canMoveSelectedRoomToRoot = computed(() => canMoveToRoot.value && selectedRoom.value?.parentRoomId !== undefined);
const movableParentRooms = computed(() => manageableMoveParents(props.rooms, selectedRoom.value?.id));
const movableParentRoomIds = computed(() => movableParentRooms.value.map((room) => room.id).join("\u0000"));
const hasMoveDestination = computed(() => canMoveSelectedRoomToRoot.value || movableParentRooms.value.length > 0);
const canSubmitCreate = computed(() => Boolean(
  props.workspaceVersion
  && createName.value.trim()
  && (createAtRoot.value ? canCreateAtRoot.value : selectedRoomCanManage.value)
));
const visibleRooms = computed(() => {
  const output: Array<{ node: WorkspaceRoomTreeNode<DesktopWorkspaceRoom>; depth: number }> = [];
  const pending = [...tree.value].reverse().map((node) => ({ node, depth: 0 }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    output.push(current);
    if (expanded.value.has(current.node.room.id)) {
      for (const child of [...current.node.children].reverse()) pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return output;
});

let memberLoadToken = 0;
watch([() => props.selectedRoomId, selectedRoomCanManage, canMoveSelectedRoomToRoot, movableParentRoomIds], async ([roomId, canManage]) => {
  const token = ++memberLoadToken;
  movePreview.value = null;
  memberPreview.value = null;
  memberAccountId.value = "";
  memberRole.value = "member";
  memberState.value = "active";
  members.value = [];
  moveParentValue.value = canMoveSelectedRoomToRoot.value ? "__workspace_root__" : (movableParentRooms.value[0]?.id ?? "");
  if (!roomId || !canManage) return;
  try {
    const loaded = await props.listMembers(roomId);
    if (token !== memberLoadToken) return;
    members.value = loaded;
  } catch {
    if (token !== memberLoadToken) return;
    actionError.value = "Roomのメンバーを読み込めませんでした。";
  }
}, { immediate: true });

function toggle(roomId: string): void {
  const next = new Set(expanded.value);
  if (next.has(roomId)) next.delete(roomId);
  else next.add(roomId);
  expanded.value = next;
}

async function chooseRoom(roomId: string): Promise<void> {
  actionError.value = null;
  await props.selectRoom(roomId);
}

function newOperationId(): string {
  return "room_" + crypto.randomUUID();
}

async function submitCreate(): Promise<void> {
  if (!canSubmitCreate.value || !props.workspaceVersion) return;
  busy.value = true;
  actionError.value = null;
  try {
    await props.createRoom({
      name: createName.value.trim(),
      ...(createAtRoot.value || !selectedRoom.value ? {} : { parentRoomId: selectedRoom.value.id }),
      expectedWorkspaceVersion: props.workspaceVersion,
      operationId: newOperationId()
    });
    createName.value = "";
  } catch (error) {
    actionError.value = errorMessage(error, "Roomを作成できませんでした。");
  } finally {
    busy.value = false;
  }
}

function selectedMoveParentId(): string | null {
  return moveParentValue.value === "__workspace_root__" ? null : moveParentValue.value;
}

async function checkMove(): Promise<void> {
  if (!selectedRoom.value || !selectedRoomCanManage.value || !hasMoveDestination.value) return;
  busy.value = true;
  actionError.value = null;
  try {
    movePreview.value = await props.previewMove({ roomId: selectedRoom.value.id, parentRoomId: selectedMoveParentId() });
  } catch (error) {
    movePreview.value = null;
    actionError.value = errorMessage(error, "移動条件を確認できませんでした。");
  } finally {
    busy.value = false;
  }
}

async function submitMove(): Promise<void> {
  if (!selectedRoom.value || !selectedRoomCanManage.value || !hasMoveDestination.value || !props.workspaceVersion || !movePreview.value?.allowed) return;
  busy.value = true;
  actionError.value = null;
  try {
    await props.moveRoom({
      roomId: selectedRoom.value.id,
      parentRoomId: selectedMoveParentId(),
      expectedRoomVersion: selectedRoom.value.version,
      expectedWorkspaceVersion: props.workspaceVersion,
      operationId: newOperationId()
    });
    movePreview.value = null;
  } catch (error) {
    actionError.value = errorMessage(error, "Roomを移動できませんでした。最新状態を確認してください。");
  } finally {
    busy.value = false;
  }
}

async function checkMemberChange(): Promise<void> {
  if (!selectedRoom.value || !selectedRoomCanManage.value || !memberAccountId.value.trim()) return;
  busy.value = true;
  actionError.value = null;
  try {
    memberPreview.value = await props.previewMember({
      roomId: selectedRoom.value.id,
      accountId: memberAccountId.value.trim(),
      role: memberRole.value,
      state: memberState.value
    });
  } catch (error) {
    memberPreview.value = null;
    actionError.value = errorMessage(error, "メンバー変更の影響を確認できませんでした。");
  } finally {
    busy.value = false;
  }
}

async function submitMemberChange(): Promise<void> {
  if (!selectedRoom.value || !selectedRoomCanManage.value || !memberAccountId.value.trim() || !memberPreview.value?.allowed) return;
  busy.value = true;
  actionError.value = null;
  try {
    await props.setMember({
      roomId: selectedRoom.value.id,
      accountId: memberAccountId.value.trim(),
      role: memberRole.value,
      state: memberState.value,
      expectedVersion: selectedMember.value?.version ?? 0,
      operationId: newOperationId()
    });
    const token = ++memberLoadToken;
    const loaded = await props.listMembers(selectedRoom.value.id);
    if (token === memberLoadToken) members.value = loaded;
    memberPreview.value = null;
  } catch (error) {
    actionError.value = errorMessage(error, "メンバーを変更できませんでした。");
  } finally {
    busy.value = false;
  }
}

function roomName(roomId: string): string {
  return props.rooms.find((room) => room.id === roomId)?.name ?? "表示権限のあるRoom";
}

function moveParentLabel(room: DesktopWorkspaceRoom): string {
  return `${room.name} · ${room.id}`;
}

function memberPreviewReason(preview: DesktopRoomMemberPreview): string {
  return preview.reason === "room_last_owner_cannot_be_removed"
    ? "最後のOwnerがいなくなるため変更できません。"
    : "この変更は現在のRoom条件では実行できません。";
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
</script>

<template>
  <section v-if="props.available" class="workspace-room-tree">
    <div class="workspace-room-tree-head">
      <div>
        <strong>Room</strong>
        <p>親子Roomや既存Chatへは自動で混ぜず、このRoomを明示して操作します。</p>
      </div>
    </div>
    <p v-if="props.error" class="workspace-room-tree-error">{{ props.error }}</p>
    <p v-else-if="props.loading" class="workspace-room-tree-note">Roomを読み込んでいます。</p>
    <template v-else>
      <p v-if="currentPath.length" class="workspace-room-path">{{ currentPath.map((room) => room.name).join(" / ") }}</p>
      <div v-if="visibleRooms.length" class="workspace-room-list" aria-label="Room tree">
        <div v-for="item in visibleRooms" :key="item.node.room.id" class="workspace-room-row" :style="{ paddingLeft: (12 + item.depth * 18) + 'px' }">
          <button v-if="item.node.children.length" class="workspace-room-fold" type="button" @click="toggle(item.node.room.id)">
            <ChevronDown v-if="expanded.has(item.node.room.id)" :size="15" />
            <ChevronRight v-else :size="15" />
          </button>
          <span v-else class="workspace-room-spacer" />
          <button class="workspace-room-select" :class="{ 'is-selected': item.node.room.id === props.selectedRoomId }" type="button" @click="chooseRoom(item.node.room.id)">
            {{ item.node.room.name }}
          </button>
        </div>
      </div>
      <p v-else class="workspace-room-tree-note">表示できるRoomはまだありません。</p>

      <form v-if="canCreateAtRoot || selectedRoomCanManage" class="workspace-room-form" @submit.prevent="submitCreate">
        <label><span>新しいRoom</span><input v-model="createName" maxlength="240" placeholder="Room名" autocomplete="off" /></label>
        <label v-if="canCreateAtRoot" class="workspace-room-checkbox"><input v-model="createAtRoot" type="checkbox" /><span>Workspace直下に作る</span></label>
        <p v-if="!createAtRoot && selectedRoom && !selectedRoomCanManage" class="workspace-room-tree-note">このRoomは閲覧のみです。子Roomを作るにはRoom管理権限が必要です。</p>
        <button type="submit" :disabled="busy || !canSubmitCreate"><FolderPlus :size="15" />作成</button>
      </form>

      <template v-if="selectedRoom">
        <p v-if="!selectedRoomCanManage" class="workspace-room-tree-note">このRoomは閲覧のみです。移動とメンバー変更はできません。</p>
        <section v-if="selectedRoomCanManage" class="workspace-room-action">
          <div class="workspace-room-action-head"><MoveRight :size="15" /><strong>Roomを移動</strong></div>
          <select v-if="hasMoveDestination" v-model="moveParentValue" @change="movePreview = null">
            <option v-if="canMoveSelectedRoomToRoot" value="__workspace_root__">Workspace直下</option>
            <option v-for="room in movableParentRooms" :key="room.id" :value="room.id">{{ moveParentLabel(room) }}</option>
          </select>
          <p v-else class="workspace-room-tree-note">移動できるRoomはありません。</p>
          <button v-if="hasMoveDestination" type="button" :disabled="busy" @click="checkMove">条件を確認</button>
          <p v-if="movePreview?.allowed" class="workspace-room-tree-ok">移動できます。Knowledgeとメンバーは変えません。</p>
          <div v-else-if="movePreview" class="workspace-room-tree-error">
            <p>移動できません：{{ movePreview.reason === 'room_hierarchy_cycle' ? '自分自身または子Roomの下へは移動できません。' : '必要な親Roomへの参加条件を満たしていません。' }}</p>
            <p v-if="movePreview.blockingAccountIds.length">不足している参加者: {{ movePreview.blockingAccountIds.join(", ") }}</p>
          </div>
          <button v-if="hasMoveDestination" type="button" :disabled="busy || !movePreview?.allowed" @click="submitMove">この場所へ移動</button>
        </section>

        <section v-if="selectedRoomCanManage" class="workspace-room-action">
          <div class="workspace-room-action-head"><Users :size="15" /><strong>メンバー</strong></div>
          <p class="workspace-room-tree-note">子Roomへ追加する人は、すべての親Roomにも先に参加している必要があります。</p>
          <div class="workspace-room-members"><span v-for="member in members" :key="member.accountId">{{ member.accountId }}（{{ member.role }}・{{ member.state }}）</span></div>
          <label><span>Account ID</span><input v-model="memberAccountId" maxlength="128" autocomplete="off" @input="memberPreview = null" /></label>
          <div class="workspace-room-member-fields">
            <select v-model="memberRole" @change="memberPreview = null"><option value="owner">Owner</option><option value="admin">Admin</option><option value="member">Member</option><option value="guest">Guest</option></select>
            <select v-model="memberState" @change="memberPreview = null"><option value="active">参加</option><option value="revoked">解除</option></select>
          </div>
          <button type="button" :disabled="busy || !memberAccountId.trim()" @click="checkMemberChange">影響を確認</button>
          <div v-if="memberPreview" class="workspace-room-impact">
            <p v-if="memberPreview.affectedRoomIds.length">影響するRoom: {{ memberPreview.affectedRoomIds.map(roomName).join("、") }}</p>
            <p v-else>表示権限のある範囲では、追加の影響Roomはありません。</p>
            <p v-if="!memberPreview.allowed" class="workspace-room-tree-error">{{ memberPreviewReason(memberPreview) }}</p>
            <p v-else-if="memberPreview.blockingOwnerRoomIds.length" class="workspace-room-tree-error">最後のOwnerになるため変更できません: {{ memberPreview.blockingOwnerRoomIds.map(roomName).join("、") }}</p>
          </div>
          <button type="button" :disabled="busy || !memberPreview?.allowed" @click="submitMemberChange">変更を保存</button>
        </section>
      </template>
      <p v-if="actionError" class="workspace-room-tree-error">{{ actionError }}</p>
    </template>
  </section>
</template>

<style scoped>
.workspace-room-tree { display: grid; gap: 12px; }
.workspace-room-tree-head, .workspace-room-action-head { display: flex; align-items: center; gap: 8px; }
.workspace-room-tree-head p, .workspace-room-tree-note, .workspace-room-path, .workspace-room-impact p { margin: 3px 0 0; color: var(--muted-foreground, #6b7280); font-size: 12px; }
.workspace-room-list { border: 1px solid var(--border, #e5e7eb); border-radius: 10px; overflow: hidden; }
.workspace-room-row { display: flex; align-items: center; min-height: 34px; border-bottom: 1px solid var(--border, #e5e7eb); }
.workspace-room-row:last-child { border-bottom: 0; }
.workspace-room-fold, .workspace-room-spacer { width: 24px; height: 24px; display: inline-grid; place-items: center; flex: 0 0 24px; }
.workspace-room-fold { border: 0; background: transparent; cursor: pointer; }
.workspace-room-select { border: 0; background: transparent; text-align: left; padding: 6px; flex: 1; cursor: pointer; }
.workspace-room-select.is-selected { font-weight: 700; color: var(--accent, #2563eb); }
.workspace-room-form, .workspace-room-action { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border, #e5e7eb); border-radius: 10px; }
.workspace-room-form label, .workspace-room-action label { display: grid; gap: 4px; font-size: 12px; }
.workspace-room-checkbox { display: flex !important; align-items: center; gap: 6px; }
.workspace-room-checkbox input { width: auto; }
.workspace-room-form input, .workspace-room-action input, .workspace-room-action select { min-width: 0; padding: 7px 8px; border: 1px solid var(--border, #d1d5db); border-radius: 7px; background: transparent; }
.workspace-room-form button, .workspace-room-action button { width: fit-content; display: inline-flex; align-items: center; gap: 6px; padding: 7px 9px; border: 1px solid var(--border, #d1d5db); border-radius: 7px; background: transparent; cursor: pointer; }
.workspace-room-form button:disabled, .workspace-room-action button:disabled { opacity: .5; cursor: default; }
.workspace-room-members { display: grid; gap: 3px; max-height: 100px; overflow: auto; font-size: 12px; }
.workspace-room-member-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.workspace-room-tree-error { color: #b42318; font-size: 12px; margin: 0; }
.workspace-room-tree-ok { color: #067647; font-size: 12px; margin: 0; }
</style>
