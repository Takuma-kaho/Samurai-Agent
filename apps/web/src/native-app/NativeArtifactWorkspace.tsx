import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactRevisionRecord, GeneratedSurfaceDefinition, JsonValue } from "@samurai-agent/core-schemas";
import {
  createIdempotencyKey,
  getWorkspaceClientBridge,
  type ArtifactDetail,
  type ArtifactRevisionDetail,
  type GeneratedSurfaceBundleDetail,
  type GeneratedSurfaceDetail,
  type GeneratedSurfaceExportPayload
} from "../lib/api";
import {
  ArtifactSurfacePanel,
  ArtifactDetailView,
  type ArtifactRevisionTarget,
  type ArtifactSurfaceGateway,
  type NativeArtifactDetail,
  type NativeArtifactRevisionDetail
} from "./ArtifactSurfacePanel";
import {
  GeneratedSurfaceFrame,
  type GeneratedSurfaceActionRequest
} from "./GeneratedSurfaceFrame";
import {
  nativeWorkspaceTargetKey,
  withNativeWorkspaceTarget,
  type NativeWorkspaceTargetGuardBridge
} from "./native-workspace-target";
import type { NativeArtifactWorkspaceInitialResource, NativeWorkspaceTarget } from "./types";

export interface NativeArtifactWorkspaceTarget extends NativeWorkspaceTarget {
  roomId: string;
}

/**
 * Narrow, target-scoped Desktop bridge used by the Artifact/Surface surface.
 * Keeping this separate from the App model makes it testable and prevents the
 * renderer from selecting an arbitrary Workspace after navigation changes.
 */
export interface NativeArtifactWorkspaceBridge extends NativeWorkspaceTargetGuardBridge {
  listWorkspaceArtifacts?: (input: { roomId: string }) => Promise<{ artifacts: NativeArtifactDetail["artifact"][] }>;
  getWorkspaceArtifact?: (input: { roomId: string; artifactId: string }) => Promise<ArtifactDetail>;
  listWorkspaceArtifactRevisions?: (input: { roomId: string; artifactId: string }) => Promise<ArtifactRevisionRecord[]>;
  getWorkspaceArtifactRevision?: (input: { roomId: string; artifactId: string; revisionId: string }) => Promise<ArtifactRevisionDetail>;
  reviseWorkspaceArtifact?: (input: { roomId: string; artifactId: string; content: string; baseRevisionId?: string; expectedRevision?: number; changeSummary?: string; operationId: string }) => Promise<unknown>;
  restoreWorkspaceArtifactRevision?: (input: { roomId: string; artifactId: string; revisionId: string; baseRevisionId?: string; expectedRevision?: number; changeSummary?: string; operationId: string }) => Promise<unknown>;
  listWorkspaceGeneratedSurfaces?: (input: { roomId: string }) => Promise<GeneratedSurfaceDefinition[]>;
  queryWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string }) => Promise<GeneratedSurfaceDetail>;
  getWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string }) => Promise<GeneratedSurfaceDetail>;
  getWorkspaceGeneratedSurfaceBundle?: (input: { roomId: string; surfaceId: string; revisionId: string }) => Promise<GeneratedSurfaceBundleDetail>;
  runWorkspaceGeneratedSurfaceAction?: (input: { roomId: string; surfaceId: string; actionId: string; revisionId?: string; actionPayload?: Record<string, JsonValue>; operationId: string }) => Promise<unknown>;
  runWorkspaceGeneratedSurfaceState?: (input: { roomId: string; surfaceId: string; action: "pin" | "unpin" | "archive"; operationId: string }) => Promise<unknown>;
  exportWorkspaceGeneratedSurface?: (input: { roomId: string; surfaceId: string; revisionId?: string; format: "html" | "zip" }) => Promise<GeneratedSurfaceExportPayload>;
}

export interface NativeArtifactWorkspaceProps {
  target?: NativeArtifactWorkspaceTarget;
  canEdit?: boolean;
  canExecute?: boolean;
  bridge?: NativeArtifactWorkspaceBridge;
  /** Optional result ref; when present the list is not queried before opening it. */
  initialResource?: NativeArtifactWorkspaceInitialResource;
  onClose?: () => void;
  onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void;
}

/** Room-specific key; Artifact IDs alone are intentionally never enough. */
export function nativeArtifactWorkspaceTargetKey(target?: NativeArtifactWorkspaceTarget): string {
  return target ? `${nativeWorkspaceTargetKey(target)}\n${target.roomId}` : "no-artifact-target";
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
 * content is never decoded as UTF-8, and malformed byte arrays produce an
 * explicit unavailable preview rather than a substituted document.
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
      return (await bridge.listWorkspaceArtifacts!({ roomId })).artifacts;
    }),
    get: (roomId, artifactId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return nativeArtifactDetailFromApi(await bridge.getWorkspaceArtifact!({ roomId, artifactId }));
    }),
    listRevisions: (roomId, artifactId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return bridge.listWorkspaceArtifactRevisions!({ roomId, artifactId });
    }),
    getRevision: (roomId, artifactId, revisionId) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, roomId);
      return nativeArtifactRevisionDetailFromApi(await bridge.getWorkspaceArtifactRevision!({ roomId, artifactId, revisionId }));
    }),
    revise: (input) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, input.roomId);
      await bridge.reviseWorkspaceArtifact!({
        roomId: input.roomId,
        artifactId: input.artifactId,
        content: input.content,
        baseRevisionId: input.baseRevisionId,
        expectedRevision: input.expectedRevision,
        changeSummary: input.changeSummary,
        operationId: input.operationId
      });
    }),
    restore: (input) => withNativeWorkspaceTarget(bridge, target, async () => {
      assertRoomId(target, input.roomId);
      await bridge.restoreWorkspaceArtifactRevision!({
        roomId: input.roomId,
        artifactId: input.artifactId,
        revisionId: input.revisionId,
        baseRevisionId: input.baseRevisionId,
        expectedRevision: input.expectedRevision,
        changeSummary: "Human restored a prior artifact revision.",
        operationId: input.operationId
      });
    })
  };
}

/** The React Room surface for Artifact preview/edit/history and isolated Generated Surface display. */
export function NativeArtifactWorkspace({ target, canEdit = false, canExecute = false, bridge: suppliedBridge, initialResource: initialResourceProp, onClose, onRequestAgentRevision }: NativeArtifactWorkspaceProps) {
  const bridge = suppliedBridge ?? getWorkspaceClientBridge();
  const targetKey = nativeArtifactWorkspaceTargetKey(target);
  const initialResource = useMemo(() => nativeArtifactWorkspaceInitialResourceFromUnknown(initialResourceProp, target), [initialResourceProp, targetKey]);
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
  const [surfaces, setSurfaces] = useState<GeneratedSurfaceDefinition[]>([]);
  const [surfaceListLoading, setSurfaceListLoading] = useState(false);
  const [surfaceListError, setSurfaceListError] = useState<string>();
  const [artifact, setArtifact] = useState<NativeArtifactDetail>();
  const [artifactRevisions, setArtifactRevisions] = useState<ArtifactRevisionRecord[]>([]);
  const [artifactComparison, setArtifactComparison] = useState<NativeArtifactRevisionDetail>();
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string>();
  const gateway = useMemo(() => nativeArtifactWorkspaceGateway(bridge, target), [bridge, target]);

  useEffect(() => {
    generation.current += 1;
    surfaceListEpoch.current += 1;
    artifactEpoch.current += 1;
    setSurface(undefined);
    setSurfaceBundle(undefined);
    setSurfaceError(undefined);
    setSurfaces([]);
    setSurfaceListLoading(false);
    setSurfaceListError(undefined);
    setArtifact(undefined);
    setArtifactRevisions([]);
    setArtifactComparison(undefined);
    setArtifactLoading(false);
    setArtifactError(undefined);
  }, [initialResourceKey, targetKey]);

  const refreshSurfaceList = useCallback(async (): Promise<void> => {
    if (!target || !bridge?.listWorkspaceGeneratedSurfaces) return;
    const requestEpoch = ++surfaceListEpoch.current;
    setSurfaceListLoading(true);
    setSurfaceListError(undefined);
    try {
      const listed = await withNativeWorkspaceTarget(bridge, target, () => bridge.listWorkspaceGeneratedSurfaces!({ roomId: target.roomId }));
      if (requestEpoch !== surfaceListEpoch.current) return;
      setSurfaces(listed);
    } catch (cause) {
      if (requestEpoch === surfaceListEpoch.current) setSurfaceListError(nativeArtifactWorkspaceError(cause));
    } finally {
      if (requestEpoch === surfaceListEpoch.current) setSurfaceListLoading(false);
    }
  }, [bridge, target]);

  const openGeneratedSurface = useCallback(async (surfaceId: string, revisionId?: string): Promise<void> => {
    if (!target || !bridge) return;
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
    try {
      const detail = await withNativeWorkspaceTarget(bridge, target, () => query({ roomId: target.roomId, surfaceId }));
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
          nextBundle = await withNativeWorkspaceTarget(bridge, target, async () => {
            const bundle = await bridge.getWorkspaceGeneratedSurfaceBundle!({ roomId: target.roomId, surfaceId, revisionId });
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
  }, [bridge, target]);

  const openInitialArtifact = useCallback(async (resource: NativeArtifactWorkspaceInitialResource): Promise<void> => {
    if (!target || !gateway) {
      setArtifactError("成果物を開くための既存bridgeが利用できません。");
      return;
    }
    const requestEpoch = ++artifactEpoch.current;
    generation.current += 1;
    setSurface(undefined);
    setSurfaceBundle(undefined);
    setSurfaceError(undefined);
    setArtifactLoading(true);
    setArtifactError(undefined);
    setArtifactComparison(undefined);
    try {
      const [detail, history] = await Promise.all([
        gateway.get(target.roomId, resource.id),
        gateway.listRevisions(target.roomId, resource.id)
      ]);
      if (requestEpoch !== artifactEpoch.current || detail.artifact.id !== resource.id) throw new Error("artifact_response_mismatch");
      let nextDetail = detail;
      if (resource.revisionId) {
        const revision = await gateway.getRevision(target.roomId, resource.id, resource.revisionId);
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
  }, [gateway, target]);

  const loadArtifactComparison = useCallback(async (revisionId: string): Promise<void> => {
    if (!target || !gateway || !artifact) return;
    const requestEpoch = ++artifactEpoch.current;
    setArtifactLoading(true);
    setArtifactError(undefined);
    try {
      const revision = await gateway.getRevision(target.roomId, artifact.artifact.id, revisionId);
      if (requestEpoch !== artifactEpoch.current || revision.revision.artifact_id !== artifact.artifact.id) throw new Error("artifact_revision_response_mismatch");
      setArtifactComparison(revision);
    } catch (cause) {
      if (requestEpoch === artifactEpoch.current) setArtifactError(nativeArtifactWorkspaceError(cause));
    } finally {
      if (requestEpoch === artifactEpoch.current) setArtifactLoading(false);
    }
  }, [artifact, gateway, target]);

  const saveInitialArtifact = useCallback(async (content: string, baseRevisionId: string, expectedRevision: number, changeSummary: string): Promise<void> => {
    if (!target || !gateway || !artifact) throw new Error("artifact_save_unavailable");
    await gateway.revise({ roomId: target.roomId, artifactId: artifact.artifact.id, content, baseRevisionId, expectedRevision, changeSummary, operationId: createIdempotencyKey() });
    if (initialResource?.kind === "artifact") await openInitialArtifact(initialResource);
  }, [artifact, gateway, initialResource, openInitialArtifact, target]);

  const restoreInitialArtifact = useCallback(async (): Promise<void> => {
    if (!target || !gateway || !artifact || !artifactComparison) return;
    const current = [...artifactRevisions].sort((left, right) => right.revision - left.revision)[0] ?? artifact.revision;
    if (!current) {
      setArtifactError("現在の版を確認できないため、復元できません。");
      return;
    }
    setArtifactLoading(true);
    setArtifactError(undefined);
    try {
      await gateway.restore({ roomId: target.roomId, artifactId: artifact.artifact.id, revisionId: artifactComparison.revision.id, baseRevisionId: current.id, expectedRevision: current.revision, operationId: createIdempotencyKey() });
      setArtifactComparison(undefined);
      if (initialResource?.kind === "artifact") await openInitialArtifact(initialResource);
    } catch (cause) {
      setArtifactError(nativeArtifactWorkspaceError(cause));
    } finally {
      setArtifactLoading(false);
    }
  }, [artifact, artifactComparison, artifactRevisions, gateway, initialResource, openInitialArtifact, target]);

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
    if (!target || !bridge?.getWorkspaceGeneratedSurfaceBundle) throw new Error("generated_surface_bundle_unavailable");
    return withNativeWorkspaceTarget(bridge, target, async () => {
      const bundle = await bridge.getWorkspaceGeneratedSurfaceBundle!({ roomId: target.roomId, surfaceId: input.surfaceId, revisionId: input.revisionId });
      if (bundle.surface.id !== input.surfaceId || bundle.revision.id !== input.revisionId) throw new Error("generated_surface_bundle_mismatch");
      return bundle;
    });
  }, [bridge, target]);

  const runSurfaceAction = useCallback(async (input: GeneratedSurfaceActionRequest): Promise<void> => {
    await runNativeGeneratedSurfaceAction(bridge, target, input);
  }, [bridge, target]);

  const requestSurfaceApproval = useCallback(async (input: GeneratedSurfaceActionRequest): Promise<void> => {
    if (!target) throw new Error("generated_surface_action_unavailable");
    const capturedTarget = target;
    const response = await runNativeGeneratedSurfaceAction(bridge, capturedTarget, input);
    assertNativeGeneratedSurfaceApprovalResponse(response, capturedTarget, input);
  }, [bridge, target]);

  const setSurfaceState = useCallback(async (input: { surfaceId: string; action: "pin" | "unpin" | "archive" }): Promise<void> => {
    if (!target || !bridge?.runWorkspaceGeneratedSurfaceState) throw new Error("generated_surface_state_unavailable");
    await withNativeWorkspaceTarget(bridge, target, () => bridge.runWorkspaceGeneratedSurfaceState!({
      roomId: target.roomId,
      surfaceId: input.surfaceId,
      action: input.action,
      operationId: createIdempotencyKey()
    }));
    setSurfaces((previous) => previous.map((candidate) => candidate.id === input.surfaceId
      ? { ...candidate, state: input.action === "pin" ? "pinned" : input.action === "unpin" ? "ephemeral" : "archived" }
      : candidate));
  }, [bridge, target]);

  const exportSurface = useCallback(async (input: { surfaceId: string; revisionId: string; format: "html" | "zip" }): Promise<GeneratedSurfaceExportPayload> => {
    if (!target || !bridge?.exportWorkspaceGeneratedSurface) throw new Error("generated_surface_export_unavailable");
    return withNativeWorkspaceTarget(bridge, target, () => bridge.exportWorkspaceGeneratedSurface!({
      roomId: target.roomId,
      surfaceId: input.surfaceId,
      revisionId: input.revisionId,
      format: input.format
    }));
  }, [bridge, target]);

  return <section className="native-artifact-workspace" aria-label="Roomの成果物と操作画面">
    <header className="native-artifact-workspace-header">
      <div><span className="native-section-eyebrow">Room work</span><h1>成果物と操作画面</h1><p>現在のRoomで認可された版だけを確認・編集します。</p></div>
      {onClose ? <button type="button" className="native-button native-button-quiet" onClick={onClose}>仕事へ戻る</button> : null}
    </header>
    {surfaceError ? <p className="native-inline-error" role="alert">{surfaceError}</p> : null}
    {surface ? <GeneratedSurfaceFrame
      detail={surface}
      bundle={surfaceBundle}
      disabled={canExecute === false}
      onLoadBundle={loadBundle}
      onRunAction={runSurfaceAction}
      onRequestApproval={requestSurfaceApproval}
      {...(canEdit ? { onSetState: setSurfaceState } : {})}
      onExport={exportSurface}
      onClose={() => {
        generation.current += 1;
        setSurface(undefined);
        setSurfaceBundle(undefined);
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
        onRestore={() => void restoreInitialArtifact()}
        onCloseComparison={() => setArtifactComparison(undefined)}
        onRequestAgentRevision={onRequestAgentRevision}
        onOpenGeneratedSurface={(surfaceId) => void openGeneratedSurface(surfaceId)}
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
        onOpen={(surfaceId) => void openGeneratedSurface(surfaceId)}
      />
      <ArtifactSurfacePanel
        roomId={target?.roomId}
        gateway={gateway}
        canEdit={canEdit}
        onRequestAgentRevision={onRequestAgentRevision}
        onOpenGeneratedSurface={(surfaceId) => void openGeneratedSurface(surfaceId)}
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
    <div className="native-generated-surface-list-items">{surfaces.map((candidate) => <article key={candidate.id} className="native-generated-surface-list-item"><div><strong>{candidate.title}</strong><span>{generatedSurfaceStateLabel(candidate.state)} · revision {candidate.current_revision}</span></div><button type="button" className="native-button native-button-quiet" disabled={candidate.state === "archived"} onClick={() => onOpen(candidate.id)}>{candidate.state === "archived" ? "保管済み" : "開く"}</button></article>)}</div>
  </section>;
}

function assertRoomId(target: NativeArtifactWorkspaceTarget, roomId: string): void {
  if (roomId !== target.roomId) throw new Error("room_navigation_changed");
}

/** Sends both ordinary and confirmation-sensitive Surface actions through the fixed Room target. */
export async function runNativeGeneratedSurfaceAction(
  bridge: NativeArtifactWorkspaceBridge | undefined,
  target: NativeArtifactWorkspaceTarget | undefined,
  input: GeneratedSurfaceActionRequest
): Promise<unknown> {
  if (!target || !bridge?.runWorkspaceGeneratedSurfaceAction) throw new Error("generated_surface_action_unavailable");
  return withNativeWorkspaceTarget(bridge, target, () => bridge.runWorkspaceGeneratedSurfaceAction!({
    roomId: target.roomId,
    surfaceId: input.surfaceId,
    actionId: input.actionId,
    revisionId: input.revisionId,
    actionPayload: input.payload,
    operationId: createIdempotencyKey()
  }));
}

/** Accepts only the Server's durable approval-request envelope, never an ordinary action result. */
export function assertNativeGeneratedSurfaceApprovalResponse(
  value: unknown,
  target: NativeArtifactWorkspaceTarget,
  input: GeneratedSurfaceActionRequest
): void {
  if (!isRecord(value) || value.status !== "approval_required") {
    throw new Error("generated_surface_approval_response_invalid");
  }
  const request = value.request;
  if (!isRecord(request)
    || typeof request.id !== "string" || request.id.length === 0
    || request.workspaceId !== target.workspaceId
    || request.roomId !== target.roomId
    || request.kind !== "approval"
    || request.status !== "pending"
    || request.surfaceId !== input.surfaceId
    || request.revisionId !== input.revisionId) {
    throw new Error("generated_surface_approval_request_invalid");
  }
}

function byteArrayToBase64(value: number[] | undefined): string {
  if (!value || !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) return "";
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

export default NativeArtifactWorkspace;
