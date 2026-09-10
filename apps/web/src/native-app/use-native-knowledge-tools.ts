import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  supportedLocales,
  type AutomationJobRecord,
  type JsonValue,
  type SettingsRecord,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import {
  createIdempotencyKey,
  getWorkspaceClientBridge,
  type AutomationRunSummary,
  type DesktopWorkspaceConnectionState,
  type DesktopWorkspaceLearningSettings,
  type DesktopWorkspaceTarget,
  type SearchResult,
  type WorkspaceCompletionResourceBody,
  type WorkspaceCompletionResourceDetail,
  type WorkspaceCompletionResourceView
} from "../lib/api";
import type { NativeWorkspaceTarget } from "./types";
import {
  activeNativeWorkspaceTarget,
  assertNativeWorkspaceTarget,
  nativeWorkspaceTargetKey,
  withNativeWorkspaceTarget
} from "./native-workspace-target";

export type NativeKnowledgeToolsTab = "knowledge" | "search" | "settings" | "automation";
export type NativeKnowledgeResourceKind = "knowledge" | "skill";
export type NativeKnowledgeResourceScope = "workspace" | "room";

export interface NativeKnowledgeToolsTarget extends NativeWorkspaceTarget {
  roomId: string;
}

export type NativeKnowledgeToolsBridge = NonNullable<Window["samuraiDesktop"]>;

export interface NativeKnowledgeResourceDetail {
  resource: WorkspaceCompletionResourceView;
  version: WorkspaceCompletionResourceDetail["current_version"];
  content: string;
  versions: Array<Record<string, JsonValue>>;
  evidence: Array<Record<string, JsonValue>>;
}

export interface NativeKnowledgeToolsDraft {
  resourceId: string;
  kind: NativeKnowledgeResourceKind;
  scopeKind: NativeKnowledgeResourceScope;
  roomId?: string;
  title: string;
  content: string;
  reason: string;
  expectedVersion: number;
  dirty: boolean;
}

/**
 * Returns whether the resource draft still represents the exact values which
 * were submitted by a mutation. The dirty flag is intentionally excluded:
 * React can keep that flag true while the submitted values are unchanged, and
 * the values themselves are the source of truth for deciding whether a
 * concurrent edit must be preserved.
 */
export function nativeKnowledgeDraftMatchesSnapshot(
  current: NativeKnowledgeToolsDraft | undefined,
  submitted: NativeKnowledgeToolsDraft
): boolean {
  if (!current) return false;
  return current.resourceId === submitted.resourceId
    && current.kind === submitted.kind
    && current.scopeKind === submitted.scopeKind
    && current.roomId === submitted.roomId
    && current.title === submitted.title
    && current.content === submitted.content
    && current.reason === submitted.reason
    && current.expectedVersion === submitted.expectedVersion;
}

/**
 * Resolves the local draft after a successful Knowledge mutation. The values
 * that were submitted may be cleared, but a newer local edit must receive the
 * returned version and remain dirty for the next explicit save.
 */
export function nativeKnowledgeDraftAfterMutation(
  current: NativeKnowledgeToolsDraft | undefined,
  submitted: NativeKnowledgeToolsDraft,
  savedResource: Pick<WorkspaceCompletionResourceView, "version">
): NativeKnowledgeToolsDraft | undefined {
  if (!current || nativeKnowledgeDraftMatchesSnapshot(current, submitted)) return undefined;
  return {
    ...current,
    expectedVersion: savedResource.version,
    dirty: true
  };
}

export interface NativeKnowledgeToolsCreateDraft {
  kind: "knowledge" | "skill";
  scopeKind: NativeKnowledgeResourceScope;
  roomId?: string;
  knowledgeKind: "fact" | "decision" | "explanation" | "experience_rule";
  title: string;
  content: string;
  reason: string;
  dirty: boolean;
}

export interface NativeRoomSearchResult {
  key: string;
  kind: SearchResult["kind"] | "knowledge";
  id: string;
  title: string;
  summary: string;
  session_id?: string;
  work_id?: string;
  operation_id?: string;
  resource?: WorkspaceCompletionResourceView;
  rank?: number;
}

/** A mutation response is authoritative when a just-created resource is opened. */
export function nativeKnowledgeResourceForOpen(
  resources: readonly WorkspaceCompletionResourceView[],
  resourceId: string,
  resourceOverride?: WorkspaceCompletionResourceView
): WorkspaceCompletionResourceView | undefined {
  return resourceOverride ?? resources.find((resource) => resource.id === resourceId);
}

/** Search hits are openable only when the client has an exact navigation ref. */
export function nativeRoomSearchResultCanOpen(result: NativeRoomSearchResult, hasHostHandler: boolean): boolean {
  if (result.resource) return true;
  if (!hasHostHandler) return false;
  if (result.kind === "artifact") return Boolean(result.id);
  if (result.kind === "session" || result.kind === "message") return Boolean(result.work_id);
  return false;
}

/** Describes the truthful fallback when a search hit cannot be opened. */
export function nativeRoomSearchResultOpenHint(result: NativeRoomSearchResult, hasHostHandler: boolean): string {
  if (result.kind === "session" || result.kind === "message") {
    if (!result.work_id) return "仕事の参照（work_id）がないため開けません。検索結果のタイトルと概要を確認してください。";
    if (!hasHostHandler) return "現在の画面に仕事を開く入口がありません。";
  }
  if (result.kind === "audit") return "監査履歴を開く入口がありません。";
  if (!hasHostHandler) return "現在の画面に開く入口がありません。";
  return "この検索結果を開く入口がありません。";
}

export interface NativeLearningSettingsSnapshot {
  effective: DesktopWorkspaceLearningSettings;
  workspace?: DesktopWorkspaceLearningSettings;
  room?: DesktopWorkspaceLearningSettings;
}

export interface NativeKnowledgeToolsSettings {
  workspace: SettingsRecord;
  learning: NativeLearningSettingsSnapshot;
}

export interface NativeKnowledgeToolsSettingsDraft {
  uiLocale: SupportedLocale;
  outputLocale: SupportedLocale;
  learningEnabled: boolean;
  learningScope: "workspace" | "room";
  scopedLearningEnabled: boolean;
}

export interface UseNativeKnowledgeToolsOptions {
  target?: NativeKnowledgeToolsTarget;
  initialTab?: NativeKnowledgeToolsTab;
  /** Test seam. Production callers use window.samuraiDesktop through the helper. */
  bridge?: NativeKnowledgeToolsBridge;
}

export interface NativeKnowledgeToolsState {
  target?: NativeKnowledgeToolsTarget;
  targetKey: string;
  tab: NativeKnowledgeToolsTab;
  setTab: (tab: NativeKnowledgeToolsTab) => void;
  bridgeAvailable: boolean;
  readOnly: boolean;

  roomResources: WorkspaceCompletionResourceView[];
  workspaceResources: WorkspaceCompletionResourceView[];
  skills: WorkspaceCompletionResourceView[];
  resourcesLoading: boolean;
  resourcesError: string | null;
  reloadResources: () => Promise<void>;
  selectedResourceId?: string;
  selectedResource?: NativeKnowledgeResourceDetail;
  resourceLoading: boolean;
  resourceError: string | null;
  draft?: NativeKnowledgeToolsDraft;
  createDraft?: NativeKnowledgeToolsCreateDraft;
  createBusy: boolean;
  resourceBusy: "save" | "fixed" | "archive" | null;
  openResource: (resourceId: string) => Promise<void>;
  startCreateResource: () => boolean;
  updateCreateDraft: (patch: Partial<Pick<NativeKnowledgeToolsCreateDraft, "kind" | "scopeKind" | "roomId" | "knowledgeKind" | "title" | "content" | "reason">>) => void;
  cancelCreate: () => void;
  createResource: () => Promise<boolean>;
  requestResourceLeave: () => boolean;
  discardUnsavedChanges: () => void;
  updateDraft: (patch: Partial<Pick<NativeKnowledgeToolsDraft, "title" | "content" | "reason">>) => void;
  cancelDraft: () => void;
  saveResource: () => Promise<boolean>;
  toggleFixed: () => Promise<boolean>;
  toggleArchived: () => Promise<boolean>;
  resourceCanEdit: boolean;
  resourceCanFix: boolean;
  resourceCanArchive: boolean;

  searchQuery: string;
  setSearchQuery: (query: string) => void;
  searchResults: NativeRoomSearchResult[];
  searchLoading: boolean;
  searchError: string | null;
  runSearch: () => Promise<void>;
  openSearchResult: (result: NativeRoomSearchResult) => Promise<void>;

  settings?: NativeKnowledgeToolsSettings;
  settingsDraft?: NativeKnowledgeToolsSettingsDraft;
  settingsLoading: boolean;
  settingsError: string | null;
  settingsBusy: "language" | "learning" | "override" | null;
  hasUnsavedChanges: boolean;
  saving: boolean;
  settingsLanguageDirty: boolean;
  settingsLearningDirty: boolean;
  settingsCanEdit: boolean;
  updateSettingsDraft: (patch: Partial<NativeKnowledgeToolsSettingsDraft>) => void;
  reloadSettings: () => Promise<void>;
  saveLanguageSettings: () => Promise<boolean>;
  saveLearningSettings: () => Promise<boolean>;
  removeRoomLearningOverride: () => Promise<boolean>;

  automationJobs: AutomationJobRecord[];
  automationRuns: AutomationRunSummary[];
  automationLoading: boolean;
  automationError: string | null;
  automationBusyJobId?: string;
  automationCanManage: boolean;
  reloadAutomation: () => Promise<void>;
  toggleAutomation: (job: AutomationJobRecord) => Promise<boolean>;
}

const supportedLocaleSet = new Set<string>(supportedLocales);

export function nativeKnowledgeToolsTargetKey(target?: NativeKnowledgeToolsTarget): string {
  return target ? `${target.connectionId}\n${target.workspaceId}\n${target.roomId}` : "no-target";
}

export function nativeKnowledgeWorkspaceTargetKey(target?: NativeWorkspaceTarget): string {
  return target ? nativeWorkspaceTargetKey(target) : "no-workspace-target";
}

export function sameNativeKnowledgeToolsTarget(
  left?: NativeKnowledgeToolsTarget,
  right?: NativeKnowledgeToolsTarget
): boolean {
  return Boolean(left && right)
    && left?.connectionId === right?.connectionId
    && left?.workspaceId === right?.workspaceId
    && left?.roomId === right?.roomId;
}

export function resourceMatchesNativeKnowledgeToolsTarget(
  resource: WorkspaceCompletionResourceView,
  target: NativeKnowledgeToolsTarget
): boolean {
  if (resource.workspaceId !== target.workspaceId) return false;
  if (resource.scope.kind === "workspace") return true;
  return resource.scope.kind === "room" && resource.scope.roomId === target.roomId;
}

export function isNativeKnowledgeResourceKind(value: WorkspaceCompletionResourceView["kind"]): value is NativeKnowledgeResourceKind {
  return value === "knowledge" || value === "skill";
}

export function automationJobMatchesNativeKnowledgeToolsTarget(
  job: AutomationJobRecord,
  target: NativeKnowledgeToolsTarget
): boolean {
  return job.workspace_id !== undefined && job.workspace_id === target.workspaceId
    && job.room_id === target.roomId;
}

export function automationRunMatchesNativeKnowledgeToolsTarget(
  run: AutomationRunSummary,
  target: NativeKnowledgeToolsTarget
): boolean {
  const candidate = run as AutomationRunSummary & { workspace_id?: string; room_id?: string };
  return (candidate.workspace_id === undefined || candidate.workspace_id === target.workspaceId)
    && candidate.room_id === target.roomId;
}

export function activeDesktopTargetFromConnectionState(
  state: DesktopWorkspaceConnectionState
): DesktopWorkspaceTarget | undefined {
  return activeNativeWorkspaceTarget(state);
}

export async function assertNativeKnowledgeToolsTarget(
  bridge: NativeKnowledgeToolsBridge,
  target: NativeKnowledgeToolsTarget
): Promise<void> {
  await assertNativeWorkspaceTarget(bridge, target);
}

export async function withNativeKnowledgeToolsTarget<T>(
  bridge: NativeKnowledgeToolsBridge,
  target: NativeKnowledgeToolsTarget,
  task: () => Promise<T>
): Promise<T> {
  return withNativeWorkspaceTarget(bridge, target, task);
}

export function nativeKnowledgeToolsErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const normalized = raw.toLowerCase();
  if (normalized.includes("workspace_navigation_changed") || normalized.includes("workspace_target")) {
    return "WorkspaceまたはRoomの対象が切り替わりました。現在の画面を更新してください。";
  }
  if (normalized.includes("conflict") || normalized.includes("version") || normalized.includes("stale")) {
    return "先行する変更があります。下書きを保持したまま、現在版を確認してください。";
  }
  if (normalized.includes("forbidden") || normalized.includes("permission") || normalized.includes("unauthorized") || normalized.includes("access")) {
    return "このRoomまたはWorkspaceでは、その操作を実行できません。内容は保持されています。";
  }
  if (normalized.includes("unavailable") || normalized.includes("required")) {
    return "この操作に必要な既存bridgeが利用できません。読み取り専用で表示しています。";
  }
  return raw || "補助パネルの処理に失敗しました。内容は保持されています。";
}

function cloneTarget(target?: NativeKnowledgeToolsTarget): NativeKnowledgeToolsTarget | undefined {
  return target ? { connectionId: target.connectionId, workspaceId: target.workspaceId, roomId: target.roomId } : undefined;
}

function resourceVersion(detail?: NativeKnowledgeResourceDetail): number {
  return detail?.version.version ?? detail?.resource.version ?? 0;
}

function resourceScopeInput(resource: WorkspaceCompletionResourceView, target: NativeKnowledgeToolsTarget): {
  scopeKind: NativeKnowledgeResourceScope;
  roomId?: string;
} {
  return resource.scope.kind === "room"
    ? { scopeKind: "room", roomId: target.roomId }
    : { scopeKind: "workspace" };
}

function isSupportedLocale(value: string): value is SupportedLocale {
  return supportedLocaleSet.has(value);
}

function fallbackResourceVersion(resource: WorkspaceCompletionResourceView): WorkspaceCompletionResourceDetail["current_version"] {
  return {
    version: resource.version,
    metadata: {},
    contentHash: "",
    reason: "現在版",
    createdAt: resource.updatedAt
  };
}

type CompletionResourcePage<T extends WorkspaceCompletionResourceView = WorkspaceCompletionResourceView> = {
  resources: T[];
  next_cursor?: string;
};

const maxCompletionResourcePages = 100;

/**
 * Completion endpoints are cursor based. The management surface deliberately
 * drains the cursor so a resource which is outside the first server page is
 * still reachable, while rejecting malformed/cyclic pagination instead of
 * silently presenting an incomplete catalog.
 */
export async function collectCompletionResourcePages<T extends WorkspaceCompletionResourceView = WorkspaceCompletionResourceView>(
  fetchPage: (cursor?: string) => Promise<CompletionResourcePage<T>>
): Promise<T[]> {
  const resources: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < maxCompletionResourcePages; pageNumber += 1) {
    const page = await fetchPage(cursor);
    if (!page || !Array.isArray(page.resources)) throw new Error("workspace_completion_resource_page_invalid");
    resources.push(...page.resources);
    const nextCursor = typeof page.next_cursor === "string" && page.next_cursor.length > 0
      ? page.next_cursor
      : undefined;
    if (!nextCursor) return resources;
    if (seenCursors.has(nextCursor)) throw new Error("workspace_completion_resource_cursor_repeated");
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("workspace_completion_resource_page_limit_exceeded");
}

function stableNativeKnowledgeJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function resourceDetailFromResponses(
  requestedId: string,
  view: WorkspaceCompletionResourceView,
  detail: WorkspaceCompletionResourceDetail | undefined,
  body: WorkspaceCompletionResourceBody | { resource: WorkspaceCompletionResourceView; version: WorkspaceCompletionResourceDetail["current_version"]; content: string }
): NativeKnowledgeResourceDetail {
  if (view.id !== requestedId || body.resource.id !== requestedId || (detail && detail.resource.id !== requestedId)) {
    throw new Error("workspace_resource_response_scope_invalid");
  }
  const resolvedResource = detail?.resource ?? body.resource;
  return {
    resource: resolvedResource,
    version: body.version ?? detail?.current_version ?? fallbackResourceVersion(resolvedResource),
    content: body.content,
    versions: detail?.versions ?? [],
    evidence: detail?.evidence ?? []
  };
}

function learningSnapshotFromResponse(value: {
  settings: DesktopWorkspaceLearningSettings;
  workspace_settings?: DesktopWorkspaceLearningSettings;
  room_settings?: DesktopWorkspaceLearningSettings;
}, target: NativeKnowledgeToolsTarget): NativeLearningSettingsSnapshot {
  const values: DesktopWorkspaceLearningSettings[] = [value.settings, value.workspace_settings, value.room_settings]
    .filter((item): item is DesktopWorkspaceLearningSettings => Boolean(item));
  if (values.some((item) => item.workspaceId !== target.workspaceId)) throw new Error("workspace_learning_response_scope_invalid");
  if (value.room_settings && (value.room_settings.scope.kind !== "room" || value.room_settings.scope.roomId !== target.roomId)) {
    throw new Error("workspace_learning_room_scope_invalid");
  }
  if (value.workspace_settings && value.workspace_settings.scope.kind !== "workspace") {
    throw new Error("workspace_learning_workspace_scope_invalid");
  }
  if (value.settings.scope.kind === "room" && value.settings.scope.roomId !== target.roomId) {
    throw new Error("workspace_learning_effective_scope_invalid");
  }
  return {
    effective: value.settings,
    ...(value.workspace_settings ? { workspace: value.workspace_settings } : {}),
    ...(value.room_settings ? { room: value.room_settings } : {})
  };
}

export function useNativeKnowledgeTools(options: UseNativeKnowledgeToolsOptions = {}): NativeKnowledgeToolsState {
  const requestedTarget = cloneTarget(options.target);
  const targetKey = nativeKnowledgeToolsTargetKey(requestedTarget);
  const getBridge = useCallback(() => options.bridge ?? getWorkspaceClientBridge(), [options.bridge]);
  const targetRef = useRef<NativeKnowledgeToolsTarget | undefined>(requestedTarget);
  const targetKeyRef = useRef(targetKey);
  targetRef.current = requestedTarget;
  targetKeyRef.current = targetKey;

  const [tab, setTab] = useState<NativeKnowledgeToolsTab>(options.initialTab ?? "knowledge");
  const [roomResources, setRoomResources] = useState<WorkspaceCompletionResourceView[]>([]);
  const [workspaceResources, setWorkspaceResources] = useState<WorkspaceCompletionResourceView[]>([]);
  const [skills, setSkills] = useState<WorkspaceCompletionResourceView[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string>();
  const [selectedResource, setSelectedResource] = useState<NativeKnowledgeResourceDetail>();
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NativeKnowledgeToolsDraft>();
  const [createDraft, setCreateDraft] = useState<NativeKnowledgeToolsCreateDraft>();
  const [createBusy, setCreateBusy] = useState(false);
  const [resourceBusy, setResourceBusy] = useState<NativeKnowledgeToolsState["resourceBusy"]>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<NativeRoomSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [settings, setSettings] = useState<NativeKnowledgeToolsSettings>();
  const [settingsDraft, setSettingsDraft] = useState<NativeKnowledgeToolsSettingsDraft>();
  const [settingsLanguageDirty, setSettingsLanguageDirty] = useState(false);
  const [settingsLearningDirty, setSettingsLearningDirty] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState<NativeKnowledgeToolsState["settingsBusy"]>(null);

  const [automationJobs, setAutomationJobs] = useState<AutomationJobRecord[]>([]);
  const [automationRuns, setAutomationRuns] = useState<AutomationRunSummary[]>([]);
  const [automationLoading, setAutomationLoading] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [automationBusyJobId, setAutomationBusyJobId] = useState<string>();

  const resourceGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const searchGeneration = useRef(0);
  const settingsGeneration = useRef(0);
  const automationGeneration = useRef(0);
  const resourceMutationOperationIds = useRef(new Map<string, { fingerprint: string; operationId: string }>());
  const createOperationRef = useRef<{ fingerprint: string; operationId: string } | undefined>(undefined);
  const draftRef = useRef<NativeKnowledgeToolsDraft | undefined>(undefined);
  const createDraftRef = useRef<NativeKnowledgeToolsCreateDraft | undefined>(undefined);
  const selectedResourceIdRef = useRef<string | undefined>(undefined);
  draftRef.current = draft;
  createDraftRef.current = createDraft;
  selectedResourceIdRef.current = selectedResourceId;

  const allResources = useMemo(
    () => [...roomResources, ...workspaceResources, ...skills],
    [roomResources, workspaceResources, skills]
  );

  const isCurrent = useCallback((capturedTargetKey: string): boolean => {
    return targetKeyRef.current === capturedTargetKey
      && nativeKnowledgeToolsTargetKey(targetRef.current) === capturedTargetKey;
  }, []);

  const discardUnsavedChanges = useCallback((): void => {
    draftRef.current = undefined;
    createDraftRef.current = undefined;
    setDraft(undefined);
    setCreateDraft(undefined);
    setSettingsDraft(undefined);
    setSettingsLanguageDirty(false);
    setSettingsLearningDirty(false);
    setResourceError(null);
  }, []);

  const requestResourceLeave = useCallback((): boolean => {
    const hasDirtyDraft = Boolean(draftRef.current?.dirty || createDraftRef.current?.dirty || settingsLanguageDirty || settingsLearningDirty);
    if (!hasDirtyDraft) return true;
    const shouldDiscard = typeof window !== "undefined" && typeof window.confirm === "function"
      ? window.confirm("未保存の下書きを破棄して、この画面を離れますか？")
      : false;
    if (!shouldDiscard) {
      setResourceError("未保存の下書きを保持しています。保存または取消を選んでください。");
      return false;
    }
    discardUnsavedChanges();
    return true;
  }, [discardUnsavedChanges, settingsLanguageDirty, settingsLearningDirty]);

  const reloadResources = useCallback(async (): Promise<void> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const generation = ++resourceGeneration.current;
    if (!capturedTarget) {
      setRoomResources([]);
      setWorkspaceResources([]);
      setSkills([]);
      setResourcesError(null);
      return;
    }
    const bridge = getBridge();
    if (!bridge?.listWorkspaceCompletionResources) {
      setResourcesError("Knowledgeの既存bridgeが利用できないため、読み取り専用で表示できません。");
      return;
    }
    setResourcesLoading(true);
    setResourcesError(null);
    try {
      const listResources = (input: { scopeKind: "room" | "workspace"; kind: "knowledge" | "skill" }) => collectCompletionResourcePages(
        (cursor) => withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.listWorkspaceCompletionResources!({
          ...input,
          ...(input.scopeKind === "room" ? { roomId: capturedTarget.roomId } : {}),
          includeArchived: true,
          ...(cursor ? { cursor } : {}),
          target: capturedTarget
        }))
      );
      const [roomKnowledge, workspaceKnowledge, roomSkills, workspaceSkills] = await Promise.all([
        listResources({ scopeKind: "room", kind: "knowledge" }),
        listResources({ scopeKind: "workspace", kind: "knowledge" }),
        listResources({ scopeKind: "room", kind: "skill" }),
        listResources({ scopeKind: "workspace", kind: "skill" })
      ]);
      if (generation !== resourceGeneration.current || !isCurrent(capturedTargetKey)) return;
      const room = roomKnowledge.filter((resource) => resource.kind === "knowledge"
        && resource.scope.kind === "room"
        && resource.scope.roomId === capturedTarget.roomId
        && resource.workspaceId === capturedTarget.workspaceId);
      const workspace = workspaceKnowledge.filter((resource) => resource.kind === "knowledge"
        && resource.scope.kind === "workspace"
        && resource.workspaceId === capturedTarget.workspaceId);
      const listedSkills = [...roomSkills, ...workspaceSkills]
        .filter((resource) => resource.kind === "skill" && resourceMatchesNativeKnowledgeToolsTarget(resource, capturedTarget));
      const uniqueSkills = [...new Map(listedSkills.map((resource) => [resource.id, resource])).values()];
      setRoomResources(room);
      setWorkspaceResources(workspace);
      setSkills(uniqueSkills);
    } catch (error) {
      if (generation === resourceGeneration.current && isCurrent(capturedTargetKey)) {
        setResourcesError(nativeKnowledgeToolsErrorMessage(error));
      }
    } finally {
      if (generation === resourceGeneration.current && isCurrent(capturedTargetKey)) setResourcesLoading(false);
    }
  }, [getBridge, isCurrent]);

  const openResource = useCallback(async (resourceId: string, resourceOverride?: WorkspaceCompletionResourceView): Promise<void> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const listed = nativeKnowledgeResourceForOpen(allResources, resourceId, resourceOverride);
    if (selectedResourceIdRef.current !== resourceId && !requestResourceLeave()) return;
    const generation = ++detailGeneration.current;
    if (!capturedTarget || !listed) {
      setResourceError("この資源は現在のRoomから開けません。");
      return;
    }
    const bridge = getBridge();
    if (!bridge?.getWorkspaceCompletionResourceBody) {
      setResourceError("Knowledge本文の既存bridgeが利用できないため、読み取り専用で表示できません。");
      return;
    }
    selectedResourceIdRef.current = resourceId;
    setSelectedResourceId(resourceId);
    setSelectedResource(undefined);
    draftRef.current = undefined;
    setDraft(undefined);
    setResourceLoading(true);
    setResourceError(null);
    try {
      const [detail, body] = await Promise.all([
        bridge.getWorkspaceCompletionResource
          ? withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.getWorkspaceCompletionResource!({ resourceId, target: capturedTarget }))
          : Promise.resolve(undefined),
        listed.kind === "skill" && bridge.getWorkspaceCompletionSkill
          ? withNativeKnowledgeToolsTarget(bridge, capturedTarget, async () => {
            const result = await bridge.getWorkspaceCompletionSkill!({ resourceId, target: capturedTarget });
            return {
              resource: result.resource,
              version: result.version,
              content: result.content
            } satisfies Pick<NativeKnowledgeResourceDetail, "resource" | "version" | "content">;
          })
          : withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.getWorkspaceCompletionResourceBody!({ resourceId, target: capturedTarget }))
      ]);
      if (generation !== detailGeneration.current || !isCurrent(capturedTargetKey)) return;
      const resolved = resourceDetailFromResponses(
        resourceId,
        listed,
        detail,
        body as WorkspaceCompletionResourceBody & { resource: WorkspaceCompletionResourceView }
      );
      if (!resourceMatchesNativeKnowledgeToolsTarget(resolved.resource, capturedTarget)) throw new Error("workspace_resource_response_scope_invalid");
      if (!isNativeKnowledgeResourceKind(resolved.resource.kind)) throw new Error("workspace_resource_kind_invalid");
      setSelectedResource(resolved);
      setDraft({
        resourceId,
        kind: resolved.resource.kind,
        scopeKind: resolved.resource.scope.kind,
        ...(resolved.resource.scope.kind === "room" ? { roomId: capturedTarget.roomId } : {}),
        title: resolved.resource.title,
        content: resolved.content,
        reason: "",
        expectedVersion: resourceVersion(resolved),
        dirty: false
      });
    } catch (error) {
      if (generation === detailGeneration.current && isCurrent(capturedTargetKey)) setResourceError(nativeKnowledgeToolsErrorMessage(error));
    } finally {
      if (generation === detailGeneration.current && isCurrent(capturedTargetKey)) setResourceLoading(false);
    }
  }, [allResources, getBridge, isCurrent, requestResourceLeave]);

  const updateDraft = useCallback((patch: Partial<Pick<NativeKnowledgeToolsDraft, "title" | "content" | "reason">>): void => {
    const current = draftRef.current;
    const next = current ? { ...current, ...patch, dirty: true } : current;
    draftRef.current = next;
    setDraft(next);
  }, []);

  const cancelDraft = useCallback((): void => {
    if (!selectedResource) return;
    const current = draftRef.current;
    const next = current ? {
      ...current,
      title: selectedResource.resource.title,
      content: selectedResource.content,
      reason: "",
      expectedVersion: resourceVersion(selectedResource),
      dirty: false
    } : current;
    draftRef.current = next;
    setDraft(next);
    setResourceError(null);
  }, [selectedResource]);

  const validateResourceMutationResponse = useCallback((
    response: { resource: WorkspaceCompletionResourceView },
    resourceId: string,
    capturedTarget: NativeKnowledgeToolsTarget
  ): WorkspaceCompletionResourceView => {
    if (response.resource.id !== resourceId || !resourceMatchesNativeKnowledgeToolsTarget(response.resource, capturedTarget)) {
      throw new Error("workspace_resource_response_scope_invalid");
    }
    return response.resource;
  }, []);

  const resourceMutationOperationId = useCallback((
    key: string,
    fingerprint: string
  ): string => {
    const current = resourceMutationOperationIds.current.get(key);
    if (current?.fingerprint === fingerprint) return current.operationId;
    const operationId = createIdempotencyKey();
    resourceMutationOperationIds.current.set(key, { fingerprint, operationId });
    return operationId;
  }, []);

  const clearResourceMutationOperationId = useCallback((key: string): void => {
    resourceMutationOperationIds.current.delete(key);
  }, []);

  const finishResourceMutation = useCallback((input: {
    operationKey: string;
    submittedDraft: NativeKnowledgeToolsDraft;
    savedResource: WorkspaceCompletionResourceView;
  }): boolean => {
    clearResourceMutationOperationId(input.operationKey);
    const nextDraft = nativeKnowledgeDraftAfterMutation(draftRef.current, input.submittedDraft, input.savedResource);
    if (!nextDraft) {
      draftRef.current = undefined;
      setDraft(undefined);
      return false;
    }
    // The submitted values are persisted, but a newer local edit must remain
    // editable. Advance only its optimistic base version; the next save will
    // receive a fresh operation ID for the newer fingerprint.
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setResourceError("保存中に追加された下書きを保持しています。内容を確認して、もう一度保存してください。");
    return true;
  }, [clearResourceMutationOperationId]);

  const startCreateResource = useCallback((): boolean => {
    const capturedTarget = cloneTarget(targetRef.current);
    if (!capturedTarget) {
      setResourceError("WorkspaceとRoomを選択してからKnowledgeを作成してください。");
      return false;
    }
    if (!requestResourceLeave()) return false;
    setSelectedResourceId(undefined);
    setSelectedResource(undefined);
    setResourceError(null);
    const nextDraft: NativeKnowledgeToolsCreateDraft = {
      kind: "knowledge",
      scopeKind: "room",
      roomId: capturedTarget.roomId,
      knowledgeKind: "fact",
      title: "",
      content: "",
      reason: "",
      dirty: false
    };
    createDraftRef.current = nextDraft;
    setCreateDraft(nextDraft);
    return true;
  }, [requestResourceLeave]);

  const updateCreateDraft = useCallback((patch: Partial<Pick<NativeKnowledgeToolsCreateDraft, "kind" | "scopeKind" | "roomId" | "knowledgeKind" | "title" | "content" | "reason">>): void => {
    const current = createDraftRef.current;
    const next = current ? { ...current, ...patch, dirty: true } : current;
    createDraftRef.current = next;
    setCreateDraft(next);
  }, []);

  const cancelCreate = useCallback((): void => {
    createDraftRef.current = undefined;
    setCreateDraft(undefined);
    setResourceError(null);
    createOperationRef.current = undefined;
  }, []);

  const createResource = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const currentDraft = createDraft;
    const bridge = getBridge();
    if (!capturedTarget || !currentDraft || !bridge?.createWorkspaceCompletionResource) {
      setResourceError("Knowledgeを作成できる既存bridgeが利用できません。下書きは保持されています。");
      return false;
    }
    if (!currentDraft.title.trim() || !currentDraft.content.trim() || !currentDraft.reason.trim()) {
      setResourceError("タイトル、本文、作成理由を入力してください。下書きは保持されています。");
      return false;
    }
    if (currentDraft.scopeKind === "room" && currentDraft.roomId !== capturedTarget.roomId) {
      setResourceError("作成対象のRoomが切り替わりました。下書きを確認してください。");
      return false;
    }
    const fingerprint = stableNativeKnowledgeJson({
      target: capturedTargetKey,
      kind: currentDraft.kind,
      scopeKind: currentDraft.scopeKind,
      roomId: currentDraft.roomId,
      knowledgeKind: currentDraft.knowledgeKind,
      title: currentDraft.title,
      content: currentDraft.content,
      reason: currentDraft.reason
    });
    const operationId = createOperationRef.current?.fingerprint === fingerprint
      ? createOperationRef.current.operationId
      : createIdempotencyKey();
    createOperationRef.current = { fingerprint, operationId };
    setCreateBusy(true);
    setResourceError(null);
    try {
      const response = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.createWorkspaceCompletionResource!({
        scopeKind: currentDraft.scopeKind,
        ...(currentDraft.scopeKind === "room" ? { roomId: capturedTarget.roomId } : {}),
        kind: currentDraft.kind,
        knowledgeKind: currentDraft.knowledgeKind,
        title: currentDraft.title.trim(),
        content: currentDraft.content,
        reason: currentDraft.reason.trim(),
        operationId,
        target: capturedTarget
      }));
      const createdResource = validateResourceMutationResponse(response, response.resource.id, capturedTarget);
      if (!isCurrent(capturedTargetKey)) return false;
      createDraftRef.current = undefined;
      setCreateDraft(undefined);
      createOperationRef.current = undefined;
      await reloadResources();
      if (!isCurrent(capturedTargetKey)) return false;
      await openResource(createdResource.id, createdResource);
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setResourceError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setCreateBusy(false);
    }
  }, [createDraft, getBridge, isCurrent, openResource, reloadResources, validateResourceMutationResponse]);

  const saveResource = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const currentDraft = draft;
    const currentDetail = selectedResource;
    const bridge = getBridge();
    const resourceKind = currentDetail && isNativeKnowledgeResourceKind(currentDetail.resource.kind)
      ? currentDetail.resource.kind
      : undefined;
    if (!capturedTarget || !currentDraft || !currentDetail || !resourceKind
      || currentDetail.resource.lifecycleState === "archived" || !bridge?.updateWorkspaceCompletionResource) {
      setResourceError("この資源は読み取り専用です。既存の編集bridgeが利用できません。");
      return false;
    }
    if (!currentDraft.title.trim() || !currentDraft.content.trim() || !currentDraft.reason.trim()) {
      setResourceError("タイトル、本文、変更理由を入力してください。下書きは保持されています。");
      return false;
    }
    const generation = detailGeneration.current;
    const operationKey = `resource:${capturedTargetKey}:${currentDraft.resourceId}:save`;
    const operationId = resourceMutationOperationId(operationKey, stableNativeKnowledgeJson({
      resourceId: currentDraft.resourceId,
      expectedVersion: currentDraft.expectedVersion,
      title: currentDraft.title,
      content: currentDraft.content,
      reason: currentDraft.reason,
      kind: resourceKind
    }));
    setResourceBusy("save");
    setResourceError(null);
    try {
      const response = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.updateWorkspaceCompletionResource!({
        resourceId: currentDraft.resourceId,
        ...resourceScopeInput(currentDetail.resource, capturedTarget),
        kind: resourceKind,
        ...(currentDetail.resource.knowledgeKind ? { knowledgeKind: currentDetail.resource.knowledgeKind } : {}),
        title: currentDraft.title.trim(),
        content: currentDraft.content,
        reason: currentDraft.reason.trim(),
        expectedVersion: currentDraft.expectedVersion,
        operationId,
        target: capturedTarget
      }));
      const savedResource = validateResourceMutationResponse(response, currentDraft.resourceId, capturedTarget);
      if (!isCurrent(capturedTargetKey) || generation !== detailGeneration.current) return false;
      const hasNewerDraft = finishResourceMutation({ operationKey, submittedDraft: currentDraft, savedResource });
      await reloadResources();
      if (hasNewerDraft) return true;
      await openResource(currentDraft.resourceId);
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setResourceError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setResourceBusy(null);
    }
  }, [draft, finishResourceMutation, getBridge, isCurrent, openResource, reloadResources, resourceMutationOperationId, selectedResource, validateResourceMutationResponse]);

  const toggleFixed = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const current = selectedResource;
    const bridge = getBridge();
    if (!capturedTarget || !current || current.resource.kind !== "knowledge" || current.resource.lifecycleState === "archived" || draft?.dirty || !bridge?.setWorkspaceCompletionResourceFixed) {
      setResourceError("Knowledgeの固定状態を変更できる既存bridgeがありません。読み取り専用で表示しています。");
      return false;
    }
    const generation = detailGeneration.current;
    const fixed = current.resource.aiProtection !== "fixed";
    const operationKey = `resource:${capturedTargetKey}:${current.resource.id}:fixed`;
    const operationId = resourceMutationOperationId(operationKey, stableNativeKnowledgeJson({
      resourceId: current.resource.id,
      expectedVersion: resourceVersion(current),
      fixed,
      reason: draft?.reason.trim() || "人が確認して固定状態を変更"
    }));
    setResourceBusy("fixed");
    setResourceError(null);
    try {
      const response = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.setWorkspaceCompletionResourceFixed!({
        resourceId: current.resource.id,
        fixed,
        expectedVersion: resourceVersion(current),
        reason: draft?.reason.trim() || "人が確認して固定状態を変更",
        operationId,
        target: capturedTarget
      }));
      const savedResource = validateResourceMutationResponse(response, current.resource.id, capturedTarget);
      if (!isCurrent(capturedTargetKey) || generation !== detailGeneration.current) return false;
      const submittedDraft = draft ?? {
        resourceId: current.resource.id,
        kind: "knowledge" as const,
        scopeKind: current.resource.scope.kind,
        ...(current.resource.scope.kind === "room" ? { roomId: capturedTarget.roomId } : {}),
        title: current.resource.title,
        content: current.content,
        reason: "人が確認して固定状態を変更",
        expectedVersion: resourceVersion(current),
        dirty: false
      };
      const hasNewerDraft = finishResourceMutation({ operationKey, submittedDraft, savedResource });
      await reloadResources();
      if (hasNewerDraft) return true;
      await openResource(current.resource.id);
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setResourceError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setResourceBusy(null);
    }
  }, [draft, finishResourceMutation, getBridge, isCurrent, openResource, reloadResources, resourceMutationOperationId, selectedResource, validateResourceMutationResponse]);

  const toggleArchived = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const current = selectedResource;
    const bridge = getBridge();
    if (!capturedTarget || !current || draft?.dirty || !bridge?.archiveWorkspaceCompletionResource) {
      setResourceError("この資源の保管状態を変更できる既存bridgeがありません。読み取り専用で表示しています。");
      return false;
    }
    const generation = detailGeneration.current;
    const archived = current.resource.lifecycleState !== "archived";
    const operationKey = `resource:${capturedTargetKey}:${current.resource.id}:archive`;
    const operationId = resourceMutationOperationId(operationKey, stableNativeKnowledgeJson({
      resourceId: current.resource.id,
      expectedVersion: resourceVersion(current),
      archived,
      reason: draft?.reason.trim() || "人が確認して保管状態を変更"
    }));
    setResourceBusy("archive");
    setResourceError(null);
    try {
      const response = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.archiveWorkspaceCompletionResource!({
        resourceId: current.resource.id,
        archived,
        expectedVersion: resourceVersion(current),
        reason: draft?.reason.trim() || "人が確認して保管状態を変更",
        operationId,
        target: capturedTarget
      }));
      const savedResource = validateResourceMutationResponse(response, current.resource.id, capturedTarget);
      if (!isCurrent(capturedTargetKey) || generation !== detailGeneration.current) return false;
      const submittedDraft = draft ?? {
        resourceId: current.resource.id,
        kind: current.resource.kind === "skill" ? "skill" as const : "knowledge" as const,
        scopeKind: current.resource.scope.kind,
        ...(current.resource.scope.kind === "room" ? { roomId: capturedTarget.roomId } : {}),
        title: current.resource.title,
        content: current.content,
        reason: "人が確認して保管状態を変更",
        expectedVersion: resourceVersion(current),
        dirty: false
      };
      const hasNewerDraft = finishResourceMutation({ operationKey, submittedDraft, savedResource });
      await reloadResources();
      if (hasNewerDraft) return true;
      await openResource(current.resource.id);
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setResourceError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setResourceBusy(null);
    }
  }, [draft, finishResourceMutation, getBridge, isCurrent, openResource, reloadResources, resourceMutationOperationId, selectedResource, validateResourceMutationResponse]);

  const runSearch = useCallback(async (): Promise<void> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const query = searchQuery.trim();
    const generation = ++searchGeneration.current;
    const bridge = getBridge();
    if (!capturedTarget || !query) {
      setSearchResults([]);
      setSearchError(query ? "Roomを選択してから検索してください。" : null);
      return;
    }
    if (!bridge?.searchWorkspace && !bridge?.searchWorkspaceCompletionKnowledge) {
      setSearchError("Room内検索の既存bridgeが利用できません。");
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const [roomResponse, knowledgeResponse] = await Promise.all([
        bridge.searchWorkspace
          ? withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.searchWorkspace!({ roomId: capturedTarget.roomId, query, target: capturedTarget }))
          : Promise.resolve([] as SearchResult[]),
        bridge.searchWorkspaceCompletionKnowledge
          ? collectCompletionResourcePages((cursor) => withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.searchWorkspaceCompletionKnowledge!({
            roomId: capturedTarget.roomId,
            query,
            limit: 30,
            ...(cursor ? { cursor } : {}),
            target: capturedTarget
          })))
          : Promise.resolve([] as Array<WorkspaceCompletionResourceView & { rank?: number }>)
      ]);
      if (generation !== searchGeneration.current || !isCurrent(capturedTargetKey)) return;
      const records: NativeRoomSearchResult[] = [];
      for (const result of knowledgeResponse) {
        if (!resourceMatchesNativeKnowledgeToolsTarget(result, capturedTarget) || result.kind !== "knowledge") continue;
        records.push({
          key: `knowledge:${result.id}`,
          kind: "knowledge",
          id: result.id,
          title: result.title,
          summary: `${result.scope.kind === "room" ? "このRoom" : "Workspace共通"} · ${result.creationSource}`,
          resource: result,
          ...(result.rank === undefined ? {} : { rank: result.rank })
        });
      }
      for (const result of roomResponse) {
        records.push({
          key: `${result.kind}:${result.id}`,
          kind: result.kind,
          id: result.id,
          title: result.title,
          summary: result.summary,
          ...(result.session_id ? { session_id: result.session_id } : {}),
          ...(result.work_id ? { work_id: result.work_id } : {}),
          ...(result.operation_id ? { operation_id: result.operation_id } : {})
        });
      }
      const unique = new Map(records.map((record) => [record.key, record]));
      setSearchResults([...unique.values()]);
    } catch (error) {
      if (generation === searchGeneration.current && isCurrent(capturedTargetKey)) setSearchError(nativeKnowledgeToolsErrorMessage(error));
    } finally {
      if (generation === searchGeneration.current && isCurrent(capturedTargetKey)) setSearchLoading(false);
    }
  }, [getBridge, isCurrent, searchQuery]);

  const openSearchResult = useCallback(async (result: NativeRoomSearchResult): Promise<void> => {
    if (result.resource) await openResource(result.resource.id, result.resource);
  }, [openResource]);

  const reloadSettings = useCallback(async (): Promise<void> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const generation = ++settingsGeneration.current;
    const bridge = getBridge();
    if (!capturedTarget) return;
    if (!bridge?.getWorkspaceSettings || !bridge.getWorkspaceLearningSettings) {
      setSettingsError("基本設定の既存bridgeが利用できません。読み取り専用で表示しています。");
      return;
    }
    setSettingsLoading(true);
    setSettingsError(null);
    try {
      const [workspace, learning] = await Promise.all([
        withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.getWorkspaceSettings!({ target: capturedTarget })),
        withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.getWorkspaceLearningSettings!({ roomId: capturedTarget.roomId, target: capturedTarget }))
      ]);
      if (generation !== settingsGeneration.current || !isCurrent(capturedTargetKey)) return;
      const learningSnapshot = learningSnapshotFromResponse(learning, capturedTarget);
      const nextSettings = { workspace, learning: learningSnapshot };
      setSettings(nextSettings);
      setSettingsDraft((current) => {
        if (current && (settingsLanguageDirty || settingsLearningDirty)) return current;
        const scope = learningSnapshot.room ? "room" : "workspace";
        const scoped = learningSnapshot.room ?? learningSnapshot.workspace ?? learningSnapshot.effective;
        return {
          uiLocale: isSupportedLocale(workspace.ui_locale) ? workspace.ui_locale : "ja",
          outputLocale: isSupportedLocale(workspace.output_locale) ? workspace.output_locale : "ja",
          learningEnabled: workspace.learning_enabled,
          learningScope: scope,
          scopedLearningEnabled: scoped.enabled
        };
      });
    } catch (error) {
      if (generation === settingsGeneration.current && isCurrent(capturedTargetKey)) setSettingsError(nativeKnowledgeToolsErrorMessage(error));
    } finally {
      if (generation === settingsGeneration.current && isCurrent(capturedTargetKey)) setSettingsLoading(false);
    }
  }, [getBridge, isCurrent, settingsLanguageDirty, settingsLearningDirty]);

  const updateSettingsDraft = useCallback((patch: Partial<NativeKnowledgeToolsSettingsDraft>): void => {
    setSettingsDraft((current) => current ? { ...current, ...patch } : current);
    if ("uiLocale" in patch || "outputLocale" in patch) setSettingsLanguageDirty(true);
    if ("learningEnabled" in patch || "learningScope" in patch || "scopedLearningEnabled" in patch) setSettingsLearningDirty(true);
  }, []);

  const saveLanguageSettings = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const currentDraft = settingsDraft;
    const bridge = getBridge();
    if (!capturedTarget || !currentDraft || !bridge?.patchWorkspaceSettings) {
      setSettingsError("言語設定を保存できる既存bridgeがありません。下書きは保持されています。");
      return false;
    }
    setSettingsBusy("language");
    setSettingsError(null);
    try {
      const result = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.patchWorkspaceSettings!({
        patch: { ui_locale: currentDraft.uiLocale, output_locale: currentDraft.outputLocale },
        operationId: createIdempotencyKey(),
        target: capturedTarget
      }));
      if (!isSupportedLocale(result.settings.ui_locale) || !isSupportedLocale(result.settings.output_locale)) throw new Error("workspace_settings_response_invalid");
      if (!isCurrent(capturedTargetKey)) return false;
      setSettings((current) => current ? { ...current, workspace: result.settings } : current);
      setSettingsLanguageDirty(false);
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setSettingsError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setSettingsBusy(null);
    }
  }, [getBridge, isCurrent, settingsDraft]);

  const saveLearningSettings = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const currentSettings = settings;
    const currentDraft = settingsDraft;
    const bridge = getBridge();
    if (!capturedTarget || !currentSettings || !currentDraft || !bridge?.updateWorkspaceLearningSettings) {
      setSettingsError("学習状態を保存できる既存bridgeがありません。下書きは保持されています。");
      return false;
    }
    setSettingsBusy("learning");
    setSettingsError(null);
    try {
      if (currentDraft.learningEnabled !== currentSettings.workspace.learning_enabled && !bridge.patchWorkspaceSettings) {
        throw new Error("workspace_settings_patch_unavailable");
      }
      if (bridge.patchWorkspaceSettings && currentDraft.learningEnabled !== currentSettings.workspace.learning_enabled) {
        await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.patchWorkspaceSettings!({
          patch: { learning_enabled: currentDraft.learningEnabled },
          operationId: createIdempotencyKey(),
          target: capturedTarget
        }));
      }
      const scopeKind = currentDraft.learningScope;
      const currentScope = scopeKind === "room"
        ? currentSettings.learning.room
        : currentSettings.learning.workspace;
      const result = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.updateWorkspaceLearningSettings!({
        scopeKind,
        ...(scopeKind === "room" ? { roomId: capturedTarget.roomId } : {}),
        enabled: currentDraft.scopedLearningEnabled,
        expectedVersion: currentScope?.version ?? 0,
        operationId: createIdempotencyKey(),
        target: capturedTarget
      }));
      const resultSettings = result.settings;
      if (resultSettings.workspaceId !== capturedTarget.workspaceId) throw new Error("workspace_learning_response_scope_invalid");
      if (scopeKind === "room" && (resultSettings.scope.kind !== "room" || resultSettings.scope.roomId !== capturedTarget.roomId)) {
        throw new Error("workspace_learning_room_scope_invalid");
      }
      if (scopeKind === "workspace" && resultSettings.scope.kind !== "workspace") throw new Error("workspace_learning_workspace_scope_invalid");
      if (!isCurrent(capturedTargetKey)) return false;
      setSettingsLearningDirty(false);
      await reloadSettings();
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setSettingsError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setSettingsBusy(null);
    }
  }, [getBridge, isCurrent, reloadSettings, settings, settingsDraft]);

  const removeRoomLearningOverride = useCallback(async (): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const roomSettings = settings?.learning.room;
    const bridge = getBridge();
    if (!capturedTarget || !roomSettings || !bridge?.updateWorkspaceLearningSettings) {
      setSettingsError("このRoomの学習上書きを解除できる既存bridgeがありません。");
      return false;
    }
    setSettingsBusy("override");
    setSettingsError(null);
    try {
      await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.updateWorkspaceLearningSettings!({
        scopeKind: "room",
        roomId: capturedTarget.roomId,
        removeOverride: true,
        expectedVersion: roomSettings.version,
        operationId: createIdempotencyKey(),
        target: capturedTarget
      }));
      if (!isCurrent(capturedTargetKey)) return false;
      setSettingsLearningDirty(false);
      await reloadSettings();
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setSettingsError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setSettingsBusy(null);
    }
  }, [getBridge, isCurrent, reloadSettings, settings?.learning.room]);

  const reloadAutomation = useCallback(async (): Promise<void> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const generation = ++automationGeneration.current;
    const bridge = getBridge();
    if (!capturedTarget) return;
    if (!bridge?.listWorkspaceAutomationJobs || !bridge.listWorkspaceAutomationRuns) {
      setAutomationError("既存automation bridgeが利用できません。");
      return;
    }
    setAutomationLoading(true);
    setAutomationError(null);
    try {
      const [jobsResponse, runsResponse] = await Promise.all([
        withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.listWorkspaceAutomationJobs!({ roomId: capturedTarget.roomId, target: capturedTarget })),
        withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.listWorkspaceAutomationRuns!({ roomId: capturedTarget.roomId, target: capturedTarget }))
      ]);
      if (generation !== automationGeneration.current || !isCurrent(capturedTargetKey)) return;
      setAutomationJobs(jobsResponse.jobs.filter((job) => automationJobMatchesNativeKnowledgeToolsTarget(job, capturedTarget)));
      setAutomationRuns(runsResponse.runs.filter((run) => automationRunMatchesNativeKnowledgeToolsTarget(run, capturedTarget)));
    } catch (error) {
      if (generation === automationGeneration.current && isCurrent(capturedTargetKey)) setAutomationError(nativeKnowledgeToolsErrorMessage(error));
    } finally {
      if (generation === automationGeneration.current && isCurrent(capturedTargetKey)) setAutomationLoading(false);
    }
  }, [getBridge, isCurrent]);

  const toggleAutomation = useCallback(async (job: AutomationJobRecord): Promise<boolean> => {
    const capturedTarget = cloneTarget(targetRef.current);
    const capturedTargetKey = targetKeyRef.current;
    const bridge = getBridge();
    if (!capturedTarget || !automationJobMatchesNativeKnowledgeToolsTarget(job, capturedTarget) || !bridge?.setWorkspaceAutomationManagement) {
      setAutomationError("このautomationは現在のRoomから管理できません。");
      return false;
    }
    setAutomationBusyJobId(job.id);
    setAutomationError(null);
    try {
      const result = await withNativeKnowledgeToolsTarget(bridge, capturedTarget, () => bridge.setWorkspaceAutomationManagement!({
        jobId: job.id,
        state: job.status === "enabled" ? "manager_stopped" : "allowed",
        operationId: createIdempotencyKey(),
        target: capturedTarget
      }));
      if (!automationJobMatchesNativeKnowledgeToolsTarget(result.job, capturedTarget)) throw new Error("automation_response_scope_invalid");
      if (!isCurrent(capturedTargetKey)) return false;
      await reloadAutomation();
      return true;
    } catch (error) {
      if (isCurrent(capturedTargetKey)) setAutomationError(nativeKnowledgeToolsErrorMessage(error));
      return false;
    } finally {
      if (isCurrent(capturedTargetKey)) setAutomationBusyJobId(undefined);
    }
  }, [getBridge, isCurrent, reloadAutomation]);

  useEffect(() => {
    resourceGeneration.current += 1;
    detailGeneration.current += 1;
    searchGeneration.current += 1;
    settingsGeneration.current += 1;
    automationGeneration.current += 1;
    selectedResourceIdRef.current = undefined;
    draftRef.current = undefined;
    createDraftRef.current = undefined;
    setSelectedResourceId(undefined);
    setSelectedResource(undefined);
    setDraft(undefined);
    setCreateDraft(undefined);
    createOperationRef.current = undefined;
    resourceMutationOperationIds.current.clear();
    setResourceError(null);
    setSearchResults([]);
    setSearchError(null);
    setSettings(undefined);
    setSettingsDraft(undefined);
    setSettingsLanguageDirty(false);
    setSettingsLearningDirty(false);
    setAutomationJobs([]);
    setAutomationRuns([]);
    setResourcesError(null);
    setAutomationError(null);
    setResourcesLoading(false);
    setResourceLoading(false);
    setResourceBusy(null);
    setSearchLoading(false);
    setSettingsLoading(false);
    setSettingsBusy(null);
    setAutomationLoading(false);
    setAutomationBusyJobId(undefined);
    if (targetRef.current) void reloadResources();
  }, [reloadResources, targetKey]);

  useEffect(() => {
    if (tab === "settings") void reloadSettings();
    if (tab === "automation") void reloadAutomation();
  }, [reloadAutomation, reloadSettings, tab]);

  useEffect(() => {
    const bridge = getBridge();
    const capturedTarget = cloneTarget(targetRef.current);
    if (!bridge?.onWorkspaceServerEvent || !capturedTarget) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = bridge.onWorkspaceServerEvent((event) => {
      if (!event || event.workspaceId !== capturedTarget.workspaceId || (event.roomId && event.roomId !== capturedTarget.roomId)) return;
      const kind = event.kind ?? "";
      if (!kind.startsWith("completion.resource.") && !kind.startsWith("learning.settings.") && !kind.startsWith("automation.")) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (kind.startsWith("completion.resource.")) void reloadResources();
        if (kind.startsWith("learning.settings.")) void reloadSettings();
        if (kind.startsWith("automation.")) void reloadAutomation();
      }, 120);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [getBridge, reloadAutomation, reloadResources, reloadSettings, targetKey]);

  const bridgeAvailable = Boolean(getBridge());
  const readOnly = !bridgeAvailable || !requestedTarget;
  const resourceCanEdit = Boolean(selectedResource && selectedResource.resource.lifecycleState !== "archived" && getBridge()?.updateWorkspaceCompletionResource);
  const resourceCanFix = Boolean(selectedResource?.resource.kind === "knowledge" && selectedResource.resource.lifecycleState !== "archived" && getBridge()?.setWorkspaceCompletionResourceFixed);
  const resourceCanArchive = Boolean(selectedResource && getBridge()?.archiveWorkspaceCompletionResource);
  const settingsCanEdit = Boolean(getBridge()?.patchWorkspaceSettings && getBridge()?.updateWorkspaceLearningSettings);
  const automationCanManage = Boolean(getBridge()?.setWorkspaceAutomationManagement);
  const hasUnsavedChanges = Boolean(draft?.dirty || createDraft?.dirty || settingsLanguageDirty || settingsLearningDirty);
  const saving = createBusy || resourceBusy === "save" || settingsBusy !== null;

  return {
    target: requestedTarget,
    targetKey,
    tab,
    setTab,
    bridgeAvailable,
    readOnly,
    roomResources,
    workspaceResources,
    skills,
    resourcesLoading,
    resourcesError,
    reloadResources,
    selectedResourceId,
    selectedResource,
    resourceLoading,
    resourceError,
    draft,
    createDraft,
    createBusy,
    resourceBusy,
    openResource,
    startCreateResource,
    updateCreateDraft,
    cancelCreate,
    createResource,
    requestResourceLeave,
    discardUnsavedChanges,
    updateDraft,
    cancelDraft,
    saveResource,
    toggleFixed,
    toggleArchived,
    resourceCanEdit,
    resourceCanFix,
    resourceCanArchive,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    searchError,
    runSearch,
    openSearchResult,
    settings,
    settingsDraft,
    settingsLoading,
    settingsError,
    settingsBusy,
    hasUnsavedChanges,
    saving,
    settingsLanguageDirty,
    settingsLearningDirty,
    settingsCanEdit,
    updateSettingsDraft,
    reloadSettings,
    saveLanguageSettings,
    saveLearningSettings,
    removeRoomLearningOverride,
    automationJobs,
    automationRuns,
    automationLoading,
    automationError,
    automationBusyJobId,
    automationCanManage,
    reloadAutomation,
    toggleAutomation
  };
}
