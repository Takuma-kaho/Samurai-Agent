import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  DesktopWorkspaceTarget,
  WorkspaceContextSearchInput,
  WorkspaceContextSearchPage,
  WorkspaceContextSearchType
} from "../lib/api";
import {
  searchTypesAreAllSelected,
  toggleWorkspaceContextSearchType,
  workspaceContextSearchTypes,
  workspaceContextSearchViewState,
  workspaceContextTargetKey
} from "./workspace-context-ui-helpers";

export interface WorkspaceContextSearchProps {
  /** The parent owns the bridge/API connection and may reject stale targets. */
  search: (input: WorkspaceContextSearchInput) => Promise<WorkspaceContextSearchPage>;
  target?: DesktopWorkspaceTarget;
  workspaceName?: string;
  initialQuery?: string;
  /** Optional controlled query so the sidebar and result surface share one input state. */
  query?: string;
  onQueryChange?: (query: string) => void;
  initialTypes?: WorkspaceContextSearchType[];
  open?: boolean;
  onClose?: () => void;
  /** Search results expose only the authorized Room navigation callback. */
  onOpenRoom: (roomId: string) => void;
}

const searchTypeLabels: Record<WorkspaceContextSearchType, string> = {
  room: "Room",
  conversation: "会話",
  knowledge: "知識"
};

export function WorkspaceContextSearch({
  search,
  target,
  workspaceName = "現在のWorkspace",
  initialQuery = "",
  query: controlledQuery,
  onQueryChange,
  initialTypes,
  open = true,
  onClose,
  onOpenRoom
}: WorkspaceContextSearchProps) {
  const [localQuery, setLocalQuery] = useState(initialQuery);
  const query = controlledQuery ?? localQuery;
  const setQuery = useCallback((nextQuery: string): void => {
    if (controlledQuery === undefined) setLocalQuery(nextQuery);
    onQueryChange?.(nextQuery);
  }, [controlledQuery, onQueryChange]);
  const [selectedTypes, setSelectedTypes] = useState<WorkspaceContextSearchType[] | undefined>(
    initialTypes?.length ? initialTypes : undefined
  );
  const [page, setPage] = useState<WorkspaceContextSearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const targetKey = workspaceContextTargetKey(target);
  const targetKeyRef = useRef(targetKey);
  const previousTargetKey = useRef(targetKey);
  targetKeyRef.current = targetKey;

  const executeSearch = useCallback(async (
    rawQuery: string,
    types: WorkspaceContextSearchType[] | undefined,
    cursor: string | undefined,
    append: boolean
  ): Promise<void> => {
    const normalizedQuery = rawQuery.trim();
    if (!normalizedQuery || !target) {
      requestSequence.current += 1;
      setPage(null);
      setError(null);
      setLoading(false);
      return;
    }
    const sequence = ++requestSequence.current;
    const requestTargetKey = targetKey;
    setLoading(true);
    if (!append) setError(null);
    try {
      const response = await search({
        query: normalizedQuery,
        ...(types?.length ? { types } : {}),
        ...(cursor ? { cursor } : {}),
        target
      });
      if (sequence !== requestSequence.current || targetKeyRef.current !== requestTargetKey) return;
      setPage((current) => append && current
        ? { items: mergeSearchItems(current.items, response.items), nextCursor: response.nextCursor }
        : response);
      setError(null);
    } catch {
      if (sequence !== requestSequence.current || targetKeyRef.current !== requestTargetKey) return;
      if (!append) setPage(null);
      setError("検索結果を取得できませんでした。Workspaceの接続と権限を確認して、もう一度お試しください。");
    } finally {
      if (sequence === requestSequence.current && targetKeyRef.current === requestTargetKey) setLoading(false);
    }
  }, [search, target, targetKey]);

  useEffect(() => {
    if (previousTargetKey.current === targetKey) return;
    previousTargetKey.current = targetKey;
    requestSequence.current += 1;
    targetKeyRef.current = targetKey;
    setPage(null);
    setError(null);
    setQuery("");
  }, [setQuery, targetKey]);

  useEffect(() => {
    if (!open) {
      requestSequence.current += 1;
      setLoading(false);
      return undefined;
    }
    if (!query.trim() || !target) {
      requestSequence.current += 1;
      setPage(null);
      setError(null);
      setLoading(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      void executeSearch(query, selectedTypes, undefined, false);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [executeSearch, open, query, selectedTypes, target]);

  if (!open) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeSearch(query, selectedTypes, undefined, false);
  };

  const chooseType = (type: WorkspaceContextSearchType) => {
    setSelectedTypes((current) => toggleWorkspaceContextSearchType(current, type));
  };
  const viewState = workspaceContextSearchViewState({
    loading,
    error,
    query,
    hasTarget: Boolean(target),
    itemCount: page?.items.length ?? 0
  });

  return <>
    <style>{workspaceContextSearchStyles}</style>
    <section
      className="native-workspace-context-search"
      role="dialog"
      aria-modal="true"
      aria-labelledby="native-workspace-context-search-title"
      aria-busy={loading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose?.();
        }
      }}
    >
      <div className="native-workspace-context-search__header">
        <div>
          <span className="native-section-eyebrow">Workspace context</span>
          <h2 id="native-workspace-context-search-title">Workspaceを検索</h2>
          <p className="native-workspace-context-search__scope">検索範囲: {workspaceName}</p>
        </div>
        {onClose ? <button className="native-icon-button" type="button" onClick={onClose} aria-label="Workspace検索を閉じる">×</button> : null}
      </div>

      <form className="native-workspace-context-search__form" onSubmit={submit} role="search">
        <label htmlFor="native-workspace-context-search-input">検索語</label>
        <div className="native-workspace-context-search__input-row">
          <input
            id="native-workspace-context-search-input"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Room、会話、知識を検索"
            autoComplete="off"
            disabled={!target}
          />
          <button className="native-button native-button-primary" type="submit" disabled={!target || loading || !query.trim()}>検索</button>
        </div>
        <fieldset className="native-workspace-context-search__filters">
          <legend>検索対象</legend>
          <button
            type="button"
            className="native-workspace-context-search__filter"
            aria-pressed={searchTypesAreAllSelected(selectedTypes)}
            onClick={() => setSelectedTypes(undefined)}
          >すべて</button>
          {workspaceContextSearchTypes.map((type) => {
            const checked = selectedTypes === undefined || selectedTypes.includes(type);
            return <label className="native-workspace-context-search__checkbox" key={type}>
              <input type="checkbox" checked={checked} onChange={() => chooseType(type)} />
              <span>{searchTypeLabels[type]}</span>
            </label>;
          })}
        </fieldset>
        {!target ? <p className="native-workspace-context-search__note" role="status">Workspaceを選択すると検索できます。</p> : null}
      </form>

      <div className="native-workspace-context-search__status" aria-live="polite">
        {viewState === "loading" ? <p role="status">検索しています…</p> : null}
        {viewState === "error" && error ? <p className="native-inline-error" role="alert">{error}</p> : null}
        {viewState === "empty" ? <p className="native-workspace-context-search__note" role="status">該当するRoom、会話、知識はありません。</p> : null}
      </div>

      {page?.items.length ? <ul className="native-workspace-context-search__results" aria-label="Workspace検索結果">
          {page.items.map((item) => <li key={`${item.type}:${item.id}`}>
          <button
            type="button"
            className="native-workspace-context-search__result"
            onClick={() => item.roomId.trim() && onOpenRoom(item.roomId.trim())}
            aria-label={`${item.title}（${item.roomId}）を開く`}
          >
            <span className="native-workspace-context-search__result-kind">{searchTypeLabels[item.type]}</span>
            <strong>{item.title}</strong>
            <span className="native-workspace-context-search__result-room">Room: {item.roomId}</span>
            <span className="native-workspace-context-search__result-snippet">{item.snippet}</span>
            <time dateTime={item.updatedAt}>{item.updatedAt}</time>
          </button>
        </li>)}
      </ul> : null}
      {page?.nextCursor ? <button
        className="native-button native-workspace-context-search__more"
        type="button"
        disabled={loading}
        onClick={() => void executeSearch(query, selectedTypes, page.nextCursor ?? undefined, true)}
      >{loading ? "読み込み中…" : "検索結果を追加"}</button> : null}
    </section>
  </>;
}

function mergeSearchItems(
  current: WorkspaceContextSearchPage["items"],
  next: WorkspaceContextSearchPage["items"]
): WorkspaceContextSearchPage["items"] {
  const merged = new Map(current.map((item) => [`${item.type}:${item.id}`, item]));
  next.forEach((item) => merged.set(`${item.type}:${item.id}`, item));
  return [...merged.values()];
}

const workspaceContextSearchStyles = `
.native-workspace-context-search { width: min(640px, calc(100vw - 32px)); max-height: min(680px, calc(100vh - 32px)); overflow: auto; padding: 20px; border: 1px solid var(--native-line); border-radius: 12px; background: var(--native-bg); color: var(--native-copy); }
.native-workspace-context-search__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.native-workspace-context-search h2 { margin: 4px 0; font-size: 1.125rem; line-height: 1.3; }
.native-workspace-context-search__scope, .native-workspace-context-search__note { margin: 0; color: var(--native-muted); font-size: .8125rem; }
.native-workspace-context-search__form { display: grid; gap: 8px; margin-top: 16px; }
.native-workspace-context-search__input-row { display: flex; gap: 8px; }
.native-workspace-context-search__input-row input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid var(--native-line); border-radius: 8px; background: rgba(var(--native-accent-rgb), .06); color: inherit; font: inherit; }
.native-workspace-context-search__input-row input:focus-visible, .native-workspace-context-search__filter:focus-visible, .native-workspace-context-search__checkbox input:focus-visible, .native-workspace-context-search__result:focus-visible, .native-workspace-context-search__more:focus-visible { outline: 2px solid var(--native-accent); outline-offset: 2px; }
.native-workspace-context-search__filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0; border: 0; }
.native-workspace-context-search__filters legend { width: 100%; padding: 0; color: var(--native-muted); font-size: .75rem; }
.native-workspace-context-search__filter, .native-workspace-context-search__checkbox { min-height: 32px; padding: 5px 9px; border: 1px solid var(--native-line); border-radius: 999px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.native-workspace-context-search__filter[aria-pressed="true"] { border-color: var(--native-accent); background: var(--native-accent-soft); }
.native-workspace-context-search__checkbox { display: inline-flex; align-items: center; gap: 6px; }
.native-workspace-context-search__status { min-height: 24px; margin-top: 12px; }
.native-workspace-context-search__status p { margin: 0; }
.native-workspace-context-search__results { display: grid; gap: 6px; padding: 0; margin: 8px 0 0; list-style: none; }
.native-workspace-context-search__result { display: grid; width: 100%; gap: 4px; padding: 11px; text-align: left; border: 1px solid var(--native-line); border-radius: 10px; background: rgba(var(--native-accent-rgb), .045); color: inherit; cursor: pointer; }
.native-workspace-context-search__result:hover { border-color: rgba(var(--native-accent-rgb), .6); background: rgba(var(--native-accent-rgb), .08); }
.native-workspace-context-search__result-kind { color: var(--native-accent); font-size: .6875rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.native-workspace-context-search__result-room, .native-workspace-context-search__result-snippet, .native-workspace-context-search__result time { color: var(--native-muted); font-size: .8125rem; }
.native-workspace-context-search__more { width: 100%; margin-top: 12px; }
@media (max-width: 620px) { .native-workspace-context-search { padding: 16px; border-radius: 10px; } .native-workspace-context-search__input-row { align-items: stretch; flex-direction: column; } }
`;

export default WorkspaceContextSearch;
