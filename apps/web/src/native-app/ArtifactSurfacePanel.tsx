import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactRecord, ArtifactRevisionRecord, JsonValue } from "@samurai-agent/core-schemas";
import { createIdempotencyKey, type ArtifactMutationResult } from "../lib/api";
import { artifactContentType, isImageArtifact, isPdfArtifact, markdownPreviewHtml } from "../lib/surface-view-helpers";
import type { NativeWorkspaceTarget } from "./types";
import { useNativeDraftNavigation } from "./use-native-draft-navigation";
import { NativeDraftNavigationPrompt } from "./NativeDraftNavigationPrompt";

export interface NativeArtifactDetail {
  artifact: ArtifactRecord;
  /** UTF-8 text, or base64 for a binary Artifact. */
  content: string;
  contentEncoding?: "utf8" | "base64";
  contentType?: string;
  fileName?: string;
  revision?: ArtifactRevisionRecord;
}

export interface NativeArtifactRevisionDetail {
  revision: ArtifactRevisionRecord;
  content: string;
  contentEncoding?: "utf8" | "base64";
  contentType?: string;
}

export interface ArtifactSurfaceGateway {
  list(roomId: string): Promise<ArtifactRecord[]>;
  get(roomId: string, artifactId: string): Promise<NativeArtifactDetail>;
  listRevisions(roomId: string, artifactId: string): Promise<ArtifactRevisionRecord[]>;
  getRevision(roomId: string, artifactId: string, revisionId: string): Promise<NativeArtifactRevisionDetail>;
  revise(input: ArtifactSaveRequest & { roomId: string }): Promise<ArtifactMutationResult>;
  restore(input: ArtifactRestoreRequest & { roomId: string }): Promise<ArtifactMutationResult>;
}

export interface ArtifactSaveRequest {
  artifactId: string;
  content: string;
  baseRevisionId: string;
  expectedRevision: number;
  changeSummary: string;
  operationId: string;
}

export interface ArtifactRestoreRequest {
  artifactId: string;
  revisionId: string;
  baseRevisionId: string;
  expectedRevision: number;
  operationId: string;
}

export interface NativeArtifactEditorController {
  artifactId: string;
  dirty: boolean;
  saving: boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

export interface ArtifactEditorStatusChange {
  artifactId: string;
  dirty: boolean;
  saving: boolean;
}

export interface ArtifactRevisionTarget {
  artifact: ArtifactRecord;
  revisionId?: string;
  /** Renderer-only scope captured at request start; never sent to the Server as authority. */
  workspaceTarget?: NativeWorkspaceTarget & { roomId?: string };
  /** Server-recorded origin Work, when this Artifact came from Room Work. */
  sourceWorkId?: string;
  location?: { kind: "text"; start: number; end: number; text: string } | { kind: "table_cell"; rowId: string; columnId: string; value: JsonValue };
  request: string;
}

export type ArtifactRevisionRequestHandler = (
  target: ArtifactRevisionTarget
) => boolean | void | Promise<boolean | void>;

/**
 * Normalizes the Room Work hand-off contract for every Artifact kind. A host
 * may reject navigation with false or throw a typed error; either outcome is
 * a failed request and must leave the local request text intact.
 */
export async function invokeArtifactRevisionRequest(
  handler: ArtifactRevisionRequestHandler | undefined,
  target: ArtifactRevisionTarget
): Promise<void> {
  if (!handler) throw new Error("artifact_revision_request_unavailable");
  const accepted = await handler(target);
  if (accepted === false) throw new Error("artifact_revision_request_cancelled");
}

export interface ArtifactSurfacePanelProps {
  roomId?: string;
  gateway?: ArtifactSurfaceGateway;
  canEdit?: boolean;
  /** Captured Renderer navigation scope for Agent revision hand-offs. */
  workspaceTarget?: NativeWorkspaceTarget;
  /** Leaves sending to the existing Room Work path; this component never invents a Session. */
  onRequestAgentRevision?: ArtifactRevisionRequestHandler;
  onOpenGeneratedSurface?: (surfaceId: string) => void;
  onClose?: () => void;
  onEditorControllerChange?: (controller: NativeArtifactEditorController | undefined) => void;
}

/** Keeps a failed retry on the same logical payload and therefore the same operation ID. */
export function operationForArtifactSnapshot(
  previous: { operationId: string; snapshot: string } | undefined,
  snapshot: string
): { operationId: string; snapshot: string } {
  if (previous?.snapshot === snapshot) return previous;
  return { operationId: createIdempotencyKey(), snapshot };
}

export function artifactRestoreOperationSnapshot(input: Pick<ArtifactRestoreRequest, "artifactId" | "revisionId" | "baseRevisionId" | "expectedRevision">): string {
  return JSON.stringify([input.artifactId, input.revisionId, input.baseRevisionId, input.expectedRevision]);
}

/** Rejects a response that belongs to a previous Artifact selection or request generation. */
export function artifactRequestIsCurrent(input: {
  requestEpoch: number;
  currentEpoch: number;
  artifactId: string;
  currentArtifactId: string | undefined;
}): boolean {
  return input.requestEpoch === input.currentEpoch && input.artifactId === input.currentArtifactId;
}

const maximumBinaryPreviewBytes = 12 * 1024 * 1024;

/** Validates the Server-owned revision before it is allowed into the editor. */
export function assertArtifactMutationResult(value: ArtifactMutationResult, artifactId: string): ArtifactMutationResult {
  if (!value || !value.artifact || value.artifact.id !== artifactId || !value.revision || value.revision.artifact_id !== artifactId) {
    throw new Error("artifact_mutation_response_mismatch");
  }
  return value;
}

/** Combines the mutation's new revision with the exact revision detail read from the Server. */
export function nativeArtifactDetailFromMutation(
  mutation: ArtifactMutationResult,
  revisionDetail: NativeArtifactRevisionDetail
): NativeArtifactDetail {
  if (!mutation?.artifact) throw new Error("artifact_mutation_response_mismatch");
  assertArtifactMutationResult(mutation, mutation.artifact.id);
  if (revisionDetail.revision.id !== mutation.revision?.id || revisionDetail.revision.artifact_id !== mutation.artifact.id) {
    throw new Error("artifact_mutation_revision_mismatch");
  }
  return {
    artifact: mutation.artifact,
    content: revisionDetail.content,
    ...(revisionDetail.contentEncoding ? { contentEncoding: revisionDetail.contentEncoding } : {}),
    ...(revisionDetail.contentType ? { contentType: revisionDetail.contentType } : {}),
    revision: mutation.revision
  };
}

type ArtifactPanelNavigation =
  | { kind: "artifact"; artifactId: string }
  | { kind: "surface"; surfaceId: string }
  | { kind: "close" };

/**
 * Room-scoped Artifact browser and editor. All reads and writes go through a
 * fixed gateway supplied by the active connection; this component contains no
 * cache keyed only by Artifact ID.
 */
export function ArtifactSurfacePanel({ roomId, gateway, canEdit = false, workspaceTarget, onRequestAgentRevision, onOpenGeneratedSurface, onClose, onEditorControllerChange }: ArtifactSurfacePanelProps) {
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const selectedArtifactIdRef = useRef<string | undefined>(undefined);
  const editorControllerRef = useRef<NativeArtifactEditorController | undefined>(undefined);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState<NativeArtifactDetail>();
  const [revisions, setRevisions] = useState<ArtifactRevisionRecord[]>([]);
  const [comparison, setComparison] = useState<NativeArtifactRevisionDetail>();
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [editorController, setEditorController] = useState<NativeArtifactEditorController>();

  selectedArtifactIdRef.current = selected?.artifact.id;

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

  const unavailable = !roomId || !gateway;
  const draftNavigation = useNativeDraftNavigation({
    scopeKey: "artifact-panel\n" + (workspaceTarget?.connectionId ?? "") + "\n" + (workspaceTarget?.workspaceId ?? "") + "\n" + (roomId ?? ""),
    label: "成果物",
    dirty: editorController?.dirty === true,
    saving: editorController?.saving === true,
    canSave: canEdit,
    saveUnavailableMessage: "このRoomでは成果物を保存できません。破棄するか、編集権限を確認してください。",
    save: () => editorControllerRef.current?.save() ?? false,
    discard: () => editorControllerRef.current?.discard()
  });

  const refresh = async (): Promise<void> => {
    if (!roomId || !gateway) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await gateway.list(roomId);
      if (epoch !== listEpoch.current) return;
      setArtifacts(next);
      const selectedArtifactId = selectedArtifactIdRef.current;
      if (selectedArtifactId && !next.some((artifact) => artifact.id === selectedArtifactId)) {
        if (editorControllerRef.current?.dirty || editorControllerRef.current?.saving) {
          setError("Server上でこの成果物の一覧上の参照が変わりました。下書きは保持しています。保存結果を確認してから移動してください。");
        } else {
          setSelected(undefined);
          setRevisions([]);
          setComparison(undefined);
        }
      }
    } catch (cause) {
      if (epoch === listEpoch.current) setError(errorMessage(cause, "成果物一覧を読み込めませんでした。"));
    } finally {
      if (epoch === listEpoch.current) setLoading(false);
    }
  };

  useEffect(() => {
    setArtifacts([]);
    setSelected(undefined);
    setRevisions([]);
    setComparison(undefined);
    void refresh();
    return () => { listEpoch.current += 1; detailEpoch.current += 1; };
  // A new connection/Room must discard old, authorized-but-wrong results.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, gateway]);

  const loadArtifact = async (artifactId: string): Promise<void> => {
    if (!roomId || !gateway) return;
    const epoch = ++detailEpoch.current;
    if (selectedArtifactIdRef.current !== artifactId) {
      // Remove the old editor before the asynchronous read begins. This keeps
      // a user from typing into A while B is loading and then losing A input
      // when B's response commits.
      setSelected(undefined);
      setRevisions([]);
      setComparison(undefined);
    }
    setDetailLoading(true);
    setError(undefined);
    setComparison(undefined);
    try {
      const [detail, history] = await Promise.all([
        gateway.get(roomId, artifactId),
        gateway.listRevisions(roomId, artifactId)
      ]);
      if (epoch !== detailEpoch.current || detail.artifact.id !== artifactId) return;
      setSelected(detail);
      setRevisions([...history].sort((left, right) => right.revision - left.revision));
    } catch (cause) {
      if (epoch === detailEpoch.current) setError(errorMessage(cause, "成果物を開けませんでした。"));
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  };

  const proceedArtifactNavigation = (navigation: ArtifactPanelNavigation): void => {
    if (navigation.kind === "artifact") {
      void loadArtifact(navigation.artifactId);
    } else if (navigation.kind === "surface") {
      onOpenGeneratedSurface?.(navigation.surfaceId);
    } else {
      onClose?.();
    }
  };

  const requestArtifactNavigation = (navigation: ArtifactPanelNavigation): void => {
    draftNavigation.requestNavigation(() => proceedArtifactNavigation(navigation));
  };

  const loadComparison = async (revisionId: string): Promise<void> => {
    if (!roomId || !gateway || !selected) return;
    const artifactId = selected.artifact.id;
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setError(undefined);
    try {
      const revision = await gateway.getRevision(roomId, artifactId, revisionId);
      if (!artifactRequestIsCurrent({ requestEpoch: epoch, currentEpoch: detailEpoch.current, artifactId, currentArtifactId: selectedArtifactIdRef.current }) || revision.revision.artifact_id !== artifactId) return;
      setComparison(revision);
    } catch (cause) {
      if (epoch === detailEpoch.current && selectedArtifactIdRef.current === artifactId) setError(errorMessage(cause, "指定した版を開けませんでした。"));
    } finally {
      if (epoch === detailEpoch.current && selectedArtifactIdRef.current === artifactId) setDetailLoading(false);
    }
  };

  const save = async (input: ArtifactSaveRequest): Promise<ArtifactMutationResult> => {
    if (!roomId || !gateway || !selected) throw new Error("artifact_save_unavailable");
    if (selectedArtifactIdRef.current !== input.artifactId) throw new Error("artifact_navigation_changed");
    const epoch = ++detailEpoch.current;
    setDetailLoading(false);
    const mutation = assertArtifactMutationResult(await gateway.revise({ roomId, ...input }), input.artifactId);
    const revision = mutation.revision;
    if (!revision) throw new Error("artifact_mutation_revision_missing");
    const [revisionDetail, history] = await Promise.all([
      gateway.getRevision(roomId, input.artifactId, revision.id),
      gateway.listRevisions(roomId, input.artifactId)
    ]);
    if (!artifactRequestIsCurrent({ requestEpoch: epoch, currentEpoch: detailEpoch.current, artifactId: input.artifactId, currentArtifactId: selectedArtifactIdRef.current })) throw new Error("artifact_navigation_changed");
    setSelected(nativeArtifactDetailFromMutation(mutation, revisionDetail));
    setRevisions(addMutationRevision(history, revision));
    setComparison(undefined);
    await refresh();
    if (!artifactRequestIsCurrent({ requestEpoch: epoch, currentEpoch: detailEpoch.current, artifactId: input.artifactId, currentArtifactId: selectedArtifactIdRef.current })) throw new Error("artifact_navigation_changed");
    return mutation;
  };

  const restore = async (input: ArtifactRestoreRequest): Promise<ArtifactMutationResult> => {
    if (!roomId || !gateway || !selected || selectedArtifactIdRef.current !== input.artifactId) throw new Error("artifact_restore_unavailable");
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setError(undefined);
    try {
      const mutation = assertArtifactMutationResult(await gateway.restore({ roomId, ...input }), input.artifactId);
      const revision = mutation.revision;
      if (!revision) throw new Error("artifact_mutation_revision_missing");
      const [revisionDetail, history] = await Promise.all([
        gateway.getRevision(roomId, input.artifactId, revision.id),
        gateway.listRevisions(roomId, input.artifactId)
      ]);
      if (!artifactRequestIsCurrent({ requestEpoch: epoch, currentEpoch: detailEpoch.current, artifactId: input.artifactId, currentArtifactId: selectedArtifactIdRef.current })) throw new Error("artifact_navigation_changed");
      setSelected(nativeArtifactDetailFromMutation(mutation, revisionDetail));
      setRevisions(addMutationRevision(history, revision));
      setComparison(undefined);
      await refresh();
      if (!artifactRequestIsCurrent({ requestEpoch: epoch, currentEpoch: detailEpoch.current, artifactId: input.artifactId, currentArtifactId: selectedArtifactIdRef.current })) throw new Error("artifact_navigation_changed");
      return mutation;
    } catch (cause) {
      if (epoch === detailEpoch.current && selectedArtifactIdRef.current === input.artifactId) setError(errorMessage(cause, "復元できませんでした。別の更新がある場合は最新版を確認してください。"));
      throw cause;
    } finally {
      if (epoch === detailEpoch.current && selectedArtifactIdRef.current === input.artifactId) setDetailLoading(false);
    }
  };

  return <section className="native-artifact-surface" aria-label="Roomの成果物">
    <header className="native-artifact-surface-header">
      <div><span className="native-section-eyebrow">Artifacts</span><h2>成果物</h2><p>このRoomで認可された文書・表・画像・PDF・操作画面を確認します。</p></div>
      <div className="native-artifact-surface-header-actions"><button type="button" className="native-button native-button-quiet" onClick={() => void refresh()} disabled={unavailable || loading}>{loading ? "再読込中…" : "再読込"}</button>{onClose ? <button type="button" className="native-button native-button-quiet" onClick={() => requestArtifactNavigation({ kind: "close" })}>閉じる</button> : null}</div>
    </header>
    {unavailable ? <p className="native-inline-note">Roomを選択すると、認可された成果物を表示します。</p> : null}
    {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    {loading ? <p className="native-inline-note" role="status">成果物を確認しています…</p> : null}
    {!loading && !unavailable && artifacts.length === 0 ? <p className="native-inline-note">このRoomには、まだ確認できる成果物がありません。</p> : null}
    <NativeDraftNavigationPrompt controller={draftNavigation} />
    <div className="native-artifact-layout">
      <nav className="native-artifact-list" aria-label="成果物一覧">{artifacts.map((artifact) => <button key={artifact.id} type="button" className={`native-artifact-list-item${selected?.artifact.id === artifact.id ? " is-active" : ""}`} onClick={() => requestArtifactNavigation({ kind: "artifact", artifactId: artifact.id })} aria-pressed={selected?.artifact.id === artifact.id}>
        <strong>{artifact.title}</strong><span>{artifactKindLabel(artifact)} · {formatUpdatedAt(artifact.updated_at)}</span>
      </button>)}</nav>
      <div className="native-artifact-detail" aria-live="polite">
        {detailLoading ? <p className="native-inline-note" role="status">成果物と版履歴を確認しています…</p> : null}
        {selected ? <ArtifactDetailView
          detail={selected}
          revisions={revisions}
          comparison={comparison}
          canEdit={canEdit}
          onSave={save}
          onCompare={(revisionId) => void loadComparison(revisionId)}
          onRestore={restore}
          onCloseComparison={() => setComparison(undefined)}
          onRequestAgentRevision={onRequestAgentRevision}
          workspaceTarget={workspaceTarget}
          onOpenGeneratedSurface={(surfaceId) => requestArtifactNavigation({ kind: "surface", surfaceId })}
          onEditorControllerChange={registerEditorController}
        /> : !detailLoading && artifacts.length > 0 ? <p className="native-inline-note">成果物を選択すると内容と版履歴を開きます。</p> : null}
      </div>
    </div>
  </section>;
}


interface ArtifactDetailViewProps {
  detail: NativeArtifactDetail;
  revisions: ArtifactRevisionRecord[];
  comparison?: NativeArtifactRevisionDetail;
  canEdit: boolean;
  workspaceTarget?: NativeWorkspaceTarget;
  onSave: (input: ArtifactSaveRequest) => Promise<ArtifactMutationResult>;
  onCompare: (revisionId: string) => void;
  onRestore: (input: ArtifactRestoreRequest) => Promise<ArtifactMutationResult>;
  onCloseComparison: () => void;
  onRequestAgentRevision?: ArtifactRevisionRequestHandler;
  onOpenGeneratedSurface?: (surfaceId: string) => void;
  onEditorControllerChange?: (controller: NativeArtifactEditorController | undefined) => void;
}

export function ArtifactDetailView({ detail, revisions, comparison, canEdit, workspaceTarget, onSave, onCompare, onRestore, onCloseComparison, onRequestAgentRevision, onOpenGeneratedSurface, onEditorControllerChange }: ArtifactDetailViewProps) {
  const current = artifactCurrentRevision(detail, revisions);
  const surfaceId = metadataText(detail.artifact, "generated_surface_id");
  const isBinary = binaryArtifact(detail);
  const [downloadError, setDownloadError] = useState<string>();
  const download = () => {
    try {
      downloadArtifact(detail);
      setDownloadError(undefined);
    } catch (cause) {
      setDownloadError(errorMessage(cause, "成果物の実byteを読み込めないため、ダウンロードできません。"));
    }
  };
  return <article className="native-artifact-card">
    <header className="native-artifact-card-header"><div><span className="native-section-eyebrow">{artifactKindLabel(detail.artifact)}</span><h3>{detail.artifact.title}</h3><p>{current ? `現在版 revision ${current.revision}` : "版情報を確認できません"}</p></div><button type="button" className="native-button native-button-quiet" onClick={download}>ダウンロード</button></header>
    {downloadError ? <p className="native-inline-error" role="alert">{downloadError}</p> : null}
    {surfaceId && onOpenGeneratedSurface ? <button type="button" className="native-button native-button-quiet" onClick={() => onOpenGeneratedSurface(surfaceId)}>操作画面を開く</button> : null}
    <ArtifactBody detail={detail} current={current} canEdit={canEdit && !isBinary} workspaceTarget={workspaceTarget} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} onEditorControllerChange={onEditorControllerChange} />
    <RevisionHistory artifactId={detail.artifact.id} currentRevision={current} revisions={revisions} currentContent={detail.content} comparison={comparison} onCompare={onCompare} onRestore={onRestore} onCloseComparison={onCloseComparison} />
  </article>;
}

function ArtifactBody({ detail, current, canEdit, workspaceTarget, onSave, onRequestAgentRevision, onEditorControllerChange }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; workspaceTarget?: NativeWorkspaceTarget; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: ArtifactRevisionRequestHandler; onEditorControllerChange?: ArtifactDetailViewProps["onEditorControllerChange"] }) {
  if (isPdfArtifact(detail.artifact) || isImageArtifact(detail.artifact)) return <BinaryArtifactView detail={detail} current={current} workspaceTarget={workspaceTarget} onRequestAgentRevision={onRequestAgentRevision} onEditorControllerChange={onEditorControllerChange} />;
  if (detail.artifact.kind === "table") return <TableArtifactEditor detail={detail} current={current} canEdit={canEdit} workspaceTarget={workspaceTarget} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} onEditorControllerChange={onEditorControllerChange} />;
  if (detail.artifact.kind === "chart") return <ChartArtifactView detail={detail} />;
  return <TextArtifactEditor detail={detail} current={current} canEdit={canEdit} workspaceTarget={workspaceTarget} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} onEditorControllerChange={onEditorControllerChange} />;
}

function TextArtifactEditor({ detail, current, canEdit, workspaceTarget, onSave, onRequestAgentRevision, onEditorControllerChange }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; workspaceTarget?: NativeWorkspaceTarget; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: ArtifactRevisionRequestHandler; onEditorControllerChange?: ArtifactDetailViewProps["onEditorControllerChange"] }) {
  const [editorArtifactId, setEditorArtifactId] = useState(detail.artifact.id);
  const [draft, setDraft] = useState(detail.content);
  const [baseRevisionId, setBaseRevisionId] = useState(current?.id);
  const [baseRevisionNumber, setBaseRevisionNumber] = useState(current?.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [selection, setSelection] = useState<{ start: number; end: number; text: string }>();
  const [request, setRequest] = useState("");
  const [stale, setStale] = useState(false);
  const saveOperationRef = useRef<{ operationId: string; snapshot: string } | undefined>(undefined);
  const draftRef = useRef(draft);
  const baseRevisionIdRef = useRef(baseRevisionId);
  const baseRevisionNumberRef = useRef(baseRevisionNumber);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(saving);
  const requestRef = useRef(request);
  const selectionRef = useRef(selection);
  const editorArtifactIdRef = useRef(editorArtifactId);
  draftRef.current = draft;
  baseRevisionIdRef.current = baseRevisionId;
  baseRevisionNumberRef.current = baseRevisionNumber;
  dirtyRef.current = dirty;
  savingRef.current = saving;
  requestRef.current = request;
  selectionRef.current = selection;
  editorArtifactIdRef.current = editorArtifactId;

  useEffect(() => {
    if (editorArtifactId !== detail.artifact.id) {
      editorArtifactIdRef.current = detail.artifact.id;
      draftRef.current = detail.content;
      baseRevisionIdRef.current = current?.id;
      baseRevisionNumberRef.current = current?.revision;
      dirtyRef.current = false;
      savingRef.current = false;
      requestRef.current = "";
      setEditorArtifactId(detail.artifact.id);
      setDraft(detail.content);
      setBaseRevisionId(current?.id);
      setBaseRevisionNumber(current?.revision);
      setDirty(false);
      setSaving(false);
      setSaveError(undefined);
      setSelection(undefined);
      setRequest("");
      setStale(false);
      saveOperationRef.current = undefined;
      return;
    }
    if (!dirty) {
      draftRef.current = detail.content;
      baseRevisionIdRef.current = current?.id;
      baseRevisionNumberRef.current = current?.revision;
      if (draft !== detail.content) setDraft(detail.content);
      if (baseRevisionId !== current?.id) setBaseRevisionId(current?.id);
      if (baseRevisionNumber !== current?.revision) setBaseRevisionNumber(current?.revision);
      setStale(false);
      saveOperationRef.current = undefined;
    } else if (current?.id && current.id !== baseRevisionId) {
      setStale(true);
    }
  }, [baseRevisionId, baseRevisionNumber, current?.id, current?.revision, detail.artifact.id, detail.content, dirty, draft, editorArtifactId]);

  const saveContent = useCallback(async (): Promise<boolean> => {
    const artifactId = detail.artifact.id;
    const submittedDraft = draftRef.current;
    const submittedBaseRevisionId = baseRevisionIdRef.current;
    const submittedBaseRevisionNumber = baseRevisionNumberRef.current;
    if (editorArtifactIdRef.current !== artifactId || !submittedBaseRevisionId || submittedBaseRevisionNumber === undefined) return false;
    if (!dirtyRef.current) return true;
    if (savingRef.current) return false;
    const operation = operationForArtifactSnapshot(saveOperationRef.current, submittedDraft);
    saveOperationRef.current = operation;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const mutation = await onSave({ artifactId, content: submittedDraft, baseRevisionId: submittedBaseRevisionId, expectedRevision: submittedBaseRevisionNumber, changeSummary: "Human edited document content.", operationId: operation.operationId });
      const nextRevision = mutation.revision;
      if (!nextRevision) throw new Error("artifact_mutation_revision_missing");
      if (editorArtifactIdRef.current === artifactId) {
        baseRevisionIdRef.current = nextRevision.id;
        baseRevisionNumberRef.current = nextRevision.revision;
        setBaseRevisionId(nextRevision.id);
        setBaseRevisionNumber(nextRevision.revision);
        const contentChangedWhileSaving = draftRef.current !== submittedDraft;
        dirtyRef.current = contentChangedWhileSaving;
        setDirty(contentChangedWhileSaving);
      }
      saveOperationRef.current = undefined;
      return !dirtyRef.current;
    } catch (cause) {
      // Preserve the buffer and the originally-read revision so the person can
      // compare it with the latest Server state instead of silently losing it.
      setSaveError(errorMessage(cause, "本文を保存できませんでした。下書きは保持しています。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [detail.artifact.id, onSave]);

  const sendRequest = useCallback(async (): Promise<boolean> => {
    const submittedRequest = requestRef.current;
    const normalized = submittedRequest.trim();
    const artifactId = detail.artifact.id;
    const submittedBaseRevisionId = baseRevisionIdRef.current;
    if (!normalized) return true;
    if (!onRequestAgentRevision || editorArtifactIdRef.current !== artifactId || !submittedBaseRevisionId || savingRef.current) return false;
    if (dirtyRef.current) {
      setSaveError("本文に未保存の変更があります。先に本文を保存してから、Agentへの修正依頼を送信してください。");
      return false;
    }
    const submittedSelection = selectionRef.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      await invokeArtifactRevisionRequest(onRequestAgentRevision, { artifact: detail.artifact, revisionId: submittedBaseRevisionId, workspaceTarget, sourceWorkId: metadataText(detail.artifact, "source_work_id"), request: normalized, ...(submittedSelection && submittedSelection.text ? { location: { kind: "text" as const, ...submittedSelection } } : {}) });
      if (editorArtifactIdRef.current === artifactId && requestRef.current === submittedRequest) {
        requestRef.current = "";
        setRequest("");
      }
      return true;
    } catch (cause) {
      setSaveError(errorMessage(cause, "Agentへの修正依頼を追加できませんでした。下書きは保持しています。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [detail.artifact, onRequestAgentRevision, workspaceTarget]);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (!await saveContent()) return false;
    return sendRequest();
  }, [saveContent, sendRequest]);

  const reload = useCallback(() => {
    draftRef.current = detail.content;
    baseRevisionIdRef.current = current?.id;
    baseRevisionNumberRef.current = current?.revision;
    dirtyRef.current = false;
    requestRef.current = "";
    setDraft(detail.content);
    setBaseRevisionId(current?.id);
    setBaseRevisionNumber(current?.revision);
    setDirty(false);
    setSaveError(undefined);
    setSelection(undefined);
    setRequest("");
    setStale(false);
    saveOperationRef.current = undefined;
  }, [current?.id, current?.revision, detail.content]);

  const hasDraft = dirty || request.length > 0;

  useEffect(() => {
    onEditorControllerChange?.({ artifactId: detail.artifact.id, dirty: hasDraft, saving, save, discard: reload });
    return () => onEditorControllerChange?.(undefined);
  }, [detail.artifact.id, hasDraft, onEditorControllerChange, reload, save, saving]);

  if (editorArtifactId !== detail.artifact.id) return <p className="native-inline-note" role="status">成果物の下書きを切り替えています…</p>;

  return <div className="native-artifact-text">
    {stale ? <p className="native-inline-error">Server上で新しい版があります。下書きを保護しています。保存すると競合として扱われます。</p> : null}
    {saveError ? <p className="native-inline-error" role="alert">{saveError} 下書きは保持しています。</p> : null}
    <article className="native-artifact-markdown" dangerouslySetInnerHTML={{ __html: markdownPreviewHtml(detail.content) }} />
    {canEdit ? <><label className="native-artifact-editor-label" htmlFor={`artifact-editor-${detail.artifact.id}`}>本文を直接編集</label><textarea id={`artifact-editor-${detail.artifact.id}`} value={draft} rows={12} onChange={(event) => { draftRef.current = event.currentTarget.value; dirtyRef.current = true; setDraft(event.currentTarget.value); setDirty(true); }} onSelect={(event) => { const input = event.currentTarget; const start = input.selectionStart; const end = input.selectionEnd; const nextSelection = start === end ? undefined : { start, end, text: input.value.slice(start, end) }; selectionRef.current = nextSelection; setSelection(nextSelection); }} />
      <div className="native-artifact-editor-actions"><button type="button" className="native-button native-button-primary" disabled={!dirty || saving || !baseRevisionId} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button><button type="button" className="native-button native-button-quiet" disabled={!dirty || saving} onClick={reload}>取消</button>{selection?.text ? <span className="native-inline-note">{selection.text.length}文字を選択中</span> : null}</div></> : null}
    {onRequestAgentRevision ? <div className="native-artifact-agent-request"><label htmlFor={`artifact-request-${detail.artifact.id}`}>Agentに修正を依頼</label><textarea id={`artifact-request-${detail.artifact.id}`} value={request} rows={2} placeholder={selection?.text ? "選択した箇所への修正内容…" : "対象成果物への修正内容…"} disabled={!baseRevisionId} onChange={(event) => { requestRef.current = event.currentTarget.value; setRequest(event.currentTarget.value); }} /><button type="button" className="native-button native-button-quiet" disabled={!request.trim() || saving || !baseRevisionId} onClick={() => void sendRequest()}>依頼文へ追加</button>{!baseRevisionId ? <p className="native-inline-note">対象版を確認できないため、依頼を開始できません。</p> : null}</div> : null}
  </div>;
}

function TableArtifactEditor({ detail, current, canEdit, workspaceTarget, onSave, onRequestAgentRevision, onEditorControllerChange }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; workspaceTarget?: NativeWorkspaceTarget; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: ArtifactRevisionRequestHandler; onEditorControllerChange?: ArtifactDetailViewProps["onEditorControllerChange"] }) {
  const [editorArtifactId, setEditorArtifactId] = useState(detail.artifact.id);
  const parsed = useMemo(() => parseTable(detail.content), [detail.content]);
  const [table, setTable] = useState(parsed);
  const [baseRevisionId, setBaseRevisionId] = useState(current?.id);
  const [baseRevisionNumber, setBaseRevisionNumber] = useState(current?.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [request, setRequest] = useState("");
  const [target, setTarget] = useState<{ rowId: string; columnId: string; value: JsonValue }>();
  const [stale, setStale] = useState(false);
  const saveOperationRef = useRef<{ operationId: string; snapshot: string } | undefined>(undefined);
  const tableRef = useRef(table);
  const baseRevisionIdRef = useRef(baseRevisionId);
  const baseRevisionNumberRef = useRef(baseRevisionNumber);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(saving);
  const requestRef = useRef(request);
  const targetRef = useRef(target);
  const editorArtifactIdRef = useRef(editorArtifactId);
  tableRef.current = table;
  baseRevisionIdRef.current = baseRevisionId;
  baseRevisionNumberRef.current = baseRevisionNumber;
  dirtyRef.current = dirty;
  savingRef.current = saving;
  requestRef.current = request;
  targetRef.current = target;
  editorArtifactIdRef.current = editorArtifactId;


  useEffect(() => {
    if (editorArtifactId !== detail.artifact.id) {
      editorArtifactIdRef.current = detail.artifact.id;
      tableRef.current = parsed;
      baseRevisionIdRef.current = current?.id;
      baseRevisionNumberRef.current = current?.revision;
      dirtyRef.current = false;
      savingRef.current = false;
      requestRef.current = "";
      setEditorArtifactId(detail.artifact.id);
      setTable(parsed);
      setBaseRevisionId(current?.id);
      setBaseRevisionNumber(current?.revision);
      setDirty(false);
      setSaving(false);
      setSaveError(undefined);
      setRequest("");
      setTarget(undefined);
      setStale(false);
      saveOperationRef.current = undefined;
      return;
    }
    if (!dirty) {
      tableRef.current = parsed;
      baseRevisionIdRef.current = current?.id;
      baseRevisionNumberRef.current = current?.revision;
      if (table !== parsed) setTable(parsed);
      if (baseRevisionId !== current?.id) setBaseRevisionId(current?.id);
      if (baseRevisionNumber !== current?.revision) setBaseRevisionNumber(current?.revision);
      setStale(false);
      saveOperationRef.current = undefined;
    } else if (current?.id && current.id !== baseRevisionId) {
      setStale(true);
    }
  }, [baseRevisionId, baseRevisionNumber, current?.id, current?.revision, detail.artifact.id, dirty, editorArtifactId, parsed, table]);

  const saveContent = useCallback(async (): Promise<boolean> => {
    const artifactId = detail.artifact.id;
    const submittedTable = tableRef.current;
    const submittedBaseRevisionId = baseRevisionIdRef.current;
    const submittedBaseRevisionNumber = baseRevisionNumberRef.current;
    if (editorArtifactIdRef.current !== artifactId || !submittedBaseRevisionId || submittedBaseRevisionNumber === undefined || !submittedTable) return false;
    if (!dirtyRef.current) return true;
    if (savingRef.current) return false;
    const snapshot = artifactTableSnapshot(submittedTable);
    const operation = operationForArtifactSnapshot(saveOperationRef.current, snapshot);
    saveOperationRef.current = operation;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      const mutation = await onSave({ artifactId, content: snapshot, baseRevisionId: submittedBaseRevisionId, expectedRevision: submittedBaseRevisionNumber, changeSummary: "Human edited table data.", operationId: operation.operationId });
      const nextRevision = mutation.revision;
      if (!nextRevision) throw new Error("artifact_mutation_revision_missing");
      if (editorArtifactIdRef.current === artifactId) {
        baseRevisionIdRef.current = nextRevision.id;
        baseRevisionNumberRef.current = nextRevision.revision;
        setBaseRevisionId(nextRevision.id);
        setBaseRevisionNumber(nextRevision.revision);
        const contentChangedWhileSaving = artifactTableSnapshot(tableRef.current) !== snapshot;
        dirtyRef.current = contentChangedWhileSaving;
        setDirty(contentChangedWhileSaving);
      }
      saveOperationRef.current = undefined;
      return !dirtyRef.current;
    } catch (cause) {
      setSaveError(errorMessage(cause, "表を保存できませんでした。下書きは保持しています。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [detail.artifact.id, onSave]);

  const sendRequest = useCallback(async (): Promise<boolean> => {
    const submittedRequest = requestRef.current;
    const normalized = submittedRequest.trim();
    const artifactId = detail.artifact.id;
    const submittedBaseRevisionId = baseRevisionIdRef.current;
    if (!normalized) return true;
    if (!onRequestAgentRevision || editorArtifactIdRef.current !== artifactId || !submittedBaseRevisionId || savingRef.current) return false;
    if (dirtyRef.current) {
      setSaveError("表に未保存の変更があります。先に表を保存してから、Agentへの修正依頼を送信してください。");
      return false;
    }
    const submittedTarget = targetRef.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    try {
      await invokeArtifactRevisionRequest(onRequestAgentRevision, { artifact: detail.artifact, revisionId: submittedBaseRevisionId, workspaceTarget, sourceWorkId: metadataText(detail.artifact, "source_work_id"), request: normalized, ...(submittedTarget ? { location: { kind: "table_cell" as const, ...submittedTarget } } : {}) });
      if (editorArtifactIdRef.current === artifactId && requestRef.current === submittedRequest) {
        requestRef.current = "";
        setRequest("");
      }
      return true;
    } catch (cause) {
      setSaveError(errorMessage(cause, "Agentへの修正依頼を追加できませんでした。下書きは保持しています。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [detail.artifact, onRequestAgentRevision, workspaceTarget]);

  const save = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false;
    if (!await saveContent()) return false;
    return sendRequest();
  }, [saveContent, sendRequest]);

  const reload = useCallback(() => {
    tableRef.current = parsed;
    baseRevisionIdRef.current = current?.id;
    baseRevisionNumberRef.current = current?.revision;
    dirtyRef.current = false;
    requestRef.current = "";
    setTable(parsed);
    setBaseRevisionId(current?.id);
    setBaseRevisionNumber(current?.revision);
    setDirty(false);
    setSaveError(undefined);
    setRequest("");
    setTarget(undefined);
    setStale(false);
    saveOperationRef.current = undefined;
  }, [current?.id, current?.revision, parsed]);

  const hasDraft = dirty || request.length > 0;

  useEffect(() => {
    onEditorControllerChange?.({ artifactId: detail.artifact.id, dirty: hasDraft, saving, save, discard: reload });
    return () => onEditorControllerChange?.(undefined);
  }, [detail.artifact.id, hasDraft, onEditorControllerChange, reload, save, saving]);

  const editable = Boolean(table && canEdit && table.editable && baseRevisionId);
  const change = (rowId: string, key: string, value: string | boolean): void => {
    setTable((previous) => {
      const next = previous ? updateTable(previous, rowId, key, value) : previous;
      tableRef.current = next;
      return next;
    });
    dirtyRef.current = true;
    setDirty(true);
  };
  if (editorArtifactId !== detail.artifact.id) return <p className="native-inline-note" role="status">成果物の下書きを切り替えています…</p>;
  if (!table) return <pre className="native-artifact-raw">{detail.content}</pre>;
  return <div className="native-artifact-table-wrap">
    {!table.editable && canEdit ? <p className="native-inline-note">この表には安定した行IDがないため、誤った行の更新を避けて直接編集は停止しています。</p> : null}
    {stale ? <p className="native-inline-error">Server上で新しい版があります。下書きを保護しています。保存すると競合として扱われます。</p> : null}
    {saveError ? <p className="native-inline-error" role="alert">{saveError} 下書きは保持しています。</p> : null}
    <table className="native-artifact-table"><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row) => <tr key={row.id}>{table.columns.map((column) => <td key={column}>{renderTableCell(row, column, table.columnTypes[column] ?? "string", editable, (value) => change(row.id, column, value), () => setTarget({ rowId: row.id, columnId: column, value: jsonCellValue(row.value[column]) }))}</td>)}</tr>)}</tbody></table>
    {canEdit && table.editable ? <div className="native-artifact-editor-actions"><button type="button" className="native-button native-button-primary" disabled={!dirty || saving || !baseRevisionId} onClick={() => void save()}>{saving ? "保存中…" : "表を保存"}</button><button type="button" className="native-button native-button-quiet" disabled={!dirty || saving} onClick={reload}>取消</button></div> : null}
    {onRequestAgentRevision ? <div className="native-artifact-agent-request"><label htmlFor={`artifact-table-request-${detail.artifact.id}`}>Agentに表の修正を依頼</label><textarea id={`artifact-table-request-${detail.artifact.id}`} value={request} rows={2} placeholder={target ? `${target.rowId} / ${target.columnId} を対象に修正…` : "対象セルを選択してから修正内容を入力…"} disabled={!baseRevisionId} onChange={(event) => { requestRef.current = event.currentTarget.value; setRequest(event.currentTarget.value); }} /><button type="button" className="native-button native-button-quiet" disabled={!request.trim() || saving || !baseRevisionId} onClick={() => void sendRequest()}>依頼文へ追加</button>{!baseRevisionId ? <p className="native-inline-note">対象版を確認できないため、依頼を開始できません。</p> : null}</div> : null}
  </div>;
}

function ChartArtifactView({ detail }: { detail: NativeArtifactDetail }) {
  const chart = useMemo(() => parseChart(detail.content), [detail.content]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  useEffect(() => setFilters({}), [detail.content]);
  if (!chart) return <><p className="native-inline-note">このchartには描画可能な値がありません。構造化したデータを確認してください。</p><pre className="native-artifact-raw">{detail.content}</pre></>;

  const values = filterChartValues(chart.values, filters);
  const maximum = Math.max(...values.map((entry) => entry.value), 1);
  return <section className="native-artifact-chart" aria-label={`${detail.artifact.title}のグラフとデータ表`}>
    {chart.filters.length > 0 ? <div className="native-artifact-chart-filters" aria-label="グラフの絞り込み">{chart.filters.map((filter) => <label key={filter.key}><span>{filter.label}</span><select value={filters[filter.key] ?? ""} onChange={(event) => setFilters((previous) => ({ ...previous, [filter.key]: event.currentTarget.value }))}><option value="">すべて</option>{filter.options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>)}</div> : null}
    {values.length === 0 ? <p className="native-inline-note">指定した条件に一致する値がありません。</p> : <figure><svg viewBox="0 0 640 260" role="img" aria-label={`${detail.artifact.title}の棒グラフ`}><line x1="48" y1="218" x2="620" y2="218" stroke="currentColor" opacity=".35" />{values.map((entry, index) => { const width = 500 / values.length; const height = (entry.value / maximum) * 172; const x = 60 + index * width; const y = 218 - height; return <g key={entry.id}><rect x={x} y={y} width={Math.max(width - 14, 12)} height={height} rx="4" fill="var(--native-accent)" /><text x={x + Math.max(width - 14, 12) / 2} y="238" textAnchor="middle" fill="currentColor" fontSize="11">{entry.label.slice(0, 12)}</text><text x={x + Math.max(width - 14, 12) / 2} y={Math.max(y - 8, 16)} textAnchor="middle" fill="currentColor" fontSize="11">{entry.value}{chart.unit ? ` ${chart.unit}` : ""}</text></g>; })}</svg><figcaption>値{chart.unit ? `（${chart.unit}）` : ""}。絞り込み後の値は下の表と同じです。</figcaption></figure>}
    <div className="native-artifact-chart-data"><h4>表示データ</h4><table><thead><tr><th scope="col">項目</th><th scope="col">値{chart.unit ? `（${chart.unit}）` : ""}</th>{chart.filters.map((filter) => <th key={filter.key} scope="col">{filter.label}</th>)}</tr></thead><tbody>{values.map((entry) => <tr key={entry.id}><td>{entry.label}</td><td>{entry.value}</td>{chart.filters.map((filter) => <td key={filter.key}>{entry.dimensions[filter.key] ?? ""}</td>)}</tr>)}</tbody></table></div>
  </section>;
}

function BinaryArtifactView({ detail, current, workspaceTarget, onRequestAgentRevision, onEditorControllerChange }: {
  detail: NativeArtifactDetail;
  current?: ArtifactRevisionRecord;
  workspaceTarget?: NativeWorkspaceTarget;
  onRequestAgentRevision?: ArtifactRevisionRequestHandler;
  onEditorControllerChange?: ArtifactDetailViewProps["onEditorControllerChange"];
}) {
  const [request, setRequest] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestError, setRequestError] = useState<string>();
  const revisionId = current?.id ?? detail.revision?.id;
  const isPdf = isPdfArtifact(detail.artifact);
  const requestRef = useRef(request);
  const savingRef = useRef(saving);
  const revisionIdRef = useRef(revisionId);
  const artifactIdRef = useRef(detail.artifact.id);
  requestRef.current = request;
  savingRef.current = saving;
  revisionIdRef.current = revisionId;
  artifactIdRef.current = detail.artifact.id;

  useEffect(() => {
    requestRef.current = "";
    savingRef.current = false;
    setRequest("");
    setSaving(false);
    setRequestError(undefined);
  }, [detail.artifact.id]);

  const sendRequest = useCallback(async (): Promise<boolean> => {
    const submittedRequest = requestRef.current;
    const normalized = submittedRequest.trim();
    const submittedRevisionId = revisionIdRef.current;
    if (!normalized) return true;
    if (!onRequestAgentRevision || !submittedRevisionId || savingRef.current) return false;
    const artifactId = artifactIdRef.current;
    savingRef.current = true;
    setSaving(true);
    setRequestError(undefined);
    try {
      await invokeArtifactRevisionRequest(onRequestAgentRevision, {
        artifact: detail.artifact,
        revisionId: submittedRevisionId,
        workspaceTarget: workspaceTarget,
        sourceWorkId: metadataText(detail.artifact, "source_work_id"),
        request: normalized
      });
      const requestChangedWhileSaving = artifactIdRef.current !== artifactId || requestRef.current !== submittedRequest;
      if (!requestChangedWhileSaving) {
        requestRef.current = "";
        setRequest("");
      }
      return !requestChangedWhileSaving;
    } catch (cause) {
      setRequestError(errorMessage(cause, "Agentへの修正依頼を追加できませんでした。"));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [detail.artifact, onRequestAgentRevision, workspaceTarget]);

  const discard = useCallback(() => {
    requestRef.current = "";
    setRequest("");
    setRequestError(undefined);
  }, []);

  useEffect(() => {
    onEditorControllerChange?.({ artifactId: detail.artifact.id, dirty: request.length > 0, saving, save: sendRequest, discard });
    return () => onEditorControllerChange?.(undefined);
  }, [detail.artifact.id, discard, onEditorControllerChange, request.length, saving, sendRequest]);

  return <div className="native-artifact-binary">
    <BinaryPreview detail={detail} />
    {requestError ? <p className="native-inline-error" role="alert">{requestError} 依頼文は保持しています。</p> : null}
    {onRequestAgentRevision ? <div className="native-artifact-agent-request">
      <label htmlFor={`artifact-binary-request-${detail.artifact.id}`}>{isPdf ? "AgentにPDFの修正を依頼" : "Agentに画像の修正を依頼"}</label>
      <textarea id={`artifact-binary-request-${detail.artifact.id}`} value={request} rows={2} placeholder={isPdf ? "このPDFの修正内容…" : "この画像の修正内容…"} disabled={!revisionId} onChange={(event) => { requestRef.current = event.currentTarget.value; setRequest(event.currentTarget.value); }} />
      <button type="button" className="native-button native-button-quiet" disabled={!request.trim() || saving || !revisionId} onClick={() => void sendRequest()}>{saving ? "追加中…" : "依頼文へ追加"}</button>
      {!revisionId ? <p className="native-inline-note">対象版を確認できないため、依頼を開始できません。</p> : null}
    </div> : null}
  </div>;
}

function BinaryPreview({ detail }: { detail: NativeArtifactDetail }) {
  const preview = useBinaryPreview(detail);
  if (preview.status === "loading") return <p className="native-inline-note" role="status">実byteを検査して安全なプレビューを準備しています…</p>;
  if (preview.status === "unavailable") return <p className="native-inline-note">{preview.reason} ダウンロードして確認してください。</p>;
  return isPdfArtifact(detail.artifact)
    ? <object className="native-artifact-pdf" data={preview.url} type={contentType(detail)}><a href={preview.url} target="_blank" rel="noreferrer">PDFを開く</a></object>
    : <img className="native-artifact-image" src={preview.url} alt={detail.artifact.title} />;
}

interface RevisionHistoryProps {
  artifactId: string;
  revisions: ArtifactRevisionRecord[];
  currentRevision?: ArtifactRevisionRecord;
  currentContent: string;
  comparison?: NativeArtifactRevisionDetail;
  onCompare: (revisionId: string) => void;
  onRestore: (input: ArtifactRestoreRequest) => Promise<ArtifactMutationResult>;
  onCloseComparison: () => void;
}

function RevisionHistory({ artifactId, revisions, currentRevision, currentContent, comparison, onCompare, onRestore, onCloseComparison }: RevisionHistoryProps) {
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();
  const restoreOperationRef = useRef<{ operationId: string; snapshot: string } | undefined>(undefined);
  const currentRevisionId = currentRevision?.id;

  useEffect(() => {
    restoreOperationRef.current = undefined;
    setRestoreError(undefined);
  }, [artifactId, comparison?.revision.id, currentRevision?.id]);

  const restore = async (): Promise<void> => {
    if (!comparison || !currentRevision || restoring) return;
    const snapshot = artifactRestoreOperationSnapshot({ artifactId, revisionId: comparison.revision.id, baseRevisionId: currentRevision.id, expectedRevision: currentRevision.revision });
    const operation = operationForArtifactSnapshot(restoreOperationRef.current, snapshot);
    restoreOperationRef.current = operation;
    setRestoring(true);
    setRestoreError(undefined);
    try {
      await onRestore({
        artifactId,
        revisionId: comparison.revision.id,
        baseRevisionId: currentRevision.id,
        expectedRevision: currentRevision.revision,
        operationId: operation.operationId
      });
      restoreOperationRef.current = undefined;
    } catch (cause) {
      setRestoreError(errorMessage(cause, "この版から復元できませんでした。下書きと現在版は保持しています。"));
    } finally {
      setRestoring(false);
    }
  };

  return <section className="native-artifact-history"><h4>版履歴</h4>
    {revisions.length === 0 ? <p className="native-inline-note">保存済みの版履歴を確認できません。</p> : <ul>{revisions.map((revision) => <li key={revision.id}><span>revision {revision.revision}{revision.id === currentRevisionId ? "（現在）" : ""}</span><small>{revision.editor_source ?? "不明"} · {formatUpdatedAt(revision.created_at)}</small>{revision.id !== currentRevisionId ? <button type="button" className="native-text-button" onClick={() => onCompare(revision.id)}>比較</button> : null}</li>)}</ul>}
    {restoreError ? <p className="native-inline-error" role="alert">{restoreError}</p> : null}
    {comparison ? <div className="native-artifact-comparison"><header><strong>revision {comparison.revision.revision} と現在版を比較</strong><button type="button" className="native-text-button" onClick={onCloseComparison} disabled={restoring}>閉じる</button></header><div className="native-artifact-comparison-grid"><label><span>現在版</span><pre>{currentContent}</pre></label><label><span>比較する版</span><pre>{comparison.content}</pre></label></div><button type="button" className="native-button native-button-quiet" onClick={() => void restore()} disabled={restoring || !currentRevision}>{restoring ? "復元中…" : "この版から復元"}</button></div> : null}
  </section>;
}

export type TableColumnType = "string" | "number" | "boolean" | "json";

export interface ParsedTable {
  root: JsonValue;
  rows: Array<{ id: string; value: Record<string, JsonValue> }>;
  columns: string[];
  columnTypes: Record<string, TableColumnType>;
  editable: boolean;
  source: "array" | "rows";
}

export function artifactTableSnapshot(table: ParsedTable | undefined): string {
  return table ? JSON.stringify(table.root, null, 2) + "\n" : "";
}

export function parseTable(content: string): ParsedTable | undefined {
  try {
    const root: unknown = JSON.parse(content);
    const rows = Array.isArray(root) ? root : isJsonRecord(root) && Array.isArray(root.rows) ? root.rows : undefined;
    if (!rows || !rows.every(isJsonRecord)) return undefined;
    const typedRows = rows as Array<Record<string, JsonValue>>;
    const columns = Array.from(new Set(typedRows.flatMap((row) => Object.keys(row))));
    const columnTypes = Object.fromEntries(columns.map((column) => [column, inferTableColumnType(typedRows.map((row) => row[column]))]));
    const stableIds = typedRows.map((row) => typeof row.id === "string" && row.id.trim() ? row.id : undefined);
    const editable = stableIds.every((id): id is string => Boolean(id)) && new Set(stableIds).size === stableIds.length;
    const usedIds = new Set<string>();
    const normalized = typedRows.map((value, index) => {
      const candidate = stableIds[index];
      let id = candidate && !usedIds.has(candidate) ? candidate : `unsafe-row-${index}`;
      while (usedIds.has(id)) id = `unsafe-row-${index}-${usedIds.size}`;
      usedIds.add(id);
      return { id, value };
    });
    return { root: cloneJson(root as JsonValue), rows: normalized, columns, columnTypes, editable, source: Array.isArray(root) ? "array" : "rows" };
  } catch { return undefined; }
}

/** Updates by the stable server-provided row ID, never by a changing array index. */
export function updateTable(table: ParsedTable, rowId: string, key: string, input: string | boolean): ParsedTable {
  const root = cloneJson(table.root);
  const targetRows = tableRowsFromRoot(root);
  const row = targetRows.find((candidate) => candidate.id === rowId);
  if (!row) return table;
  row[key] = coerceTableCellValue(table.columnTypes[key] ?? "string", input, row[key]);
  const rows = targetRows.map((value, index) => ({ id: typeof value.id === "string" && value.id ? value.id : `unsafe-row-${index}`, value }));
  return { ...table, root, rows };
}

export function coerceTableCellValue(columnType: TableColumnType, input: string | boolean, previous: JsonValue | undefined): JsonValue {
  if (columnType === "boolean") return Boolean(input);
  if (columnType === "number") {
    if (input === "") return null;
    const number = Number(input);
    return Number.isFinite(number) ? number : previous ?? null;
  }
  if (columnType === "json") return previous ?? null;
  return typeof input === "boolean" ? String(input) : input;
}

function renderTableCell(row: { id: string; value: Record<string, JsonValue> }, column: string, columnType: TableColumnType, editable: boolean, onChange: (value: string | boolean) => void, onFocus: () => void) {
  const value = row.value[column];
  if (!editable || column === "id" || columnType === "json" || (!isScalar(value) && value !== undefined)) return <span onFocus={onFocus} tabIndex={0}>{displayCellValue(value)}</span>;
  if (columnType === "boolean") return <input type="checkbox" checked={value === true} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.checked)} aria-label={`${row.id} ${column}`} />;
  return <input type={columnType === "number" ? "number" : "text"} value={value === null || value === undefined ? "" : String(value)} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.value)} aria-label={`${row.id} ${column}`} />;
}

type ChartValue = { id: string; label: string; value: number; dimensions: Record<string, string> };
type ParsedChart = { values: ChartValue[]; unit?: string; filters: Array<{ key: string; label: string; options: string[] }> };

function parseChart(content: string): ParsedChart | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    const source = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : isRecord(parsed) && Array.isArray(parsed.values) ? parsed.values : undefined;
    if (!source) return undefined;
    const values = source.flatMap((item, index) => {
      if (!isRecord(item) || typeof item.value !== "number" || !Number.isFinite(item.value)) return [];
      const dimensions = Object.fromEntries(Object.entries(item).flatMap(([key, value]) => {
        if (key === "id" || key === "label" || key === "name" || key === "value" || (typeof value !== "string" && typeof value !== "boolean")) return [];
        return [[key, String(value)]];
      }));
      return [{ id: typeof item.id === "string" && item.id ? item.id : `chart-row-${index}`, label: typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : String(index + 1), value: item.value, dimensions }];
    });
    if (!values.length) return undefined;
    const filters = Array.from(new Set(values.flatMap((entry) => Object.keys(entry.dimensions)))).flatMap((key) => {
      const options = Array.from(new Set(values.flatMap((entry) => entry.dimensions[key] ? [entry.dimensions[key]] : [])));
      return options.length > 1 ? [{ key, label: chartFilterLabel(key), options }] : [];
    });
    return { values, filters, ...(isRecord(parsed) && typeof parsed.unit === "string" ? { unit: parsed.unit } : {}) };
  } catch { return undefined; }
}

/** Applies only declared chart dimensions, preserving the exact rows shown in
 * both the SVG and its accompanying data table. */
export function filterChartValues(values: readonly ChartValue[], filters: Readonly<Record<string, string>>): ChartValue[] {
  return values.filter((entry) => Object.entries(filters).every(([key, value]) => !value || entry.dimensions[key] === value));
}

function chartFilterLabel(key: string): string {
  return key.replace(/[_-]+/g, " ");
}

export function artifactCurrentRevision(detail: NativeArtifactDetail, revisions: ArtifactRevisionRecord[]): ArtifactRevisionRecord | undefined {
  const id = metadataText(detail.artifact, "current_revision_id");
  const revisionNumber = metadataNumber(detail.artifact, "current_revision");
  // `detail.revision` is the revision whose content is actually displayed.
  // A result card may intentionally open a historical revision while the
  // Artifact's metadata still points at a newer current revision. Editing must
  // keep the displayed revision as its captured base until a mutation returns
  // a new Server revision.
  const displayedRevision = detail.revision?.artifact_id === detail.artifact.id ? detail.revision : undefined;
  return displayedRevision
    ?? (id ? revisions.find((revision) => revision.id === id) : undefined)
    ?? (revisionNumber === undefined ? undefined : revisions.find((revision) => revision.revision === revisionNumber))
    ?? undefined;
}

function addMutationRevision(history: ArtifactRevisionRecord[], revision: ArtifactRevisionRecord): ArtifactRevisionRecord[] {
  return [...history.filter((candidate) => candidate.id !== revision.id), revision]
    .sort((left, right) => right.revision - left.revision);
}

function binaryArtifact(detail: NativeArtifactDetail): boolean { return detail.contentEncoding === "base64" || isPdfArtifact(detail.artifact) || isImageArtifact(detail.artifact); }
function contentType(detail: NativeArtifactDetail): string { return detail.contentType ?? artifactContentType(detail.artifact); }
function metadataText(artifact: ArtifactRecord, key: string): string | undefined { const value = artifact.metadata[key]; return typeof value === "string" && value ? value : undefined; }
function metadataNumber(artifact: ArtifactRecord, key: string): number | undefined { const value = artifact.metadata[key]; return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined; }
function artifactKindLabel(artifact: ArtifactRecord): string { return ({ markdown: "文書", document: "文書", table: "表", chart: "グラフ", graph: "グラフ", image: "画像", pdf: "PDF", structured_draft: "構造化下書き", generated_report: "レポート", note: "メモ" } as const)[artifact.kind]; }
function formatUpdatedAt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
function tableRowsFromRoot(root: JsonValue): Array<Record<string, JsonValue>> {
  if (Array.isArray(root)) return root.filter(isJsonRecord);
  return isJsonRecord(root) && Array.isArray(root.rows) ? root.rows.filter(isJsonRecord) : [];
}
function inferTableColumnType(values: readonly (JsonValue | undefined)[]): TableColumnType {
  const observed = values.filter((value): value is JsonValue => value !== undefined && value !== null);
  if (observed.length === 0) return "json";
  const kinds = new Set(observed.map((value) => typeof value === "object" ? "json" : typeof value));
  return kinds.size === 1 && (kinds.has("string") || kinds.has("number") || kinds.has("boolean"))
    ? [...kinds][0] as TableColumnType
    : "json";
}
function isScalar(value: JsonValue | undefined): value is string | number | boolean | null { return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"; }
function jsonCellValue(value: JsonValue | undefined): JsonValue { return value === undefined ? null : value; }
function displayCellValue(value: JsonValue | undefined): string { return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value); }
function errorMessage(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  if (raw === "artifact_revision_request_cancelled") return "移動確認をキャンセルしたため、Agentへの修正依頼を追加できませんでした。";
  if (raw === "artifact_revision_request_unavailable") return "Agentへの修正依頼を追加する入口が利用できません。";
  return raw || fallback;
}

type BinaryPreview = { status: "loading" } | { status: "unavailable"; reason: string } | { status: "ready"; url: string };

/**
 * Use a revocable object URL instead of a potentially unbounded data URL.
 * The byte count is checked before decoding so a malformed or oversized
 * response never causes the renderer to allocate an unbounded preview.
 */
function useBinaryPreview(detail: NativeArtifactDetail): BinaryPreview {
  const [preview, setPreview] = useState<BinaryPreview>({ status: "loading" });
  const binary = binaryArtifact(detail);
  const type = contentType(detail);

  useEffect(() => {
    if (!binary) {
      setPreview({ status: "unavailable", reason: "binaryとして扱う内容ではありません。" });
      return;
    }
    const decoded = decodeBase64Artifact(detail.content);
    if (!decoded) {
      setPreview({ status: "unavailable", reason: "実byteを検証できないため、プレビューを停止しました。" });
      return;
    }
    if (decoded.byteLength > maximumBinaryPreviewBytes) {
      setPreview({ status: "unavailable", reason: `プレビュー上限（${formatByteSize(maximumBinaryPreviewBytes)}）を超えています。` });
      return;
    }
    const url = URL.createObjectURL(new Blob([byteArrayBuffer(decoded)], { type }));
    setPreview({ status: "ready", url });
    return () => URL.revokeObjectURL(url);
  }, [binary, detail.content, type]);

  return preview;
}

export function artifactBinaryPreviewEligibility(content: string): { eligible: true; byteLength: number } | { eligible: false; reason: "invalid" | "too_large" } {
  const decoded = decodeBase64Artifact(content);
  if (!decoded) return { eligible: false, reason: "invalid" };
  if (decoded.byteLength > maximumBinaryPreviewBytes) return { eligible: false, reason: "too_large" };
  return { eligible: true, byteLength: decoded.byteLength };
}

function downloadArtifact(detail: NativeArtifactDetail): void {
  if (typeof document === "undefined") return;
  const bytes = binaryArtifact(detail) ? decodeBase64Artifact(detail.content) : undefined;
  if (binaryArtifact(detail) && !bytes) throw new Error("成果物のbase64が壊れているため、実byteを作成できません。");
  const blob = bytes ? new Blob([byteArrayBuffer(bytes)], { type: contentType(detail) }) : new Blob([detail.content], { type: contentType(detail) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = detail.fileName ?? fileName(detail.artifact);
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function decodeBase64Artifact(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}
function byteArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
function formatByteSize(value: number): string { return `${Math.round(value / (1024 * 1024))} MB`; }
function fileName(artifact: ArtifactRecord): string { const suffix = artifact.file_ref.uri.split("/").pop(); return suffix && suffix.includes(".") ? suffix : `${artifact.title}.${artifact.kind === "pdf" ? "pdf" : artifact.kind === "image" ? "bin" : artifact.kind === "table" || artifact.kind === "chart" ? "json" : "md"}`; }
