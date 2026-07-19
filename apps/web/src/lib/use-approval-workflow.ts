import { ref, type Ref } from "vue";
import type {
  ActivityInboxItem,
  ApprovalRequest,
  AuditRecord,
  MemoryFrontmatter,
  OperationRecord,
  PolicyDecisionRecord,
  RollbackPoint,
  SessionRecord
} from "@samurai-agent/core-schemas";
import type { LocaleKey } from "@samurai-agent/localization";
import { api, ApiError, type ApprovalLifecyclePayload, type ArchiveMemoryPayload, type MemoryDetail } from "./api";

export type PendingApprovalChoice = "allow" | "allow_prefix" | "deny";

export function useApprovalWorkflow(input: {
  activeSession: Ref<SessionRecord | null>;
  activeMemory: Ref<MemoryDetail | null>;
  approvalRequests: Ref<ApprovalRequest[]>;
  operations: Ref<OperationRecord[]>;
  auditRecords: Ref<AuditRecord[]>;
  policyDecisions: Ref<PolicyDecisionRecord[]>;
  rollbackPoints: Ref<RollbackPoint[]>;
  activity: Ref<ActivityInboxItem[]>;
  memory: Ref<Array<MemoryFrontmatter & { file_path: string }>>;
  loading: Ref<boolean>;
  operationsById: Readonly<Ref<Map<string, OperationRecord>>>;
  approvalsById: Readonly<Ref<Map<string, ApprovalRequest>>>;
  label: (key: LocaleKey) => string;
  reloadActiveSession: () => Promise<void>;
}) {
  const pendingApprovalChoices = ref<Record<string, PendingApprovalChoice>>({});

  async function approveRequest(request: ApprovalRequest) {
    await handleApprovalLifecycle(() => api.approveApprovalRequest(request.id));
  }

  async function denyRequest(request: ApprovalRequest) {
    await handleApprovalLifecycle(() => api.denyApprovalRequest(request.id, input.label("approval.denied_reason")));
  }

  async function restoreWorkspaceChange(point: RollbackPoint) {
    if (input.loading.value || !point.reversible) return;
    input.loading.value = true;
    try {
      await api.restoreRollbackPoint(point.id);
      await input.reloadActiveSession();
    } finally {
      input.loading.value = false;
    }
  }

  async function archiveMemoryItem(id: string) {
    const session = input.activeSession.value;
    if (!session) return;
    applyArchiveMemory(await api.archiveMemory(id, session.id));
    await input.reloadActiveSession();
  }

  async function approveActivity(item: ActivityInboxItem) {
    if (item.approval_request_id) await handleApprovalLifecycle(() => api.approveApprovalRequest(item.approval_request_id!));
  }

  async function denyActivity(item: ActivityInboxItem) {
    if (item.approval_request_id) await handleApprovalLifecycle(() => api.denyApprovalRequest(item.approval_request_id!, input.label("approval.denied_reason")));
  }

  async function handleApprovalLifecycle(action: () => Promise<ApprovalLifecyclePayload>) {
    try {
      applyApprovalLifecycle(await action());
    } catch (error) {
      if (error instanceof ApiError && isApprovalLifecyclePayload(error.body)) {
        applyApprovalLifecycle(error.body);
        return;
      }
      throw error;
    }
  }

  async function refreshAuditContext() {
    const payload = await api.getAudit();
    input.auditRecords.value = payload.auditRecords;
    input.operations.value = mergeById(payload.operations, input.operations.value);
    input.policyDecisions.value = payload.policyDecisions;
    input.approvalRequests.value = payload.approvalRequests;
    input.rollbackPoints.value = payload.rollbackPoints;
  }

  function applyApprovalLifecycle(payload: ApprovalLifecyclePayload) {
    input.approvalRequests.value = replaceFirst(input.approvalRequests.value, payload.approvalRequest);
    input.operations.value = replaceFirst(input.operations.value, payload.operation);
    input.auditRecords.value = replaceFirst(input.auditRecords.value, payload.auditRecord);
    input.activity.value = payload.activity;
  }

  function applyArchiveMemory(payload: ArchiveMemoryPayload) {
    input.operations.value = replaceFirst(input.operations.value, payload.operation);
    input.auditRecords.value = replaceFirst(input.auditRecords.value, payload.auditRecord);
    if (payload.rollbackPoint) input.rollbackPoints.value = replaceFirst(input.rollbackPoints.value, payload.rollbackPoint);
    input.activity.value = payload.activity;
    input.memory.value = input.memory.value.filter((item) => item.id !== payload.memory.id);
    if (input.activeMemory.value?.memory.id === payload.memory.id) input.activeMemory.value = null;
  }

  function activityLabel(item: ActivityInboxItem): string {
    return input.label(`activity.type.${item.activity_type}` as LocaleKey);
  }

  function auditStatus(audit: AuditRecord): string {
    const operation = input.operationsById.value.get(audit.operation_id);
    const approval = operation?.approval_request_id ? input.approvalsById.value.get(operation.approval_request_id) : undefined;
    if (approval?.status === "pending") return input.label("approval.status.pending");
    if (approval?.status === "approved" && operation?.status === "deferred") return input.label("approval.status.approved_deferred");
    if (approval?.status === "denied" || operation?.status === "denied") return input.label("approval.status.denied");
    if (approval?.status === "expired") return input.label("approval.status.expired");
    if (approval?.status === "cancelled") return input.label("approval.status.cancelled");
    if (operation?.status === "completed") return input.label("approval.status.completed");
    if (operation?.status === "deferred") return input.label("approval.status.deferred");
    return input.label("approval.status.recorded");
  }

  function approvalRequestLabel(request: ApprovalRequest): string {
    if (request.status === "approved") return input.label("approval.status.completed");
    return request.status === "pending" ? input.label("approval.status.pending") : input.label(`approval.status.${request.status}` as LocaleKey);
  }

  function approvalRequestTitle(): string { return input.label("pending_request.title"); }

  function approvalRequestReason(request: ApprovalRequest): string {
    if (!/approval|user-visible boundary|needs permission/i.test(request.reason)) return request.reason;
    const operation = input.operationsById.value.get(request.operation_id);
    const operationText = [operation?.capability_id, operation?.operation, ...(operation?.proposed_effects ?? []), ...(operation?.target_resource_refs.map((ref) => ref.kind) ?? [])].join(" ");
    if (/command|shell|exec|terminal/i.test(operationText) || approvalRequestCommandText(request)) return input.label("pending_request.command_reason");
    if (/write|patch|update|create|delete|file|artifact|memory|wiki|skill|collection/i.test(operationText)) return input.label("pending_request.change_reason");
    return input.label("pending_request.work_reason");
  }

  function approvalRequestCommandText(request: ApprovalRequest): string {
    const operation = input.operationsById.value.get(request.operation_id);
    if (!operation) return "";
    return operation.proposed_effects.find(isCommandLikeText) ?? (isCommandLikeText(operation.operation) ? operation.operation : "");
  }

  function pendingApprovalChoice(request: ApprovalRequest): PendingApprovalChoice {
    return pendingApprovalChoices.value[request.id] ?? "allow";
  }

  function setPendingApprovalChoice(request: ApprovalRequest, choice: PendingApprovalChoice) {
    pendingApprovalChoices.value = { ...pendingApprovalChoices.value, [request.id]: choice };
  }

  async function submitPendingApproval(request: ApprovalRequest) {
    if (pendingApprovalChoice(request) === "deny") await denyRequest(request);
    else await approveRequest(request);
  }

  return {
    pendingApprovalChoices, approveRequest, denyRequest, restoreWorkspaceChange, archiveMemoryItem,
    approveActivity, denyActivity, refreshAuditContext, applyApprovalLifecycle, applyArchiveMemory,
    activityLabel, auditStatus, approvalRequestLabel, approvalRequestTitle, approvalRequestReason,
    approvalRequestCommandText, pendingApprovalChoice, setPendingApprovalChoice, submitPendingApproval
  };
}

function isCommandLikeText(value: string | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  if (!text || /[.?!。！？]$/.test(text)) return false;
  return /^(?:CI=true\s+|[A-Z_][A-Z0-9_]*=[^\s]+\s+)*(?:pnpm|npm|yarn|bun|node|npx|go|cargo|python3?|pytest|rg|curl|git|vite|tsx|tsc|deno|make|bash|sh|zsh)\b/.test(text);
}

function isApprovalLifecyclePayload(value: unknown): value is ApprovalLifecyclePayload {
  return isRecord(value) && isRecord(value.approvalRequest) && isRecord(value.operation) && isRecord(value.auditRecord) && Array.isArray(value.activity);
}

function mergeById<T extends { id: string }>(primary: T[], fallback: T[]): T[] {
  return [...primary, ...fallback.filter((candidate) => !primary.some((item) => item.id === candidate.id))];
}

function replaceFirst<T extends { id: string }>(items: T[], item: T): T[] {
  return [item, ...items.filter((candidate) => candidate.id !== item.id)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
