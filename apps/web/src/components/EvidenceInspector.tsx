import type { NativeChatMessage, NativeEvidenceBundle } from "../native-app/types";

export interface EvidenceInspectorProps {
  message?: NativeChatMessage;
  evidence?: NativeEvidenceBundle;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

function valueFrom(entry: unknown, ...keys: string[]): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
    if (typeof record[key] === "number") return String(record[key]);
  }
  return undefined;
}

function shortDate(value?: string): string {
  if (!value) return "時刻不明";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function EvidenceInspector({ message, evidence, loading = false, error, onClose }: EvidenceInspectorProps) {
  const activity = evidence?.activity ?? [];
  const backendRuns = evidence?.backendRuns ?? [];
  const artifacts = evidence?.artifacts ?? [];
  const memories = evidence?.memories ?? [];
  const hasEvidence = activity.length > 0 || backendRuns.length > 0 || artifacts.length > 0 || memories.length > 0;

  return (
    <aside className="native-evidence-inspector" aria-labelledby="native-evidence-heading">
      <header className="native-inspector-header">
        <div>
          <div className="native-section-eyebrow">Trace / proof</div>
          <h2 id="native-evidence-heading">実行の根拠</h2>
        </div>
        <button type="button" className="native-icon-button" onClick={onClose} aria-label="根拠を閉じる">×</button>
      </header>
      {message ? <p className="native-inspector-context">「{message.content.slice(0, 96)}{message.content.length > 96 ? "…" : ""}」</p> : null}
      {loading ? <div className="native-inspector-loading" role="status">根拠を確認中…</div> : null}
      {error ? <p className="native-inline-error" role="alert">{error}</p> : null}
      {!loading && !error && !hasEvidence ? <div className="native-inspector-empty">この実行に紐づく公開証拠はまだありません。</div> : null}

      {!loading && !error && hasEvidence ? (
        <div className="native-evidence-groups">
          {activity.length ? (
            <section className="native-evidence-group" aria-labelledby="native-activity-label">
              <h3 id="native-activity-label">Activity</h3>
              <ul>
                {activity.map((item, index) => {
                  const id = valueFrom(item, "id", "activity_id") ?? `activity-${index + 1}`;
                  const state = valueFrom(item, "state", "status") ?? "記録済み";
                  const created = valueFrom(item, "created_at", "createdAt");
                  return <li key={id}><span className="native-evidence-icon" aria-hidden="true">✦</span><span><strong>{id}</strong><small>{state} · {shortDate(created)}</small></span></li>;
                })}
              </ul>
            </section>
          ) : null}
          {backendRuns.length ? (
            <section className="native-evidence-group" aria-labelledby="native-run-label">
              <h3 id="native-run-label">Agent execution</h3>
              <ul>
                {backendRuns.map((run, index) => {
                  const state = valueFrom(run, "status", "state") ?? "確認中";
                  const created = valueFrom(run, "created_at", "createdAt");
                  return <li key={valueFrom(run, "id", "run_id") ?? `run-${index + 1}`}><span className="native-evidence-icon is-accent" aria-hidden="true">↗</span><span><strong>{state}</strong><small>{shortDate(created)} · 内部実行情報は非表示</small></span></li>;
                })}
              </ul>
            </section>
          ) : null}
          {artifacts.length ? (
            <section className="native-evidence-group" aria-labelledby="native-file-label">
              <h3 id="native-file-label">Files</h3>
              <ul>
                {artifacts.map((artifact, index) => <li key={artifact.id || `artifact-${index + 1}`}><span className="native-evidence-icon" aria-hidden="true">▧</span><span><strong>{artifact.title ?? artifact.id}</strong><small>{artifact.kind ?? "Workspace file"}</small></span></li>)}
              </ul>
            </section>
          ) : null}
          {memories.length ? (
            <section className="native-evidence-group" aria-labelledby="native-memory-label">
              <h3 id="native-memory-label">再利用されたKnowledge</h3>
              <ul>
                {memories.map((memory, index) => <li key={memory.id || `memory-${index + 1}`}><span className="native-evidence-icon is-accent" aria-hidden="true">⌁</span><span><strong>{memory.title ?? memory.id}</strong><small>{memory.state ?? "参照"}</small></span></li>)}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

export default EvidenceInspector;
