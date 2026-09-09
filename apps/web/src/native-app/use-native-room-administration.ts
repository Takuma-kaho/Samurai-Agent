import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createIdempotencyKey,
  type DesktopWorkspaceConnectionState,
  getWorkspaceClientBridge,
  type DesktopRoomMemberPreview,
  type DesktopRoomMovePreview,
  type DesktopWorkspaceRoomMembership
} from "../lib/api";
import { canMoveRoomToWorkspaceRoot, manageableMoveParents } from "../lib/workspace-room-capabilities";
import type { NativeRoom, NativeWorkspaceTarget } from "./types";
import {
  activeNativeWorkspaceTarget,
  assertNativeWorkspaceTarget,
  nativeWorkspaceTargetKey,
  withNativeWorkspaceTarget
} from "./native-workspace-target";

export const WORKSPACE_ROOT_VALUE = "__workspace_root__" as const;

export type NativeRoomAdministrationRole = "owner" | "admin" | "member" | "guest";
export type NativeRoomAdministrationMemberState = "active" | "revoked";
export type NativeRoomAdministrationAction =
  | "loading-members"
  | "create-child"
  | "preview-move"
  | "move"
  | "preview-member"
  | "save-member";

export interface NativeRoomAdministrationCreateInput {
  name: string;
  parentRoomId: string;
  expectedWorkspaceVersion: number;
  operationId: string;
  target: NativeWorkspaceTarget;
}

export interface NativeRoomAdministrationMovePreviewInput {
  roomId: string;
  /** `null` is an intentional Workspace-root destination, never an omitted value. */
  parentRoomId: string | null;
  target: NativeWorkspaceTarget;
}

export interface NativeRoomAdministrationMoveInput extends NativeRoomAdministrationMovePreviewInput {
  expectedRoomVersion: number;
  expectedWorkspaceVersion: number;
  operationId: string;
}

export interface NativeRoomAdministrationMemberPreviewInput {
  roomId: string;
  accountId: string;
  role: NativeRoomAdministrationRole;
  state: NativeRoomAdministrationMemberState;
  target: NativeWorkspaceTarget;
}

export interface NativeRoomAdministrationMemberInput extends NativeRoomAdministrationMemberPreviewInput {
  expectedVersion: number;
  operationId: string;
}

/**
 * The desktop bridge currently accepts the room operations below.  The target
 * is carried in this local contract as a scope guard even where an older
 * bridge implementation obtains it from its active workspace snapshot.
 */
export interface NativeRoomAdministrationBridge {
  listWorkspaceConnections?: () => Promise<DesktopWorkspaceConnectionState>;
  listWorkspaceRoomMembers?: (
    roomId: string
  ) => Promise<{ members: DesktopWorkspaceRoomMembership[] }>;
  createWorkspaceRoom?: (input: NativeRoomAdministrationCreateInput) => Promise<unknown>;
  previewWorkspaceRoomMove?: (
    input: NativeRoomAdministrationMovePreviewInput
  ) => Promise<{ preview: DesktopRoomMovePreview }>;
  moveWorkspaceRoom?: (input: NativeRoomAdministrationMoveInput) => Promise<unknown>;
  previewWorkspaceRoomMember?: (
    input: NativeRoomAdministrationMemberPreviewInput
  ) => Promise<{ preview: DesktopRoomMemberPreview }>;
  setWorkspaceRoomMember?: (input: NativeRoomAdministrationMemberInput) => Promise<unknown>;
}

export type NativeRoomAdministrationBridgeSource =
  | NativeRoomAdministrationBridge
  | NonNullable<Window["samuraiDesktop"]>;

export interface UseNativeRoomAdministrationOptions {
  rooms: readonly NativeRoom[];
  target?: NativeWorkspaceTarget;
  /** Alias accepted for callers that name the prop after the active target. */
  workspaceTarget?: NativeWorkspaceTarget;
  workspaceVersion?: number;
  currentRoomId?: string;
  currentRoom?: NativeRoom;
  /** Alias accepted for callers that pass the selected Room as `room`. */
  room?: NativeRoom;
  workspaceRole?: NativeRoomAdministrationRole;
  bridge?: NativeRoomAdministrationBridgeSource;
  onSelectRoom?: (room: NativeRoom) => void | Promise<void>;
  onRefresh?: (reason: "room-created" | "room-moved" | "membership-changed") => void | Promise<void>;
}

interface ContextStamp {
  contextKey: string;
  targetKey: string;
  roomId: string;
  generation: number;
}

interface MovePreviewRecord {
  preview: DesktopRoomMovePreview;
  stamp: ContextStamp;
  parentRoomId: string | null;
  roomVersion?: number;
  workspaceVersion?: number;
  sequence: number;
}

interface MemberPreviewRecord {
  preview: DesktopRoomMemberPreview;
  stamp: ContextStamp;
  accountId: string;
  role: NativeRoomAdministrationRole;
  state: NativeRoomAdministrationMemberState;
  memberVersion: number;
  sequence: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readErrorField(value: unknown, field: string): unknown {
  const record = asRecord(value);
  return record?.[field];
}

/** Keeps the Server's error code/message visible instead of replacing it with a UI guess. */
export function nativeRoomAdministrationErrorMessage(error: unknown, fallback: string): string {
  const errorRecord = asRecord(error);
  const body = readErrorField(error, "body") ?? errorRecord?.data;
  const bodyRecord = asRecord(body);
  const code = nonEmptyString(bodyRecord?.error)
    ?? nonEmptyString(bodyRecord?.code)
    ?? nonEmptyString(errorRecord?.error)
    ?? nonEmptyString(errorRecord?.code)
    ?? nonEmptyString(readErrorField(error, "code"));
  const detail = nonEmptyString(bodyRecord?.message)
    ?? nonEmptyString(bodyRecord?.detail)
    ?? nonEmptyString(errorRecord?.detail);
  if (code && detail && code !== detail) return `${code}: ${detail}`;
  if (code) return code;
  if (detail) return detail;
  if (error instanceof Error && error.message.trim()) return error.message;
  const message = nonEmptyString(errorRecord?.message) ?? nonEmptyString(error);
  return message ?? fallback;
}

function targetKey(target: NativeWorkspaceTarget | undefined): string {
  return target ? nativeWorkspaceTargetKey(target) : "";
}

/**
 * Desktop and Browser bridges are scoped to the active connection. A Room
 * mutation must therefore verify that the active target still matches the
 * panel that initiated it both before and after the request. Passing an
 * arbitrary target field to an IPC payload is not a substitute for this
 * check: most existing Room routes intentionally derive their target from the
 * active authenticated connection.
 */
export function activeNativeRoomAdministrationTarget(
  state: DesktopWorkspaceConnectionState
): NativeWorkspaceTarget | undefined {
  return activeNativeWorkspaceTarget(state);
}

export async function assertNativeRoomAdministrationTarget(
  bridge: NativeRoomAdministrationBridge,
  target: NativeWorkspaceTarget
): Promise<void> {
  await assertNativeWorkspaceTarget(bridge, target);
}

export async function withNativeRoomAdministrationTarget<T>(
  bridge: NativeRoomAdministrationBridge,
  target: NativeWorkspaceTarget,
  task: () => Promise<T>
): Promise<T> {
  return withNativeWorkspaceTarget(bridge, target, task);
}

function isValidVersion(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1;
}

function normalizeMovePreview(value: unknown): DesktopRoomMovePreview {
  const record = asRecord(value);
  return {
    allowed: record?.allowed === true,
    reason: nonEmptyString(record?.reason),
    blockingAccountIds: Array.isArray(record?.blockingAccountIds)
      ? record.blockingAccountIds.filter((item): item is string => typeof item === "string")
      : [],
    requiredAncestorRoomIds: Array.isArray(record?.requiredAncestorRoomIds)
      ? record.requiredAncestorRoomIds.filter((item): item is string => typeof item === "string")
      : []
  };
}

function normalizeMemberPreview(value: unknown): DesktopRoomMemberPreview {
  const record = asRecord(value);
  const blockingOwnerRoomIds = Array.isArray(record?.blockingOwnerRoomIds)
    ? record.blockingOwnerRoomIds.filter((item): item is string => typeof item === "string")
    : [];
  const affectedRoomIds = Array.isArray(record?.affectedRoomIds)
    ? record.affectedRoomIds.filter((item): item is string => typeof item === "string")
    : [];
  return {
    // Some older Server responses omit `allowed` and only return blockers.
    allowed: record?.allowed === true || (record?.allowed === undefined && blockingOwnerRoomIds.length === 0),
    reason: nonEmptyString(record?.reason),
    affectedRoomIds,
    blockingOwnerRoomIds
  };
}

function normalizeMembers(value: unknown, target: NativeWorkspaceTarget, roomId: string): DesktopWorkspaceRoomMembership[] {
  const record = asRecord(value);
  if (!Array.isArray(record?.members)) {
    throw new Error("room_members_response_invalid");
  }
  const members = record.members as unknown[];
  for (const member of members) {
    const item = asRecord(member);
    if (item?.workspaceId !== target.workspaceId || item?.roomId !== roomId) {
      throw new Error("room_members_response_scope_invalid");
    }
  }
  return members as DesktopWorkspaceRoomMembership[];
}

function canManageRoom(room: NativeRoom | undefined): boolean {
  return room?.canManage === true || room?.capabilities?.canManage === true;
}

export function nativeRoomAdministrationCreateInput(input: {
  name: string;
  parentRoomId: string;
  expectedWorkspaceVersion: number;
  operationId: string;
  target: NativeWorkspaceTarget;
}): NativeRoomAdministrationCreateInput {
  return {
    name: input.name,
    parentRoomId: input.parentRoomId,
    expectedWorkspaceVersion: input.expectedWorkspaceVersion,
    operationId: input.operationId,
    target: { ...input.target }
  };
}

export function nativeRoomAdministrationMoveInput(input: {
  roomId: string;
  parentRoomId?: string | null;
  expectedRoomVersion: number;
  expectedWorkspaceVersion: number;
  operationId: string;
  target: NativeWorkspaceTarget;
}): NativeRoomAdministrationMoveInput {
  return {
    roomId: input.roomId,
    parentRoomId: input.parentRoomId ?? null,
    expectedRoomVersion: input.expectedRoomVersion,
    expectedWorkspaceVersion: input.expectedWorkspaceVersion,
    operationId: input.operationId,
    target: { ...input.target }
  };
}

export function nativeRoomAdministrationMemberInput(input: {
  roomId: string;
  accountId: string;
  role: NativeRoomAdministrationRole;
  state: NativeRoomAdministrationMemberState;
  expectedVersion: number;
  operationId: string;
  target: NativeWorkspaceTarget;
}): NativeRoomAdministrationMemberInput {
  return {
    roomId: input.roomId,
    accountId: input.accountId,
    role: input.role,
    state: input.state,
    expectedVersion: input.expectedVersion,
    operationId: input.operationId,
    target: { ...input.target }
  };
}

export function useNativeRoomAdministration(options: UseNativeRoomAdministrationOptions) {
  const bridge = useMemo<NativeRoomAdministrationBridge | undefined>(() => {
    if (options.bridge) return options.bridge as NativeRoomAdministrationBridge;
    return getWorkspaceClientBridge() as unknown as NativeRoomAdministrationBridge | undefined;
  }, [options.bridge]);
  const target = options.target ?? options.workspaceTarget;
  const activeRoom = options.currentRoom ?? options.room ?? options.rooms.find((room) => room.id === options.currentRoomId);
  const currentRoomId = activeRoom?.id ?? options.currentRoomId;
  const currentRoomIsDm = activeRoom?.kind === "agent_dm";
  const roomCanManage = canManageRoom(activeRoom);
  const targetScopeKey = targetKey(target);
  const contextKey = `${targetScopeKey}\n${options.workspaceVersion ?? ""}\n${currentRoomId ?? ""}\n${activeRoom?.kind ?? "normal"}\n${activeRoom?.version ?? ""}`;

  const [members, setMembers] = useState<DesktopWorkspaceRoomMembership[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [createName, setCreateNameState] = useState("");
  const [moveParentId, setMoveParentIdState] = useState<string | undefined>();
  const [movePreviewRecord, setMovePreviewRecord] = useState<MovePreviewRecord | null>(null);
  const [memberAccountId, setMemberAccountIdState] = useState("");
  const [memberRole, setMemberRoleState] = useState<NativeRoomAdministrationRole>("member");
  const [memberState, setMemberStateState] = useState<NativeRoomAdministrationMemberState>("active");
  const [memberPreviewRecord, setMemberPreviewRecord] = useState<MemberPreviewRecord | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<NativeRoomAdministrationAction | null>(null);

  const generationRef = useRef(0);
  const latestContextKeyRef = useRef(contextKey);
  const latestTargetKeyRef = useRef(targetScopeKey);
  const latestRoomIdRef = useRef(currentRoomId ?? "");
  const membersSequenceRef = useRef(0);
  const movePreviewSequenceRef = useRef(0);
  const memberPreviewSequenceRef = useRef(0);
  const operationIdsRef = useRef(new Map<string, string>());

  const renderedContextKeyRef = useRef(contextKey);
  if (renderedContextKeyRef.current !== contextKey) {
    renderedContextKeyRef.current = contextKey;
    generationRef.current += 1;
  }

  latestContextKeyRef.current = contextKey;
  latestTargetKeyRef.current = targetScopeKey;
  latestRoomIdRef.current = currentRoomId ?? "";

  const parentRooms = useMemo(
    () => currentRoomId
      ? manageableMoveParents(
        options.rooms.map((room) => ({ ...room, canManage: canManageRoom(room) })),
        currentRoomId
      ).map((room) => options.rooms.find((candidate) => candidate.id === room.id))
        .filter((room): room is NativeRoom => Boolean(room))
        .filter((room) => room.workspaceId === target?.workspaceId && room.kind !== "agent_dm")
      : [],
    [currentRoomId, options.rooms, target?.workspaceId]
  );
  const canMoveToRoot = Boolean(
    activeRoom
    && activeRoom.parentRoomId !== undefined
    && canMoveRoomToWorkspaceRoot(options.workspaceRole)
  );
  const hasMoveDestination = canMoveToRoot || parentRooms.length > 0;
  const destinationIds = useMemo(
    () => [
      ...(canMoveToRoot ? [WORKSPACE_ROOT_VALUE] : []),
      ...parentRooms.map((room) => room.id)
    ].join("\n"),
    [canMoveToRoot, parentRooms]
  );

  const currentContextStamp = useCallback((): ContextStamp | undefined => {
    if (!currentRoomId) return undefined;
    return {
      contextKey,
      targetKey: targetScopeKey,
      roomId: currentRoomId,
      generation: generationRef.current
    };
  }, [contextKey, currentRoomId, targetScopeKey]);

  const isCurrentContext = useCallback((stamp: ContextStamp): boolean => (
    stamp.contextKey === latestContextKeyRef.current
    && stamp.targetKey === latestTargetKeyRef.current
    && stamp.roomId === latestRoomIdRef.current
    && stamp.generation === generationRef.current
  ), []);

  const operationIdFor = useCallback((operationKey: string): string => {
    const existing = operationIdsRef.current.get(operationKey);
    if (existing) return existing;
    const operationId = createIdempotencyKey();
    operationIdsRef.current.set(operationKey, operationId);
    return operationId;
  }, []);

  useEffect(() => {
    membersSequenceRef.current += 1;
    movePreviewSequenceRef.current += 1;
    memberPreviewSequenceRef.current += 1;
    setMembers([]);
    setMembersLoading(false);
    setMembersError(null);
    setMovePreviewRecord(null);
    setMemberPreviewRecord(null);
    setActionError(null);
  }, [contextKey]);

  useEffect(() => {
    setMoveParentIdState((current) => {
      const allowed = new Set([
        ...(canMoveToRoot ? [WORKSPACE_ROOT_VALUE] : []),
        ...parentRooms.map((room) => room.id)
      ]);
      if (current && allowed.has(current)) return current;
      if (canMoveToRoot) return undefined;
      return parentRooms[0]?.id;
    });
  }, [canMoveToRoot, destinationIds, parentRooms]);

  const setCreateName = useCallback((value: string) => {
    setCreateNameState(value);
    setActionError(null);
  }, []);

  const setMoveParentId = useCallback((value: string | undefined) => {
    movePreviewSequenceRef.current += 1;
    setMoveParentIdState(value);
    setMovePreviewRecord(null);
    setActionError(null);
  }, []);

  const setMemberAccountId = useCallback((value: string) => {
    memberPreviewSequenceRef.current += 1;
    setMemberAccountIdState(value);
    setMemberPreviewRecord(null);
    setActionError(null);
  }, []);

  const setMemberRole = useCallback((value: NativeRoomAdministrationRole) => {
    memberPreviewSequenceRef.current += 1;
    setMemberRoleState(value);
    setMemberPreviewRecord(null);
    setActionError(null);
  }, []);

  const setMemberState = useCallback((value: NativeRoomAdministrationMemberState) => {
    memberPreviewSequenceRef.current += 1;
    setMemberStateState(value);
    setMemberPreviewRecord(null);
    setActionError(null);
  }, []);

  const refreshMembers = useCallback(async (): Promise<DesktopWorkspaceRoomMembership[]> => {
    const roomId = currentRoomId;
    const stamp = currentContextStamp();
    if (!roomId || !stamp || currentRoomIsDm || !roomCanManage) {
      if (isCurrentContext(stamp ?? { contextKey, targetKey: targetScopeKey, roomId: roomId ?? "", generation: generationRef.current })) {
        setMembers([]);
      }
      return [];
    }
    if (!target) {
      setMembersError("workspace_target_required");
      return [];
    }
    if (!bridge?.listWorkspaceRoomMembers) {
      setMembersError("room_members_api_unavailable");
      return [];
    }
    const sequence = ++membersSequenceRef.current;
    setMembersLoading(true);
    setMembersError(null);
    try {
      const response = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.listWorkspaceRoomMembers!(roomId));
      if (!isCurrentContext(stamp) || sequence !== membersSequenceRef.current) return [];
      const nextMembers = normalizeMembers(response, target, roomId);
      setMembers(nextMembers);
      return nextMembers;
    } catch (error) {
      if (isCurrentContext(stamp) && sequence === membersSequenceRef.current) {
        setMembersError(nativeRoomAdministrationErrorMessage(error, "Roomのmembershipを読み込めませんでした。"));
      }
      return [];
    } finally {
      if (isCurrentContext(stamp) && sequence === membersSequenceRef.current) {
        setMembersLoading(false);
      }
    }
  }, [bridge, contextKey, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, roomCanManage, target, targetScopeKey]);

  useEffect(() => {
    if (!currentRoomIsDm && roomCanManage) {
      void refreshMembers();
    }
  }, [currentRoomIsDm, refreshMembers, roomCanManage]);

  const createChildRoom = useCallback(async (input?: { name?: string }): Promise<unknown> => {
    const roomId = currentRoomId;
    const name = (input?.name ?? createName).trim();
    const stamp = currentContextStamp();
    if (!roomId || !stamp || currentRoomIsDm) {
      setActionError("agent_dm_room_administration_unavailable");
      return undefined;
    }
    if (!roomCanManage) {
      setActionError("room_manage_permission_required");
      return undefined;
    }
    if (!target) {
      setActionError("workspace_target_required");
      return undefined;
    }
    if (!isValidVersion(options.workspaceVersion)) {
      setActionError("workspace_version_required");
      return undefined;
    }
    const workspaceVersion = options.workspaceVersion;
    if (!name) {
      setActionError("room_name_required");
      return undefined;
    }
    if (!bridge?.createWorkspaceRoom) {
      setActionError("room_create_api_unavailable");
      return undefined;
    }
    const operationKey = `create\n${targetScopeKey}\n${roomId}\n${name}\n${workspaceVersion}`;
    const operationId = operationIdFor(operationKey);
    setBusyAction("create-child");
    setActionError(null);
    try {
      const result = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.createWorkspaceRoom!(nativeRoomAdministrationCreateInput({
        name,
        parentRoomId: roomId,
        expectedWorkspaceVersion: workspaceVersion,
        operationId,
        target
      })));
      operationIdsRef.current.delete(operationKey);
      if (isCurrentContext(stamp)) {
        if (createName.trim() === name) setCreateNameState("");
        try {
          await options.onRefresh?.("room-created");
        } catch (refreshError) {
          setActionError(nativeRoomAdministrationErrorMessage(refreshError, "Room一覧の更新に失敗しました。"));
        }
      }
      return result;
    } catch (error) {
      if (isCurrentContext(stamp)) {
        setActionError(nativeRoomAdministrationErrorMessage(error, "子Roomを作成できませんでした。"));
      }
      return undefined;
    } finally {
      if (isCurrentContext(stamp)) setBusyAction(null);
    }
  }, [bridge, createName, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, operationIdFor, options.onRefresh, options.workspaceVersion, roomCanManage, target, targetScopeKey]);

  const previewRoomMove = useCallback(async (input?: { parentRoomId?: string }): Promise<DesktopRoomMovePreview | undefined> => {
    const roomId = currentRoomId;
    const parentRoomId = input?.parentRoomId ?? (moveParentId === WORKSPACE_ROOT_VALUE ? null : moveParentId ?? null);
    const stamp = currentContextStamp();
    const destinationIsAllowed = parentRoomId === null
      ? canMoveToRoot
      : parentRooms.some((room) => room.id === parentRoomId);
    if (!roomId || !stamp || currentRoomIsDm) {
      setActionError("agent_dm_room_administration_unavailable");
      return undefined;
    }
    if (!roomCanManage) {
      setActionError("room_manage_permission_required");
      return undefined;
    }
    if (!target) {
      setActionError("workspace_target_required");
      return undefined;
    }
    if (!destinationIsAllowed || parentRoomId === roomId || parentRoomId === activeRoom?.parentRoomId) {
      setActionError("room_move_destination_invalid");
      return undefined;
    }
    if (!bridge?.previewWorkspaceRoomMove) {
      setActionError("room_move_preview_api_unavailable");
      return undefined;
    }
    const sequence = ++movePreviewSequenceRef.current;
    setBusyAction("preview-move");
    setActionError(null);
    try {
      const result = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.previewWorkspaceRoomMove!({
        roomId,
        parentRoomId,
        target: { ...target }
      }));
      if (!isCurrentContext(stamp) || sequence !== movePreviewSequenceRef.current) return undefined;
      const preview = normalizeMovePreview(result?.preview);
      setMovePreviewRecord({
        preview,
        stamp,
        parentRoomId,
        roomVersion: activeRoom?.version,
        workspaceVersion: options.workspaceVersion,
        sequence
      });
      return preview;
    } catch (error) {
      if (isCurrentContext(stamp) && sequence === movePreviewSequenceRef.current) {
        setActionError(nativeRoomAdministrationErrorMessage(error, "Roomの移動条件を確認できませんでした。"));
      }
      return undefined;
    } finally {
      if (isCurrentContext(stamp) && sequence === movePreviewSequenceRef.current) setBusyAction(null);
    }
  }, [activeRoom?.parentRoomId, activeRoom?.version, bridge, canMoveToRoot, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, moveParentId, options.workspaceVersion, parentRooms, roomCanManage, target]);

  const movePreviewIsCurrent = Boolean(
    movePreviewRecord
    && isCurrentContext(movePreviewRecord.stamp)
    && movePreviewRecord.sequence === movePreviewSequenceRef.current
    && movePreviewRecord.parentRoomId === (moveParentId === WORKSPACE_ROOT_VALUE ? null : moveParentId ?? null)
    && movePreviewRecord.roomVersion === activeRoom?.version
    && movePreviewRecord.workspaceVersion === options.workspaceVersion
  );

  const moveCurrentRoom = useCallback(async (): Promise<unknown> => {
    const roomId = currentRoomId;
    const stamp = currentContextStamp();
    const record = movePreviewRecord;
    const parentRoomId = moveParentId === WORKSPACE_ROOT_VALUE ? null : moveParentId ?? null;
    if (!roomId || !stamp || currentRoomIsDm) {
      setActionError("agent_dm_room_administration_unavailable");
      return undefined;
    }
    if (!roomCanManage) {
      setActionError("room_manage_permission_required");
      return undefined;
    }
    if (!target) {
      setActionError("workspace_target_required");
      return undefined;
    }
    if (!isValidVersion(activeRoom?.version) || !isValidVersion(options.workspaceVersion)) {
      setActionError("room_or_workspace_version_required");
      return undefined;
    }
    const roomVersion = activeRoom.version;
    const workspaceVersion = options.workspaceVersion;
    if (!record || !record.preview.allowed || !movePreviewIsCurrent) {
      setActionError("room_move_preview_required");
      return undefined;
    }
    if (!bridge?.moveWorkspaceRoom) {
      setActionError("room_move_api_unavailable");
      return undefined;
    }
    const operationKey = `move\n${targetScopeKey}\n${roomId}\n${parentRoomId ?? WORKSPACE_ROOT_VALUE}\n${roomVersion}\n${workspaceVersion}`;
    const operationId = operationIdFor(operationKey);
    setBusyAction("move");
    setActionError(null);
    try {
      const result = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.moveWorkspaceRoom!(nativeRoomAdministrationMoveInput({
        roomId,
        parentRoomId,
        expectedRoomVersion: roomVersion,
        expectedWorkspaceVersion: workspaceVersion,
        operationId,
        target
      })));
      operationIdsRef.current.delete(operationKey);
      if (isCurrentContext(stamp)) {
        setMovePreviewRecord(null);
        try {
          await options.onRefresh?.("room-moved");
        } catch (refreshError) {
          setActionError(nativeRoomAdministrationErrorMessage(refreshError, "Room一覧の更新に失敗しました。"));
        }
      }
      return result;
    } catch (error) {
      if (isCurrentContext(stamp)) {
        setActionError(nativeRoomAdministrationErrorMessage(error, "Roomを移動できませんでした。"));
      }
      return undefined;
    } finally {
      if (isCurrentContext(stamp)) setBusyAction(null);
    }
  }, [activeRoom?.version, bridge, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, moveParentId, movePreviewIsCurrent, movePreviewRecord, operationIdFor, options.onRefresh, options.workspaceVersion, roomCanManage, target, targetScopeKey]);

  const previewMemberChange = useCallback(async (input?: {
    accountId?: string;
    role?: NativeRoomAdministrationRole;
    state?: NativeRoomAdministrationMemberState;
  }): Promise<DesktopRoomMemberPreview | undefined> => {
    const roomId = currentRoomId;
    const accountId = (input?.accountId ?? memberAccountId).trim();
    const role = input?.role ?? memberRole;
    const state = input?.state ?? memberState;
    const stamp = currentContextStamp();
    if (!roomId || !stamp || currentRoomIsDm) {
      setActionError("agent_dm_room_administration_unavailable");
      return undefined;
    }
    if (!roomCanManage) {
      setActionError("room_manage_permission_required");
      return undefined;
    }
    if (!target) {
      setActionError("workspace_target_required");
      return undefined;
    }
    if (!accountId) {
      setActionError("member_account_id_required");
      return undefined;
    }
    if (!bridge?.previewWorkspaceRoomMember) {
      setActionError("room_member_preview_api_unavailable");
      return undefined;
    }
    const sequence = ++memberPreviewSequenceRef.current;
    setBusyAction("preview-member");
    setActionError(null);
    try {
      const result = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.previewWorkspaceRoomMember!({
        roomId,
        accountId,
        role,
        state,
        target: { ...target }
      }));
      if (!isCurrentContext(stamp) || sequence !== memberPreviewSequenceRef.current) return undefined;
      const preview = normalizeMemberPreview(result?.preview);
      setMemberPreviewRecord({
        preview,
        stamp,
        accountId,
        role,
        state,
        memberVersion: members.find((member) => member.accountId === accountId)?.version ?? 0,
        sequence
      });
      return preview;
    } catch (error) {
      if (isCurrentContext(stamp) && sequence === memberPreviewSequenceRef.current) {
        setActionError(nativeRoomAdministrationErrorMessage(error, "membershipの影響を確認できませんでした。"));
      }
      return undefined;
    } finally {
      if (isCurrentContext(stamp) && sequence === memberPreviewSequenceRef.current) setBusyAction(null);
    }
  }, [bridge, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, memberAccountId, memberRole, memberState, members, roomCanManage, target]);

  const memberPreviewIsCurrent = Boolean(
    memberPreviewRecord
    && isCurrentContext(memberPreviewRecord.stamp)
    && memberPreviewRecord.sequence === memberPreviewSequenceRef.current
    && memberPreviewRecord.accountId === memberAccountId.trim()
    && memberPreviewRecord.role === memberRole
    && memberPreviewRecord.state === memberState
    && memberPreviewRecord.memberVersion === (members.find((member) => member.accountId === memberAccountId.trim())?.version ?? 0)
  );

  const saveMemberChange = useCallback(async (): Promise<unknown> => {
    const roomId = currentRoomId;
    const accountId = memberAccountId.trim();
    const stamp = currentContextStamp();
    const record = memberPreviewRecord;
    const currentMember = members.find((member) => member.accountId === accountId);
    if (!roomId || !stamp || currentRoomIsDm) {
      setActionError("agent_dm_room_administration_unavailable");
      return undefined;
    }
    if (!roomCanManage) {
      setActionError("room_manage_permission_required");
      return undefined;
    }
    if (!target) {
      setActionError("workspace_target_required");
      return undefined;
    }
    if (!accountId) {
      setActionError("member_account_id_required");
      return undefined;
    }
    if (!record || !record.preview.allowed || !memberPreviewIsCurrent) {
      setActionError("room_member_preview_required");
      return undefined;
    }
    if (!bridge?.setWorkspaceRoomMember) {
      setActionError("room_member_api_unavailable");
      return undefined;
    }
    const expectedVersion = currentMember?.version ?? 0;
    const operationKey = `member\n${targetScopeKey}\n${roomId}\n${accountId}\n${memberRole}\n${memberState}\n${expectedVersion}`;
    const operationId = operationIdFor(operationKey);
    setBusyAction("save-member");
    setActionError(null);
    try {
      const result = await withNativeRoomAdministrationTarget(bridge, target, () => bridge.setWorkspaceRoomMember!(nativeRoomAdministrationMemberInput({
        roomId,
        accountId,
        role: memberRole,
        state: memberState,
        expectedVersion,
        operationId,
        target
      })));
      operationIdsRef.current.delete(operationKey);
      if (isCurrentContext(stamp)) {
        setMemberPreviewRecord(null);
        await refreshMembers();
        try {
          await options.onRefresh?.("membership-changed");
        } catch (refreshError) {
          setActionError(nativeRoomAdministrationErrorMessage(refreshError, "membership一覧の更新に失敗しました。"));
        }
      }
      return result;
    } catch (error) {
      if (isCurrentContext(stamp)) {
        setActionError(nativeRoomAdministrationErrorMessage(error, "membershipを変更できませんでした。"));
      }
      return undefined;
    } finally {
      if (isCurrentContext(stamp)) setBusyAction(null);
    }
  }, [bridge, currentContextStamp, currentRoomId, currentRoomIsDm, isCurrentContext, memberAccountId, memberPreviewIsCurrent, memberPreviewRecord, memberRole, memberState, members, operationIdFor, options.onRefresh, refreshMembers, roomCanManage, target, targetScopeKey]);

  return {
    activeRoom,
    currentRoomId,
    target,
    targetScopeKey,
    contextKey,
    currentRoomIsDm,
    roomCanManage,
    workspaceVersion: options.workspaceVersion,
    parentRooms,
    canMoveToRoot,
    hasMoveDestination,
    moveParentId,
    setMoveParentId,
    movePreview: movePreviewRecord?.preview ?? null,
    members,
    membersLoading,
    membersError,
    refreshMembers,
    createName,
    setCreateName,
    createChildRoom,
    previewRoomMove,
    moveCurrentRoom,
    memberAccountId,
    setMemberAccountId,
    memberRole,
    setMemberRole,
    memberState,
    setMemberState,
    memberPreview: memberPreviewRecord?.preview ?? null,
    previewMemberChange,
    saveMemberChange,
    actionError,
    setActionError,
    busyAction,
    busy: busyAction !== null
  };
}
