import {
  type ActivityInboxItem,
  type ApprovalRequest,
  type AuditRecord,
  type OperationRecord,
  type PolicyDecisionRecord,
  type RollbackPoint,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";

export interface ActivityInputs {
  approvals: ApprovalRequest[];
  operations: OperationRecord[];
  decisions: PolicyDecisionRecord[];
  audits: AuditRecord[];
  rollbacks: RollbackPoint[];
}

export function buildActivityInboxItems(inputs: ActivityInputs): ActivityInboxItem[] {
  const items: ActivityInboxItem[] = [];
  const operationsById = new Map(inputs.operations.map((operation) => [operation.id, operation]));
  const rollbacksByOperationId = new Map(inputs.rollbacks.map((rollback) => [rollback.operation_id, rollback]));
  const auditsByOperationId = latestBy(inputs.audits, (audit) => audit.operation_id, (audit) => audit.created_at);
  const pendingApprovalByOperationId = selectPendingApprovals(inputs.approvals, operationsById);

  for (const approval of pendingApprovalByOperationId.values()) {
    const operation = operationsById.get(approval.operation_id);
    items.push({
      id: `activity_${approval.id}`,
      activity_type: "approval_required",
      severity: approval.requested_level === "strong_approval" ? "critical" : "warning",
      title: "Approval required",
      summary: approval.reason,
      operation_id: approval.operation_id,
      approval_request_id: approval.id,
      rollback_point_id: rollbacksByOperationId.get(approval.operation_id)?.id,
      created_at: approval.created_at
    });
  }

  for (const operation of inputs.operations) {
    if (operation.status === "failed") {
      items.push({
        id: `activity_failure_${operation.id}`,
        activity_type: "failure",
        severity: "critical",
        title: "Operation failed",
        summary: operation.error ?? `${operation.operation} failed.`,
        operation_id: operation.id,
        created_at: operation.updated_at
      });
    }
  }

  for (const decision of inputs.decisions) {
    const operation = operationsById.get(decision.operation_id);
    if (decision.decision !== "allow_with_audit" || operation?.status !== "completed") {
      continue;
    }
    items.push({
      id: `activity_audit_${decision.id}`,
      activity_type: "auto_run",
      severity: "notice",
      title: "Auto run with audit",
      summary: decision.reason,
      operation_id: decision.operation_id,
      audit_record_id: auditsByOperationId.get(decision.operation_id)?.id,
      rollback_point_id: rollbacksByOperationId.get(decision.operation_id)?.id,
      created_at: decision.created_at
    });
  }

  for (const rollback of inputs.rollbacks) {
    const expiresSoon = Date.parse(rollback.expires_at) - Date.now() < 1000 * 60 * 60 * 24;
    if (!expiresSoon) {
      continue;
    }
    items.push({
      id: `activity_rollback_${rollback.id}`,
      activity_type: "rollback_expiring",
      severity: "warning",
      title: "Rollback point expiring",
      summary: "A reversible workspace snapshot is close to expiry.",
      operation_id: rollback.operation_id,
      rollback_point_id: rollback.id,
      created_at: rollback.created_at
    });
  }

  return dedupe(items).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function createAuditRecord(input: Omit<AuditRecord, "id" | "created_at">): AuditRecord {
  return {
    ...input,
    id: createId("audit"),
    created_at: nowIso()
  };
}

function dedupe(items: ActivityInboxItem[]): ActivityInboxItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function selectPendingApprovals(
  approvals: ApprovalRequest[],
  operationsById: Map<string, OperationRecord>
): Map<string, ApprovalRequest> {
  const pendingByOperation = new Map<string, ApprovalRequest>();

  for (const approval of approvals) {
    if (approval.status !== "pending") {
      continue;
    }
    const operation = operationsById.get(approval.operation_id);
    if (!operation || operation.status !== "pending_approval") {
      continue;
    }

    const current = pendingByOperation.get(approval.operation_id);
    const isOperationLinked = operation.approval_request_id === approval.id;
    const currentIsOperationLinked = current ? operation.approval_request_id === current.id : false;

    if (
      !current ||
      (isOperationLinked && !currentIsOperationLinked) ||
      (isOperationLinked === currentIsOperationLinked && Date.parse(approval.created_at) > Date.parse(current.created_at))
    ) {
      pendingByOperation.set(approval.operation_id, approval);
    }
  }

  return pendingByOperation;
}

function latestBy<T>(items: T[], keyFor: (item: T) => string, dateFor: (item: T) => string): Map<string, T> {
  const latest = new Map<string, T>();
  for (const item of items) {
    const key = keyFor(item);
    const current = latest.get(key);
    if (!current || Date.parse(dateFor(item)) > Date.parse(dateFor(current))) {
      latest.set(key, item);
    }
  }
  return latest;
}
