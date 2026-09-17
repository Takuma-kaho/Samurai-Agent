import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonValue } from "@samurai-agent/core-schemas";
import {
  createIdempotencyKey,
  type DesktopWorkspaceTarget,
} from "../lib/api";
import type { NativeWorkspaceTarget } from "./types";
import { nativeWorkspaceTargetIdentityKey, nativeWorkspaceTargetKey } from "./types";
import {
  nativeAgentResourceCanBeShown,
  nativeAgentSafeSupportFiles,
  type NativeAgentResource,
  type NativeAgentResourceDetail,
  type NativeAgentResourceSelection,
  type NativeAgentResourceUpdateInput,
  type NativeAgentResourceWriteInput,
  type NativeAgentResourceArchiveInput,
  type NativeAgentSupportFile
} from "./NativeAgentResources";

/**
 * Agent resources use the existing target-aware Desktop/Browser seam.  This
 * alias intentionally does not add a second bridge contract or expose any
 * credential-bearing value to the renderer.
 */
export type NativeAgentResourceBridge = NonNullable<Window["samuraiDesktop"]>;

export interface UseNativeAgentResourcesOptions {
  bridge?: NativeAgentResourceBridge;
  /** Workspace scope only; Room changes are deliberately not part of this target. */
  target?: NativeWorkspaceTarget;
  /** The caller's already-authorized Workspace capability projection. */
  canManage?: boolean;
}

export interface UseNativeAgentResourcesResult {
  agentId?: string;
  resources: NativeAgentResource[];
  selectedResourceId?: string;
  loading: boolean;
  error: string | null;
  canManage: boolean;
  selectAgent: (agentId?: string) => void;
  selectResource: (selection: NativeAgentResourceSelection) => void;
  loadResource: (selection: NativeAgentResourceSelection) => Promise<NativeAgentResourceDetail>;
  createResource?: (input: NativeAgentResourceWriteInput) => Promise<NativeAgentResource>;
  updateResource?: (input: NativeAgentResourceUpdateInput) => Promise<NativeAgentResource>;
  archiveResource?: (input: NativeAgentResourceArchiveInput) => Promise<NativeAgentResource>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function resourceRows(value: unknown): unknown[] {
  const body = record(value);
  if (Array.isArray(value)) return value;
  if (Array.isArray(body.resources)) return body.resources;
  if (Array.isArray(body.items)) return body.items;
  return body.resource ? [body.resource] : [];
}

function resourceObject(value: unknown): Record<string, unknown> {
  const body = record(value);
  return body.resource && typeof body.resource === "object" && !Array.isArray(body.resource)
    ? body.resource as Record<string, unknown>
    : body;
}

function supportFilesFromUnknown(value: unknown): NativeAgentSupportFile[] {
  const rows = Array.isArray(value) ? value : [];
  const parsed = rows.flatMap((entry) => {
    const item = record(entry);
    const path = optionalString(item.path ?? item.bodyPath ?? item.body_path);
    if (!path) return [];
    return [{
      path,
      ...(optionalString(item.hash ?? item.bodyHash ?? item.body_hash) ? { hash: optionalString(item.hash ?? item.bodyHash ?? item.body_hash) } : {}),
      ...(positiveVersion(item.version ?? item.bodyVersion ?? item.body_version) ? { version: positiveVersion(item.version ?? item.bodyVersion ?? item.body_version) } : {})
    } satisfies NativeAgentSupportFile];
  });
  return nativeAgentSafeSupportFiles(parsed);
}

function resourceSupportFiles(item: Record<string, unknown>): NativeAgentSupportFile[] {
  const metadata = record(item.metadata);
  return supportFilesFromUnknown(item.supportFiles ?? item.support_files ?? metadata.supportFiles ?? metadata.support_files);
}

/**
 * Normalize only the public, manual, confirmed Agent projection.  Workspace,
 * Room, provisional, policy, and AI-managed rows are intentionally dropped
 * before they reach the UI component.
 */
export function nativeAgentResourcesFromUnknown(
  value: unknown,
  expectedAgentId: string,
  expectedWorkspaceId?: string
): NativeAgentResource[] {
  if (!expectedAgentId) return [];
  return resourceRows(value).flatMap((entry) => {
    const item = resourceObject(entry);
    const scope = record(item.scope);
    const scopeKind = scope.kind ?? item.scope_kind ?? item.scopeKind;
    const agentId = optionalString(scope.agentId ?? scope.agent_id ?? item.agent_id ?? item.agentId);
    const workspaceId = optionalString(item.workspaceId ?? item.workspace_id);
    const id = optionalString(item.id ?? item.resource_id ?? item.resourceId);
    const kind = item.kind;
    const evidenceState = optionalString(item.evidenceState ?? item.evidence_state);
    const lifecycleState = optionalString(item.lifecycleState ?? item.lifecycle_state);
    const version = positiveVersion(item.version);
    const aiManaged = item.aiManaged ?? item.ai_managed;
    if (!id || !workspaceId || (expectedWorkspaceId && workspaceId !== expectedWorkspaceId)
      || scopeKind !== "agent" || agentId !== expectedAgentId
      || (kind !== "knowledge" && kind !== "skill")
      || evidenceState !== "confirmed"
      || aiManaged !== false
      || (lifecycleState !== "active" && lifecycleState !== "archived")
      || version === undefined) return [];
    const resource: NativeAgentResource = {
      workspaceId,
      id,
      scope: { kind: "agent", agentId },
      kind,
      ...(kind === "knowledge" && (item.knowledgeKind === "fact" || item.knowledgeKind === "decision" || item.knowledgeKind === "explanation" || item.knowledgeKind === "experience_rule")
        ? { knowledgeKind: item.knowledgeKind }
        : {}),
      title: optionalString(item.title) ?? id,
      evidenceState,
      lifecycleState,
      aiManaged: false,
      version,
      ...(positiveVersion(item.currentConfirmedVersion ?? item.current_confirmed_version) ? { currentConfirmedVersion: positiveVersion(item.currentConfirmedVersion ?? item.current_confirmed_version) } : {}),
      ...(optionalString(item.contentHash ?? item.content_hash) ? { contentHash: optionalString(item.contentHash ?? item.content_hash) } : {}),
      ...(resourceSupportFiles(item).length ? { supportFiles: resourceSupportFiles(item) } : {}),
      ...(optionalString(item.createdAt ?? item.created_at) ? { createdAt: optionalString(item.createdAt ?? item.created_at) } : {}),
      ...(optionalString(item.updatedAt ?? item.updated_at) ? { updatedAt: optionalString(item.updatedAt ?? item.updated_at) } : {})
    };
    return nativeAgentResourceCanBeShown(resource, expectedAgentId) ? [resource] : [];
  });
}

function metadataSupportFiles(files: readonly NativeAgentSupportFile[]): Record<string, JsonValue> | undefined {
  const safeFiles = nativeAgentSafeSupportFiles(files);
  if (!safeFiles.length) return undefined;
  return {
    support_files: safeFiles.map((file) => ({
      path: file.path,
      ...(file.hash ? { hash: file.hash } : {}),
      ...(file.version ? { version: file.version } : {})
    })) as JsonValue[]
  };
}

function detailVersion(value: Record<string, unknown>, resource: NativeAgentResource): number {
  const current = record(value.current_version ?? value.currentVersion ?? value.version);
  return positiveVersion(current.version) ?? positiveVersion(value.version) ?? resource.version;
}

/** Normalize a detail response while keeping the same Agent scope checks as list responses. */
export function nativeAgentResourceDetailFromUnknown(
  value: unknown,
  expectedAgentId: string,
  expectedWorkspaceId?: string
): NativeAgentResourceDetail {
  const body = record(value);
  const resource = nativeAgentResourcesFromUnknown(value, expectedAgentId, expectedWorkspaceId)[0];
  if (!resource) throw new Error("agent_resource_response_scope_invalid");
  const version = detailVersion(body, resource);
  if (version !== resource.version) throw new Error("agent_resource_version_invalid");
  const current = record(body.current_version ?? body.currentVersion ?? body.version);
  const content = typeof body.content === "string" ? body.content : undefined;
  const files = resourceSupportFiles(current).length
    ? resourceSupportFiles(current)
    : resource.supportFiles;
  return {
    resource,
    version,
    ...(content === undefined ? {} : { content }),
    ...(optionalString(current.contentHash ?? current.content_hash) ? { contentHash: optionalString(current.contentHash ?? current.content_hash) } : {}),
    ...(optionalString(current.reason) ? { reason: optionalString(current.reason) } : {}),
    ...(files?.length ? { supportFiles: files } : {})
  };
}

function bodyFromUnknown(value: unknown, expectedAgentId: string, expectedWorkspaceId?: string): NativeAgentResourceDetail {
  return nativeAgentResourceDetailFromUnknown(value, expectedAgentId, expectedWorkspaceId);
}

function errorStatus(error: unknown): number | undefined {
  const status = record(error).status;
  return typeof status === "number" ? status : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message;
  const body = record(error);
  return typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "request_failed";
}

function isPermissionError(error: unknown): boolean {
  const status = errorStatus(error);
  const code = errorCode(error).toLowerCase();
  return status === 401 || status === 403 || status === 404
    || /permission|forbidden|unauthori[sz]ed|access|denied|management/.test(code);
}

function isExplicitResourceFailure(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined) return status >= 400 && status < 500;
  return /(?:_invalid|_required|_forbidden|_unavailable|_not_found|_conflict|_rejected|_mismatch)$/.test(errorCode(error));
}

function resourceErrorMessage(error: unknown): string {
  if (isPermissionError(error)) return "Agent資源を管理する権限を確認してください。";
  const code = errorCode(error).toLowerCase();
  if (code.includes("scope") || code.includes("agent_resource")) return "対象Agentと一致しない資源は表示・保存できません。";
  if (code.includes("version") || code.includes("conflict")) return "Agent資源の版が更新されています。最新の内容を読み直してください。";
  return "Agent資源を確認できませんでした。接続と権限を確認してください。";
}

function mergeResource(resources: readonly NativeAgentResource[], resource: NativeAgentResource): NativeAgentResource[] {
  return resources.some((candidate) => candidate.id === resource.id)
    ? resources.map((candidate) => candidate.id === resource.id ? resource : candidate)
    : [resource, ...resources];
}

function targetForBridge(target: NativeWorkspaceTarget): DesktopWorkspaceTarget {
  return target;
}

export function useNativeAgentResources(options: UseNativeAgentResourcesOptions): UseNativeAgentResourcesResult {
  const { bridge, target, canManage: requestedCanManage = false } = options;
  const [agentId, setAgentId] = useState<string>();
  const [resources, setResources] = useState<NativeAgentResource[]>([]);
  const [selectedResourceId, setSelectedResourceId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const agentIdRef = useRef<string | undefined>(undefined);
  const targetRef = useRef<NativeWorkspaceTarget | undefined>(target);
  const targetIdentityRef = useRef<string | undefined>(undefined);
  const requestGenerationRef = useRef(0);
  const mutationOperationIds = useRef(new Map<string, string>());
  targetRef.current = target;

  const targetIdentity = useMemo(
    () => target ? nativeWorkspaceTargetIdentityKey(target) : undefined,
    [target?.connectionId, target?.workspaceId, target?.selectionGeneration]
  );
  const managementAvailable = Boolean(
    bridge?.createWorkspaceCompletionResource
      && bridge.updateWorkspaceCompletionResource
      && bridge.archiveWorkspaceCompletionResource
  );
  const effectiveCanManage = requestedCanManage && managementAvailable && !permissionDenied;

  const resetSelection = useCallback((): void => {
    requestGenerationRef.current += 1;
    agentIdRef.current = undefined;
    setAgentId(undefined);
    setResources([]);
    setSelectedResourceId(undefined);
    setLoading(false);
    setError(null);
    setPermissionDenied(false);
  }, []);

  const listForAgent = useCallback(async (
    nextAgentId: string,
    capturedTarget: NativeWorkspaceTarget,
    generation: number
  ): Promise<void> => {
    if (!bridge?.listWorkspaceCompletionResources) throw new Error("agent_resource_api_unavailable");
    const response = await bridge.listWorkspaceCompletionResources({
      scopeKind: "agent",
      agentId: nextAgentId,
      includeArchived: true,
      target: targetForBridge(capturedTarget)
    });
    const currentTarget = targetRef.current;
    if (generation !== requestGenerationRef.current || agentIdRef.current !== nextAgentId
      || !currentTarget || nativeWorkspaceTargetKey(currentTarget) !== nativeWorkspaceTargetKey(capturedTarget)) return;
    setResources(nativeAgentResourcesFromUnknown(response, nextAgentId, capturedTarget.workspaceId));
  }, [bridge]);

  const selectAgent = useCallback((nextAgentId?: string): void => {
    const normalizedAgentId = nextAgentId?.trim();
    const capturedTarget = targetRef.current;
    const generation = ++requestGenerationRef.current;
    agentIdRef.current = normalizedAgentId || undefined;
    setAgentId(normalizedAgentId || undefined);
    setResources([]);
    setSelectedResourceId(undefined);
    setError(null);
    setPermissionDenied(false);
    if (!normalizedAgentId || !capturedTarget) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void listForAgent(normalizedAgentId, capturedTarget, generation).catch((requestError: unknown) => {
      if (generation !== requestGenerationRef.current || agentIdRef.current !== normalizedAgentId) return;
      if (isPermissionError(requestError)) setPermissionDenied(true);
      setResources([]);
      setError(resourceErrorMessage(requestError));
    }).finally(() => {
      if (generation === requestGenerationRef.current && agentIdRef.current === normalizedAgentId) setLoading(false);
    });
  }, [listForAgent]);

  useEffect(() => {
    const previous = targetIdentityRef.current;
    targetIdentityRef.current = targetIdentity;
    if (previous === undefined || previous === targetIdentity) return;
    resetSelection();
  }, [resetSelection, targetIdentity]);

  const assertCurrent = useCallback((requestedAgentId: string): NativeWorkspaceTarget => {
    const currentTarget = targetRef.current;
    if (!currentTarget || !agentIdRef.current || agentIdRef.current !== requestedAgentId) throw new Error("workspace_navigation_changed");
    return currentTarget;
  }, []);

  const selectResource = useCallback((selection: NativeAgentResourceSelection): void => {
    if (selection.agentId !== agentIdRef.current) return;
    if (!resources.some((resource) => resource.id === selection.resourceId && nativeAgentResourceCanBeShown(resource, selection.agentId))) return;
    setSelectedResourceId(selection.resourceId);
  }, [resources]);

  const loadResource = useCallback(async (selection: NativeAgentResourceSelection): Promise<NativeAgentResourceDetail> => {
    const capturedTarget = assertCurrent(selection.agentId);
    if (!bridge?.getWorkspaceCompletionResource) throw new Error("agent_resource_api_unavailable");
    try {
      const listed = resources.find((resource) => resource.id === selection.resourceId);
      const detailResponse = await bridge.getWorkspaceCompletionResource({
        resourceId: selection.resourceId,
        scopeKind: "agent",
        agentId: selection.agentId,
        ...(listed ? { kind: listed.kind } : {}),
        target: targetForBridge(capturedTarget)
      });
      const detail = nativeAgentResourceDetailFromUnknown(detailResponse, selection.agentId, capturedTarget.workspaceId);
      const currentTarget = targetRef.current;
      if (!currentTarget || nativeWorkspaceTargetKey(currentTarget) !== nativeWorkspaceTargetKey(capturedTarget)) throw new Error("workspace_navigation_changed");
      if (detail.resource.id !== selection.resourceId) throw new Error("agent_resource_response_scope_invalid");
      if (bridge.getWorkspaceCompletionResourceBody) {
        const bodyResponse = await bridge.getWorkspaceCompletionResourceBody({
          resourceId: selection.resourceId,
          scopeKind: "agent",
          agentId: selection.agentId,
          kind: detail.resource.kind,
          version: detail.version,
          target: targetForBridge(capturedTarget)
        });
        const body = bodyFromUnknown(bodyResponse, selection.agentId, capturedTarget.workspaceId);
        if (body.resource.id !== selection.resourceId || body.version !== detail.version) throw new Error("agent_resource_version_invalid");
        return {
          ...detail,
          resource: body.resource,
          version: body.version,
          ...(body.content === undefined ? {} : { content: body.content }),
          ...(body.contentHash ? { contentHash: body.contentHash } : {})
        };
      }
      return detail;
    } catch (requestError) {
      if (isPermissionError(requestError)) setPermissionDenied(true);
      throw requestError;
    }
  }, [assertCurrent, bridge, resources]);

  const createResource = useCallback(async (input: NativeAgentResourceWriteInput): Promise<NativeAgentResource> => {
    const capturedTarget = assertCurrent(input.agentId);
    if (input.scopeKind !== "agent") throw new Error("agent_resource_scope_invalid");
    if (!bridge?.createWorkspaceCompletionResource) throw new Error("agent_resource_api_unavailable");
    const key = `create\n${nativeWorkspaceTargetKey(capturedTarget)}\n${input.agentId}`;
    const operationId = mutationOperationIds.current.get(key) ?? createIdempotencyKey();
    mutationOperationIds.current.set(key, operationId);
    try {
      const response = await bridge.createWorkspaceCompletionResource({
        scopeKind: "agent",
        agentId: input.agentId,
        kind: input.kind,
        ...(input.kind === "knowledge" && input.knowledgeKind ? { knowledgeKind: input.knowledgeKind } : {}),
        title: input.title,
        content: input.content,
        ...(metadataSupportFiles(input.supportFiles) ? { metadata: metadataSupportFiles(input.supportFiles) } : {}),
        reason: input.reason,
        operationId,
        target: targetForBridge(capturedTarget)
      });
      const resource = nativeAgentResourcesFromUnknown(response, input.agentId, capturedTarget.workspaceId)[0];
      if (!resource) throw new Error("agent_resource_response_scope_invalid");
      assertCurrent(input.agentId);
      setResources((current) => mergeResource(current, resource));
      setSelectedResourceId(resource.id);
      mutationOperationIds.current.delete(key);
      return resource;
    } catch (requestError) {
      if (isPermissionError(requestError)) setPermissionDenied(true);
      if (isExplicitResourceFailure(requestError)) mutationOperationIds.current.delete(key);
      throw requestError;
    }
  }, [assertCurrent, bridge]);

  const updateResource = useCallback(async (input: NativeAgentResourceUpdateInput): Promise<NativeAgentResource> => {
    const capturedTarget = assertCurrent(input.agentId);
    if (input.scopeKind !== "agent") throw new Error("agent_resource_scope_invalid");
    if (!bridge?.updateWorkspaceCompletionResource) throw new Error("agent_resource_api_unavailable");
    const key = `update\n${nativeWorkspaceTargetKey(capturedTarget)}\n${input.agentId}\n${input.resourceId}`;
    const operationId = mutationOperationIds.current.get(key) ?? createIdempotencyKey();
    mutationOperationIds.current.set(key, operationId);
    try {
      const response = await bridge.updateWorkspaceCompletionResource({
        resourceId: input.resourceId,
        scopeKind: "agent",
        agentId: input.agentId,
        kind: input.kind,
        ...(input.kind === "knowledge" && input.knowledgeKind ? { knowledgeKind: input.knowledgeKind } : {}),
        title: input.title,
        content: input.content,
        ...(metadataSupportFiles(input.supportFiles) ? { metadata: metadataSupportFiles(input.supportFiles) } : {}),
        reason: input.reason,
        expectedVersion: input.expectedVersion,
        operationId,
        target: targetForBridge(capturedTarget)
      });
      const resource = nativeAgentResourcesFromUnknown(response, input.agentId, capturedTarget.workspaceId)[0];
      if (!resource || resource.id !== input.resourceId) throw new Error("agent_resource_response_scope_invalid");
      assertCurrent(input.agentId);
      setResources((current) => mergeResource(current, resource));
      mutationOperationIds.current.delete(key);
      return resource;
    } catch (requestError) {
      if (isPermissionError(requestError)) setPermissionDenied(true);
      if (isExplicitResourceFailure(requestError)) mutationOperationIds.current.delete(key);
      throw requestError;
    }
  }, [assertCurrent, bridge]);

  const archiveResource = useCallback(async (input: NativeAgentResourceArchiveInput): Promise<NativeAgentResource> => {
    const capturedTarget = assertCurrent(input.agentId);
    if (!bridge?.archiveWorkspaceCompletionResource) throw new Error("agent_resource_api_unavailable");
    const key = `archive\n${nativeWorkspaceTargetKey(capturedTarget)}\n${input.agentId}\n${input.resourceId}`;
    const operationId = mutationOperationIds.current.get(key) ?? createIdempotencyKey();
    mutationOperationIds.current.set(key, operationId);
    try {
      const response = await bridge.archiveWorkspaceCompletionResource({
        resourceId: input.resourceId,
        scopeKind: "agent",
        agentId: input.agentId,
        archived: true,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
        operationId,
        target: targetForBridge(capturedTarget)
      });
      const resource = nativeAgentResourcesFromUnknown(response, input.agentId, capturedTarget.workspaceId)[0];
      if (!resource || resource.id !== input.resourceId) throw new Error("agent_resource_response_scope_invalid");
      assertCurrent(input.agentId);
      setResources((current) => mergeResource(current, resource));
      mutationOperationIds.current.delete(key);
      return resource;
    } catch (requestError) {
      if (isPermissionError(requestError)) setPermissionDenied(true);
      if (isExplicitResourceFailure(requestError)) mutationOperationIds.current.delete(key);
      throw requestError;
    }
  }, [assertCurrent, bridge]);

  return {
    agentId,
    resources,
    selectedResourceId,
    loading,
    error,
    canManage: effectiveCanManage,
    selectAgent,
    selectResource,
    loadResource,
    createResource,
    updateResource,
    archiveResource
  };
}
