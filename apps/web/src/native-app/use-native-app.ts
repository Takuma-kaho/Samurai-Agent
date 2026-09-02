import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActivityInboxItem, ArtifactRecord, BackendRunRecord, MemoryFrontmatter, MessageRecord } from "@samurai-agent/core-schemas";
import {
  api,
  createIdempotencyKey,
  getWorkspaceClientBridge,
  setActiveWorkspaceRoomId,
  type DesktopWorkspaceConnection,
  type DesktopWorkspaceConnectionState,
  type DesktopWorkspaceRoom,
  type ChatTurnResult,
  type SessionDetail
} from "../lib/api";
import { createOrganizationApi, OrganizationApiError } from "../lib/organization-api";
import { clearNativeSelectionCandidate, readNativeSelectionCandidate, writeNativeSelectionCandidate } from "../lib/native-app-preferences";
import type {
  NativeChatMessage,
  NativeEvidenceBundle,
  NativeOrganization,
  NativeOrganizationInvitation,
  NativeOrganizationMember,
  NativeRoom,
  NativeWorkspace,
  NativeWorkspaceBundleExport,
  NativeWorkspaceBundleRestoreResult,
  NativeWorkspaceMovePreview,
  OrganizationRole
} from "./types";

const legacyOrganizationId = "__legacy_connection__";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof OrganizationApiError) return error.code;
  if (error instanceof Error) return error.message;
  return "request_failed";
}

function isPermissionError(error: unknown): boolean {
  const message = errorCode(error).toLowerCase();
  return /permission|forbidden|not.?found|access|unauthori[sz]ed|403|401|revoke|denied/.test(message);
}

function userFacingError(error: unknown, fallback: string): string {
  if (isPermissionError(error)) return "権限が変わったため、保護された内容を表示できません。Serverを再確認してください。";
  if (errorCode(error).includes("workspace_connection_required")) return "Workspace Serverへの接続が必要です。";
  return fallback;
}

function randomLocalId(prefix: string): string {
  return `${prefix}_${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Date.now()}`;
}

function connectionFromState(state: DesktopWorkspaceConnectionState): DesktopWorkspaceConnection | undefined {
  return state.connections.find((connection) => connection.id === state.activeConnectionId) ?? state.connections[0];
}

function nativeRoom(room: DesktopWorkspaceRoom): NativeRoom {
  const roomCapabilities = room as DesktopWorkspaceRoom & { canExecute?: boolean };
  return {
    id: room.id,
    workspaceId: room.workspaceId,
    name: room.name,
    ...(room.parentRoomId ? { parentRoomId: room.parentRoomId } : {}),
    ...(roomCapabilities.canExecute === undefined ? {} : { canExecute: roomCapabilities.canExecute }),
    ...(room.canManage === undefined ? {} : { canManage: room.canManage }),
    version: room.version,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt
  };
}

function nativeRooms(value: unknown): NativeRoom[] {
  const body = record(value);
  const rows = Array.isArray(value) ? value : Array.isArray(body.rooms) ? body.rooms : [];
  return rows.map((entry) => {
    const room = record(entry);
    return {
      id: stringValue(room.id ?? room.room_id),
      workspaceId: stringValue(room.workspace_id),
      name: stringValue(room.name, "名称未設定のRoom"),
      ...(optionalString(room.parent_room_id ?? room.parentRoomId) ? { parentRoomId: optionalString(room.parent_room_id ?? room.parentRoomId) } : {}),
      ...(typeof room.can_execute === "boolean" ? { canExecute: room.can_execute } : {}),
      ...(typeof room.can_manage === "boolean" ? { canManage: room.can_manage } : {}),
      ...(typeof room.version === "number" ? { version: room.version } : {}),
      ...(optionalString(room.created_at) ? { createdAt: optionalString(room.created_at) } : {}),
      ...(optionalString(room.updated_at) ? { updatedAt: optionalString(room.updated_at) } : {})
    } satisfies NativeRoom;
  }).filter((room) => room.id.length > 0);
}

function legacyWorkspace(status: unknown, connection: DesktopWorkspaceConnection): NativeWorkspace {
  const statusBody = record(status);
  const workspaceEnvelope = record(statusBody.workspace);
  const body = record(workspaceEnvelope.body ?? workspaceEnvelope);
  const workspace = record(body.workspace ?? body);
  const state = workspace.state === "archived" || workspace.state === "read_only" ? workspace.state : "active";
  const role = workspace.role === "owner" || workspace.role === "admin" || workspace.role === "member" || workspace.role === "guest" ? workspace.role : "member";
  return {
    id: stringValue(workspace.id, connection.workspaceId),
    organizationId: legacyOrganizationId,
    name: stringValue(workspace.name ?? workspace.workspace_name, connection.label),
    state,
    access: "granted",
    role,
    ...(typeof workspace.version === "number" ? { version: workspace.version } : {}),
    ...(optionalString(workspace.created_at) ? { createdAt: optionalString(workspace.created_at) } : {}),
    ...(optionalString(workspace.updated_at) ? { updatedAt: optionalString(workspace.updated_at) } : {})
  };
}

function nativeMessage(message: MessageRecord): NativeChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.created_at
  };
}

function withEvidence(messages: NativeChatMessage[], evidence: NativeEvidenceBundle): NativeChatMessage[] {
  const refs = [
    ...evidence.activity.map((item) => ({ id: item.id, kind: "activity" as const, label: item.title || item.id, status: item.severity, createdAt: item.created_at })),
    ...evidence.artifacts.map((item) => ({ id: item.id, kind: "file" as const, label: item.title || item.id, status: item.kind })),
    ...evidence.memories.map((item) => ({ id: item.id, kind: "knowledge" as const, label: item.title || item.id, status: item.state }))
  ];
  if (!refs.length) return messages;
  return messages.map((message) => message.role === "agent" ? { ...message, evidence: refs } : message);
}

function evidenceFromDetail(detail: SessionDetail): NativeEvidenceBundle {
  return {
    activity: detail.activity,
    backendRuns: detail.backendRuns,
    artifacts: detail.artifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind })),
    memories: detail.memory.map((memory) => ({ id: memory.id, title: memory.topic, state: memory.state }))
  };
}

function evidenceFromResult(result: { activity: ActivityInboxItem[]; backendRun: BackendRunRecord; artifacts: ArtifactRecord[]; memories: MemoryFrontmatter[] }): NativeEvidenceBundle {
  return {
    activity: result.activity,
    backendRuns: result.backendRun ? [result.backendRun] : [],
    artifacts: result.artifacts.map((artifact) => ({ id: artifact.id, title: artifact.title, kind: artifact.kind })),
    memories: result.memories.map((memory) => ({ id: memory.id, title: memory.topic, state: memory.state }))
  };
}

export function useNativeApp() {
  const bridge = useMemo(() => getWorkspaceClientBridge(), []);
  const organizationApi = useMemo(() => createOrganizationApi(), []);
  const browserMode = typeof window !== "undefined" && !window.samuraiDesktop;

  const [connectionState, setConnectionState] = useState<DesktopWorkspaceConnectionState>({ connections: [] });
  const [connection, setConnection] = useState<DesktopWorkspaceConnection>();
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [transportState, setTransportState] = useState<"connected" | "reconnecting" | "offline">("reconnecting");
  const [organizations, setOrganizations] = useState<NativeOrganization[]>([]);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationApiAvailable, setOrganizationApiAvailable] = useState(true);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<NativeWorkspace[]>([]);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [rooms, setRooms] = useState<NativeRoom[]>([]);
  const [roomLoading, setRoomLoading] = useState(false);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [chatLoading, setChatLoading] = useState(false);
  const [messages, setMessages] = useState<NativeChatMessage[]>([]);
  const [chatError, setChatError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sessionId, setSessionId] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [evidence, setEvidence] = useState<NativeEvidenceBundle>({ activity: [], backendRuns: [], artifacts: [], memories: [] });
  const [evidenceMessage, setEvidenceMessage] = useState<NativeChatMessage>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [members, setMembers] = useState<NativeOrganizationMember[]>([]);
  const [invitations, setInvitations] = useState<NativeOrganizationInvitation[]>([]);
  const [managementError, setManagementError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [workspaceRefreshNonce, setWorkspaceRefreshNonce] = useState(0);
  const initializedConnection = useRef(false);

  const selectedOrganization = organizations.find((organization) => organization.id === selectedOrganizationId);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedRoom = rooms.find((room) => room.id === selectedRoomId);

  const refreshConnections = useCallback(async (): Promise<void> => {
    if (!bridge?.listWorkspaceConnections) {
      setConnectionLoading(false);
      setConnectionError("Workspace Server bridgeが利用できません。");
      setTransportState("offline");
      return;
    }
    setConnectionLoading(true);
    try {
      const state = await bridge.listWorkspaceConnections();
      const active = connectionFromState(state);
      setConnectionState(state);
      setConnection(active);
      setConnectionError(null);
      setTransportState(active ? "connected" : "offline");
    } catch (error) {
      setConnectionError(userFacingError(error, "接続先を確認できませんでした。"));
      setTransportState("offline");
    } finally {
      setConnectionLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (initializedConnection.current) return;
    initializedConnection.current = true;
    void refreshConnections();
  }, [refreshConnections]);

  const loadLegacyWorkspace = useCallback(async (active: DesktopWorkspaceConnection): Promise<void> => {
    if (!bridge) return;
    try {
      const status = bridge.getWorkspaceServerStatus ? await bridge.getWorkspaceServerStatus() : undefined;
      const workspace = legacyWorkspace(status, active);
      const listedRooms = bridge.listWorkspaceRooms ? (await bridge.listWorkspaceRooms()).rooms.map(nativeRoom) : nativeRooms(record(status).rooms);
      const legacy: NativeOrganization = { id: legacyOrganizationId, name: "接続先（移行中）", state: "active", role: workspace.role ?? "member", workspaceCount: 1, workspaces: [{ ...workspace, rooms: listedRooms }] };
      setOrganizations([legacy]);
      setSelectedOrganizationId(legacyOrganizationId);
      setWorkspaces([{ ...workspace, rooms: listedRooms }]);
      setSelectedWorkspaceId(workspace.id);
      setOrganizationError("Organization APIはまだ接続されていません。既存Workspaceを安全な移行表示で開いています。");
      setWorkspaceError(null);
      setTransportState("connected");
    } catch (error) {
      setOrganizations([]);
      setWorkspaces([]);
      setSelectedOrganizationId(undefined);
      setSelectedWorkspaceId(undefined);
      setRoomError(userFacingError(error, "Workspaceを確認できませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    }
  }, [bridge]);

  const loadOrganizations = useCallback(async (active: DesktopWorkspaceConnection): Promise<void> => {
    setOrganizationLoading(true);
    setOrganizationError(null);
    try {
      const values = await organizationApi.listOrganizations();
      setOrganizationApiAvailable(true);
      setOrganizations(values);
      setTransportState("connected");
      if (values.length === 0) {
        setSelectedOrganizationId(undefined);
        setSelectedWorkspaceId(undefined);
        setWorkspaces([]);
        setRooms([]);
        setSelectedRoomId(undefined);
        clearNativeSelectionCandidate();
        return;
      }
      const candidate = readNativeSelectionCandidate(active);
      const selected = values.find((organization) => organization.id === candidate?.organizationId) ?? values[0];
      if (!selected) return;
      setSelectedOrganizationId(selected.id);
    } catch (error) {
      setOrganizationApiAvailable(false);
      await loadLegacyWorkspace(active);
    } finally {
      setOrganizationLoading(false);
    }
  }, [loadLegacyWorkspace, organizationApi]);

  useEffect(() => {
    if (!connection) return;
    void loadOrganizations(connection);
  }, [connection, loadOrganizations, refreshNonce]);

  const loadOrganizationWorkspaces = useCallback(async (organizationId: string, active: DesktopWorkspaceConnection): Promise<void> => {
    if (organizationId === legacyOrganizationId) return;
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    try {
      const values = await organizationApi.listWorkspaces(organizationId);
      setWorkspaces(values);
      const candidate = readNativeSelectionCandidate(active);
      const selected = values.find((workspace) => workspace.id === candidate?.workspaceId && workspace.access === "granted")
        ?? values.find((workspace) => workspace.access === "granted");
      setSelectedWorkspaceId(selected?.id);
      setRooms([]);
      setSelectedRoomId(undefined);
      setOrganizations((current) => current.map((organization) => organization.id === organizationId
        ? { ...organization, workspaceCount: values.length }
        : organization));
      if (selected) {
        writeNativeSelectionCandidate({ organizationId, workspaceId: selected.id }, active);
      } else {
        writeNativeSelectionCandidate({ organizationId }, active);
      }
    } catch (error) {
      setWorkspaces([]);
      setSelectedWorkspaceId(undefined);
      setRooms([]);
      setSelectedRoomId(undefined);
      setWorkspaceError(userFacingError(error, "Workspace一覧を確認できませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      setWorkspaceLoading(false);
    }
  }, [organizationApi]);

  useEffect(() => {
    if (!connection || !selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    void loadOrganizationWorkspaces(selectedOrganizationId, connection);
  }, [connection, loadOrganizationWorkspaces, selectedOrganizationId, refreshNonce]);

  // The public Organization projection intentionally contains no membership
  // role. Resolve the current Account's role separately so Owner/Admin UI is
  // enabled only after Server authorization, never from a local candidate.
  useEffect(() => {
    if (!connection || !selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    let cancelled = false;
    void organizationApi.listMembers(selectedOrganizationId).then((values) => {
      if (cancelled) return;
      const membership = values.find((member) => member.accountId === connection.accountId && member.state === "active");
      if (!membership) return;
      setOrganizations((current) => current.map((organization) => organization.id === selectedOrganizationId
        ? { ...organization, role: membership.role }
        : organization));
    }).catch(() => {
      // A member projection may be unavailable to a Guest. The safe default
      // remains member, which only removes management affordances.
    });
    return () => {
      cancelled = true;
    };
  }, [connection, organizationApi, selectedOrganizationId, refreshNonce]);

  const activateWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!bridge || !connection || workspace.access !== "granted") return;
    setRoomLoading(true);
    setRoomError(null);
    setChatError(null);
    setRooms([]);
    setSelectedRoomId(undefined);
    setActiveWorkspaceRoomId(undefined);
    try {
      let authorizedConnection = connection;
      if (connection.workspaceId !== workspace.id) {
        if (!bridge.selectWorkspaceCandidate) throw new Error("workspace_switch_requires_desktop_bridge");
        const nextState = await bridge.selectWorkspaceCandidate(workspace.id);
        const nextConnection = connectionFromState(nextState);
        if (nextConnection) {
          authorizedConnection = nextConnection;
          setConnectionState(nextState);
          setConnection(nextConnection);
        }
      }
      const status = bridge.getWorkspaceServerStatus ? await bridge.getWorkspaceServerStatus() : undefined;
      const statusBody = record(status);
      const workspaceStatus = record(statusBody.workspace);
      if (workspaceStatus.status !== undefined && workspaceStatus.status !== 200) throw new Error("workspace_reauthorization_denied");
      const listed = bridge.listWorkspaceRooms ? (await bridge.listWorkspaceRooms()).rooms.map(nativeRoom) : [];
      setRooms(listed);
      const candidate = readNativeSelectionCandidate(authorizedConnection);
      const selected = listed.find((room) => room.id === candidate?.roomId) ?? listed[0];
      setSelectedRoomId(selected?.id);
      if (selectedOrganizationId) writeNativeSelectionCandidate({ organizationId: selectedOrganizationId, workspaceId: workspace.id, ...(selected ? { roomId: selected.id } : {}) }, authorizedConnection);
      setTransportState("connected");
    } catch (error) {
      setRoomError(userFacingError(error, "このWorkspaceを再認可できませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      setRoomLoading(false);
    }
  }, [bridge, connection, selectedOrganizationId]);

  useEffect(() => {
    if (!selectedWorkspace || !connection || selectedWorkspace.access !== "granted") {
      setRooms([]);
      setSelectedRoomId(undefined);
      setActiveWorkspaceRoomId(undefined);
      return;
    }
    void activateWorkspace(selectedWorkspace);
  }, [activateWorkspace, connection, selectedWorkspace, workspaceRefreshNonce]);

  const openRoom = useCallback(async (room: NativeRoom): Promise<void> => {
    if (!bridge || !selectedWorkspace || selectedWorkspace.access !== "granted") return;
    setSelectedRoomId(room.id);
    setActiveWorkspaceRoomId(room.id);
    if (connection && selectedOrganizationId) writeNativeSelectionCandidate({ organizationId: selectedOrganizationId, workspaceId: selectedWorkspace.id, roomId: room.id }, connection);
    setChatLoading(true);
    setChatError(null);
    setMessages([]);
    setSessionId(undefined);
    setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    try {
      const sessions = bridge.listWorkspaceChatSessions ? await bridge.listWorkspaceChatSessions() : [];
      const roomSession = sessions
        .filter((session) => session.room_id === room.id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];
      const session = roomSession ?? (bridge.createWorkspaceChatSession ? await bridge.createWorkspaceChatSession({ roomId: room.id, operationId: createIdempotencyKey() }) : undefined);
      if (!session) throw new Error("chat_session_unavailable");
      setSessionId(session.id);
      const detail = bridge.getWorkspaceChatSession ? await bridge.getWorkspaceChatSession({ sessionId: session.id }) : await api.getSession(session.id);
      const nextEvidence = evidenceFromDetail(detail);
      setEvidence(nextEvidence);
      setMessages(withEvidence(detail.messages.map(nativeMessage), nextEvidence));
      setTransportState("connected");
    } catch (error) {
      setChatError(userFacingError(error, "会話を読み込めませんでした。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      setChatLoading(false);
    }
  }, [bridge, connection, selectedOrganizationId, selectedWorkspace]);

  useEffect(() => {
    const room = rooms.find((candidate) => candidate.id === selectedRoomId);
    if (room) void openRoom(room);
    else {
      setMessages([]);
      setSessionId(undefined);
      setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
    }
  }, [openRoom, rooms, selectedRoomId]);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    if (!selectedRoom) throw new Error("room_required");
    const created = await api.createSession({ room_id: selectedRoom.id });
    setSessionId(created.id);
    return created.id;
  }, [selectedRoom, sessionId]);

  const sendMessage = useCallback(async (content: string): Promise<void> => {
    if (!selectedRoom || !selectedWorkspace || selectedWorkspace.access !== "granted" || selectedWorkspace.state !== "active" || selectedRoom.canExecute === false) return;
    const localMessage: NativeChatMessage = { id: randomLocalId("pending"), role: "user", content, pending: true };
    setMessages((current) => [...current, localMessage]);
    setSending(true);
    setChatError(null);
    const operationId = createIdempotencyKey();
    try {
      const currentSessionId = await ensureSession();
      const response = await api.submitChatSurfaceOperation({ sessionId: currentSessionId, content, outputLocale: "ja", idempotencyKey: operationId });
      const result = ("result" in response ? response.result : response) as ChatTurnResult;
      const nextEvidence = evidenceFromResult(result);
      setEvidence(nextEvidence);
      setActiveRunId(result.backendRun?.id);
      setMessages(withEvidence(result.messages.map(nativeMessage), nextEvidence));
      setTransportState("connected");
    } catch (error) {
      setMessages((current) => current.map((message) => message.id === localMessage.id ? { ...message, pending: false, failed: true, retryable: !isPermissionError(error) } : message));
      setChatError(userFacingError(error, "Agentへの送信に失敗しました。送信済みかを確認してから再試行してください。"));
      setTransportState(isPermissionError(error) ? "offline" : "reconnecting");
    } finally {
      setSending(false);
    }
  }, [ensureSession, selectedRoom, selectedWorkspace]);

  const stopMessage = useCallback(async (): Promise<void> => {
    if (!activeRunId) {
      setChatError("停止要求を送る実行情報を確認できません。現在の送信状態を維持しています。");
      return;
    }
    try {
      await api.cancelBackendRun(activeRunId);
      setSending(false);
      setActiveRunId(undefined);
    } catch (error) {
      setChatError(userFacingError(error, "Agentを停止できませんでした。"));
    }
  }, [activeRunId]);

  const retryMessage = useCallback(async (message: NativeChatMessage): Promise<void> => {
    setMessages((current) => current.filter((item) => item.id !== message.id));
    await sendMessage(message.content);
  }, [sendMessage]);

  const reconnect = useCallback(async (): Promise<void> => {
    setTransportState("reconnecting");
    setChatError(null);
    setWorkspaceRefreshNonce((value) => value + 1);
    setRefreshNonce((value) => value + 1);
    await refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    if (!bridge?.onWorkspaceServerEvent) return undefined;
    return bridge.onWorkspaceServerEvent((event) => {
      if (!event || (selectedWorkspaceId && event.workspaceId !== selectedWorkspaceId)) return;
      if (event.type === "access_revoked" || event.type === "room_access_revoked") {
        setMessages([]);
        setEvidence({ activity: [], backendRuns: [], artifacts: [], memories: [] });
        setSelectedRoomId(undefined);
        setActiveWorkspaceRoomId(undefined);
        setChatError("権限が変更されたため、保護された内容を閉じました。");
        setTransportState("offline");
      } else {
        setWorkspaceRefreshNonce((value) => value + 1);
      }
    });
  }, [bridge, selectedWorkspaceId]);

  const selectOrganization = useCallback((organizationId: string): void => {
    if (!organizations.some((organization) => organization.id === organizationId)) return;
    setSelectedOrganizationId(organizationId);
    setSelectedWorkspaceId(undefined);
    setSelectedRoomId(undefined);
    setRooms([]);
    setChatError(null);
    if (connection) writeNativeSelectionCandidate({ organizationId }, connection);
    if (bridge?.selectOrganizationCandidate) {
      void bridge.selectOrganizationCandidate({ organizationId }).catch((error) => {
        setOrganizationError(userFacingError(error, "Organizationを再確認できませんでした。"));
      });
    }
  }, [bridge, connection, organizations]);

  const selectWorkspace = useCallback((workspace: NativeWorkspace): void => {
    if (workspace.access !== "granted") {
      setSelectedWorkspaceId(undefined);
      setSelectedRoomId(undefined);
      setRooms([]);
      setActiveWorkspaceRoomId(undefined);
      setWorkspaceError("このWorkspaceへのアクセス権限がありません。");
      if (connection && selectedOrganizationId) writeNativeSelectionCandidate({ organizationId: selectedOrganizationId }, connection);
      return;
    }
    setWorkspaceError(null);
    setSelectedWorkspaceId(workspace.id);
    setSelectedRoomId(undefined);
    setRooms([]);
    setActiveWorkspaceRoomId(undefined);
    if (connection && selectedOrganizationId) writeNativeSelectionCandidate({ organizationId: selectedOrganizationId, workspaceId: workspace.id }, connection);
  }, [connection, selectedOrganizationId]);

  const createOrganization = useCallback(async (input: { name: string; description?: string }): Promise<void> => {
    const created = await organizationApi.createOrganization(input);
    setOrganizations((current) => [...current, { ...created, role: "owner" }]);
    setSelectedOrganizationId(created.id);
    setOrganizationError(null);
    if (connection) writeNativeSelectionCandidate({ organizationId: created.id }, connection);
  }, [connection, organizationApi]);

  const createWorkspace = useCallback(async (input: { name: string }): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const created = await organizationApi.createWorkspace(selectedOrganizationId, input);
    setWorkspaces((current) => [...current, created]);
    setSelectedWorkspaceId(created.id);
    if (connection) writeNativeSelectionCandidate({ organizationId: selectedOrganizationId, workspaceId: created.id }, connection);
  }, [connection, organizationApi, selectedOrganizationId]);

  const createRoom = useCallback(async (name: string): Promise<void> => {
    if (!bridge?.createWorkspaceRoom || !selectedWorkspace) throw new Error("room_create_unavailable");
    const result = await bridge.createWorkspaceRoom({ name, expectedWorkspaceVersion: selectedWorkspace.version ?? 0, operationId: createIdempotencyKey() });
    const created = nativeRoom(result.room);
    setRooms((current) => [...current, created]);
    setSelectedRoomId(created.id);
  }, [bridge, selectedWorkspace]);

  const loadManagement = useCallback(async (): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) {
      setManagementError("Organization管理APIがまだ接続されていません。");
      return;
    }
    setManagementError(null);
    try {
      const [nextMembers, nextInvitations] = await Promise.all([
        organizationApi.listMembers(selectedOrganizationId),
        organizationApi.listInvitations(selectedOrganizationId)
      ]);
      setMembers(nextMembers);
      setInvitations(nextInvitations);
    } catch (error) {
      setManagementError(userFacingError(error, "Organization管理情報を読み込めませんでした。"));
    }
  }, [organizationApi, selectedOrganizationId]);

  useEffect(() => {
    if (managementOpen) void loadManagement();
  }, [loadManagement, managementOpen]);

  const saveOrganization = useCallback(async (input: { name: string; description?: string }): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.patchOrganization(selectedOrganizationId, input);
    setOrganizations((current) => current.map((organization) => organization.id === updated.id ? { ...organization, ...updated } : organization));
  }, [organizationApi, selectedOrganizationId]);

  const inviteMember = useCallback(async (input: { accountId?: string; role: OrganizationRole; workspaceGrants?: Array<{ workspaceId: string; role: OrganizationRole }>; expiresAt?: string }): Promise<{ token?: string }> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const result = await organizationApi.inviteMember(selectedOrganizationId, input);
    setInvitations((current) => [result.invitation, ...current]);
    return { ...(result.token ? { token: result.token } : {}) };
  }, [organizationApi, selectedOrganizationId]);

  const changeMemberRole = useCallback(async (accountId: string, role: OrganizationRole): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const member = await organizationApi.changeMemberRole(selectedOrganizationId, accountId, role);
    setMembers((current) => current.map((item) => item.accountId === accountId ? member : item));
  }, [organizationApi, selectedOrganizationId]);

  const removeMember = useCallback(async (accountId: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.removeMember(selectedOrganizationId, accountId);
    setMembers((current) => current.filter((item) => item.accountId !== accountId));
  }, [organizationApi, selectedOrganizationId]);

  const revokeInvitation = useCallback(async (invitationId: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.revokeInvitation(selectedOrganizationId, invitationId);
    setInvitations((current) => current.map((item) => item.id === invitationId ? { ...item, state: "revoked" } : item));
  }, [organizationApi, selectedOrganizationId]);

  const reissueInvitation = useCallback(async (invitationId: string): Promise<{ token?: string }> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const result = await organizationApi.reissueInvitation(selectedOrganizationId, invitationId);
    setInvitations((current) => current.map((item) => item.id === invitationId ? result.invitation : item));
    return { ...(result.token ? { token: result.token } : {}) };
  }, [organizationApi, selectedOrganizationId]);

  const extendInvitation = useCallback(async (invitationId: string, expiresAt: string): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const invitation = await organizationApi.extendInvitation(selectedOrganizationId, invitationId, expiresAt);
    setInvitations((current) => current.map((item) => item.id === invitationId ? invitation : item));
  }, [organizationApi, selectedOrganizationId]);

  const acceptInvitation = useCallback(async (token: string): Promise<void> => {
    const result = await organizationApi.acceptInvitation(token);
    const joinedOrganization = result.organization;
    if (joinedOrganization) {
      setOrganizations((current) => current.some((item) => item.id === joinedOrganization.id)
        ? current.map((item) => item.id === joinedOrganization.id ? { ...item, ...joinedOrganization } : item)
        : [...current, joinedOrganization]);
      setSelectedOrganizationId(joinedOrganization.id);
    }
    setRefreshNonce((value) => value + 1);
  }, [organizationApi]);

  const archiveWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.archiveWorkspace(selectedOrganizationId, workspace.id);
    setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item));
  }, [organizationApi, selectedOrganizationId]);

  const restoreWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    const updated = await organizationApi.restoreWorkspace(selectedOrganizationId, workspace.id);
    setWorkspaces((current) => current.map((item) => item.id === updated.id ? updated : item));
  }, [organizationApi, selectedOrganizationId]);

  const deleteWorkspace = useCallback(async (workspace: NativeWorkspace): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.deleteWorkspace(selectedOrganizationId, workspace.id);
    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    if (selectedWorkspaceId === workspace.id) {
      setSelectedWorkspaceId(undefined);
      setSelectedRoomId(undefined);
      setRooms([]);
    }
  }, [organizationApi, selectedOrganizationId, selectedWorkspaceId]);

  const deleteOrganization = useCallback(async (): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) return;
    await organizationApi.deleteOrganization(selectedOrganizationId);
    setOrganizations((current) => current.filter((organization) => organization.id !== selectedOrganizationId));
    setSelectedOrganizationId(undefined);
    setSelectedWorkspaceId(undefined);
    setSelectedRoomId(undefined);
    setWorkspaces([]);
    setRooms([]);
    clearNativeSelectionCandidate();
    setManagementOpen(false);
  }, [organizationApi, selectedOrganizationId]);

  const previewWorkspaceMove = useCallback(async (workspace: NativeWorkspace, targetOrganizationId: string): Promise<NativeWorkspaceMovePreview> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    if (!targetOrganizationId || targetOrganizationId === selectedOrganizationId) throw new Error("workspace_move_target_invalid");
    return organizationApi.previewWorkspaceMove(selectedOrganizationId, workspace.id, {
      targetOrganizationId,
      ...(workspace.version === undefined ? {} : { expectedWorkspaceVersion: workspace.version })
    });
  }, [organizationApi, selectedOrganizationId]);

  const moveWorkspace = useCallback(async (workspace: NativeWorkspace, targetOrganizationId: string, preview: NativeWorkspaceMovePreview): Promise<void> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    if (preview.targetOrganizationId !== targetOrganizationId || preview.workspaceId !== workspace.id) throw new Error("workspace_move_preview_mismatch");
    const result = await organizationApi.moveWorkspace(selectedOrganizationId, workspace.id, {
      targetOrganizationId,
      preflightId: preview.operationId,
      confirmGuestMembership: true,
      ...(workspace.version === undefined ? {} : { expectedWorkspaceVersion: workspace.version })
    });
    if (result.status === "failed" || result.status === "rolled_back") throw new Error(result.failureCode ?? "workspace_move_failed");
    setWorkspaces((current) => current.filter((item) => item.id !== workspace.id));
    setOrganizations((current) => current.map((organization) => organization.id === selectedOrganizationId
      ? { ...organization, ...(organization.workspaceCount === undefined ? {} : { workspaceCount: Math.max(0, organization.workspaceCount - 1) }) }
      : organization));
    if (selectedWorkspaceId === workspace.id) {
      setSelectedWorkspaceId(undefined);
      setSelectedRoomId(undefined);
      setRooms([]);
      setActiveWorkspaceRoomId(undefined);
      clearNativeSelectionCandidate();
    }
    setWorkspaceRefreshNonce((value) => value + 1);
  }, [organizationApi, selectedOrganizationId, selectedWorkspaceId]);

  const exportWorkspaceBundle = useCallback(async (workspace: NativeWorkspace): Promise<NativeWorkspaceBundleExport> => {
    if (!selectedOrganizationId || selectedOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    if (workspace.organizationId && workspace.organizationId !== selectedOrganizationId) throw new Error("workspace_organization_mismatch");
    return organizationApi.exportWorkspaceBundle(selectedOrganizationId, workspace.id, workspace.version);
  }, [organizationApi, selectedOrganizationId]);

  const restoreOrganizationBundle = useCallback(async (targetOrganizationId: string, bundleId: string): Promise<NativeWorkspaceBundleRestoreResult> => {
    if (!targetOrganizationId || !bundleId.trim()) throw new Error("workspace_bundle_input_invalid");
    if (targetOrganizationId === legacyOrganizationId) throw new Error("organization_api_required");
    const result = await organizationApi.restoreOrganizationBundle(targetOrganizationId, bundleId.trim());
    if (result.status === "restored") {
      setRefreshNonce((value) => value + 1);
      setWorkspaceRefreshNonce((value) => value + 1);
    }
    return result;
  }, [organizationApi]);

  const openEvidence = useCallback((message: NativeChatMessage): void => {
    setEvidenceMessage(message);
    setEvidenceOpen(true);
  }, []);

  return {
    browserMode,
    bridge,
    connection,
    connectionState,
    connectionLoading,
    connectionError,
    transportState,
    organizations,
    organizationLoading,
    organizationError: organizationError ?? (organizationApiAvailable ? null : "Organization APIを利用できません。既存Workspace表示へ切り替えています。"),
    organizationApiAvailable,
    selectedOrganization,
    selectedOrganizationId,
    workspaces,
    workspaceLoading,
    workspaceError,
    selectedWorkspace,
    selectedWorkspaceId,
    rooms,
    roomLoading,
    roomError,
    selectedRoom,
    selectedRoomId,
    chatLoading,
    messages,
    chatError,
    sending,
    evidence,
    evidenceMessage,
    evidenceOpen,
    setEvidenceOpen,
    managementOpen,
    setManagementOpen,
    members,
    invitations,
    managementError,
    refreshConnections,
    selectOrganization,
    selectWorkspace,
    openRoom,
    sendMessage,
    stopMessage,
    retryMessage,
    reconnect,
    createOrganization,
    createWorkspace,
    createRoom,
    saveOrganization,
    inviteMember,
    changeMemberRole,
    removeMember,
    revokeInvitation,
    reissueInvitation,
    extendInvitation,
    acceptInvitation,
    archiveWorkspace,
    restoreWorkspace,
    deleteWorkspace,
    deleteOrganization,
    previewWorkspaceMove,
    moveWorkspace,
    exportWorkspaceBundle,
    restoreOrganizationBundle,
    openEvidence
  };
}

export type NativeAppModel = ReturnType<typeof useNativeApp>;
