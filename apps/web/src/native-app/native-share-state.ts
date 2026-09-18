import type {
  PublicShareDraft,
  PublicShareDraftCreateInput,
  PublicShareDraftUpdateInput,
  PublicShareImportResult,
  PublicShareManifest,
  PublicSharePublishResult,
  PublicShareRevokeResult
} from "@samurai-agent/domain-api";
import type {
  WorkspaceShareDraft,
  WorkspaceShareDraftCreateInput,
  WorkspaceShareDraftUpdateInput,
  WorkspaceShareImportResult,
  WorkspaceShareLinkView,
  WorkspaceShareManifest,
  WorkspaceSharePublishResult,
  WorkspaceShareRevokeResult,
  WorkspaceShareSummary
} from "../lib/api";
import { PublicShareManifestSchema, PublicShareDraftSchema } from "@samurai-agent/domain-api";
import type { NativeAgentResource, NativeAgentResourceSelection } from "./NativeAgentResources";
import { nativeAgentResourceCanBeShown } from "./NativeAgentResources";
import type { NativeRoomKnowledgeShareSelection } from "./use-native-knowledge-tools";
import type { NativeWorkspaceTarget } from "./types";
import type { WorkspaceSharePublishedSummary, WorkspaceShareResourceOption, WorkspaceShareSource } from "./WorkspaceShareDialog";
import type { WorkspaceSharePublishedView } from "./WorkspaceShareDialog";

export interface NativeAgentShareSelection extends NativeAgentResourceSelection {
  kind: NativeAgentResource["kind"];
}

function nonEmptyText(value: unknown, max = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : undefined;
}

function positiveVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** A share source is only accepted when the selected Room is the current Room. */
export function nativeRoomShareSelectionForTarget(
  selection: NativeRoomKnowledgeShareSelection | undefined,
  target: NativeWorkspaceTarget | undefined,
  roomId: string | undefined
): { source: WorkspaceShareSource; resources: WorkspaceShareResourceOption[] } | undefined {
  if (!selection || !target || !roomId || selection.source.kind !== "room_knowledge") return undefined;
  if (selection.source.id !== roomId || target.workspaceId.length === 0) return undefined;
  const label = nonEmptyText(selection.source.label, 200);
  if (!label || selection.resources.length === 0) return undefined;
  const seen = new Set<string>();
  const resources = selection.resources.flatMap((resource) => {
    const id = nonEmptyText(resource.id);
    const version = positiveVersion(resource.version);
    const title = nonEmptyText(resource.title, 512);
    if (!id || version === undefined || !title || resource.kind !== "knowledge" || seen.has(id)) return [];
    seen.add(id);
    return [{ id, version, kind: "knowledge" as const, title }];
  });
  if (resources.length === 0) return undefined;
  return { source: { kind: "room_knowledge", id: roomId, label }, resources };
}

/** Re-check the complete Agent scope before opening the share dialog. */
export function nativeAgentShareSelectionForTarget(
  selection: NativeAgentShareSelection | undefined,
  target: NativeWorkspaceTarget | undefined,
  resources: readonly NativeAgentResource[],
  agentLabel: string | undefined
): { source: WorkspaceShareSource; resources: WorkspaceShareResourceOption[] } | undefined {
  if (!selection || !target || !selection.agentId || !selection.resourceId) return undefined;
  const selected = resources.find((candidate) => candidate.id === selection.resourceId
    && candidate.scope.agentId === selection.agentId
    && candidate.workspaceId === target.workspaceId
    && candidate.kind === selection.kind
    && nativeAgentResourceCanBeShown(candidate, selection.agentId)
    && candidate.lifecycleState === "active");
  if (!selected) return undefined;
  const label = nonEmptyText(agentLabel, 200) ?? "選択中のAgent";
  const shareableResources = resources.flatMap((candidate) => {
    if (candidate.workspaceId !== target.workspaceId
      || candidate.scope.agentId !== selection.agentId
      || !nativeAgentResourceCanBeShown(candidate, selection.agentId)
      || candidate.lifecycleState !== "active") return [];
    return [{
      id: candidate.id,
      version: candidate.version,
      kind: candidate.kind,
      title: nonEmptyText(candidate.title, 512) ?? candidate.id
    } satisfies WorkspaceShareResourceOption];
  });
  if (shareableResources.length === 0) return undefined;
  return {
    source: { kind: "agent", id: selection.agentId, label },
    resources: shareableResources
  };
}

function manifestToDomain(manifest: WorkspaceShareManifest): PublicShareManifest | undefined {
  const value = {
    format_version: manifest.formatVersion,
    kind: manifest.kind,
    title: manifest.title,
    entries: manifest.entries.map((entry) => ({
      entry_id: entry.entryId,
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
      ...(entry.knowledgeKind === undefined ? {} : { knowledge_kind: entry.knowledgeKind }),
      files: (entry.files ?? []).map((file) => ({
        path: file.path,
        encoding: file.encoding,
        content: file.content,
        byte_size: file.byteSize,
        sha256: file.sha256
      }))
    })),
    ...(manifest.agent === undefined ? {} : { agent: manifest.agent })
  };
  const parsed = PublicShareManifestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function publicShareManifestToWorkspace(manifest: PublicShareManifest): WorkspaceShareManifest {
  return {
    formatVersion: 1,
    kind: manifest.kind,
    title: manifest.title,
    entries: manifest.entries.map((entry) => ({
      entryId: entry.entry_id,
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
      ...(entry.knowledge_kind === undefined ? {} : { knowledgeKind: entry.knowledge_kind }),
      files: entry.files.map((file) => ({
        path: file.path,
        encoding: file.encoding,
        content: file.content,
        byteSize: file.byte_size,
        sha256: file.sha256
      }))
    })),
    ...(manifest.agent === undefined ? {} : { agent: { ...manifest.agent } })
  };
}

/** The bridge deliberately returns recipientCount only; IDs are supplied only from the current edit. */
export function workspaceShareDraftToDomain(draft: WorkspaceShareDraft, recipientIds: readonly string[] = []): PublicShareDraft {
  const manifest = manifestToDomain(draft.manifest);
  if (!manifest) throw new Error("workspace_share_draft_manifest_invalid");
  const parsed = PublicShareDraftSchema.safeParse({
    draft_id: draft.draftId,
    version: draft.version,
    manifest,
    content_hash: draft.contentHash,
    visibility: draft.visibility,
    recipient_account_ids: [...recipientIds],
    removed_references: []
  });
  if (!parsed.success) throw new Error("workspace_share_draft_response_invalid");
  return parsed.data;
}

export function publicShareDraftCreateToWorkspace(input: PublicShareDraftCreateInput): WorkspaceShareDraftCreateInput {
  if ("base_share_id" in input) return { baseShareId: input.base_share_id, operationId: "" };
  return {
    sourceKind: input.source_kind,
    sourceId: input.source_id,
    resourceRefs: input.resource_refs.map((ref) => ({ id: ref.id, version: ref.version })),
    operationId: ""
  };
}

export function publicShareDraftUpdateToWorkspace(input: PublicShareDraftUpdateInput): WorkspaceShareDraftUpdateInput {
  const manifest = PublicShareManifestSchema.parse(input.manifest);
  return {
    draftId: input.draft_id,
    expectedVersion: input.expected_version,
    manifest: publicShareManifestToWorkspace(manifest),
    visibility: input.visibility,
    recipientAccountIds: [...input.recipient_account_ids],
    operationId: ""
  };
}

export function workspaceSharePublishToDomain(result: WorkspaceSharePublishResult): PublicSharePublishResult {
  return {
    share_id: result.shareId,
    version: result.version,
    url: result.url,
    content_hash: result.contentHash,
    published_at: result.publishedAt
  };
}

export function workspaceShareRevokeToDomain(result: WorkspaceShareRevokeResult): PublicShareRevokeResult {
  return {
    share_id: result.shareId,
    version: result.version,
    status: "revoked",
    revoked_at: result.revokedAt
  };
}

export function workspaceShareImportToDomain(result: WorkspaceShareImportResult): PublicShareImportResult {
  return {
    import_id: result.importId,
    kind: result.kind,
    status: result.status,
    phase: result.phase,
    retryable: result.retryable,
    failure_code: result.failureCode,
    created_resource_ids: [...result.createdResourceIds],
    created_agent_id: result.createdAgentId,
    committed_at: result.committedAt
  };
}

export function workspaceShareLinkViewToDomain(view: WorkspaceShareLinkView): WorkspaceSharePublishedView {
  const manifest = manifestToDomain(view.manifest);
  if (!manifest) throw new Error("workspace_share_link_manifest_invalid");
  return {
    title: view.title,
    kind: view.manifest.kind,
    visibility: view.visibility,
    manifest,
    contentHash: view.contentHash,
    publishedAt: view.publishedAt
  };
}

export function workspaceShareSummaryToDialog(summary: WorkspaceShareSummary): WorkspaceSharePublishedSummary | undefined {
  if (summary.status === "draft" || (summary.status !== "active" && summary.status !== "revoked")) return undefined;
  return {
    shareId: summary.shareId,
    version: summary.version,
    title: summary.title,
    visibility: summary.visibility,
    status: summary.status,
    publishedAt: summary.publishedAt ?? summary.createdAt,
    ...(summary.recipientCount > 0 ? { recipientLabels: [`受信者 ${summary.recipientCount}件`] } : {})
  };
}
