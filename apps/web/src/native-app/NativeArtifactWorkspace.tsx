import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactRevisionRecord, GeneratedSurfaceDefinition, JsonValue } from "@samurai-agent/core-schemas";
import {
  createIdempotencyKey,
  getWorkspaceClientBridge,
  type ArtifactDetail,
  type ArtifactMutationResult,
  type ArtifactRevisionDetail,
  type GeneratedSurfaceBundleDetail,
  type GeneratedSurfaceDetail,
  type GeneratedSurfaceExportPayload,
  type DesktopWorkspaceInteractionResult
} from "../lib/api";
import {
  ArtifactSurfacePanel,
  ArtifactDetailView,
  type ArtifactRevisionTarget,
  type ArtifactRestoreRequest,
  type ArtifactSaveRequest,
  type ArtifactSurfaceGateway,
  type NativeArtifactEditorController,
  type NativeArtifactDetail,
  type NativeArtifactRevisionDetail,
  assertArtifactMutationResult,
  nativeArtifactDetailFromMutation
} from "./ArtifactSurfacePanel";
import {
  GeneratedSurfaceFrame,
  type GeneratedSurfaceActionCompletion,
  type GeneratedSurfaceActionRequest,
  type GeneratedSurfaceApprovalRecovery,
  type GeneratedSurfaceApprovalResolution,
} from "./GeneratedSurfaceFrame";
import {
  nativeWorkspaceTargetIdentityKey,
  nativeWorkspaceTargetMatches,
  withNativeWorkspaceTarget,
  type NativeWorkspaceTargetGuardBridge
} from "./native-workspace-target";
import { useNativeDraftNavigation, type NativeDraftNavigationController } from "./use-native-draft-navigation";
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";
import type { NativeArtifactWorkspaceInitialResource, NativeWorkspaceTarget } from "./types";
import type { DesktopWorkspaceInteractionRequest } from "../lib/api";
import type { WorkspaceOperationHistoryBridge } from "../lib/workspace-browser-bridge";
import { toJsonValue } from "../lib/surface-view-helpers";
import {
  assertNativeGeneratedSurfaceApprovalResponse,
  clearNativeSurfaceOperationLedger,
  nativeCompletedSurfaceApprovalCompletion,
  nativeGeneratedSurfaceActionInputHash,
  nativeGeneratedSurfaceStateInputHash,
  nativeLatestSurfaceApprovalRequest,
  nativeSurfaceApprovalInputFromRequest,
  nativeSurfaceApprovalIsActive,
  nativeSurfaceApprovalOperationForRequest,
  nativeSurfaceApprovalPollScopeIsCurrent,
  nativeSurfaceApprovalRequestMatches,
  nativeSurfaceApprovalRequestScopeMatches,
  nativeSurfaceApprovalTerminalProjection,
  nativeSurfaceOperationSnapshot,
  nativeSurfaceStateOperationSnapshot,
  operationForNativeSurfaceSnapshot,
  recoveredNativeSurfaceApprovalFrameRequestId,
  recoveredNativeSurfaceApprovalOperation,
  recoverNativeSurfaceActionOperation,
  recoverNativeSurfaceApprovalRequest,
  recoverNativeSurfaceStateOperation,
  type NativeSurfaceApprovalPollScope,
  type NativeSurfaceOperationState
} from "./native-generated-surface-operation-recovery";

export {
  assertNativeGeneratedSurfaceApprovalResponse,
  clearNativeSurfaceOperationLedger,
  nativeCompletedSurfaceApprovalCompletion,
  nativeGeneratedSurfaceActionInputHash,
  nativeGeneratedSurfaceStateInputHash,
  nativeLatestSurfaceApprovalRequest,
  nativeSurfaceApprovalPollScopeIsCurrent,
  nativeSurfaceApprovalRequestMatches,
  nativeSurfaceApprovalRequestScopeMatches,
  nativeSurfaceOperationSnapshot,
  nativeSurfaceStateOperationSnapshot,
  operationForNativeSurfaceSnapshot,
  recoverNativeSurfaceActionOperation,
  recoverNativeSurfaceApprovalRequest,
  recoverNativeSurfaceStateOperation
} from "./native-generated-surface-operation-recovery";
export type {
  NativeSurfaceApprovalHistoryMatch,
  NativeSurfaceApprovalPollScope,
  NativeSurfaceOperationState
} from "./native-generated-surface-operation-recovery";

export interface NativeArtifactWorkspaceTarget extends NativeWorkspaceTarget {
  roomId: string;
}

/**
 * Narrow, target-scoped Desktop bridge used by the Artifact/Surface surface.
 * Keeping this separate from the App model makes it testable and prevents the
 * renderer from selecting an arbitrary Workspace after navigation changes.
 */
export interface NativeArtifactWorkspaceBridge extends NativeWorkspaceTargetGuardBridge {
  listWorkspaceArtifacts?: (input: { roomId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<{ artifacts: NativeArtifactDetail["artifact"][] }>;
  getWorkspaceArtifact?: (input: { roomId: string; artifactId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<ArtifactDetail>;
  listWorkspaceArtifactRevisions?: (input: { roomId: string; artifactId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<ArtifactRevisionRecord[]>;
  getWorkspaceArtifactRevision?: (input: { roomId: string; artifactId: string; revisionId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<ArtifactRevisionDetail>;
  reviseWorkspaceArtifact?: (input: { roomId: string; artifactId: string; content: string; baseRevisionId?: string; expectedRevision?: number; changeSummary?: string; operationId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<ArtifactMutationResult>;
  restoreWorkspaceArtifactRevision?: (input: { roomId: string; artifactId: string; revisionId: string; baseRevisionId?: string; expectedRevision?: number; changeSummary?: string; operationId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<ArtifactMutationResult>;
  listWorkspaceGeneratedSurfaces?: (input: { roomId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceDefinition[]>;
  queryWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceDetail>;
  getWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceDetail>;
  getWorkspaceGeneratedSurfaceBundle?: (input: { roomId: string; surfaceId: string; revisionId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceBundleDetail>;
  runWorkspaceGeneratedSurfaceAction?: (input: { roomId: string; surfaceId: string; actionId: string; revisionId?: string; actionPayload?: Record<string, JsonValue>; operationId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<Record<string, unknown>>;
  runWorkspaceGeneratedSurfaceState?: (input: { roomId: string; surfaceId: string; action: "pin" | "unpin" | "archive"; operationId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceDefinition>;
  exportWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string; revisionId?: string; format: "html" | "zip"; target?: NativeArtifactWorkspaceTarget }) => Promise<GeneratedSurfaceExportPayload>;
  listWorkspaceInteractionRequests?: (input: { roomId: string; includeResolved?: boolean; target?: NativeArtifactWorkspaceTarget }) => Promise<{ requests: DesktopWorkspaceInteractionRequest[] }>;
  getWorkspaceInteractionRequestResult?: (input: { roomId: string; requestId: string; operationId: string; target?: NativeArtifactWorkspaceTarget }) => Promise<DesktopWorkspaceInteractionResult>;
  listWorkspaceOperationHistory?: WorkspaceOperationHistoryBridge["listWorkspaceOperationHistory"];
}

export interface NativeArtifactWorkspaceProps {
  target?: NativeArtifactWorkspaceTarget;
  canEdit?: boolean;
  canExecute?: boolean;
  bridge?: NativeArtifactWorkspaceBridge;
  /** Optional result ref; when present the list is not queried before opening it. */
  initialResource?: NativeArtifactWorkspaceInitialResource;
  onClose?: () => void;
  onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void | Promise<void>;
  onEditorControllerChange?: (controller: NativeArtifactEditorController | undefined) => void;
  onDraftNavigationControllerChange?: (controller: NativeDraftNavigationController | undefined) => void;
  /** Reports action/approval/state execution to the Room/Workspace host. */
  onBusyStateChange?: (state: NativeArtifactWorkspaceBusyState) => void;
}

export interface NativeArtifactWorkspaceBusyState {
  target: NativeArtifactWorkspaceTarget;
  busy: boolean;
}

/** Room-specific key; Artifact IDs alone are intentionally never enough. */
export function nativeArtifactWorkspaceTargetKey(target?: NativeArtifactWorkspaceTarget): string {
  return target ? nativeWorkspaceTargetIdentityKey(target) : "no-artifact-target";
}

export function nativeArtifactWorkspaceRequestIsCurrent(input: {
  requestGeneration: number;
  currentGeneration: number;
  requestedTargetKey: string;
  currentTargetKey: string;
  resourceId: string;
  currentResourceId: string | undefined;
}): boolean {
  return input.requestGeneration === input.currentGeneration
    && input.requestedTargetKey === input.currentTargetKey
    && input.resourceId === input.currentResourceId;
}

/** Revalidates a result ref at the direct-open boundary before any bridge call. */
export function nativeArtifactWorkspaceInitialResourceFromUnknown(
  value: unknown,
  target?: NativeArtifactWorkspaceTarget
): NativeArtifactWorkspaceInitialResource | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "artifact" && kind !== "generated_surface") return undefined;
  const id = value.id;
  const uri = value.uri;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)) return undefined;
  if (typeof uri !== "string" || !nativeArtifactWorkspaceResourceUri(kind, uri)) return undefined;
  const revisionId = typeof value.revisionId === "string"
    ? value.revisionId
    : typeof value.revision_id === "string" ? value.revision_id : undefined;
  if (revisionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(revisionId)) return undefined;
  const connectionId = optionalScopeString(value.connectionId ?? value.connection_id);
  const workspaceId = optionalScopeString(value.workspaceId ?? value.workspace_id);
  const roomId = optionalScopeString(value.roomId ?? value.room_id);
  if ((target && connectionId && connectionId !== target.connectionId)
    || (target && workspaceId && workspaceId !== target.workspaceId)
    || (target && roomId && roomId !== target.roomId)) return undefined;
  return {
    kind,
    id,
    uri,
    ...(revisionId ? { revisionId } : {}),
    ...(typeof value.label === "string" && value.label.trim() ? { label: value.label.trim().slice(0, 4_096) } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(roomId ? { roomId } : {})
  };
}

/**
 * Converts the API's JSON byte projection at the rendering boundary. Binary
 * content is never decoded as UTF-8. Malformed byte arrays fail closed so a
 * caller cannot accidentally display an empty or substituted document.
 */
export function nativeArtifactDetailFromApi(detail: ArtifactDetail): NativeArtifactDetail {
  const binary = detail.encoding === "binary";
  return {
    artifact: detail.artifact,
    content: binary ? byteArrayToBase64(detail.content_bytes) : detail.content,
    contentEncoding: binary ? "base64" : "utf8",
    ...(detail.mime_type ? { contentType: detail.mime_type } : {}),
    ...(detail.revision ? { revision: detail.revision } : {})
  };
}

export function nativeArtifactRevisionDetailFromApi(detail: ArtifactRevisionDetail): NativeArtifactRevisionDetail {
  const binary = detail.encoding === "binary";
  return {
    revision: detail.revision,
    content: binary ? byteArrayToBase64(detail.content_bytes) : detail.content,
    contentEncoding: binary ? "base64" : "utf8",
    contentType: detail.mime_type
  };
}

/** Returns undefined unless every operation needed by direct editing exists. */
export function nativeArtifactWorkspaceGateway(
  bridge: NativeArtifactWorkspaceBridge | undefined,
  target: NativeArtifactWorkspaceTarget | undefined
): ArtifactSurfaceGateway | undefined {
  if (!bridge || !target
    || !bridge.getWorkspaceArtifact
    || !bridge.listWorkspaceArtifactRevisions
    || !bridge.getWorkspaceArtifactRevision
    || !bridge.reviseWorkspaceArtifact
    || !bridge.restoreWorkspaceArtifactRevision) return undefined;

  return {
    list: (roomId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      if (!bridge.listWorkspaceArtifacts) throw new Error("artifact_list_unavailable");
      return (await bridge.listWorkspaceArtifacts!({ roomId, target })).artifacts;
    }),
    get: (roomId, artifactId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return nativeArtifactDetailFromApi(await bridge.getWorkspaceArtifact!({ roomId, artifactId, target }));
    }),
    listRevisions: (roomId, artifactId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return bridge.listWorkspaceArtifactRevisions!({ roomId, artifactId, target });
    }),
    getRevision: (roomId, artifactId, revisionId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return nativeArtifactRevisionDetailFromApi(await bridge.getWorkspaceArtifactRevision!({ roomId, artifactId, revisionId, target }));
    }),
    revise: (input) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, input.roomId);
      const result = await bridge.reviseWorkspaceArtifact!({
        roomId: input.roomId,
        artifactId: input.artifactId,
        content: input.content,
        baseRevisionId: input.baseRevisionId,
        expectedRevision: input.expectedRevision,
        changeSummary: input.changeSummary,
        operationId: input.operationId,
        target
      });
      return assertArtifactMutationResult(result, input.artifactId);
    }),
    restore: (input) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, input.roomId);
      const result = await bridge.restoreWorkspaceArtifactRevision!({
        roomId: input.roomId,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        baseRevisionId: input.baseRevisionId,
        expectedRevision: input.expectedRevision,
        changeSummary: "Human restored a prior artifact revision.",
        operationId: input.operationId,
        target
      });
      return assertArtifactMutationResult(result, input.artifactId);
    })
  };
}

/** The React Room surface for Artifact preview/edit/history and isolated Generated Surface display. */
export function NativeArtifactWorkspace({ target, canEdit = false, canExecute = false, bridge: suppliedBridge, initialResource: initialResourceProp, onClose, onRequestAgentRevision, onEditorControllerChange, onDraftNavigationControllerChange, onBusyStateChange }: NativeArtifactWorkspaceProps) {
  const bridge = (suppliedBridge ?? getWorkspaceClientBridge()) as NativeArtifactWorkspaceBridge | undefined;
  const targetKey = nativeArtifactWorkspaceTargetKey(target);
  const stableTarget = useMemo(() => target ? { ...target } : undefined, [target?.connectionId, target?.workspaceId, target?.roomId, target?.selectionGeneration]);
  const initialResource = useMemo(() => nativeArtifactWorkspaceInitialResourceFromUnknown(initialResourceProp, stableTarget), [initialResourceProp?.connectionId, initialResourceProp?.kind, initialResourceProp?.id, initialResourceProp?.revisionId, initialResourceProp?.roomId, initialResourceProp?.uri, initialResourceProp?.workspaceId, targetKey]);
  const initialResourceInvalid = initialResourceProp !== undefined && !initialResource;
  const initialResourceKey = initialResource
    ? [initialResource.kind, initialResource.id, initialResource.revisionId ?? "", initialResource.uri].join("\n")
    : initialResourceInvalid ? "invalid-initial-resource" : "no-initial-resource";
  const generation = useRef(0);
  const surfaceListEpoch = useRef(0);
  const artifactEpoch = useRef(0);
  const [surface, setSurface] = useState<GeneratedSurfaceDetail>();
  const [surfaceBundle, setSurfaceBundle] = useState<GeneratedSurfaceBundleDetail>();
  const [surfaceError, setSurfaceError] = useState<string>();
  const [surfaceApprovalNotice, setSurfaceApprovalNotice] = useState<string>();
  const [surfaceApprovalResolution, setSurfaceApprovalResolution] = useState<GeneratedSurfaceApprovalResolution>();
  const [surfaceApprovalRecoveries, setSurfaceApprovalRecoveries] = useState<GeneratedSurfaceApprovalRecovery[]>([]);
  const [surfaces, setSurfaces] = useState<GeneratedSurfaceDefinition[]>([]);
  const [surfaceListLoading, setSurfaceListLoading] = useState(false);
  const [surfaceListError, setSurfaceListError] = useState<string>();
  const [artifact, setArtifact] = useState<NativeArtifactDetail>();
  const [artifactRevisions, setArtifactRevisions] = useState<ArtifactRevisionRecord[]>([]);
  const [artifactComparison, setArtifactComparison] = useState<NativeArtifactRevisionDetail>();
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string>();
  const [editorController, setEditorController] = useState<NativeArtifactEditorController>();
  const editorControllerRef = useRef<NativeArtifactEditorController | undefined>(undefined);
  const targetKeyRef = useRef(targetKey);
  const surfaceActionOperations = useRef(new Map<string, NativeSurfaceOperationState>());
  const surfaceApprovalOperations = useRef(new Map<string, NativeSurfaceOperationState>());
  const surfaceStateOperations = useRef(new Map<string, NativeSurfaceOperationState>());
  const surfaceActionCompletedOperations = useRef(new Set<string>());
  const surfaceStateCompletedOperations = useRef(new Set<string>());
  const surfaceApprovalStatus = useRef(new Map<string, string>());
  const surfaceApprovalResolutionRef = useRef<GeneratedSurfaceApprovalResolution | undefined>(undefined);
  const surfaceApprovalRecoveriesRef = useRef<GeneratedSurfaceApprovalRecovery[]>([]);
  const surfaceViewKeyRef = useRef<string | undefined>(undefined);
  const surfaceBundleRef = useRef<GeneratedSurfaceBundleDetail | undefined>(undefined);
  const surfaceBusyRef = useRef(false);
  targetKeyRef.current = targetKey;
  surfaceViewKeyRef.current = surface ? `${surface.surface.id}\n${surface.surface.current_revision_id}` : undefined;
  surfaceBundleRef.current = surfaceBundle;
  surfaceApprovalResolutionRef.current = surfaceApprovalResolution;
  surfaceApprovalRecoveriesRef.current = surfaceApprovalRecoveries;
  const gateway = useMemo(() => nativeArtifactWorkspaceGateway(bridge, stableTarget), [bridge, targetKey]);

  const reportSurfaceBusyState = useCallback((busy: boolean): void => {
    surfaceBusyRef.current = busy;
    if (stableTarget) onBusyStateChange?.({ target: stableTarget, busy });
  }, [onBusyStateChange, stableTarget]);

  const requestAgentRevision = useCallback(async (revisionTarget: ArtifactRevisionTarget): Promise<void> => {
    if (!stableTarget || targetKeyRef.current !== targetKey) throw new Error("artifact_revision_target_stale");
    if (revisionTarget.workspaceTarget && !nativeWorkspaceTargetMatches(revisionTarget.workspaceTarget, stableTarget)) {
      throw new Error("artifact_revision_target_stale");
    }
    if (!onRequestAgentRevision) throw new Error("artifact_revision_request_unavailable");
    await onRequestAgentRevision({ ...revisionTarget, workspaceTarget: stableTarget });
  }, [onRequestAgentRevision, stableTarget, targetKey]);

  useEffect(() => {
    generation.current += 1;
    surfaceListEpoch.current += 1;
    artifactEpoch.current += 1;
    surfaceActionOperations.current.clear();
    surfaceApprovalOperations.current.clear();
    surfaceStateOperations.current.clear();
    surfaceActionCompletedOperations.current.clear();
    surfaceStateCompletedOperations.current.clear();
    surfaceApprovalStatus.current.clear();
    surfaceBusyRef.current = false;
    if (stableTarget) onBusyStateChange?.({ target: stableTarget, busy: false });
    editorControllerRef.current = undefined;
    onEditorControllerChange?.(undefined);
    setSurface(undefined);
    setSurfaceBundle(undefined);
    setSurfaceError(undefined);
    setSurfaceApprovalNotice(undefined);
    setSurfaceApprovalResolution(undefined);
    setSurfaceApprovalRecoveries([]);
    setSurfaces([]);
    setSurfaceListLoading(false);
    setSurfaceListError(undefined);
    setArtifact(undefined);
    setArtifactRevisions([]);
    setArtifactComparison(undefined);
    setArtifactLoading(false);
    setArtifactError(undefined);
  }, [initialResourceKey, onBusyStateChange, onEditorControllerChange, stableTarget, targetKey]);

  useEffect(() => () => {
    if (stableTarget) onBusyStateChange?.({ target: stableTarget, busy: false });
  }, [onBusyStateChange, stableTarget]);

  const refreshSurfaceList = useCallback(async (): Promise<void> => {
    if (!stableTarget || !bridge?.listWorkspaceGeneratedSurfaces) return;
    const requestEpoch = ++surfaceListEpoch.current;
    setSurfaceListLoading(true);
    setSurfaceListError(undefined);
    try {
      const listed = await withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.listWorkspaceGeneratedSurfaces!({ roomId: stableTarget.roomId, target: stableTarget }));
      if (requestEpoch !== surfaceListEpoch.current) return;
      setSurfaces(listed);
    } catch (cause) {
      if (requestEpoch === surfaceListEpoch.current) setSurfaceListError(nativeArtifactWorkspaceError(cause));
    } finally {
      if (requestEpoch === surfaceListEpoch.current) setSurfaceListLoading(false);
    }
  }, [bridge, stableTarget]);

  const openGeneratedSurface = useCallback(async (surfaceId: string, revisionId?: string): Promise<void> => {
    if (!stableTarget || !bridge) return;
    const query = bridge.queryWorkspaceGeneratedSurface ?? bridge.getWorkspaceGeneratedSurface;
    if (!query) {
      setSurfaceError("操作画面を開くための既存bridgeが利用できません。");
      return;
    }
    const requestGeneration = ++generation.current;
    setArtifact(undefined);
    setArtifactComparison(undefined);
    setArtifactError(undefined);
    setSurfaceBundle(undefined);
    setSurfaceError(undefined);
    setSurfaceApprovalResolution(undefined);
    setSurfaceApprovalRecoveries([]);
    try {
      const detail = await withNativeWorkspaceTarget(bridge, stableTarget, () => query({ roomId: stableTarget.roomId, surfaceId, target: stableTarget }));
      if (requestGeneration !== generation.current) return;
      if (detail.surface.id !== surfaceId) throw new Error("generated_surface_response_mismatch");
      let nextDetail = detail;
      let nextBundle: GeneratedSurfaceBundleDetail | undefined;
      if (revisionId) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(revisionId)) throw new Error("generated_surface_revision_invalid");
        const revision = detail.revisions.find((candidate) => candidate.id === revisionId);
        if (revision) {
          nextDetail = { ...detail, surface: { ...detail.surface, current_revision_id: revision.id, current_revision: revision.revision } };
        } else {
          if (!bridge.getWorkspaceGeneratedSurfaceBundle) throw new Error("generated_surface_revision_not_found");
          nextBundle = await withNativeWorkspaceTarget(bridge, stableTarget, async () => {
            const bundle = await bridge.getWorkspaceGeneratedSurfaceBundle!({ roomId: stableTarget.roomId, surfaceId, revisionId, target: stableTarget });
            if (bundle.surface.id !== surfaceId || bundle.revision.id !== revisionId) throw new Error("generated_surface_bundle_mismatch");
            return bundle;
          });
          if (requestGeneration !== generation.current) return;
          nextDetail = {
            ...detail,
            surface: { ...detail.surface, current_revision_id: nextBundle.revision.id, current_revision: nextBundle.revision.revision },
            revisions: [...detail.revisions, nextBundle.revision]
          };
        }
      }
      setSurfaceBundle(nextBundle);
      setSurface(nextDetail);
    } catch (cause) {
      if (requestGeneration === generation.current) setSurfaceError(nativeArtifactWorkspaceError(cause));
    }
  }, [bridge, stableTarget]);

  const openInitialArtifact = useCallback(async (resource: NativeArtifactWorkspaceInitialResource): Promise<void> => {
    if (!stableTarget || !gateway) {
      setArtifactError("成果物を開くための既存bridgeが利用できません。");
      return;
    }
    const requestEpoch = ++artifactEpoch.current;
    generation.current += 1;
    setSurface(undefined);
    setSurfaceBundle(undefined);
    setSurfaceError(undefined);
    setSurfaceApprovalResolution(undefined);
    setSurfaceApprovalRecoveries([]);
    setArtifactLoading(true);
    setArtifactError(undefined);
    setArtifactComparison(undefined);
    try {
      const [detail, history] = await Promise.all([
        gateway.get(stableTarget.roomId, resource.id),
        gateway.listRevisions(stableTarget.roomId, resource.id)
      ]);
      if (requestEpoch !== artifactEpoch.current || detail.artifact.id !== resource.id) throw new Error("artifact_response_mismatch");
      let nextDetail = detail;
      if (resource.revisionId) {
        const revision = await gateway.getRevision(stableTarget.roomId, resource.id, resource.revisionId);
        if (requestEpoch !== artifactEpoch.current || revision.revision.artifact_id !== resource.id || revision.revision.id !== resource.revisionId) {
          throw new Error("artifact_revision_response_mismatch");
        }
        nextDetail = {
          ...detail,
          content: revision.content,
          ...(revision.contentEncoding ? { contentEncoding: revision.contentEncoding } : {}),
          ...(revision.contentType ? { contentType: revision.contentType } : {}),
          revision: revision.revision
        };
      }
      setArtifact(nextDetail);
      setArtifactRevisions([...history].sort((left, right) => right.revision - left.revision));
    } catch (cause) {
      if (requestEpoch === artifactEpoch.current) setArtifactError(nativeArtifactWorkspaceError(cause));
    } finally {
      if (requestEpoch === artifactEpoch.current) setArtifactLoading(false);
    }
  }, [gateway, stableTarget]);

  const loadArtifactComparison = useCallback(async (revisionId: string): Promise<void> => {
    if (!stableTarget || !gateway || !artifact) return;
    const artifactId = artifact.artifact.id;
    const requestEpoch = ++artifactEpoch.current;
    setArtifactLoading(true);
    setArtifactError(undefined);
    try {
      const revision = await gateway.getRevision(stableTarget.roomId, artifactId, revisionId);
      if (!nativeArtifactWorkspaceRequestIsCurrent({ requestGeneration: requestEpoch, currentGeneration: artifactEpoch.current, requestedTargetKey: targetKey, currentTargetKey: targetKeyRef.current, resourceId: artifactId, currentResourceId: artifact?.artifact.id }) || revision.revision.artifact_id !== artifactId) throw new Error("artifact_revision_response_mismatch");
      setArtifactComparison(revision);
    } catch (cause) {
      if (requestEpoch === artifactEpoch.current && targetKeyRef.current === targetKey && artifact?.artifact.id === artifactId) setArtifactError(nativeArtifactWorkspaceError(cause));
    } finally {
      if (requestEpoch === artifactEpoch.current && targetKeyRef.current === targetKey && artifact?.artifact.id === artifactId) setArtifactLoading(false);
    }
  }, [artifact, gateway, stableTarget, targetKey]);

  const saveInitialArtifact = useCallback(async (input: ArtifactSaveRequest): Promise<ArtifactMutationResult> => {
    if (!stableTarget || !gateway || !artifact || input.artifactId !== artifact.artifact.id || targetKeyRef.current !== targetKey) {
      throw new Error("artifact_save_unavailable");
    }
    const requestEpoch = ++artifactEpoch.current;
    const artifactId = artifact.artifact.id;
    setArtifactLoading(false);
    const mutation = assertArtifactMutationResult(await gateway.revise({ roomId: stableTarget.roomId, ...input }), input.artifactId);
    const revision = mutation.revision;
    if (!revision) throw new Error("artifact_mutation_revision_missing");
    const [revisionDetail, history] = await Promise.all([
      gateway.getRevision(stableTarget.roomId, input.artifactId, revision.id),
      gateway.listRevisions(stableTarget.roomId, input.artifactId)
    ]);
    if (!nativeArtifactWorkspaceRequestIsCurrent({ requestGeneration: requestEpoch, currentGeneration: artifactEpoch.current, requestedTargetKey: targetKey, currentTargetKey: targetKeyRef.current, resourceId: artifactId, currentResourceId: artifact?.artifact.id }) || revisionDetail.revision.id !== revision.id) throw new Error("artifact_navigation_changed");
    setArtifact(nativeArtifactDetailFromMutation(mutation, revisionDetail));
    setArtifactRevisions(artifactHistoryWithMutation(history, revision));
    setArtifactComparison(undefined);
    return mutation;
  }, [artifact, gateway, stableTarget, targetKey]);

  const restoreInitialArtifact = useCallback(async (input: ArtifactRestoreRequest): Promise<ArtifactMutationResult> => {
    if (!stableTarget || !gateway || !artifact || input.artifactId !== artifact.artifact.id || targetKeyRef.current !== targetKey) {
      throw new Error("artifact_restore_unavailable");
    }
    const requestEpoch = ++artifactEpoch.current;
    const artifactId = artifact.artifact.id;
    setArtifactLoading(true);
    setArtifactError(undefined);
    try {
      const mutation = assertArtifactMutationResult(await gateway.restore({ roomId: stableTarget.roomId, ...input }), input.artifactId);
      const revision = mutation.revision;
      if (!revision) throw new Error("artifact_mutation_revision_missing");
      const [revisionDetail, history] = await Promise.all([
        gateway.getRevision(stableTarget.roomId, input.artifactId, revision.id),
        gateway.listRevisions(stableTarget.roomId, input.artifactId)
      ]);
      if (!nativeArtifactWorkspaceRequestIsCurrent({ requestGeneration: requestEpoch, currentGeneration: artifactEpoch.current, requestedTargetKey: targetKey, currentTargetKey: targetKeyRef.current, resourceId: artifactId, currentResourceId: artifact?.artifact.id }) || revisionDetail.revision.id !== revision.id) throw new Error("artifact_navigation_changed");
      setArtifact(nativeArtifactDetailFromMutation(mutation, revisionDetail));
      setArtifactRevisions(artifactHistoryWithMutation(history, revision));
      setArtifactComparison(undefined);
      return mutation;
    } catch (cause) {
      if (requestEpoch === artifactEpoch.current && targetKeyRef.current === targetKey && artifact?.artifact.id === artifactId) setArtifactError(nativeArtifactWorkspaceError(cause));
      throw cause;
    } finally {
      if (requestEpoch === artifactEpoch.current && targetKeyRef.current === targetKey && artifact?.artifact.id === artifactId) setArtifactLoading(false);
    }
  }, [artifact, gateway, stableTarget, targetKey]);

  useEffect(() => {
    if (initialResourceInvalid) {
      setSurfaceError("仕事の結果から受け取った成果物参照が無効です。");
      return;
    }
    if (initialResource?.kind === "generated_surface") {
      void openGeneratedSurface(initialResource.id, initialResource.revisionId);
      return;
    }
    if (initialResource?.kind === "artifact") {
      void openInitialArtifact(initialResource);
      return;
    }
    void refreshSurfaceList();
  }, [initialResource, initialResourceInvalid, openGeneratedSurface, openInitialArtifact, refreshSurfaceList]);

  const loadBundle = useCallback(async (input: { surfaceId: string; revisionId: string }): Promise<GeneratedSurfaceBundleDetail> => {
    if (!stableTarget || !bridge?.getWorkspaceGeneratedSurfaceBundle) throw new Error("generated_surface_bundle_unavailable");
    return withNativeWorkspaceTarget(bridge, stableTarget, async () => {
      const bundle = await bridge.getWorkspaceGeneratedSurfaceBundle!({ roomId: stableTarget.roomId, surfaceId: input.surfaceId, revisionId: input.revisionId, target: stableTarget });
      if (bundle.surface.id !== input.surfaceId || bundle.revision.id !== input.revisionId) throw new Error("generated_surface_bundle_mismatch");
      return bundle;
    });
  }, [bridge, stableTarget]);

  const refreshSurfaceAfterMutation = useCallback(async (surfaceId: string, requestGeneration: number): Promise<GeneratedSurfaceDetail> => {
    if (!stableTarget || !bridge) throw new Error("generated_surface_refresh_unavailable");
    const query = bridge.queryWorkspaceGeneratedSurface ?? bridge.getWorkspaceGeneratedSurface;
    if (!query) throw new Error("generated_surface_refresh_unavailable");
    const detailPromise = withNativeWorkspaceTarget(bridge, stableTarget, () => query({ roomId: stableTarget.roomId, surfaceId, target: stableTarget }));
    const listPromise = bridge.listWorkspaceGeneratedSurfaces
      ? withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.listWorkspaceGeneratedSurfaces!({ roomId: stableTarget.roomId, target: stableTarget }))
      : Promise.resolve(undefined);
    const [nextDetail, nextList] = await Promise.all([detailPromise, listPromise]);
    if (nextDetail.surface.id !== surfaceId) throw new Error("generated_surface_response_mismatch");
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current?.split("\n", 1)[0] !== surfaceId) throw new Error("surface_navigation_changed");
    setSurface(nextDetail);
    if (nextList) setSurfaces(nextList);
    const currentBundle = surfaceBundleRef.current;
    if (currentBundle?.surface.id === surfaceId && currentBundle.revision.id === nextDetail.surface.current_revision_id) {
      setSurfaceBundle(currentBundle);
      return nextDetail;
    }
    if (!bridge.getWorkspaceGeneratedSurfaceBundle) {
      setSurfaceBundle(undefined);
      return nextDetail;
    }
    const nextBundle = await loadBundle({ surfaceId, revisionId: nextDetail.surface.current_revision_id });
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current?.split("\n", 1)[0] !== surfaceId) throw new Error("surface_navigation_changed");
    setSurfaceBundle(nextBundle);
    return nextDetail;
  }, [bridge, loadBundle, stableTarget, targetKey]);

  const readCompletedSurfaceApproval = useCallback(async (input: {
    action: GeneratedSurfaceActionRequest;
    requestId: string;
    operationId: string;
  }): Promise<GeneratedSurfaceActionCompletion | undefined> => {
    if (!stableTarget || !bridge?.getWorkspaceInteractionRequestResult) return undefined;
    const response = await withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.getWorkspaceInteractionRequestResult!({
      roomId: stableTarget.roomId,
      requestId: input.requestId,
      operationId: input.operationId,
      target: stableTarget
    }));
    const completion = nativeCompletedSurfaceApprovalCompletion(
      response,
      stableTarget,
      input.action,
      input.requestId,
      input.operationId
    );
    return completion;
  }, [bridge, stableTarget]);

  const loadCompletedSurfaceApproval = useCallback(async (input: {
    action: GeneratedSurfaceActionRequest;
    requestId: string;
    operationId: string;
    requestGeneration: number;
  }): Promise<GeneratedSurfaceActionCompletion | undefined> => {
    const completion = await readCompletedSurfaceApproval(input);
    if (!completion || !stableTarget) return undefined;
    const nextDetail = await refreshSurfaceAfterMutation(input.action.surfaceId, input.requestGeneration);
    return {
      ...completion,
      latest: {
        surface: toJsonValue(nextDetail.surface),
        data: completion.result ?? null
      }
    };
  }, [readCompletedSurfaceApproval, refreshSurfaceAfterMutation, stableTarget]);

  useEffect(() => {
    if (!stableTarget || !surface || !bridge?.listWorkspaceInteractionRequests) {
      setSurfaceApprovalNotice(undefined);
      return;
    }
    let active = true;
    let pollInFlight = false;
    const listWorkspaceInteractionRequests = bridge.listWorkspaceInteractionRequests;
    const surfaceId = surface.surface.id;
    const revisionId = surface.surface.current_revision_id;
    const actionIds = new Set(surface.surface.actions.map((action) => action.id));
    const statusKey = surfaceId + "\n" + revisionId;
    const pollScope: NativeSurfaceApprovalPollScope = {
      generation: generation.current,
      targetKey,
      surfaceViewKey: `${surfaceId}\n${revisionId}`
    };
    const isCurrentPoll = (): boolean => active && nativeSurfaceApprovalPollScopeIsCurrent(pollScope, {
      generation: generation.current,
      targetKey: targetKeyRef.current,
      surfaceViewKey: surfaceViewKeyRef.current ?? ""
    });
    const poll = async (): Promise<void> => {
      if (!isCurrentPoll() || pollInFlight) return;
      pollInFlight = true;
      try {
        const result = await withNativeWorkspaceTarget(bridge, stableTarget, () => listWorkspaceInteractionRequests({
          roomId: stableTarget.roomId,
          includeResolved: true,
          target: stableTarget
        }));
        if (!isCurrentPoll()) return;
        const latestMatching = nativeLatestSurfaceApprovalRequest(result.requests, stableTarget, {
          surfaceId,
          revisionId,
          actionIds
        });
        if (!latestMatching) {
          for (const key of surfaceApprovalStatus.current.keys()) {
            if (key.startsWith(statusKey + "\n")) surfaceApprovalStatus.current.delete(key);
          }
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([]);
          setSurfaceApprovalNotice(undefined);
          return;
        }
        setSurfaceApprovalNotice(surfaceApprovalNoticeForRequest(latestMatching));
        const requestStatusKey = statusKey + "\n" + latestMatching.id;
        const statusIdentity = latestMatching.id + "\n" + latestMatching.status;
        for (const key of surfaceApprovalStatus.current.keys()) {
          if (key.startsWith(statusKey + "\n") && key !== requestStatusKey) {
            surfaceApprovalStatus.current.delete(key);
          }
        }
        const terminalStatuses = new Set(["completed", "denied", "cancelled", "expired", "failed"]);
        const approvalInput = nativeSurfaceApprovalInputFromRequest(latestMatching, stableTarget);
        if (!approvalInput || !terminalStatuses.has(latestMatching.status)) {
          surfaceApprovalStatus.current.set(requestStatusKey, statusIdentity);
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([]);
          return;
        }

        let operation = nativeSurfaceApprovalOperationForRequest(surfaceApprovalOperations.current, latestMatching.id);
        if (!operation) {
          operation = recoveredNativeSurfaceApprovalOperation(stableTarget, approvalInput, latestMatching.id);
          surfaceApprovalOperations.current.set(`${targetKey}\nrecovered-approval\n${latestMatching.id}`, operation);
        } else if (!operation.frameRequestId) {
          operation.frameRequestId = recoveredNativeSurfaceApprovalFrameRequestId(stableTarget, latestMatching.id);
        }
        const frameRequestId = operation.frameRequestId;
        if (!frameRequestId) {
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([]);
          return;
        }
        const terminalStatus = latestMatching.status === "completed" ? "completed" : "failed";
        const existingRecovery = surfaceApprovalRecoveriesRef.current.find((recovery) =>
          recovery.request.requestId === frameRequestId
          && recovery.request.operationId === operation.operationId
          && recovery.status === terminalStatus
        );
        const existingResolution = surfaceApprovalResolutionRef.current;
        const hasCurrentResolution = operation.approvalResultChannel === "frame"
          && existingResolution?.requestId === frameRequestId
          && existingResolution.operationId === operation.operationId
          && existingResolution.status === terminalStatus;
        if (surfaceApprovalStatus.current.get(requestStatusKey) === statusIdentity && hasCurrentResolution) {
          setSurfaceApprovalRecoveries([]);
          return;
        }
        if (surfaceApprovalStatus.current.get(requestStatusKey) === statusIdentity
          && operation.approvalResultChannel !== "frame"
          && existingRecovery) {
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([existingRecovery]);
          return;
        }

        if (latestMatching.status === "completed") {
          try {
            const completion = await readCompletedSurfaceApproval({
              action: approvalInput,
              requestId: latestMatching.id,
              operationId: operation.operationId
            });
            if (!isCurrentPoll()) return;
            if (!completion) {
              setSurfaceApprovalResolution(undefined);
              setSurfaceApprovalRecoveries([]);
              return;
            }
            const nextDetail = await refreshSurfaceAfterMutation(surfaceId, pollScope.generation);
            if (!isCurrentPoll()) return;
            const projection = nativeSurfaceApprovalTerminalProjection(operation, approvalInput, {
              status: "completed",
              result: completion.result ?? null,
              latest: {
                surface: toJsonValue(nextDetail.surface),
                data: completion.result ?? null
              }
            });
            if (!projection) {
              setSurfaceApprovalResolution(undefined);
              setSurfaceApprovalRecoveries([]);
              return;
            }
            surfaceApprovalStatus.current.set(requestStatusKey, statusIdentity);
            setSurfaceApprovalNotice("承認された操作の保存結果と最新のSurfaceデータを反映しました。");
            if (projection.channel === "frame") {
              setSurfaceApprovalRecoveries([]);
              setSurfaceApprovalResolution(projection.resolution);
            } else {
              setSurfaceApprovalResolution(undefined);
              setSurfaceApprovalRecoveries([projection.recovery]);
            }
          } catch {
            setSurfaceApprovalResolution(undefined);
            setSurfaceApprovalRecoveries([]);
            if (targetKeyRef.current === targetKey) {
              setSurfaceApprovalNotice("承認後の操作結果を反映できませんでした。保存結果を取得できるまで待機します。");
            }
          }
          return;
        }

        const projection = nativeSurfaceApprovalTerminalProjection(operation, approvalInput, {
          status: "failed",
          error: {
            code: "generated_surface_approval_" + latestMatching.status,
            message: surfaceApprovalResolutionMessage(latestMatching.status),
            retryable: false
          }
        });
        if (!projection) {
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([]);
          return;
        }
        surfaceApprovalStatus.current.set(requestStatusKey, statusIdentity);
        if (projection.channel === "frame") {
          setSurfaceApprovalRecoveries([]);
          setSurfaceApprovalResolution(projection.resolution);
        } else {
          setSurfaceApprovalResolution(undefined);
          setSurfaceApprovalRecoveries([projection.recovery]);
        }
      } catch {
        if (isCurrentPoll()) {
          setSurfaceApprovalNotice("承認要求の状態を確認できません。重複実行を避けるため、再試行前にInteractionを再読込してください。");
        }
      } finally {
        pollInFlight = false;
      }
    };
    setSurfaceApprovalNotice(undefined);
    void poll();
    const interval = globalThis.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
    };
  }, [bridge, readCompletedSurfaceApproval, refreshSurfaceAfterMutation, stableTarget, surface?.surface.actions, surface?.surface.current_revision_id, surface?.surface.id, targetKey]);

  const runSurfaceAction = useCallback(async (input: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => {
    if (!stableTarget) throw new Error("generated_surface_action_unavailable");
    if (targetKeyRef.current !== targetKey) throw new Error("surface_navigation_changed");
    const requestGeneration = generation.current;
    const requestedViewKey = `${input.surfaceId}\n${input.revisionId}`;
    if (surfaceViewKeyRef.current !== requestedViewKey) throw new Error("generated_surface_revision_stale");
    const snapshot = nativeSurfaceOperationSnapshot(input);
    const operationKey = `${targetKey}\n${snapshot}`;
    const previous = surfaceActionOperations.current.get(operationKey);
    const recovered = previous ?? (surfaceActionCompletedOperations.current.has(operationKey)
      ? undefined
      : await (bridge?.listWorkspaceOperationHistory
        ? withNativeWorkspaceTarget(bridge, stableTarget, () => recoverNativeSurfaceActionOperation(bridge, stableTarget, input))
        : Promise.resolve(undefined)));
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) {
      throw new Error("surface_navigation_changed");
    }
    const operation = operationForNativeSurfaceSnapshot(recovered, snapshot, input.operationId);
    surfaceActionOperations.current.set(operationKey, operation);
    try {
      const response = await runNativeGeneratedSurfaceAction(bridge, stableTarget, input, operation.operationId);
      if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) throw new Error("surface_navigation_changed");
      const nextDetail = await refreshSurfaceAfterMutation(input.surfaceId, requestGeneration);
      surfaceActionCompletedOperations.current.add(operationKey);
      clearNativeSurfaceOperationLedger(surfaceActionOperations.current, operationKey, operation);
      return nativeGeneratedSurfaceActionCompletion(response, operation.operationId, nextDetail);
    } catch (cause) {
      // Keep the operation ID until the action and its authoritative refresh
      // both succeed, so a retry cannot duplicate a partially applied command.
      throw cause;
    }
  }, [bridge, refreshSurfaceAfterMutation, stableTarget, targetKey]);

  const requestSurfaceApproval = useCallback(async (input: GeneratedSurfaceActionRequest): Promise<GeneratedSurfaceActionCompletion> => {
    if (!stableTarget) throw new Error("generated_surface_action_unavailable");
    if (targetKeyRef.current !== targetKey) throw new Error("surface_navigation_changed");
    const frameRequestId = input.requestId?.trim();
    if (!frameRequestId) throw new Error("generated_surface_approval_request_id_missing");
    const requestGeneration = generation.current;
    const requestedViewKey = `${input.surfaceId}\n${input.revisionId}`;
    if (surfaceViewKeyRef.current !== requestedViewKey) throw new Error("generated_surface_revision_stale");
    setSurfaceApprovalResolution(undefined);
    const snapshot = nativeSurfaceOperationSnapshot(input);
    const operationKey = `${targetKey}\n${snapshot}`;
    let previous = surfaceApprovalOperations.current.get(operationKey);
    const durable = bridge?.listWorkspaceOperationHistory
      ? await withNativeWorkspaceTarget(bridge, stableTarget, () => recoverNativeSurfaceApprovalRequest(bridge, stableTarget, input, previous?.requestId))
      : undefined;
    if (targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) {
      throw new Error("surface_navigation_changed");
    }
    if (durable && nativeSurfaceApprovalIsActive(durable.status)) {
      const reusable = previous?.requestId === durable.requestId ? previous : undefined;
      const recovered = recoveredNativeSurfaceApprovalOperation(stableTarget, input, durable.requestId);
      const operation = operationForNativeSurfaceSnapshot(reusable, snapshot, reusable?.operationId ?? recovered.operationId);
      surfaceApprovalOperations.current.set(operationKey, {
        ...operation,
        requestId: durable.requestId,
        frameRequestId,
        approvalResultChannel: "frame"
      });
      setSurfaceApprovalNotice("このSurfaceには未完了の承認要求があります。Interactionから承認または拒否を完了してください。");
      return { operationId: operation.operationId };
    }
    if (durable?.status === "completed"
      && previous?.requestId === durable.requestId
      && previous.frameRequestId === frameRequestId) {
      const operation = operationForNativeSurfaceSnapshot(previous, snapshot, input.operationId);
      surfaceApprovalOperations.current.set(operationKey, {
        ...operation,
        requestId: durable.requestId,
        frameRequestId,
        approvalResultChannel: "frame"
      });
      const completion = await loadCompletedSurfaceApproval({
        action: input,
        requestId: durable.requestId,
        operationId: operation.operationId,
        requestGeneration
      });
      if (completion) {
        setSurfaceApprovalNotice("承認された操作の保存結果と最新のSurfaceデータを反映しました。");
        return completion;
      }
      setSurfaceApprovalNotice("承認済みの操作を確認しました。保存結果を取得できるまで待機しています。");
      return { operationId: operation.operationId };
    }
    if (durable && !["completed", "denied", "cancelled", "expired", "failed"].includes(durable.status)) {
      throw new Error("generated_surface_approval_recovery_unknown");
    }
    if (bridge?.listWorkspaceInteractionRequests) {
      const listed = await withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.listWorkspaceInteractionRequests!({
        roomId: stableTarget.roomId,
        includeResolved: true,
        target: stableTarget
      }));
      const matches = listed.requests.filter((request) => nativeSurfaceApprovalRequestMatches(request, stableTarget, input));
      const activeMatches = matches.filter((request) => nativeSurfaceApprovalIsActive(request.status));
      if (activeMatches.length > 1) throw new Error("generated_surface_approval_recovery_ambiguous");
      const existing = activeMatches[0] ?? (previous?.requestId
        ? matches.find((request) => request.id === previous?.requestId && request.status === "completed")
        : undefined);
      if (existing && nativeSurfaceApprovalIsActive(existing.status)) {
        const reusable = previous?.requestId === existing.id ? previous : undefined;
        const recovered = recoveredNativeSurfaceApprovalOperation(stableTarget, input, existing.id);
        const operation = operationForNativeSurfaceSnapshot(reusable, snapshot, reusable?.operationId ?? recovered.operationId);
        surfaceApprovalOperations.current.set(operationKey, {
          ...operation,
          requestId: existing.id,
          frameRequestId,
          approvalResultChannel: "frame"
        });
        setSurfaceApprovalNotice("このSurfaceには未完了の承認要求があります。Interactionから承認または拒否を完了してください。");
        return { operationId: operation.operationId };
      }
      const canReplayCompleted = existing?.status === "completed"
        && previous?.requestId === existing.id
        && previous.frameRequestId === frameRequestId;
      if (existing?.status === "completed" && canReplayCompleted) {
        const operation = operationForNativeSurfaceSnapshot(previous, snapshot, input.operationId);
        surfaceApprovalOperations.current.set(operationKey, {
          ...operation,
          requestId: existing.id,
          frameRequestId,
          approvalResultChannel: "frame"
        });
        const completion = await loadCompletedSurfaceApproval({
          action: input,
          requestId: existing.id,
          operationId: operation.operationId,
          requestGeneration
        });
        if (completion) {
          setSurfaceApprovalNotice("承認された操作の保存結果と最新のSurfaceデータを反映しました。");
          return completion;
        }
        setSurfaceApprovalNotice("承認済みの操作を確認しました。保存結果を取得できるまで待機しています。");
        return { operationId: operation.operationId };
      }
      if (matches.some((request) => !["completed", "denied", "cancelled", "expired", "failed"].includes(request.status))) {
        throw new Error("generated_surface_approval_recovery_unknown");
      }
      surfaceApprovalOperations.current.delete(operationKey);
      previous = undefined;
    }
    const operation = operationForNativeSurfaceSnapshot(previous, snapshot, input.operationId);
    surfaceApprovalOperations.current.set(operationKey, operation);
    const response = await runNativeGeneratedSurfaceAction(bridge, stableTarget, input, operation.operationId);
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) throw new Error("surface_navigation_changed");
    const request = assertNativeGeneratedSurfaceApprovalResponse(response, stableTarget, input);
    surfaceApprovalOperations.current.set(operationKey, {
      ...operation,
      requestId: request.id,
      frameRequestId,
      approvalResultChannel: "frame"
    });
    setSurfaceApprovalNotice("確認要求をServerへ保存しました。Interactionから承認または拒否を完了してください。");
    return { operationId: operation.operationId };
  }, [bridge, loadCompletedSurfaceApproval, stableTarget, targetKey]);

  const setSurfaceState = useCallback(async (input: { surfaceId: string; action: "pin" | "unpin" | "archive" }): Promise<void> => {
    if (!stableTarget || !bridge?.runWorkspaceGeneratedSurfaceState) throw new Error("generated_surface_state_unavailable");
    if (targetKeyRef.current !== targetKey) throw new Error("surface_navigation_changed");
    const requestGeneration = generation.current;
    const revisionId = surface?.surface.current_revision_id;
    if (!revisionId) throw new Error("generated_surface_revision_unavailable");
    const requestedViewKey = `${input.surfaceId}\n${revisionId}`;
    if (surfaceViewKeyRef.current !== requestedViewKey) throw new Error("surface_navigation_changed");
    const snapshot = nativeSurfaceStateOperationSnapshot({ surfaceId: input.surfaceId, revisionId, action: input.action });
    const operationKey = `${targetKey}\n${snapshot}`;
    const previous = surfaceStateOperations.current.get(operationKey);
    const recovered = previous ?? (surfaceStateCompletedOperations.current.has(operationKey)
      ? undefined
      : await (bridge.listWorkspaceOperationHistory
        ? withNativeWorkspaceTarget(bridge, stableTarget, () => recoverNativeSurfaceStateOperation(bridge, stableTarget, { surfaceId: input.surfaceId, revisionId, action: input.action }))
        : Promise.resolve(undefined)));
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) {
      throw new Error("surface_navigation_changed");
    }
    const operation = operationForNativeSurfaceSnapshot(recovered, snapshot);
    surfaceStateOperations.current.set(operationKey, operation);
    const returned = await withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.runWorkspaceGeneratedSurfaceState!({
      roomId: stableTarget.roomId,
      surfaceId: input.surfaceId,
      action: input.action,
      operationId: operation.operationId,
      target: stableTarget
    }));
    if (generation.current !== requestGeneration || targetKeyRef.current !== targetKey || surfaceViewKeyRef.current !== requestedViewKey) throw new Error("surface_navigation_changed");
    if (returned.id !== input.surfaceId) throw new Error("generated_surface_state_response_mismatch");
    setSurface((previousSurface) => previousSurface?.surface.id === input.surfaceId ? { ...previousSurface, surface: returned } : previousSurface);
    setSurfaces((previousSurfaces) => previousSurfaces.map((candidate) => candidate.id === returned.id ? returned : candidate));
    await refreshSurfaceAfterMutation(input.surfaceId, requestGeneration);
    surfaceStateCompletedOperations.current.add(operationKey);
    clearNativeSurfaceOperationLedger(surfaceStateOperations.current, operationKey, operation);
  }, [bridge, refreshSurfaceAfterMutation, stableTarget, surface, targetKey]);

  const exportSurface = useCallback(async (input: { surfaceId: string; revisionId: string; format: "html" | "zip" }): Promise<GeneratedSurfaceExportPayload> => {
    if (!stableTarget || !bridge?.exportWorkspaceGeneratedSurface) throw new Error("generated_surface_export_unavailable");
    return withNativeWorkspaceTarget(bridge, stableTarget, () => bridge.exportWorkspaceGeneratedSurface!({
      roomId: stableTarget.roomId,
      surfaceId: input.surfaceId,
      revisionId: input.revisionId,
      format: input.format,
      target: stableTarget
    }));
  }, [bridge, stableTarget]);

  const registerEditorController = useCallback((controller: NativeArtifactEditorController | undefined): void => {
    editorControllerRef.current = controller;
    setEditorController(controller);
    onEditorControllerChange?.(controller);
  }, [onEditorControllerChange]);

  useEffect(() => () => {
    editorControllerRef.current = undefined;
    setEditorController(undefined);
    onEditorControllerChange?.(undefined);
  }, [onEditorControllerChange]);

  const draftNavigation = useNativeDraftNavigation({
    scopeKey: "artifact-workspace\n" + targetKey,
    label: "成果物",
    dirty: editorController?.dirty === true,
    saving: editorController?.saving === true,
    canSave: canEdit,
    saveUnavailableMessage: "このRoomでは成果物を保存できません。破棄するか、編集権限を確認してください。",
    save: () => editorControllerRef.current?.save() ?? true,
    discard: () => editorControllerRef.current?.discard(),
    onControllerChange: onDraftNavigationControllerChange
  });

  const performLeave = useCallback((action: "close" | { kind: "surface"; surfaceId: string }): void => {
    if (action === "close") {
      onClose?.();
      return;
    }
    void openGeneratedSurface(action.surfaceId);
  }, [onClose, openGeneratedSurface]);

  const requestLeave = useCallback((action: "close" | { kind: "surface"; surfaceId: string }): void => {
    if (surfaceBusyRef.current) return;
    draftNavigation.requestNavigation(() => performLeave(action));
  }, [draftNavigation, performLeave]);

  return <section className="native-artifact-workspace" aria-label="Roomの成果物と操作画面">
    <header className="native-artifact-workspace-header">
      <div><span className="native-section-eyebrow">Room work</span><h1>成果物と操作画面</h1><p>現在のRoomで認可された版だけを確認・編集します。</p></div>
      {onClose ? <button type="button" className="native-button native-button-quiet" onClick={() => requestLeave("close")}>仕事へ戻る</button> : null}
    </header>
    <NativeDraftNavigationPrompt controller={draftNavigation} />
    {surfaceError ? <p className="native-inline-error" role="alert">{surfaceError}</p> : null}
    {surface ? <GeneratedSurfaceFrame
      detail={surface}
      bundle={surfaceBundle}
      disabled={canExecute === false}
      onLoadBundle={loadBundle}
      onRunAction={runSurfaceAction}
      onRequestApproval={requestSurfaceApproval}
      onBusyStateChange={reportSurfaceBusyState}
      approvalRecoveryNotice={surfaceApprovalNotice}
      approvalResolution={surfaceApprovalResolution}
      approvalRecoveries={surfaceApprovalRecoveries}
      {...(canEdit ? { onSetState: setSurfaceState } : {})}
      onExport={exportSurface}
      onClose={() => {
        reportSurfaceBusyState(false);
        generation.current += 1;
        setSurface(undefined);
        setSurfaceBundle(undefined);
        setSurfaceApprovalResolution(undefined);
        setSurfaceApprovalRecoveries([]);
        if (initialResource) onClose?.();
      }}
    /> : initialResource?.kind === "artifact" ? <section className="native-artifact-direct" aria-label="結果の成果物">
      {artifactLoading ? <p className="native-inline-note" role="status">成果物と版履歴を確認しています…</p> : null}
      {artifactError ? <p className="native-inline-error" role="alert">{artifactError}</p> : null}
      {artifact ? <ArtifactDetailView
        detail={artifact}
        revisions={artifactRevisions}
        comparison={artifactComparison}
        canEdit={canEdit}
        onSave={saveInitialArtifact}
        onCompare={(revisionId) => void loadArtifactComparison(revisionId)}
        onRestore={restoreInitialArtifact}
        onCloseComparison={() => setArtifactComparison(undefined)}
        workspaceTarget={stableTarget}
        onRequestAgentRevision={requestAgentRevision}
        onOpenGeneratedSurface={(surfaceId) => requestLeave({ kind: "surface", surfaceId })}
        onEditorControllerChange={registerEditorController}
      /> : !artifactLoading && !artifactError ? <p className="native-inline-note">結果の成果物を確認しています…</p> : null}
    </section> : initialResource?.kind === "generated_surface" ? <section className="native-generated-surface-direct" aria-label="結果の操作画面">
      {surfaceError ? <p className="native-inline-error" role="alert">{surfaceError}</p> : null}
      {!surfaceError ? <p className="native-inline-note" role="status">結果の操作画面を開いています…</p> : null}
    </section> : <>
      <GeneratedSurfaceList
        surfaces={surfaces}
        loading={surfaceListLoading}
        error={surfaceListError}
        supported={Boolean(bridge?.listWorkspaceGeneratedSurfaces)}
       onRefresh={() => void refreshSurfaceList()}
        onOpen={(surfaceId) => requestLeave({ kind: "surface", surfaceId })}
     />
      <ArtifactSurfacePanel
        roomId={stableTarget?.roomId}
        gateway={gateway}
        canEdit={canEdit}
        workspaceTarget={stableTarget}
        onRequestAgentRevision={requestAgentRevision}
        onOpenGeneratedSurface={(surfaceId) => void openGeneratedSurface(surfaceId)}
        onEditorControllerChange={registerEditorController}
      />
    </>}
  </section>;
}

/** Lists saved Surfaces independently of pin state, so an unpinned Surface
 * remains reopenable from the same Room without relying on a legacy Session. */
export function GeneratedSurfaceList({ surfaces, loading, error, supported, onRefresh, onOpen }: {
  surfaces: GeneratedSurfaceDefinition[];
  loading: boolean;
  error?: string;
  supported: boolean;
  onRefresh: () => void;
  onOpen: (surfaceId: string) => void;
}) {
  if (!supported) return null;
  return <section className="native-generated-surface-list" aria-label="保存済みの操作画面">
    <header><div><span className="native-section-eyebrow">Generated surfaces</span><h2>操作画面</h2><p>ピン留めしていない保存済みの画面も、このRoomから開けます。</p></div><button type="button" className="native-button native-button-quiet" disabled={loading} onClick={onRefresh}>{loading ? "再読込中…" : "再読込"}</button></header>
    {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    {loading ? <p className="native-inline-note" role="status">操作画面を確認しています…</p> : null}
    {!loading && !error && surfaces.length === 0 ? <p className="native-inline-note">このRoomには、まだ保存済みの操作画面がありません。</p> : null}
    <div className="native-generated-surface-list-items">{surfaces.map((candidate) => <article key={candidate.id} className="native-generated-surface-list-item"><div><strong>{candidate.title}</strong><span>{generatedSurfaceStateLabel(candidate.state)} · revision {candidate.current_revision}</span></div><button type="button" className="native-button native-button-quiet" onClick={() => onOpen(candidate.id)}>{candidate.state === "archived" ? "開く（読み取り専用）" : "開く"}</button></article>)}</div>
  </section>;
}

function assertRoomId(target: NativeArtifactWorkspaceTarget, roomId: string): void {
  if (roomId !== target.roomId) throw new Error("room_navigation_changed");
}

/** Sends both ordinary and confirmation-sensitive Surface actions through the fixed Room target. */
export async function runNativeGeneratedSurfaceAction(
  bridge: NativeArtifactWorkspaceBridge | undefined,
  target: NativeArtifactWorkspaceTarget | undefined,
  input: GeneratedSurfaceActionRequest,
  operationId = createIdempotencyKey()
): Promise<Record<string, unknown>> {
  if (!target || !bridge?.runWorkspaceGeneratedSurfaceAction) throw new Error("generated_surface_action_unavailable");
  return withNativeWorkspaceTarget(bridge, target, () => bridge.runWorkspaceGeneratedSurfaceAction!({
    roomId: target.roomId,
    surfaceId: input.surfaceId,
    actionId: input.actionId,
    revisionId: input.revisionId,
    actionPayload: input.payload,
    operationId,
    target
  }));
}

/**
 * Converts the Server-owned action envelope into the frame protocol's
 * completion value. Keeping this projection at the workspace boundary
 * ensures the iframe receives the authoritative result and refreshed Surface
 * snapshot from the same successful operation.
 */
export function nativeGeneratedSurfaceActionCompletion(
  response: Record<string, unknown>,
  operationId: string,
  latest: GeneratedSurfaceDetail
): GeneratedSurfaceActionCompletion {
  const result = toJsonValue(Object.hasOwn(response, "target_result") ? response.target_result : response);
  return {
    operationId,
    result,
    latest: {
      surface: toJsonValue(latest.surface),
      data: result
    }
  };
}

function byteArrayToBase64(value: number[] | undefined): string {
  if (!value || !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    throw new Error("artifact_binary_content_invalid");
  }
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalScopeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nativeArtifactWorkspaceResourceUri(kind: "artifact" | "generated_surface", value: string): boolean {
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "workspace" && scheme !== "runtime") return false;
  const path = scheme ? value.slice(scheme.length + 3) : value;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  return parts[0] === (kind === "artifact" ? "artifacts" : "surfaces");
}

function nativeArtifactWorkspaceError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : "";
  if (code.includes("workspace_navigation_changed") || code.includes("room_navigation_changed")) {
    return "WorkspaceまたはRoomの対象が切り替わりました。現在の画面を更新してください。";
  }
  if (code.includes("stale") || code.includes("revision")) {
    return "Surfaceの版が更新されています。最新の成果物から開き直してください。";
  }
  return code || "操作画面を開けませんでした。";
}

function generatedSurfaceStateLabel(state: GeneratedSurfaceDefinition["state"]): string {
  return state === "pinned" ? "ピン留め" : state === "archived" ? "保管済み" : "保存済み";
}

function surfaceApprovalNoticeForRequest(request: DesktopWorkspaceInteractionRequest): string {
  if (nativeSurfaceApprovalIsActive(request.status)) {
    return "このSurfaceには未完了の承認要求があります。Interactionから承認または拒否を完了してください。";
  }
  if (request.status === "completed") return "承認されたSurface操作が完了しました。最新の操作結果を表示しています。";
  if (request.status === "denied") return "このSurface操作は拒否されました。必要なら操作をもう一度開始してください。";
  if (request.status === "cancelled") return "このSurface操作は取り消されました。必要なら操作をもう一度開始してください。";
  if (request.status === "expired") return "このSurface操作の承認期限が切れました。必要なら操作をもう一度開始してください。";
  const failure = request.failureSummary ?? request.errorCode ?? request.execution?.errorCode;
  return failure ? `承認後のSurface操作に失敗しました: ${failure}` : "承認後のSurface操作に失敗しました。Interactionで詳細を確認してください。";
}

function surfaceApprovalResolutionMessage(status: string): string {
  if (status === "denied") return "承認されなかったため、Surface操作は実行されませんでした。";
  if (status === "cancelled") return "承認要求が取り消されたため、Surface操作は実行されませんでした。";
  if (status === "expired") return "承認期限が切れたため、Surface操作は実行されませんでした。";
  return "承認後のSurface操作を実行できませんでした。";
}

function artifactHistoryWithMutation(history: ArtifactRevisionRecord[], revision: ArtifactRevisionRecord): ArtifactRevisionRecord[] {
  return [...history.filter((candidate) => candidate.id !== revision.id), revision]
    .sort((left, right) => right.revision - left.revision);
}

export default NativeArtifactWorkspace;
