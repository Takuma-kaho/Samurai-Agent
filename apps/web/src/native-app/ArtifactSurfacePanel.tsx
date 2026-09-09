import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactRecord, ArtifactRevisionRecord, JsonValue } from "@samurai-agent/core-schemas";
import { createIdempotencyKey } from "../lib/api";
import { artifactContentType, isImageArtifact, isPdfArtifact, markdownPreviewHtml } from "../lib/surface-view-helpers";

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
  revise(input: {
    roomId: string;
    artifactId: string;
    content: string;
    baseRevisionId: string;
    expectedRevision: number;
    changeSummary: string;
    operationId: string;
  }): Promise<void>;
  restore(input: {
    roomId: string;
    artifactId: string;
    revisionId: string;
    baseRevisionId: string;
    expectedRevision: number;
    operationId: string;
  }): Promise<void>;
}

export interface ArtifactRevisionTarget {
  artifact: ArtifactRecord;
  revisionId?: string;
  /** Server-recorded origin Work, when this Artifact came from Room Work. */
  sourceWorkId?: string;
  location?: { kind: "text"; start: number; end: number; text: string } | { kind: "table_cell"; rowId: string; columnId: string; value: JsonValue };
  request: string;
}

export interface ArtifactSurfacePanelProps {
  roomId?: string;
  gateway?: ArtifactSurfaceGateway;
  canEdit?: boolean;
  /** Leaves sending to the existing Room Work path; this component never invents a Session. */
  onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void;
  onOpenGeneratedSurface?: (surfaceId: string) => void;
}

const maximumBinaryPreviewBytes = 12 * 1024 * 1024;

/**
 * Room-scoped Artifact browser and editor. All reads and writes go through a
 * fixed gateway supplied by the active connection; this component contains no
 * cache keyed only by Artifact ID.
 */
export function ArtifactSurfacePanel({ roomId, gateway, canEdit = false, onRequestAgentRevision, onOpenGeneratedSurface }: ArtifactSurfacePanelProps) {
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [selected, setSelected] = useState<NativeArtifactDetail>();
  const [revisions, setRevisions] = useState<ArtifactRevisionRecord[]>([]);
  const [comparison, setComparison] = useState<NativeArtifactRevisionDetail>();
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();

  const unavailable = !roomId || !gateway;

  const refresh = async (): Promise<void> => {
    if (!roomId || !gateway) return;
    const epoch = ++listEpoch.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await gateway.list(roomId);
      if (epoch !== listEpoch.current) return;
      setArtifacts(next);
      if (selected && !next.some((artifact) => artifact.id === selected.artifact.id)) {
        setSelected(undefined);
        setRevisions([]);
        setComparison(undefined);
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

  const openArtifact = async (artifactId: string): Promise<void> => {
    if (!roomId || !gateway) return;
    const epoch = ++detailEpoch.current;
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
      setRevisions(history.sort((left, right) => right.revision - left.revision));
    } catch (cause) {
      if (epoch === detailEpoch.current) setError(errorMessage(cause, "成果物を開けませんでした。"));
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  };

  const loadComparison = async (revisionId: string): Promise<void> => {
    if (!roomId || !gateway || !selected) return;
    const epoch = ++detailEpoch.current;
    setDetailLoading(true);
    setError(undefined);
    try {
      const revision = await gateway.getRevision(roomId, selected.artifact.id, revisionId);
      if (epoch !== detailEpoch.current || revision.revision.artifact_id !== selected.artifact.id) return;
      setComparison(revision);
    } catch (cause) {
      if (epoch === detailEpoch.current) setError(errorMessage(cause, "指定した版を開けませんでした。"));
    } finally {
      if (epoch === detailEpoch.current) setDetailLoading(false);
    }
  };

  const save = async (content: string, baseRevisionId: string, expectedRevision: number, changeSummary: string): Promise<void> => {
    if (!roomId || !gateway || !selected) throw new Error("artifact_save_unavailable");
    await gateway.revise({ roomId, artifactId: selected.artifact.id, content, baseRevisionId, expectedRevision, changeSummary, operationId: createIdempotencyKey() });
    await openArtifact(selected.artifact.id);
    await refresh();
  };

  const restore = async (): Promise<void> => {
    if (!roomId || !gateway || !selected || !comparison) return;
    const current = currentRevision(selected, revisions);
    if (!current) {
      setError("現在の版を確認できないため、復元できません。");
      return;
    }
    setDetailLoading(true);
    setError(undefined);
    try {
      await gateway.restore({ roomId, artifactId: selected.artifact.id, revisionId: comparison.revision.id, baseRevisionId: current.id, expectedRevision: current.revision, operationId: createIdempotencyKey() });
      setComparison(undefined);
      await openArtifact(selected.artifact.id);
      await refresh();
    } catch (cause) {
      setError(errorMessage(cause, "復元できませんでした。別の更新がある場合は最新版を確認してください。"));
    } finally {
      setDetailLoading(false);
    }
  };

  return <section className="native-artifact-surface" aria-label="Roomの成果物">
    <header className="native-artifact-surface-header">
      <div><span className="native-section-eyebrow">Artifacts</span><h2>成果物</h2><p>このRoomで認可された文書・表・画像・PDF・操作画面を確認します。</p></div>
      <button type="button" className="native-button native-button-quiet" onClick={() => void refresh()} disabled={unavailable || loading}>{loading ? "再読込中…" : "再読込"}</button>
    </header>
    {unavailable ? <p className="native-inline-note">Roomを選択すると、認可された成果物を表示します。</p> : null}
    {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
    {loading ? <p className="native-inline-note" role="status">成果物を確認しています…</p> : null}
    {!loading && !unavailable && artifacts.length === 0 ? <p className="native-inline-note">このRoomには、まだ確認できる成果物がありません。</p> : null}
    <div className="native-artifact-layout">
      <nav className="native-artifact-list" aria-label="成果物一覧">{artifacts.map((artifact) => <button key={artifact.id} type="button" className={`native-artifact-list-item${selected?.artifact.id === artifact.id ? " is-active" : ""}`} onClick={() => void openArtifact(artifact.id)} aria-pressed={selected?.artifact.id === artifact.id}>
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
          onRestore={() => void restore()}
          onCloseComparison={() => setComparison(undefined)}
          onRequestAgentRevision={onRequestAgentRevision}
          onOpenGeneratedSurface={onOpenGeneratedSurface}
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
  onSave: (content: string, baseRevisionId: string, expectedRevision: number, changeSummary: string) => Promise<void>;
  onCompare: (revisionId: string) => void;
  onRestore: () => void;
  onCloseComparison: () => void;
  onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void;
  onOpenGeneratedSurface?: (surfaceId: string) => void;
}

export function ArtifactDetailView({ detail, revisions, comparison, canEdit, onSave, onCompare, onRestore, onCloseComparison, onRequestAgentRevision, onOpenGeneratedSurface }: ArtifactDetailViewProps) {
  const current = currentRevision(detail, revisions);
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
    <ArtifactBody detail={detail} current={current} canEdit={canEdit && !isBinary} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} />
    <RevisionHistory revisions={revisions} currentRevisionId={current?.id} currentContent={detail.content} comparison={comparison} onCompare={onCompare} onRestore={onRestore} onCloseComparison={onCloseComparison} />
  </article>;
}

function ArtifactBody({ detail, current, canEdit, onSave, onRequestAgentRevision }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void }) {
  if (isPdfArtifact(detail.artifact)) return <BinaryPreview detail={detail} />;
  if (isImageArtifact(detail.artifact)) return <BinaryPreview detail={detail} />;
  if (detail.artifact.kind === "table") return <TableArtifactEditor detail={detail} current={current} canEdit={canEdit} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} />;
  if (detail.artifact.kind === "chart") return <ChartArtifactView detail={detail} />;
  return <TextArtifactEditor detail={detail} current={current} canEdit={canEdit} onSave={onSave} onRequestAgentRevision={onRequestAgentRevision} />;
}

function TextArtifactEditor({ detail, current, canEdit, onSave, onRequestAgentRevision }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void }) {
  const [draft, setDraft] = useState(detail.content);
  const [baseRevisionId, setBaseRevisionId] = useState(current?.id);
  const [baseRevisionNumber, setBaseRevisionNumber] = useState(current?.revision);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [selection, setSelection] = useState<{ start: number; end: number; text: string }>();
  const [request, setRequest] = useState("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setDraft(detail.content);
      setBaseRevisionId(current?.id);
      setBaseRevisionNumber(current?.revision);
      setStale(false);
    } else if (current?.id && current.id !== baseRevisionId) setStale(true);
  }, [baseRevisionId, current?.id, current?.revision, detail.content, dirty]);

  const save = async (): Promise<void> => {
    if (!baseRevisionId || baseRevisionNumber === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave(draft, baseRevisionId, baseRevisionNumber, "Human edited document content.");
      setDirty(false);
    } catch (cause) {
      // Preserve the buffer and the originally-read revision so the person can
      // compare it with the latest Server state instead of silently losing it.
      setSaveError(errorMessage(cause, "本文を保存できませんでした。下書きは保持しています。"));
    } finally { setSaving(false); }
  };
  const reload = () => { setDraft(detail.content); setBaseRevisionId(current?.id); setBaseRevisionNumber(current?.revision); setDirty(false); setStale(false); };
  const requestRevision = () => {
    const normalized = request.trim();
    if (!normalized || !onRequestAgentRevision) return;
    onRequestAgentRevision({ artifact: detail.artifact, revisionId: baseRevisionId, sourceWorkId: metadataText(detail.artifact, "source_work_id"), request: normalized, ...(selection && selection.text ? { location: { kind: "text" as const, ...selection } } : {}) });
    setRequest("");
  };
  return <div className="native-artifact-text">
    {stale ? <p className="native-inline-error">Server上で新しい版があります。下書きを保護しています。保存すると競合として扱われます。</p> : null}
    {saveError ? <p className="native-inline-error" role="alert">{saveError} 下書きは保持しています。</p> : null}
    <article className="native-artifact-markdown" dangerouslySetInnerHTML={{ __html: markdownPreviewHtml(detail.content) }} />
    {canEdit ? <><label className="native-artifact-editor-label" htmlFor={`artifact-editor-${detail.artifact.id}`}>本文を直接編集</label><textarea id={`artifact-editor-${detail.artifact.id}`} value={draft} rows={12} disabled={saving} onChange={(event) => { setDraft(event.currentTarget.value); setDirty(true); }} onSelect={(event) => { const input = event.currentTarget; const start = input.selectionStart; const end = input.selectionEnd; setSelection(start === end ? undefined : { start, end, text: input.value.slice(start, end) }); }} />
      <div className="native-artifact-editor-actions"><button type="button" className="native-button native-button-primary" disabled={!dirty || saving || !baseRevisionId} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button><button type="button" className="native-button native-button-quiet" disabled={!dirty || saving} onClick={reload}>取消</button>{selection?.text ? <span className="native-inline-note">{selection.text.length}文字を選択中</span> : null}</div></> : null}
    {onRequestAgentRevision ? <div className="native-artifact-agent-request"><label htmlFor={`artifact-request-${detail.artifact.id}`}>Agentに修正を依頼</label><textarea id={`artifact-request-${detail.artifact.id}`} value={request} rows={2} placeholder={selection?.text ? "選択した箇所への修正内容…" : "対象成果物への修正内容…"} onChange={(event) => setRequest(event.currentTarget.value)} /><button type="button" className="native-button native-button-quiet" disabled={!request.trim()} onClick={requestRevision}>依頼文へ追加</button></div> : null}
  </div>;
}

function TableArtifactEditor({ detail, current, canEdit, onSave, onRequestAgentRevision }: { detail: NativeArtifactDetail; current?: ArtifactRevisionRecord; canEdit: boolean; onSave: ArtifactDetailViewProps["onSave"]; onRequestAgentRevision?: (target: ArtifactRevisionTarget) => void }) {
  const parsed = useMemo(() => parseTable(detail.content), [detail.content]);
  const [table, setTable] = useState(parsed);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [request, setRequest] = useState("");
  const [target, setTarget] = useState<{ rowId: string; columnId: string; value: JsonValue }>();
  useEffect(() => { if (!dirty) setTable(parsed); }, [dirty, parsed]);
  if (!table) return <pre className="native-artifact-raw">{detail.content}</pre>;
  const editable = canEdit && table.editable && Boolean(current);
  const change = (rowIndex: number, key: string, value: string | boolean) => {
    setTable((previous) => previous && updateTable(previous, rowIndex, key, value));
    setDirty(true);
  };
  const save = async () => {
    if (!current || !table) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await onSave(JSON.stringify(table.root, null, 2) + "\n", current.id, current.revision, "Human edited table data.");
      setDirty(false);
    } catch (cause) {
      setSaveError(errorMessage(cause, "表を保存できませんでした。下書きは保持しています。"));
    } finally { setSaving(false); }
  };
  const requestRevision = () => {
    if (!request.trim() || !onRequestAgentRevision) return;
    onRequestAgentRevision({ artifact: detail.artifact, revisionId: current?.id, sourceWorkId: metadataText(detail.artifact, "source_work_id"), request: request.trim(), ...(target ? { location: { kind: "table_cell" as const, ...target } } : {}) });
    setRequest("");
  };
  return <div className="native-artifact-table-wrap">
    {!table.editable && canEdit ? <p className="native-inline-note">この表には安定した行IDがないため、誤った行の更新を避けて直接編集は停止しています。</p> : null}
    {saveError ? <p className="native-inline-error" role="alert">{saveError} 下書きは保持しています。</p> : null}
    <table className="native-artifact-table"><thead><tr>{table.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={row.id}>{table.columns.map((column) => <td key={column}>{renderTableCell(row, column, editable, (value) => change(rowIndex, column, value), () => setTarget({ rowId: row.id, columnId: column, value: jsonCellValue(row.value[column]) }))}</td>)}</tr>)}</tbody></table>
    {editable ? <div className="native-artifact-editor-actions"><button type="button" className="native-button native-button-primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? "保存中…" : "表を保存"}</button><button type="button" className="native-button native-button-quiet" disabled={!dirty || saving} onClick={() => { setTable(parsed); setDirty(false); }}>取消</button></div> : null}
    {onRequestAgentRevision ? <div className="native-artifact-agent-request"><label htmlFor={`artifact-table-request-${detail.artifact.id}`}>Agentに表の修正を依頼</label><textarea id={`artifact-table-request-${detail.artifact.id}`} value={request} rows={2} placeholder={target ? `${target.rowId} / ${target.columnId} を対象に修正…` : "対象セルを選択してから修正内容を入力…"} onChange={(event) => setRequest(event.currentTarget.value)} /><button type="button" className="native-button native-button-quiet" disabled={!request.trim()} onClick={requestRevision}>依頼文へ追加</button></div> : null}
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

function BinaryPreview({ detail }: { detail: NativeArtifactDetail }) {
  const preview = useBinaryPreview(detail);
  if (preview.status === "loading") return <p className="native-inline-note" role="status">実byteを検査して安全なプレビューを準備しています…</p>;
  if (preview.status === "unavailable") return <p className="native-inline-note">{preview.reason} ダウンロードして確認してください。</p>;
  return isPdfArtifact(detail.artifact)
    ? <object className="native-artifact-pdf" data={preview.url} type={contentType(detail)}><a href={preview.url} target="_blank" rel="noreferrer">PDFを開く</a></object>
    : <img className="native-artifact-image" src={preview.url} alt={detail.artifact.title} />;
}

function RevisionHistory({ revisions, currentRevisionId, currentContent, comparison, onCompare, onRestore, onCloseComparison }: { revisions: ArtifactRevisionRecord[]; currentRevisionId?: string; currentContent: string; comparison?: NativeArtifactRevisionDetail; onCompare: (revisionId: string) => void; onRestore: () => void; onCloseComparison: () => void }) {
  return <section className="native-artifact-history"><h4>版履歴</h4>{revisions.length === 0 ? <p className="native-inline-note">保存済みの版履歴を確認できません。</p> : <ul>{revisions.map((revision) => <li key={revision.id}><span>revision {revision.revision}{revision.id === currentRevisionId ? "（現在）" : ""}</span><small>{revision.editor_source ?? "不明"} · {formatUpdatedAt(revision.created_at)}</small>{revision.id !== currentRevisionId ? <button type="button" className="native-text-button" onClick={() => onCompare(revision.id)}>比較</button> : null}</li>)}</ul>}{comparison ? <div className="native-artifact-comparison"><header><strong>revision {comparison.revision.revision} と現在版を比較</strong><button type="button" className="native-text-button" onClick={onCloseComparison}>閉じる</button></header><div className="native-artifact-comparison-grid"><label><span>現在版</span><pre>{currentContent}</pre></label><label><span>比較する版</span><pre>{comparison.content}</pre></label></div><button type="button" className="native-button native-button-quiet" onClick={onRestore}>この版から復元</button></div> : null}</section>;
}

type ParsedTable = { root: unknown; rows: Array<{ id: string; value: Record<string, JsonValue> }>; columns: string[]; editable: boolean; source: "array" | "rows" };

function parseTable(content: string): ParsedTable | undefined {
  try {
    const root: unknown = JSON.parse(content);
    const rows = Array.isArray(root) ? root : isRecord(root) && Array.isArray(root.rows) ? root.rows : undefined;
    if (!rows || !rows.every(isRecord)) return undefined;
    const typedRows = rows as Array<Record<string, JsonValue>>;
    const columns = Array.from(new Set(typedRows.flatMap((row) => Object.keys(row))));
    const normalized = typedRows.map((value, index) => ({ id: typeof value.id === "string" && value.id ? value.id : `unsafe-row-${index}`, value }));
    return { root: cloneJson(root), rows: normalized, columns, editable: typedRows.every((row) => typeof row.id === "string" && Boolean(row.id)), source: Array.isArray(root) ? "array" : "rows" };
  } catch { return undefined; }
}

function updateTable(table: ParsedTable, rowIndex: number, key: string, input: string | boolean): ParsedTable {
  const root = cloneJson(table.root);
  const targetRows = Array.isArray(root) ? root : isRecord(root) && Array.isArray(root.rows) ? root.rows : [];
  const row = targetRows[rowIndex];
  if (!isRecord(row)) return table;
  const before = row[key];
  row[key] = coerceCellValue(before, input);
  const rows = targetRows.filter(isRecord).map((value, index) => ({ id: typeof value.id === "string" ? value.id : `unsafe-row-${index}`, value: value as Record<string, JsonValue> }));
  return { ...table, root, rows };
}

function renderTableCell(row: { id: string; value: Record<string, JsonValue> }, column: string, editable: boolean, onChange: (value: string | boolean) => void, onFocus: () => void) {
  const value = row.value[column];
  if (!editable || column === "id" || !isScalar(value)) return <span onFocus={onFocus} tabIndex={0}>{displayCellValue(value)}</span>;
  if (typeof value === "boolean") return <input type="checkbox" checked={value} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.checked)} aria-label={`${row.id} ${column}`} />;
  return <input type={typeof value === "number" ? "number" : "text"} value={value === null ? "" : String(value)} onFocus={onFocus} onChange={(event) => onChange(event.currentTarget.value)} aria-label={`${row.id} ${column}`} />;
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

function currentRevision(detail: NativeArtifactDetail, revisions: ArtifactRevisionRecord[]): ArtifactRevisionRecord | undefined {
  const id = detail.revision?.id ?? metadataText(detail.artifact, "current_revision_id");
  return revisions.find((revision) => revision.id === id) ?? detail.revision;
}

function binaryArtifact(detail: NativeArtifactDetail): boolean { return detail.contentEncoding === "base64" || isPdfArtifact(detail.artifact) || isImageArtifact(detail.artifact); }
function contentType(detail: NativeArtifactDetail): string { return detail.contentType ?? artifactContentType(detail.artifact); }
function metadataText(artifact: ArtifactRecord, key: string): string | undefined { const value = artifact.metadata[key]; return typeof value === "string" && value ? value : undefined; }
function artifactKindLabel(artifact: ArtifactRecord): string { return ({ markdown: "文書", document: "文書", table: "表", chart: "グラフ", graph: "グラフ", image: "画像", pdf: "PDF", structured_draft: "構造化下書き", generated_report: "レポート", note: "メモ" } as const)[artifact.kind]; }
function formatUpdatedAt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isScalar(value: JsonValue | undefined): value is string | number | boolean | null { return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"; }
function jsonCellValue(value: JsonValue | undefined): JsonValue { return value === undefined ? null : value; }
function displayCellValue(value: JsonValue | undefined): string { return value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value); }
function coerceCellValue(previous: unknown, input: string | boolean): JsonValue { if (typeof previous === "boolean") return Boolean(input); if (typeof previous === "number") { if (input === "") return null; const number = Number(input); return Number.isFinite(number) ? number : previous; } return String(input); }
function errorMessage(cause: unknown, fallback: string): string { return cause instanceof Error && cause.message ? cause.message : fallback; }

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
