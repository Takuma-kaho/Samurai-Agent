import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

export type NativeAgentResourceKind = "knowledge" | "skill";
export type NativeAgentKnowledgeKind = "fact" | "decision" | "explanation" | "experience_rule";

export interface NativeAgentResourceScope {
  kind: "agent";
  agentId: string;
}

/**
 * A support file is a display/reference value. The component never opens or
 * executes the path; the Server remains responsible for resolving it.
 * `body*` aliases keep this seam usable with Completion bundle projections.
 */
export interface NativeAgentSupportFile {
  path?: string;
  bodyPath?: string;
  hash?: string;
  bodyHash?: string;
  version?: number;
  bodyVersion?: number;
}

export interface NativeAgentResource {
  workspaceId: string;
  id: string;
  scope: NativeAgentResourceScope;
  kind: NativeAgentResourceKind;
  knowledgeKind?: NativeAgentKnowledgeKind;
  title: string;
  evidenceState: string;
  lifecycleState: string;
  aiManaged: boolean;
  version: number;
  currentConfirmedVersion?: number;
  contentHash?: string;
  supportFiles?: readonly NativeAgentSupportFile[];
  createdAt?: string;
  updatedAt?: string;
}

/** Detail is intentionally a parent-injected projection, not a Bridge type. */
export interface NativeAgentResourceDetail {
  resource: NativeAgentResource;
  version: number;
  content?: string;
  contentHash?: string;
  reason?: string;
  supportFiles?: readonly NativeAgentSupportFile[];
}

export interface NativeAgentResourceSelection {
  agentId: string;
  resourceId: string;
}

export interface NativeAgentResourceWriteInput {
  agentId: string;
  scopeKind: "agent";
  kind: NativeAgentResourceKind;
  knowledgeKind?: NativeAgentKnowledgeKind;
  title: string;
  content: string;
  reason: string;
  /** Manual UI never creates AI-managed resources. */
  aiManaged: false;
  supportFiles: readonly NativeAgentSupportFile[];
}

export interface NativeAgentResourceUpdateInput extends NativeAgentResourceWriteInput {
  resourceId: string;
  expectedVersion: number;
}

export interface NativeAgentResourceArchiveInput {
  agentId: string;
  resourceId: string;
  expectedVersion: number;
  reason: string;
}

export interface NativeAgentResourcesProps {
  /** The Agent target is fixed by the parent and is never editable here. */
  agentId: string;
  agentLabel?: string;
  resources: readonly NativeAgentResource[];
  selectedResourceId?: string;
  canManage?: boolean;
  loading?: boolean;
  error?: string | null;
  onSelectResource?: (selection: NativeAgentResourceSelection) => void | Promise<void>;
  onLoadResource?: (selection: NativeAgentResourceSelection) => Promise<NativeAgentResourceDetail>;
  onCreateResource?: (input: NativeAgentResourceWriteInput) => Promise<NativeAgentResource>;
  onUpdateResource?: (input: NativeAgentResourceUpdateInput) => Promise<NativeAgentResource>;
  onArchiveResource?: (input: NativeAgentResourceArchiveInput) => Promise<NativeAgentResource>;
  /** Opens the existing share surface; this component does not create a share. */
  onOpenShare?: (selection: NativeAgentResourceSelection & { kind: NativeAgentResourceKind }) => void | Promise<void>;
}

export type NativeAgentResourceOperation = "create" | "update" | "archive" | "share";

const resourceKindLabels: Record<NativeAgentResourceKind, string> = {
  knowledge: "Knowledge",
  skill: "Skill"
};

const knowledgeKindLabels: Record<NativeAgentKnowledgeKind, string> = {
  fact: "事実",
  decision: "判断",
  explanation: "説明",
  experience_rule: "経験則"
};

const panelStyles = `
.native-agent-resources {
  --nar-ink: var(--native-copy, #eeeeee);
  --nar-muted: var(--native-muted, #b2b2b2);
  --nar-dim: var(--native-dim, #858585);
  --nar-line: var(--native-line, rgba(255, 255, 255, .09));
  --nar-line-strong: var(--native-line-strong, rgba(255, 255, 255, .18));
  --nar-accent: var(--native-accent, #d6d6d6);
  --nar-accent-soft: var(--native-accent-soft, rgba(214, 214, 214, .1));
  --nar-danger: var(--native-danger, #ee8981);
  --nar-success: var(--native-success, #8ad8b2);
  background: var(--native-surface, #171717);
  border: 1px solid var(--nar-line);
  border-radius: 10px;
  box-sizing: border-box;
  color: var(--nar-ink);
  display: grid;
  gap: 12px;
  margin: 0 auto;
  max-width: 1120px;
  padding: 20px 24px;
}
.native-agent-resources *, .native-agent-resources *::before, .native-agent-resources *::after { box-sizing: border-box; }
.native-agent-resources__header { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.native-agent-resources__eyebrow { color: var(--nar-muted); display: block; font-size: 11px; font-weight: 600; letter-spacing: .08em; margin-bottom: 6px; text-transform: uppercase; }
.native-agent-resources h2, .native-agent-resources h3, .native-agent-resources h4 { margin: 0; }
.native-agent-resources h2 { font-family: inherit; font-size: 18px; font-weight: 600; letter-spacing: .01em; line-height: 1.3; }
.native-agent-resources h3 { font-size: 14px; }
.native-agent-resources h4 { font-size: 13px; }
.native-agent-resources p { line-height: 1.55; margin: 7px 0 0; }
.native-agent-resources__lede, .native-agent-resources__muted { color: var(--nar-muted); font-size: 12px; }
.native-agent-resources__target { color: var(--nar-muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 7px; margin-top: 10px; }
.native-agent-resources__target code { background: rgba(0, 0, 0, .22); border: 1px solid var(--nar-line); border-radius: 5px; color: var(--nar-ink); padding: 2px 5px; }
.native-agent-resources__notice, .native-agent-resources__status, .native-agent-resources__error, .native-agent-resources__warning { border-left: 3px solid; font-size: 12px; padding: 2px 0 2px 10px; }
.native-agent-resources__notice { border-color: var(--nar-line-strong); color: var(--nar-muted); }
.native-agent-resources__status { border-color: var(--nar-success); color: var(--nar-muted); }
.native-agent-resources__error { border-color: var(--nar-danger); color: var(--nar-danger); }
.native-agent-resources__warning { border-color: var(--nar-accent); color: var(--nar-accent); }
.native-agent-resources__grid { display: grid; gap: 14px; grid-template-columns: minmax(220px, .78fr) minmax(0, 1.45fr); }
.native-agent-resources__card { background: var(--native-surface-soft, #1c1c1c); border: 1px solid var(--nar-line); border-radius: 9px; min-width: 0; padding: 14px; }
.native-agent-resources__card-header { align-items: flex-start; display: flex; gap: 10px; justify-content: space-between; }
.native-agent-resources__resource-list, .native-agent-resources__support-files { display: grid; gap: 7px; list-style: none; margin: 13px 0 0; padding: 0; }
.native-agent-resources__resource-row { min-width: 0; }
.native-agent-resources__resource-button { background: rgba(255, 255, 255, .02); border: 1px solid var(--nar-line); border-radius: 9px; color: inherit; cursor: pointer; display: grid; gap: 5px; padding: 10px; text-align: left; width: 100%; }
.native-agent-resources__resource-button:hover, .native-agent-resources__resource-button[aria-current="true"] { background: var(--nar-accent-soft); border-color: rgba(var(--native-accent-rgb, 214, 214, 214), .32); }
.native-agent-resources__resource-button[aria-current="true"] { box-shadow: inset 3px 0 var(--nar-accent); }
.native-agent-resources__resource-topline, .native-agent-resources__meta, .native-agent-resources__actions { align-items: center; display: flex; flex-wrap: wrap; gap: 7px; }
.native-agent-resources__resource-topline { justify-content: space-between; }
.native-agent-resources__resource-title { font-size: 13px; font-weight: 750; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.native-agent-resources__meta { color: var(--nar-dim); font-size: 12px; line-height: 1.4; }
.native-agent-resources__badge { border: 1px solid var(--nar-line-strong); border-radius: 999px; color: var(--nar-muted); font-size: 11px; font-weight: 600; letter-spacing: .02em; padding: 3px 6px; }
.native-agent-resources__badge.is-archived { color: var(--nar-dim); }
.native-agent-resources__empty { color: var(--nar-dim); font-size: 12px; line-height: 1.55; padding: 14px 0 3px; }
.native-agent-resources__detail { display: grid; gap: 13px; }
.native-agent-resources__detail-title { font-family: inherit; font-size: 16px; font-weight: 600; letter-spacing: .01em; line-height: 1.3; overflow-wrap: anywhere; }
.native-agent-resources__detail-meta { color: var(--nar-muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 8px; }
.native-agent-resources__body { background: rgba(0, 0, 0, .18); border: 1px solid var(--nar-line); border-radius: 9px; font: inherit; font-size: 12px; line-height: 1.6; margin: 0; max-height: 360px; min-height: 80px; overflow: auto; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.native-agent-resources__field { display: grid; gap: 6px; margin-top: 10px; }
.native-agent-resources__field > span, .native-agent-resources__field legend { color: var(--nar-muted); font-size: 11px; font-weight: 700; }
.native-agent-resources__field input, .native-agent-resources__field select, .native-agent-resources__field textarea { background: rgba(0, 0, 0, .22); border: 1px solid var(--nar-line-strong); border-radius: 8px; color: inherit; font: inherit; font-size: 12px; min-width: 0; padding: 9px 10px; width: 100%; }
.native-agent-resources__field textarea { line-height: 1.55; min-height: 130px; resize: vertical; }
.native-agent-resources__field input:focus-visible, .native-agent-resources__field select:focus-visible, .native-agent-resources__field textarea:focus-visible, .native-agent-resources button:focus-visible { outline: 2px solid var(--nar-accent); outline-offset: 2px; }
.native-agent-resources fieldset { border: 0; margin: 0; padding: 0; }
.native-agent-resources__actions { margin-top: 4px; }
.native-agent-resources__button { border-radius: 7px; cursor: pointer; font: inherit; font-size: 13px; font-weight: 600; min-height: 32px; padding: 7px 10px; }
.native-agent-resources__button:disabled { cursor: not-allowed; opacity: .46; }
.native-agent-resources__button--primary { background: var(--nar-accent); border: 1px solid var(--nar-accent); color: var(--native-accent-ink, #171717); }
.native-agent-resources__button--quiet { background: rgba(255, 255, 255, .035); border: 1px solid var(--nar-line-strong); color: inherit; }
.native-agent-resources__button--danger { background: transparent; border: 1px solid rgba(238, 137, 129, .46); color: var(--nar-danger); }
.native-agent-resources__button--quiet:hover, .native-agent-resources__button--danger:hover { background: rgba(255, 255, 255, .08); }
.native-agent-resources__support-card { border-top: 1px solid var(--nar-line); padding-top: 12px; }
.native-agent-resources__support-files li { align-items: flex-start; border-bottom: 1px solid var(--nar-line); display: grid; gap: 2px; padding: 7px 0; }
.native-agent-resources__support-files li:last-child { border-bottom: 0; }
.native-agent-resources__support-files code { font-size: 11px; overflow-wrap: anywhere; }
.native-agent-resources__support-meta { color: var(--nar-muted); font-size: 10px; }
@media (max-width: 720px) { .native-agent-resources__grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .native-agent-resources *, .native-agent-resources *::before, .native-agent-resources *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return error instanceof Error ? error.message : String(error ?? "");
  const value = error as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  const status = typeof value.status === "number" ? String(value.status) : "";
  return `${code} ${message} ${status}`.toLowerCase();
}

export function nativeAgentResourceErrorMessage(error: unknown, operation: NativeAgentResourceOperation | "load" = "update"): string {
  const value = errorCode(error);
  if (value.includes("permission") || value.includes("forbidden") || value.includes("unauthorized") || value.includes("management")) {
    return "Agent資源を管理する権限を確認してください。";
  }
  if (value.includes("conflict") || value.includes("version") || value.includes("409")) {
    return "Agent資源の版が更新されています。最新の内容を読み直して確認してください。入力は保持しています。";
  }
  if (value.includes("scope") || value.includes("agent") && value.includes("mismatch") || value.includes("invalid_resource")) {
    return "対象Agentと一致しない資源は表示・保存できません。対象を確認してください。";
  }
  if (value.includes("workspace_memory_removed") || value.includes("workspace_knowledge")) {
    return "Workspace専用の旧MemoryやKnowledgeはAgent資源として扱えません。";
  }
  if (operation === "load") return "Agent資源の詳細を読み込めませんでした。接続と権限を確認してください。";
  if (operation === "archive") return "Agent資源を保管できませんでした。版と権限を確認して再試行してください。";
  if (operation === "share") return "共有画面を開けませんでした。権限と接続を確認してください。";
  return "Agent資源を保存できませんでした。入力と接続を確認して再試行してください。";
}

export function nativeAgentResourceCanBeShown(resource: NativeAgentResource, agentId: string): boolean {
  return Boolean(agentId)
    && resource.scope.kind === "agent"
    && resource.scope.agentId === agentId
    && (resource.kind === "knowledge" || resource.kind === "skill")
    && resource.evidenceState === "confirmed"
    && resource.aiManaged === false
    && (resource.lifecycleState === "active" || resource.lifecycleState === "archived")
    && Number.isInteger(resource.version)
    && resource.version > 0;
}

function safeSupportPath(value: string): boolean {
  if (!value || value.length > 1024 || value.startsWith("/") || value.includes("\\") || value.includes(":")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !/[\u0000-\u001f\u007f]/.test(segment));
}

export function nativeAgentSupportFilePath(file: NativeAgentSupportFile): string | undefined {
  const path = typeof file.path === "string" ? file.path : file.bodyPath;
  return typeof path === "string" && safeSupportPath(path) ? path : undefined;
}

function supportFileHash(file: NativeAgentSupportFile): string | undefined {
  const hash = typeof file.hash === "string" ? file.hash : file.bodyHash;
  if (!hash || hash.length > 256 || /[\u0000-\u001f\u007f]/.test(hash)) return undefined;
  return hash;
}

function supportFileVersion(file: NativeAgentSupportFile): number | undefined {
  const version = typeof file.version === "number" ? file.version : file.bodyVersion;
  return typeof version === "number" && Number.isInteger(version) && version > 0 ? version : undefined;
}

export function nativeAgentSafeSupportFiles(files: readonly NativeAgentSupportFile[] | undefined): NativeAgentSupportFile[] {
  const seen = new Set<string>();
  const safe: NativeAgentSupportFile[] = [];
  for (const file of files ?? []) {
    const path = nativeAgentSupportFilePath(file);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    safe.push({ path, ...(supportFileHash(file) ? { hash: supportFileHash(file) } : {}), ...(supportFileVersion(file) ? { version: supportFileVersion(file) } : {}) });
  }
  return safe;
}

function supportFileDraft(value: string): { files: NativeAgentSupportFile[]; invalidPath?: string } {
  const paths = value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
  for (const path of paths) {
    if (!safeSupportPath(path)) return { files: [], invalidPath: path };
  }
  return { files: nativeAgentSafeSupportFiles(paths.map((path) => ({ path }))) };
}

function mergeResource(resources: readonly NativeAgentResource[], next: NativeAgentResource): NativeAgentResource[] {
  const found = resources.some((resource) => resource.id === next.id);
  return found ? resources.map((resource) => resource.id === next.id ? next : resource) : [next, ...resources];
}

function detailFromResource(resource: NativeAgentResource): NativeAgentResourceDetail {
  return {
    resource,
    version: resource.version,
    supportFiles: resource.supportFiles
  };
}

function resourceTypeLabel(resource: NativeAgentResource): string {
  return resource.kind === "knowledge" && resource.knowledgeKind
    ? `${resourceKindLabels[resource.kind]}・${knowledgeKindLabels[resource.knowledgeKind]}`
    : resourceKindLabels[resource.kind];
}

function SupportFileList({ files, headingId }: { files: readonly NativeAgentSupportFile[] | undefined; headingId: string }) {
  const safeFiles = nativeAgentSafeSupportFiles(files);
  return <section className="native-agent-resources__support-card" aria-labelledby={headingId}>
    <h4 id={headingId}>Skill support file</h4>
    {safeFiles.length === 0 ? (
      <p className="native-agent-resources__muted">安全に確認できるSupport fileはありません。</p>
    ) : (
      <ul className="native-agent-resources__support-files" aria-label="Skill support file一覧">
        {safeFiles.map((file) => <li key={file.path}>
          <code>{file.path}</code>
          <span className="native-agent-resources__support-meta">
            {file.hash ? `hash: ${file.hash}` : "hash未確認"}・{file.version ? `version: ${file.version}` : "version未確認"}
          </span>
        </li>)}
      </ul>
    )}
  </section>;
}

interface ResourceFormProps {
  idPrefix: string;
  draft: ResourceDraft;
  title: string;
  submitLabel: string;
  busy: boolean;
  onChange: (patch: Partial<ResourceDraft>) => void;
  onCancel?: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

interface ResourceDraft {
  kind: NativeAgentResourceKind;
  knowledgeKind: NativeAgentKnowledgeKind;
  title: string;
  content: string;
  reason: string;
  supportFilePaths: string;
}

function ResourceForm({ idPrefix, draft, title, submitLabel, busy, onChange, onCancel, onSubmit }: ResourceFormProps) {
  const titleId = `${idPrefix}-title`;
  const kindId = `${idPrefix}-kind`;
  const knowledgeKindId = `${idPrefix}-knowledge-kind`;
  const contentId = `${idPrefix}-content`;
  const reasonId = `${idPrefix}-reason`;
  const filesId = `${idPrefix}-support-files`;
  return <form className="native-agent-resources__detail" aria-busy={busy} onSubmit={onSubmit}>
    <h3>{title}</h3>
    <label className="native-agent-resources__field" htmlFor={kindId}>
      <span>種別</span>
      <select id={kindId} value={draft.kind} onChange={(event) => onChange({ kind: event.currentTarget.value as NativeAgentResourceKind })} disabled={busy}>
        <option value="knowledge">Knowledge</option>
        <option value="skill">Skill</option>
      </select>
    </label>
    {draft.kind === "knowledge" ? <label className="native-agent-resources__field" htmlFor={knowledgeKindId}>
      <span>Knowledgeの種類</span>
      <select id={knowledgeKindId} value={draft.knowledgeKind} onChange={(event) => onChange({ knowledgeKind: event.currentTarget.value as NativeAgentKnowledgeKind })} disabled={busy}>
        {Object.entries(knowledgeKindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select>
    </label> : null}
    <label className="native-agent-resources__field" htmlFor={titleId}>
      <span>タイトル</span>
      <input id={titleId} value={draft.title} onChange={(event) => onChange({ title: event.currentTarget.value })} disabled={busy} required />
    </label>
    <label className="native-agent-resources__field" htmlFor={contentId}>
      <span>本文</span>
      <textarea id={contentId} value={draft.content} onChange={(event) => onChange({ content: event.currentTarget.value })} disabled={busy} required />
    </label>
    <label className="native-agent-resources__field" htmlFor={reasonId}>
      <span>変更理由</span>
      <input id={reasonId} value={draft.reason} onChange={(event) => onChange({ reason: event.currentTarget.value })} disabled={busy} required />
    </label>
    {draft.kind === "skill" ? <label className="native-agent-resources__field" htmlFor={filesId}>
      <span>Support fileの相対パス（1行1件）</span>
      <textarea id={filesId} value={draft.supportFilePaths} onChange={(event) => onChange({ supportFilePaths: event.currentTarget.value })} disabled={busy} placeholder="docs/checklist.md" />
    </label> : null}
    <div className="native-agent-resources__actions">
      <button className="native-agent-resources__button native-agent-resources__button--primary" type="submit" disabled={busy}>{busy ? "保存中…" : submitLabel}</button>
      {onCancel ? <button className="native-agent-resources__button native-agent-resources__button--quiet" type="button" onClick={onCancel} disabled={busy}>取消</button> : null}
    </div>
  </form>;
}

const emptyDraft = (): ResourceDraft => ({
  kind: "knowledge",
  knowledgeKind: "fact",
  title: "",
  content: "",
  reason: "Agent詳細から手動登録",
  supportFilePaths: ""
});

export default function NativeAgentResources(props: NativeAgentResourcesProps) {
  const id = useId().replace(/:/g, "");
  const canManage = props.canManage === true;
  const [localResources, setLocalResources] = useState<NativeAgentResource[]>(() => [...props.resources]);
  const [internalSelectedResourceId, setInternalSelectedResourceId] = useState<string | undefined>(props.selectedResourceId);
  const [detail, setDetail] = useState<NativeAgentResourceDetail | undefined>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [operation, setOperation] = useState<NativeAgentResourceOperation | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiveReason, setArchiveReason] = useState("Agent詳細から保管");
  const [createDraft, setCreateDraft] = useState<ResourceDraft>(emptyDraft);
  const [editDraft, setEditDraft] = useState<ResourceDraft>(emptyDraft);
  const detailRequest = useRef(0);
  const selectedResourceId = props.selectedResourceId ?? internalSelectedResourceId;

  useEffect(() => {
    setLocalResources([...props.resources]);
  }, [props.resources, props.agentId]);

  const visibleResources = useMemo(
    () => localResources.filter((resource) => nativeAgentResourceCanBeShown(resource, props.agentId)),
    [localResources, props.agentId]
  );
  const selectedResource = visibleResources.find((resource) => resource.id === selectedResourceId);

  const loadDetail = useCallback(async (resourceId: string) => {
    const resource = visibleResources.find((candidate) => candidate.id === resourceId);
    if (!resource) {
      setDetail(undefined);
      return;
    }
    const requestId = detailRequest.current + 1;
    detailRequest.current = requestId;
    setDetailError(null);
    setDetailLoading(true);
    try {
      const loaded = props.onLoadResource
        ? await props.onLoadResource({ agentId: props.agentId, resourceId })
        : detailFromResource(resource);
      if (requestId !== detailRequest.current) return;
      if (loaded.resource.id !== resourceId || !nativeAgentResourceCanBeShown(loaded.resource, props.agentId)) {
        throw new Error("agent_resource_scope_mismatch");
      }
      if (!Number.isInteger(loaded.version) || loaded.version <= 0 || loaded.resource.version !== loaded.version) throw new Error("agent_resource_version_invalid");
      setDetail(loaded);
      setEditDraft({
        kind: loaded.resource.kind,
        knowledgeKind: loaded.resource.knowledgeKind ?? "fact",
        title: loaded.resource.title,
        content: loaded.content ?? "",
        reason: loaded.reason ?? "Agent詳細から手動更新",
        supportFilePaths: nativeAgentSafeSupportFiles(loaded.supportFiles ?? loaded.resource.supportFiles).map((file) => file.path).join("\n")
      });
    } catch (error) {
      if (requestId !== detailRequest.current) return;
      setDetail(undefined);
      setDetailError(nativeAgentResourceErrorMessage(error, "load"));
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }, [props.agentId, props.onLoadResource, visibleResources]);

  useEffect(() => {
    setCreating(false);
    setEditing(false);
    setArchiveConfirming(false);
    setDetailError(null);
    if (selectedResourceId) void loadDetail(selectedResourceId);
    else setDetail(undefined);
  }, [loadDetail, selectedResourceId]);

  useEffect(() => {
    if (selectedResourceId && !selectedResource) {
      setInternalSelectedResourceId(undefined);
      setDetail(undefined);
    }
  }, [selectedResource, selectedResourceId]);

  const selectResource = (resourceId: string) => {
    if (!visibleResources.some((resource) => resource.id === resourceId)) return;
    setInternalSelectedResourceId(resourceId);
    setCreating(false);
    setEditing(false);
    setArchiveConfirming(false);
    setLocalError(null);
    void Promise.resolve(props.onSelectResource?.({ agentId: props.agentId, resourceId })).catch((error) => {
      setLocalError(nativeAgentResourceErrorMessage(error, "load"));
    });
  };

  const updateCreateDraft = (patch: Partial<ResourceDraft>) => setCreateDraft((current) => ({ ...current, ...patch }));
  const updateEditDraft = (patch: Partial<ResourceDraft>) => setEditDraft((current) => ({ ...current, ...patch }));

  const createResource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || !props.onCreateResource || operation) return;
    const draft = createDraft;
    if (!draft.title.trim() || !draft.content.trim() || !draft.reason.trim()) {
      setLocalError("タイトル、本文、変更理由を入力してください。");
      return;
    }
    const parsed = draft.kind === "skill" ? supportFileDraft(draft.supportFilePaths) : { files: [] };
    if (parsed.invalidPath) {
      setLocalError(`安全な相対パスではありません: ${parsed.invalidPath}`);
      return;
    }
    setOperation("create");
    setLocalError(null);
    try {
      const created = await props.onCreateResource({
        agentId: props.agentId,
        scopeKind: "agent",
        kind: draft.kind,
        ...(draft.kind === "knowledge" ? { knowledgeKind: draft.knowledgeKind } : {}),
        title: draft.title.trim(),
        content: draft.content,
        reason: draft.reason.trim(),
        aiManaged: false,
        supportFiles: parsed.files
      });
      if (!nativeAgentResourceCanBeShown(created, props.agentId)) throw new Error("agent_resource_scope_mismatch");
      setLocalResources((resources) => mergeResource(resources, created));
      setInternalSelectedResourceId(created.id);
      setDetail({ resource: created, version: created.version, content: draft.content, supportFiles: parsed.files });
      setCreateDraft(emptyDraft());
      setCreating(false);
    } catch (error) {
      setLocalError(nativeAgentResourceErrorMessage(error, "create"));
    } finally {
      setOperation(null);
    }
  };

  const updateResource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManage || !props.onUpdateResource || !selectedResource || !detail || operation || detail.content === undefined) return;
    const draft = editDraft;
    if (!draft.title.trim() || !draft.content.trim() || !draft.reason.trim()) {
      setLocalError("タイトル、本文、変更理由を入力してください。");
      return;
    }
    const parsed = draft.kind === "skill" ? supportFileDraft(draft.supportFilePaths) : { files: [] };
    if (parsed.invalidPath) {
      setLocalError(`安全な相対パスではありません: ${parsed.invalidPath}`);
      return;
    }
    setOperation("update");
    setLocalError(null);
    try {
      const updated = await props.onUpdateResource({
        resourceId: selectedResource.id,
        agentId: props.agentId,
        scopeKind: "agent",
        kind: draft.kind,
        ...(draft.kind === "knowledge" ? { knowledgeKind: draft.knowledgeKind } : {}),
        title: draft.title.trim(),
        content: draft.content,
        reason: draft.reason.trim(),
        expectedVersion: detail.version,
        aiManaged: false,
        supportFiles: parsed.files
      });
      if (!nativeAgentResourceCanBeShown(updated, props.agentId)) throw new Error("agent_resource_scope_mismatch");
      setLocalResources((resources) => mergeResource(resources, updated));
      setDetail((current) => current ? { ...current, resource: updated, version: updated.version, content: draft.content, supportFiles: parsed.files } : current);
      setEditing(false);
    } catch (error) {
      setLocalError(nativeAgentResourceErrorMessage(error, "update"));
    } finally {
      setOperation(null);
    }
  };

  const archiveResource = async () => {
    if (!canManage || !props.onArchiveResource || !selectedResource || !detail || operation || selectedResource.lifecycleState === "archived") return;
    if (!archiveConfirming) {
      setArchiveConfirming(true);
      return;
    }
    if (!archiveReason.trim()) {
      setLocalError("保管理由を入力してください。");
      return;
    }
    setOperation("archive");
    setLocalError(null);
    try {
      const archived = await props.onArchiveResource({
        agentId: props.agentId,
        resourceId: selectedResource.id,
        expectedVersion: detail.version,
        reason: archiveReason.trim()
      });
      if (!nativeAgentResourceCanBeShown(archived, props.agentId)) throw new Error("agent_resource_scope_mismatch");
      setLocalResources((resources) => mergeResource(resources, archived));
      setDetail((current) => current ? { ...current, resource: archived, version: archived.version } : current);
      setArchiveConfirming(false);
    } catch (error) {
      setLocalError(nativeAgentResourceErrorMessage(error, "archive"));
    } finally {
      setOperation(null);
    }
  };

  const openShare = async () => {
    if (!canManage || !props.onOpenShare || !selectedResource || operation || selectedResource.lifecycleState === "archived") return;
    setOperation("share");
    setLocalError(null);
    try {
      await props.onOpenShare({ agentId: props.agentId, resourceId: selectedResource.id, kind: selectedResource.kind });
    } catch (error) {
      setLocalError(nativeAgentResourceErrorMessage(error, "share"));
    } finally {
      setOperation(null);
    }
  };

  const detailResource = detail?.resource ?? selectedResource;
  const canEdit = Boolean(canManage && props.onUpdateResource && detailResource && detailResource.lifecycleState === "active" && detail?.content !== undefined);
  const canArchive = Boolean(canManage && props.onArchiveResource && selectedResource && detail && selectedResource.lifecycleState === "active");
  const statusError = props.error ?? localError ?? detailError;

  return <section className="native-agent-resources" aria-labelledby={`${id}-title`} aria-busy={operation !== null || props.loading}>
    <style>{panelStyles}</style>
    <header className="native-agent-resources__header">
      <div>
        <span className="native-agent-resources__eyebrow">Agent resources</span>
        <h2 id={`${id}-title`}>AgentのKnowledge / Skill</h2>
        <p className="native-agent-resources__lede">確認済みのAgent固有資源を、本文と版を確認しながら手動で管理します。</p>
        <div className="native-agent-resources__target" aria-label="固定したAgent">
          <span>対象Agent:</span>
          <strong>{props.agentLabel ?? "選択中のAgent"}</strong>
          <code>{props.agentId || "未選択"}</code>
          <span className="native-agent-resources__badge">対象固定</span>
        </div>
      </div>
    </header>

    <p className="native-agent-resources__notice">Roomの自動学習や別の保存範囲はこの画面から変更しません。管理権限と確認済み状態を満たす資源だけを操作できます。</p>
    {statusError ? <p className="native-agent-resources__error" role="alert" aria-live="assertive">{statusError}</p> : null}
    {props.loading ? <p className="native-agent-resources__status" role="status" aria-live="polite">Agent資源を読み込み中…</p> : null}
    {!canManage ? <p className="native-agent-resources__warning" role="status">管理権限が確認できないため、作成・更新・保管・共有は利用できません。</p> : null}

    <div className="native-agent-resources__grid">
      <section className="native-agent-resources__card" aria-labelledby={`${id}-list-title`}>
        <div className="native-agent-resources__card-header">
          <div>
            <h3 id={`${id}-list-title`}>確認済み資源</h3>
            <p className="native-agent-resources__muted">Agentに属するKnowledgeとSkillだけを表示します。</p>
          </div>
          {canManage && props.onCreateResource ? <button className="native-agent-resources__button native-agent-resources__button--primary" type="button" onClick={() => { setCreating(true); setEditing(false); setLocalError(null); }} disabled={operation !== null}>新規作成</button> : null}
        </div>
        {!props.loading && visibleResources.length === 0 ? <p className="native-agent-resources__empty">確認済みのAgent資源はありません。</p> : null}
        <ul className="native-agent-resources__resource-list" aria-label="確認済みAgent資源">
          {visibleResources.map((resource) => <li className="native-agent-resources__resource-row" key={resource.id}>
            <button className="native-agent-resources__resource-button" type="button" aria-current={resource.id === selectedResourceId ? "true" : undefined} onClick={() => selectResource(resource.id)} disabled={operation !== null}>
              <span className="native-agent-resources__resource-topline"><span className="native-agent-resources__resource-title">{resource.title}</span><span className="native-agent-resources__badge">{resourceTypeLabel(resource)}</span></span>
              <span className="native-agent-resources__meta">version {resource.version}・{resource.lifecycleState === "archived" ? "保管済み" : "有効"}</span>
            </button>
          </li>)}
        </ul>
      </section>

      <section className="native-agent-resources__card" aria-labelledby={`${id}-detail-title`}>
        {creating ? <ResourceForm idPrefix={`${id}-create`} draft={createDraft} title="Agent資源を作成" submitLabel="作成" busy={operation === "create"} onChange={updateCreateDraft} onCancel={() => { setCreating(false); setCreateDraft(emptyDraft()); }} onSubmit={createResource} /> : detailResource ? (
          <div className="native-agent-resources__detail">
            <div className="native-agent-resources__card-header">
              <div>
                <h3 id={`${id}-detail-title`} className="native-agent-resources__detail-title">{detailResource.title}</h3>
                <div className="native-agent-resources__detail-meta"><span>{resourceTypeLabel(detailResource)}</span><span>version {detail?.version ?? detailResource.version}</span><span>{detailResource.lifecycleState === "archived" ? "保管済み" : "有効"}</span></div>
              </div>
            </div>
            {detailLoading ? <p className="native-agent-resources__status" role="status" aria-live="polite">本文と根拠を読み込み中…</p> : null}
            {!detailLoading && detail?.content === undefined ? <p className="native-agent-resources__warning" role="status">本文を確認できる接続がないため、編集は無効です。</p> : null}
            {!detailLoading && detail?.content !== undefined && !editing ? <>
              <pre className="native-agent-resources__body" aria-label="Agent資源の本文">{detail.content || "本文は空です。"}</pre>
              {detailResource.kind === "skill" ? <SupportFileList headingId={`${id}-support-files-title`} files={detail.supportFiles ?? detailResource.supportFiles} /> : null}
            </> : null}
            {editing && canEdit ? <ResourceForm idPrefix={`${id}-edit`} draft={editDraft} title="Agent資源を編集" submitLabel="更新を保存" busy={operation === "update"} onChange={updateEditDraft} onCancel={() => setEditing(false)} onSubmit={updateResource} /> : null}
            {!editing ? <div className="native-agent-resources__actions">
              {canEdit ? <button className="native-agent-resources__button native-agent-resources__button--quiet" type="button" onClick={() => { setEditDraft((current) => current); setEditing(true); setLocalError(null); }} disabled={operation !== null}>編集</button> : null}
              {canArchive ? <button className="native-agent-resources__button native-agent-resources__button--danger" type="button" onClick={() => void archiveResource()} disabled={operation !== null}>{archiveConfirming ? "保管を確定" : "保管"}</button> : null}
              {canManage && props.onOpenShare && detailResource.lifecycleState === "active" ? <button className="native-agent-resources__button native-agent-resources__button--quiet" type="button" onClick={() => void openShare()} disabled={operation !== null}>共有を開く</button> : null}
            </div> : null}
            {archiveConfirming ? <div className="native-agent-resources__field">
              <label htmlFor={`${id}-archive-reason`}>保管理由</label>
              <input id={`${id}-archive-reason`} value={archiveReason} onChange={(event) => setArchiveReason(event.currentTarget.value)} disabled={operation !== null} />
              <p className="native-agent-resources__warning" role="status">保管すると通常のAgent資源一覧では有効資源として扱われません。本文は削除しません。</p>
              <button className="native-agent-resources__button native-agent-resources__button--quiet" type="button" onClick={() => setArchiveConfirming(false)} disabled={operation !== null}>保管を取り消す</button>
            </div> : null}
          </div>
        ) : (
          <div className="native-agent-resources__empty" role="status">一覧からAgent資源を選ぶと、本文・版・根拠を確認できます。</div>
        )}
      </section>
    </div>
  </section>;
}
