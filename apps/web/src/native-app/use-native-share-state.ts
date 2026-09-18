import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PublicShareDraft,
  PublicShareDraftCreateInput,
  PublicShareDraftUpdateInput,
  PublicShareImportResult,
  PublicSharePublishResult,
  PublicShareRevokeResult
} from "@samurai-agent/domain-api";
import {
  type DesktopWorkspaceRoom,
  type WorkspaceShareLinkView,
  type WorkspaceShareSummary
} from "../lib/api";
import type {
  WorkspaceShareImportRoom,
  WorkspaceShareImportSource,
  WorkspaceShareImportWorkspace
} from "./WorkspaceShareImport";
import type {
  WorkspaceShareDialogStage,
  WorkspaceSharePublishedSummary,
  WorkspaceShareResourceOption,
  WorkspaceShareSource,
  WorkspaceSharePublishedView
} from "./WorkspaceShareDialog";
import type { NativeDraftNavigationTarget } from "./use-native-draft-navigation";
import type { NativeAgent, NativeOrganizationMember, NativeRoom, NativeWorkspace, NativeWorkspaceTarget } from "./types";
import type { NativeAgentResource } from "./NativeAgentResources";
import {
  nativeAgentShareSelectionForTarget,
  nativeRoomShareSelectionForTarget,
  publicShareDraftCreateToWorkspace,
  publicShareDraftUpdateToWorkspace,
  workspaceShareDraftToDomain,
  workspaceShareImportToDomain,
  workspaceShareLinkViewToDomain,
  workspaceSharePublishToDomain,
  workspaceShareRevokeToDomain,
  workspaceShareSummaryToDialog,
  type NativeAgentShareSelection
} from "./native-share-state";
import type { NativeRoomKnowledgeShareSelection } from "./use-native-knowledge-tools";
import { parseNativeShareLink, type NativeShareLink } from "./native-share-link";
import { nativeWorkspaceTargetIdentityKey } from "./types";

type NativeShareBridge = NonNullable<Window["samuraiDesktop"]>;

export interface UseNativeShareStateInput {
  bridge?: NativeShareBridge;
  target?: NativeWorkspaceTarget;
  selectedRoom?: NativeRoom;
  selectedWorkspace?: NativeWorkspace;
  workspaces: readonly NativeWorkspace[];
  rooms: readonly NativeRoom[];
  agents: readonly NativeAgent[];
  agentResources: readonly NativeAgentResource[];
  selectedAgentId?: string;
  members: readonly NativeOrganizationMember[];
  accountId?: string;
  authenticated: boolean;
  requestNavigation: (target: NativeDraftNavigationTarget) => boolean;
  refreshConnections?: () => Promise<unknown> | unknown;
}

export interface NativeShareDialogState {
  source: WorkspaceShareSource;
  resources: readonly WorkspaceShareResourceOption[];
  recipientOptions: readonly { accountId: string; label: string }[];
  draft: PublicShareDraft | null;
  publishedShares: readonly WorkspaceSharePublishedSummary[];
  initialStage?: WorkspaceShareDialogStage;
  loading: boolean;
  error: string | null;
}

export interface NativeShareImportState {
  route: NativeShareLink;
  view: WorkspaceSharePublishedView | null;
  /** The view request is safe and read-only; start/import is always explicit. */
  loading: boolean;
  error: string | null;
  status: PublicShareImportResult | null;
  source?: WorkspaceShareImportSource;
  target: NativeWorkspaceTarget;
  scopeKey: string;
  destination?: NativeShareImportDestination;
}

export interface NativeShareImportDestination {
  workspaceId: string;
  target: NativeWorkspaceTarget;
  /** Stable opaque key used by the destination selector and async guards. */
  targetKey: string;
  roomId?: string;
}

export interface NativeShareStateResult {
  dialog?: NativeShareDialogState;
  import?: NativeShareImportState;
  importRouteError: string | null;
  openRoomShare: (selection: NativeRoomKnowledgeShareSelection) => void;
  openAgentShare: (selection: NativeAgentShareSelection) => void;
  closeDialog: () => void;
  closeImport: () => void;
  onCreateDraft: (input: PublicShareDraftCreateInput & { operationId: string }) => Promise<PublicShareDraft>;
  onUpdateDraft: (input: PublicShareDraftUpdateInput & { operationId: string }) => Promise<PublicShareDraft>;
  onDiscardDraft: (input: { draft_id: string; expected_version: number; operationId: string }) => Promise<{ draft_id: string; discarded: true }>;
  onPublishDraft: (input: { draft_id: string; expected_version: number; expected_content_hash: string; operationId: string }) => Promise<PublicSharePublishResult>;
  onRevokeShare: (input: { share_id: string; expected_version: number; operationId: string }) => Promise<PublicShareRevokeResult>;
  onPublished: (result: PublicSharePublishResult) => Promise<void>;
  onAuthenticateImport?: () => Promise<void>;
  onStartImport: (input: { source: WorkspaceShareImportSource; workspaceId: string; workspaceTargetKey?: string; roomId?: string; operationId: string }) => Promise<PublicShareImportResult>;
  onGetImportStatus: (input: { workspaceId: string; workspaceTargetKey?: string; roomId?: string; operationId: string }) => Promise<PublicShareImportResult>;
  importAuthenticated: boolean;
  importAuthenticating: boolean;
  importWorkspaces: readonly WorkspaceShareImportWorkspace[];
  importRooms: readonly WorkspaceShareImportRoom[];
}

export function nativeShareScopeKey(target: NativeWorkspaceTarget | undefined, roomId: string | undefined, agentId: string | undefined): string | undefined {
  if (!target) return undefined;
  return JSON.stringify([nativeWorkspaceTargetIdentityKey({ ...target, ...(roomId ? { roomId } : {}) }), agentId ?? null]);
}

function shareTargetSnapshot(target: NativeWorkspaceTarget | undefined, roomId: string | undefined): NativeWorkspaceTarget | undefined {
  if (!target) return undefined;
  return { ...target, ...(roomId ? { roomId } : {}) };
}

function shareErrorMessage(error: unknown, fallback: string): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : error instanceof Error ? error.message : "";
  if (code.includes("permission") || code.includes("forbidden") || code.includes("unauthorized")) return "共有の権限を確認してください。";
  if (code.includes("navigation") || code.includes("target") || code.includes("scope")) return "対象が変わったため、共有画面を閉じました。現在の対象から再度開いてください。";
  if (code.includes("version") || code.includes("conflict")) return "共有内容の版が更新されています。下書きを読み直してください。";
  if (code.includes("unavailable")) return "この共有機能は現在利用できません。接続先の対応状況を確認してください。";
  return fallback;
}

function sameTarget(current: NativeWorkspaceTarget | undefined, expected: NativeWorkspaceTarget): boolean {
  return current?.connectionId === expected.connectionId
    && current.workspaceId === expected.workspaceId
    && (expected.roomId === undefined || current.roomId === undefined || current.roomId === expected.roomId)
    && (expected.selectionGeneration === undefined
      || current.selectionGeneration === undefined
      || current.selectionGeneration === expected.selectionGeneration);
}

function workspaceImportTarget(workspace: NativeWorkspace, currentTarget: NativeWorkspaceTarget): NativeWorkspaceTarget | undefined {
  const candidate = workspace.target
    ?? (workspace.connectionId ? { connectionId: workspace.connectionId, workspaceId: workspace.id } : undefined);
  if (!candidate || candidate.connectionId !== currentTarget.connectionId || candidate.workspaceId !== workspace.id) return undefined;
  return {
    connectionId: candidate.connectionId,
    workspaceId: candidate.workspaceId,
    ...(candidate.selectionGeneration === undefined ? {} : { selectionGeneration: candidate.selectionGeneration })
  };
}

function sameImportDestination(left: NativeShareImportDestination, right: NativeShareImportDestination): boolean {
  return left.workspaceId === right.workspaceId
    && left.targetKey === right.targetKey
    && left.target.connectionId === right.target.connectionId
    && left.target.workspaceId === right.target.workspaceId
    && left.target.selectionGeneration === right.target.selectionGeneration;
}

/**
 * Build destination candidates only from the already-authorized Workspace
 * directory.  The current connection is the routing boundary; a Workspace
 * ID from another connection is never enough to make a candidate.
 */
export function nativeShareImportDestinations(
  workspaces: readonly NativeWorkspace[],
  currentTarget: NativeWorkspaceTarget | undefined,
  accountId?: string
): NativeShareImportDestination[] {
  if (!currentTarget) return [];
  const seen = new Set<string>();
  return workspaces.flatMap((workspace) => {
    if (workspace.access !== "granted" || workspace.state !== "active") return [];
    if (workspace.accountId && accountId && workspace.accountId !== accountId) return [];
    const target = workspaceImportTarget(workspace, currentTarget);
    if (!target) return [];
    const targetKey = nativeWorkspaceTargetIdentityKey({ connectionId: target.connectionId, workspaceId: target.workspaceId });
    if (seen.has(targetKey)) return [];
    seen.add(targetKey);
    return [{ workspaceId: workspace.id, target, targetKey }];
  });
}

export function nativeShareImportRooms(
  destination: NativeShareImportDestination,
  rooms: readonly DesktopWorkspaceRoom[]
): WorkspaceShareImportRoom[] {
  const seen = new Set<string>();
  return rooms.flatMap((room) => {
    if (!room.id || !room.name || room.workspaceId !== destination.workspaceId || room.kind === "agent_dm" || room.canEdit === false) return [];
    const key = `${destination.targetKey}:${room.id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      id: room.id,
      workspaceId: destination.workspaceId,
      name: room.name,
      canImport: true,
      workspaceTargetKey: destination.targetKey
    }];
  });
}

function shareSummaryRows(items: readonly WorkspaceShareSummary[]): WorkspaceSharePublishedSummary[] {
  return items.flatMap((item) => {
    const summary = workspaceShareSummaryToDialog(item);
    return summary ? [summary] : [];
  });
}

/**
 * Share state intentionally lives outside useNativeApp.  It is an overlay
 * state machine: target changes invalidate its captured target, while the
 * existing Room conversation/drafts remain owned by useNativeApp.
 */
export function useNativeShareState(input: UseNativeShareStateInput): NativeShareStateResult {
  const {
    bridge,
    target,
    selectedRoom,
    workspaces,
    agents,
    agentResources,
    selectedAgentId,
    members,
    accountId,
    authenticated,
    requestNavigation,
    refreshConnections
  } = input;
  const roomId = selectedRoom?.id;
  const scopeKey = nativeShareScopeKey(target, roomId, selectedAgentId);
  const targetSnapshot = useMemo(
    () => shareTargetSnapshot(target, roomId),
    [roomId, target?.connectionId, target?.selectionGeneration, target?.workspaceId]
  );
  const recipientOptions = useMemo(() => {
    const seen = new Set<string>();
    return members.flatMap((member) => {
      if (member.state !== "active" || !member.accountId || member.accountId === accountId || seen.has(member.accountId)) return [];
      seen.add(member.accountId);
      return [{ accountId: member.accountId, label: member.displayName?.trim() || "Workspaceメンバー" }];
    });
  }, [accountId, members]);

  const [dialog, setDialog] = useState<NativeShareDialogState & { target: NativeWorkspaceTarget; targetKey: string; nonce: number }>();
  const [shareRoute, setShareRoute] = useState<NativeShareLink | null>(null);
  const [importRouteError, setImportRouteError] = useState<string | null>(null);
  const [shareImport, setShareImport] = useState<NativeShareImportState>();
  const [importAuthenticating, setImportAuthenticating] = useState(false);
  const [importRooms, setImportRooms] = useState<WorkspaceShareImportRoom[]>([]);
  const dialogRef = useRef(dialog);
  const importRef = useRef(shareImport);
  const destinationRef = useRef<readonly NativeShareImportDestination[]>([]);
  const dialogNonceRef = useRef(0);
  dialogRef.current = dialog;
  importRef.current = shareImport;

  const readShareRoute = useCallback((): void => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash;
    if (!hash.startsWith("#/share")) {
      setShareRoute(null);
      setImportRouteError(null);
      return;
    }
    try {
      setShareRoute(parseNativeShareLink(hash));
      setImportRouteError(null);
    } catch (error) {
      setShareRoute(null);
      setImportRouteError(shareErrorMessage(error, "共有リンクの形式を確認してください。"));
    }
  }, []);

  useEffect(() => {
    readShareRoute();
    if (typeof window === "undefined") return undefined;
    window.addEventListener("hashchange", readShareRoute);
    return () => window.removeEventListener("hashchange", readShareRoute);
  }, [readShareRoute]);

  useEffect(() => {
    dialogNonceRef.current += 1;
    setDialog(undefined);
    setShareImport(undefined);
  }, [scopeKey]);

  const closeDialog = useCallback((): void => {
    dialogNonceRef.current += 1;
    setDialog(undefined);
  }, []);

  const closeImport = useCallback((): void => {
    setShareImport(undefined);
    setShareRoute(null);
    setImportRouteError(null);
  }, []);

  const openDialog = useCallback((candidate: { source: WorkspaceShareSource; resources: WorkspaceShareResourceOption[] }): void => {
    if (!targetSnapshot || !scopeKey) return;
    const nonce = dialogNonceRef.current + 1;
    dialogNonceRef.current = nonce;
    requestNavigation(() => {
      setDialog({
        source: candidate.source,
        resources: candidate.resources,
        recipientOptions,
        draft: null,
        publishedShares: [],
        initialStage: undefined,
        loading: true,
        error: null,
        target: { ...targetSnapshot },
        targetKey: scopeKey,
        nonce
      });
    });
  }, [recipientOptions, requestNavigation, scopeKey, targetSnapshot]);

  const openRoomShare = useCallback((selection: NativeRoomKnowledgeShareSelection): void => {
    const candidate = nativeRoomShareSelectionForTarget(selection, target, roomId);
    if (candidate) openDialog(candidate);
  }, [openDialog, roomId, target]);

  const agentLabel = useCallback((agentId: string): string | undefined => agents.find((agent) => agent.id === agentId)?.displayName, [agents]);
  const openAgentShare = useCallback((selection: NativeAgentShareSelection): void => {
    const candidate = nativeAgentShareSelectionForTarget(selection, target, agentResources, agentLabel(selection.agentId));
    if (candidate) openDialog(candidate);
  }, [agentLabel, agentResources, openDialog, target]);

  useEffect(() => {
    const current = dialog;
    if (!current || !bridge || !current.targetKey) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        if (!bridge.listWorkspaceShares) throw new Error("workspace_share_list_unavailable");
        const page = await bridge.listWorkspaceShares({ sourceKind: current.source.kind, sourceId: current.source.id, target: current.target });
        if (cancelled || dialogRef.current?.nonce !== current.nonce || dialogRef.current?.targetKey !== current.targetKey) return;
        const summaries = shareSummaryRows(page.items);
        let draft: PublicShareDraft | null = null;
        const draftSummary = page.items.find((item) => item.status === "draft");
        if (draftSummary) {
          if (!bridge.viewWorkspaceShareDraft) throw new Error("workspace_share_draft_view_unavailable");
          const saved = await bridge.viewWorkspaceShareDraft({ draftId: draftSummary.shareId, target: current.target });
          if (cancelled || dialogRef.current?.nonce !== current.nonce || dialogRef.current?.targetKey !== current.targetKey) return;
          // The renderer must not invent recipient IDs from recipientCount. The
          // user reselects recipients before a restricted draft can publish.
          draft = workspaceShareDraftToDomain(saved, []);
        }
        setDialog((state) => state && state.nonce === current.nonce ? { ...state, publishedShares: summaries, draft, loading: false, error: null, initialStage: draft ? "edit" : undefined } : state);
      } catch (error) {
        if (cancelled || dialogRef.current?.nonce !== current.nonce) return;
        setDialog((state) => state && state.nonce === current.nonce ? { ...state, loading: false, error: shareErrorMessage(error, "共有情報を読み込めませんでした。") } : state);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [bridge, dialog?.nonce, dialog?.source.id, dialog?.source.kind, dialog?.target, dialog?.targetKey]);

  const assertDialogCurrent = useCallback((nonce: number, targetKey: string): NonNullable<typeof dialog> => {
    const current = dialogRef.current;
    if (!current || current.nonce !== nonce || current.targetKey !== targetKey) throw new Error("workspace_navigation_changed");
    return current;
  }, []);

  const onCreateDraft = useCallback(async (inputValue: PublicShareDraftCreateInput & { operationId: string }): Promise<PublicShareDraft> => {
    const current = dialogRef.current;
    if (!current || !bridge?.createWorkspaceShareDraft) throw new Error("workspace_share_draft_create_unavailable");
    if (current.targetKey !== scopeKey) throw new Error("workspace_navigation_changed");
    assertDialogCurrent(current.nonce, current.targetKey);
    if (!("source_kind" in inputValue) || inputValue.source_kind !== current.source.kind || inputValue.source_id !== current.source.id) throw new Error("workspace_share_source_mismatch");
    const allowed = new Map(current.resources.map((resource) => [resource.id, resource]));
    if (!inputValue.resource_refs.length || inputValue.resource_refs.some((ref) => {
      const resource = allowed.get(ref.id);
      return !resource || resource.version !== ref.version || (current.source.kind === "room_knowledge" && resource.kind !== "knowledge");
    })) throw new Error("workspace_share_resource_selection_invalid");
    const request = publicShareDraftCreateToWorkspace(inputValue);
    const result = await bridge.createWorkspaceShareDraft({ ...request, operationId: inputValue.operationId, target: current.target });
    assertDialogCurrent(current.nonce, current.targetKey);
    return workspaceShareDraftToDomain(result, []);
  }, [assertDialogCurrent, bridge, scopeKey]);

  const onUpdateDraft = useCallback(async (inputValue: PublicShareDraftUpdateInput & { operationId: string }): Promise<PublicShareDraft> => {
    const current = dialogRef.current;
    if (!current || !bridge?.updateWorkspaceShareDraft) throw new Error("workspace_share_draft_update_unavailable");
    if (current.targetKey !== scopeKey) throw new Error("workspace_navigation_changed");
    assertDialogCurrent(current.nonce, current.targetKey);
    const request = publicShareDraftUpdateToWorkspace(inputValue);
    const result = await bridge.updateWorkspaceShareDraft({ ...request, operationId: inputValue.operationId, target: current.target });
    assertDialogCurrent(current.nonce, current.targetKey);
    return workspaceShareDraftToDomain(result, inputValue.recipient_account_ids);
  }, [assertDialogCurrent, bridge, scopeKey]);

  const onDiscardDraft = useCallback(async (inputValue: { draft_id: string; expected_version: number; operationId: string }): Promise<{ draft_id: string; discarded: true }> => {
    const current = dialogRef.current;
    if (!current || !bridge?.discardWorkspaceShareDraft) throw new Error("workspace_share_draft_discard_unavailable");
    if (current.targetKey !== scopeKey) throw new Error("workspace_navigation_changed");
    assertDialogCurrent(current.nonce, current.targetKey);
    const result = await bridge.discardWorkspaceShareDraft({ draftId: inputValue.draft_id, expectedVersion: inputValue.expected_version, operationId: inputValue.operationId, target: current.target });
    assertDialogCurrent(current.nonce, current.targetKey);
    setDialog((state) => state && state.nonce === current.nonce ? { ...state, draft: null } : state);
    return { draft_id: result.draftId, discarded: true };
  }, [assertDialogCurrent, bridge, scopeKey]);

  const onPublishDraft = useCallback(async (inputValue: { draft_id: string; expected_version: number; expected_content_hash: string; operationId: string }): Promise<PublicSharePublishResult> => {
    const current = dialogRef.current;
    if (!current || !bridge?.publishWorkspaceShare) throw new Error("workspace_share_publish_unavailable");
    if (current.targetKey !== scopeKey) throw new Error("workspace_navigation_changed");
    assertDialogCurrent(current.nonce, current.targetKey);
    const result = await bridge.publishWorkspaceShare({ draftId: inputValue.draft_id, expectedVersion: inputValue.expected_version, expectedContentHash: inputValue.expected_content_hash, operationId: inputValue.operationId, target: current.target });
    assertDialogCurrent(current.nonce, current.targetKey);
    return workspaceSharePublishToDomain(result);
  }, [assertDialogCurrent, bridge, scopeKey]);

  const onRevokeShare = useCallback(async (inputValue: { share_id: string; expected_version: number; operationId: string }): Promise<PublicShareRevokeResult> => {
    const current = dialogRef.current;
    if (!current || !bridge?.revokeWorkspaceShare) throw new Error("workspace_share_revoke_unavailable");
    if (current.targetKey !== scopeKey) throw new Error("workspace_navigation_changed");
    assertDialogCurrent(current.nonce, current.targetKey);
    const result = await bridge.revokeWorkspaceShare({ shareId: inputValue.share_id, expectedVersion: inputValue.expected_version, operationId: inputValue.operationId, target: current.target });
    assertDialogCurrent(current.nonce, current.targetKey);
    return workspaceShareRevokeToDomain(result);
  }, [assertDialogCurrent, bridge, scopeKey]);

  const onPublished = useCallback(async (): Promise<void> => {
    const current = dialogRef.current;
    if (!current || !bridge?.listWorkspaceShares) return;
    if (current.targetKey !== scopeKey) return;
    try {
      const page = await bridge.listWorkspaceShares({ sourceKind: current.source.kind, sourceId: current.source.id, target: current.target });
      if (dialogRef.current?.nonce !== current.nonce) return;
      setDialog((state) => state && state.nonce === current.nonce ? { ...state, publishedShares: shareSummaryRows(page.items) } : state);
    } catch {
      // The published response is already authoritative. Keep the dialog open
      // and leave a later explicit refresh/reopen to recover list state.
    }
  }, [bridge, scopeKey]);

  useEffect(() => {
    const route = shareRoute;
    if (!route || !targetSnapshot) return;
    const targetKey = scopeKey;
    if (!targetKey) return;
    const currentTarget = { ...targetSnapshot };
    const state: NativeShareImportState = { route, view: null, loading: true, error: null, status: null, target: currentTarget, scopeKey: targetKey };
    setShareImport(state);
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        if (!bridge?.viewWorkspaceShareLink) throw new Error("workspace_share_link_view_unavailable");
        const view: WorkspaceShareLinkView = await bridge.viewWorkspaceShareLink({ sourceUrl: route.sourceUrl, target: currentTarget });
        if (cancelled || nativeShareScopeKey(currentTarget, currentTarget.roomId, selectedAgentId) !== targetKey) return;
        const domainView = workspaceShareLinkViewToDomain(view);
        const source: WorkspaceShareImportSource = {
          sourceOrigin: route.sourceOrigin,
          locator: route.locator,
          // WorkspaceShareImport only uses this object as an explicit-start
          // capability marker. The finite link import bridge below ignores the
          // marker and performs view -> claim -> delegation -> import itself.
          claimId: "deferred-link-import",
          contentHash: domainView.contentHash,
          delegation: undefined
        };
        setShareImport((current) => current && current.route.sourceUrl === route.sourceUrl ? { ...current, view: domainView, source, loading: false, error: null } : current);
      } catch (error) {
        if (cancelled) return;
        setShareImport((current) => current && current.route.sourceUrl === route.sourceUrl ? { ...current, loading: false, error: shareErrorMessage(error, "共有内容を表示できませんでした。") } : current);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [bridge, scopeKey, selectedAgentId, shareRoute, targetSnapshot]);

  const onAuthenticateImport = useCallback(async (): Promise<void> => {
    if (!refreshConnections) return;
    setImportAuthenticating(true);
    try {
      await refreshConnections();
    } finally {
      setImportAuthenticating(false);
    }
  }, [refreshConnections]);

  const importDestinations = useMemo(
    () => nativeShareImportDestinations(workspaces, target, accountId),
    [accountId, target?.connectionId, target?.workspaceId, workspaces]
  );
  destinationRef.current = importDestinations;

  const importWorkspaces = useMemo<WorkspaceShareImportWorkspace[]>(() => importDestinations.map((destination) => {
    const workspace = workspaces.find((candidate) => {
      const candidateTarget = candidate.target
        ?? (candidate.connectionId ? { connectionId: candidate.connectionId, workspaceId: candidate.id } : undefined);
      return candidate.id === destination.workspaceId
        && candidateTarget?.connectionId === destination.target.connectionId
        && candidateTarget.workspaceId === destination.workspaceId;
    });
    return {
      id: destination.workspaceId,
      name: workspace?.name ?? "Workspace",
      canImport: true,
      targetKey: destination.targetKey
    };
  }), [importDestinations, workspaces]);

  const resolveImportDestination = useCallback((workspaceId: string, targetKey?: string): NativeShareImportDestination => {
    const candidates = destinationRef.current;
    const matches = targetKey
      ? candidates.filter((candidate) => candidate.targetKey === targetKey && candidate.workspaceId === workspaceId)
      : candidates.filter((candidate) => candidate.workspaceId === workspaceId);
    if (matches.length !== 1) throw new Error("workspace_navigation_changed");
    const candidate = matches[0];
    if (!candidate) throw new Error("workspace_navigation_changed");
    return candidate;
  }, []);

  useEffect(() => {
    const current = shareImport;
    if (!current?.view || current.view.kind !== "room_knowledge" || !importDestinations.length || !bridge?.listWorkspaceRooms) {
      setImportRooms([]);
      return;
    }
    let cancelled = false;
    const load = async (): Promise<void> => {
      const rows = await Promise.all(importDestinations.map(async (destination) => {
        try {
          const listed = await bridge.listWorkspaceRooms?.({ target: destination.target });
          if (cancelled || !listed) return [];
          return nativeShareImportRooms(destination, listed.rooms);
        } catch {
          // A fixed bridge can reject a target whose authorization changed or
          // whose Server cannot route it. Omit only that candidate's Rooms;
          // the read-only source view remains available.
          return [];
        }
      }));
      if (cancelled) return;
      const currentTargets = new Set(destinationRef.current.map((destination) => destination.targetKey));
      setImportRooms(rows.flat().filter((room) => !room.workspaceTargetKey || currentTargets.has(room.workspaceTargetKey)));
    };
    void load();
    return () => { cancelled = true; };
  }, [bridge, importDestinations, shareImport?.route.sourceUrl, shareImport?.view?.kind]);

  const onStartImport = useCallback(async (value: { source: WorkspaceShareImportSource; workspaceId: string; workspaceTargetKey?: string; roomId?: string; operationId: string }): Promise<PublicShareImportResult> => {
    const current = importRef.current;
    if (!current || !current.view || !current.source || !bridge?.importWorkspaceShareLink) throw new Error("workspace_share_link_import_unavailable");
    if (current.scopeKey !== scopeKey) throw new Error("workspace_navigation_changed");
    if (!sameTarget(targetSnapshot, current.target)) throw new Error("workspace_navigation_changed");
    if (value.source.sourceOrigin !== current.source.sourceOrigin
      || value.source.locator !== current.source.locator
      || value.source.contentHash !== current.source.contentHash) {
      throw new Error("workspace_share_source_mismatch");
    }
    const destination = resolveImportDestination(value.workspaceId, value.workspaceTargetKey);
    if (!sameImportDestination(resolveImportDestination(value.workspaceId, value.workspaceTargetKey), destination)) {
      throw new Error("workspace_navigation_changed");
    }
    let destinationSnapshot: NativeShareImportDestination = destination;
    if (current.view.kind === "room_knowledge") {
      if (!value.roomId || !bridge.listWorkspaceRooms) throw new Error("room_permission_changed");
      const listed = await bridge.listWorkspaceRooms({ target: destination.target });
      if (importRef.current?.route.sourceUrl !== current.route.sourceUrl
        || importRef.current?.scopeKey !== scopeKey
        || !sameTarget(targetSnapshot, current.target)) throw new Error("workspace_navigation_changed");
      if (!sameImportDestination(resolveImportDestination(value.workspaceId, value.workspaceTargetKey), destination)) {
        throw new Error("workspace_navigation_changed");
      }
      const room = listed.rooms.find((candidate) => candidate.id === value.roomId
        && candidate.workspaceId === destination.workspaceId
        && candidate.kind !== "agent_dm"
        && candidate.canEdit !== false);
      if (!room) throw new Error("room_permission_changed");
      destinationSnapshot = { ...destination, target: { ...destination.target }, roomId: room.id };
    } else {
      destinationSnapshot = { ...destination, target: { ...destination.target } };
    }
    setShareImport((state) => state && state.route.sourceUrl === current.route.sourceUrl
      ? { ...state, destination: destinationSnapshot }
      : state);
    const result = await bridge.importWorkspaceShareLink({
      sourceUrl: current.route.sourceUrl,
      ...(destinationSnapshot.roomId ? { targetRoomId: destinationSnapshot.roomId } : {}),
      operationId: value.operationId,
      target: destinationSnapshot.target
    });
    if (importRef.current?.route.sourceUrl !== current.route.sourceUrl || importRef.current?.scopeKey !== scopeKey) throw new Error("workspace_navigation_changed");
    const latestDestination = resolveImportDestination(value.workspaceId, value.workspaceTargetKey);
    if (!sameImportDestination(latestDestination, destination)) throw new Error("workspace_navigation_changed");
    const next = workspaceShareImportToDomain(result);
    setShareImport((state) => state && state.route.sourceUrl === current.route.sourceUrl
      ? { ...state, status: next, destination: destinationSnapshot }
      : state);
    return next;
  }, [bridge, resolveImportDestination, scopeKey, targetSnapshot]);

  const onGetImportStatus = useCallback(async (value: { workspaceId: string; workspaceTargetKey?: string; roomId?: string; operationId: string }): Promise<PublicShareImportResult> => {
    const current = importRef.current;
    if (!current || !current.view || !bridge?.getWorkspaceShareImportStatus) throw new Error("workspace_share_import_status_unavailable");
    if (current.scopeKey !== scopeKey) throw new Error("workspace_navigation_changed");
    if (!sameTarget(targetSnapshot, current.target)) throw new Error("workspace_navigation_changed");
    const requestedDestination = resolveImportDestination(value.workspaceId, value.workspaceTargetKey);
    if (current.destination && !sameImportDestination(current.destination, requestedDestination)) throw new Error("workspace_navigation_changed");
    if (current.view.kind === "room_knowledge"
      && current.destination?.roomId !== undefined
      && value.roomId !== undefined
      && current.destination.roomId !== value.roomId) {
      throw new Error("room_navigation_changed");
    }
    const destination = current.destination ?? requestedDestination;
    if (current.view.kind === "room_knowledge") {
      const roomId = current.destination?.roomId ?? value.roomId;
      if (!roomId || !bridge.listWorkspaceRooms) throw new Error("room_permission_changed");
      const listed = await bridge.listWorkspaceRooms({ target: destination.target });
      if (importRef.current?.route.sourceUrl !== current.route.sourceUrl
        || importRef.current?.scopeKey !== scopeKey
        || !sameTarget(targetSnapshot, current.target)) throw new Error("workspace_navigation_changed");
      if (!sameImportDestination(resolveImportDestination(destination.workspaceId, destination.targetKey), destination)) {
        throw new Error("workspace_navigation_changed");
      }
      const room = listed.rooms.find((candidate) => candidate.id === roomId
        && candidate.workspaceId === destination.workspaceId
        && candidate.kind !== "agent_dm"
        && candidate.canEdit !== false);
      if (!room) throw new Error("room_permission_changed");
    }
    const result = await bridge.getWorkspaceShareImportStatus({ operationId: value.operationId, target: destination.target });
    if (importRef.current?.route.sourceUrl !== current.route.sourceUrl || importRef.current?.scopeKey !== scopeKey) throw new Error("workspace_navigation_changed");
    const latestDestination = resolveImportDestination(destination.workspaceId, destination.targetKey);
    if (!sameImportDestination(latestDestination, destination)) throw new Error("workspace_navigation_changed");
    const next = workspaceShareImportToDomain(result);
    setShareImport((state) => state && state.route.sourceUrl === current.route.sourceUrl
      ? { ...state, status: next, destination }
      : state);
    return next;
  }, [bridge, resolveImportDestination, scopeKey, targetSnapshot]);

  const importState = shareImport ?? (importRouteError && shareRoute ? {
    route: shareRoute,
    view: null,
    loading: false,
    error: importRouteError,
    status: null,
    target: targetSnapshot ?? { connectionId: "", workspaceId: "" },
    scopeKey: scopeKey ?? ""
  } satisfies NativeShareImportState : undefined);

  return {
    dialog,
    import: importState,
    importRouteError,
    openRoomShare,
    openAgentShare,
    closeDialog,
    closeImport,
    onCreateDraft,
    onUpdateDraft,
    onDiscardDraft,
    onPublishDraft,
    onRevokeShare,
    onPublished,
    onAuthenticateImport: refreshConnections ? onAuthenticateImport : undefined,
    onStartImport,
    onGetImportStatus,
    importAuthenticated: authenticated,
    importAuthenticating,
    importWorkspaces,
    importRooms
  };
}
