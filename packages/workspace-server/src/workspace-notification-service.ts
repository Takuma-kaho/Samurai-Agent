import { createHash } from "node:crypto";
import { assertOpaqueId } from "./config";
import { WorkspaceServerError } from "./errors";

export const workspaceNotificationKinds = [
  "work_completed",
  "work_failed",
  "approval_required",
  "input_required",
  "invitation"
] as const;

export type WorkspaceNotificationKnownKind = (typeof workspaceNotificationKinds)[number];
/** Unknown future kinds remain representable and are rendered safely. */
export type WorkspaceNotificationKind = WorkspaceNotificationKnownKind | (string & {});

export const workspaceNotificationActionRequiredKinds = [
  "approval_required",
  "input_required",
  "invitation"
] as const;

export type WorkspaceNotificationActionState = "not_required" | "pending" | "resolved";
export type WorkspaceNotificationOutboxAction = "create" | "invalidate";

export type WorkspaceNotificationTarget =
  | { kind: "room"; roomId: string }
  | { kind: "work"; roomId: string; workId: string; messageId?: string }
  | { kind: "knowledge"; roomId: string; resourceId: string }
  | { kind: "interaction_request"; roomId: string; requestId: string }
  | { kind: "invitation"; invitationId: string };

/** Durable metadata only. Notification title/body is never stored here. */
export interface WorkspaceNotificationRecord {
  id: string;
  recipientAccountId: string;
  workspaceId?: string;
  roomId?: string;
  kind: WorkspaceNotificationKind;
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
  createdAt: string;
  readAt: string | null;
}

/** Durable outbox metadata only. The source state remains the display authority. */
export interface WorkspaceNotificationOutbox {
  id: string;
  workspaceId?: string;
  roomId?: string;
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
  kind: WorkspaceNotificationKind;
  action: WorkspaceNotificationOutboxAction;
  recipientAccountIds: readonly string[];
  createdAt: string;
  processedAt: string | null;
  attempts: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
}

export interface WorkspaceNotificationOutboxInput {
  id?: string;
  workspaceId?: string;
  roomId?: string;
  sourceKind: string;
  sourceId: string;
  sourceRevision: number;
  kind: WorkspaceNotificationKind;
  action?: WorkspaceNotificationOutboxAction;
  recipientAccountIds: readonly string[];
  createdAt?: string;
}

export interface WorkspaceNotificationReadContext {
  accountId: string;
  workspaceId: string;
}

export interface WorkspaceNotificationAccountContext {
  accountId: string;
}

/**
 * The resolver is the current authorization and source-state boundary. It is
 * called for every notification returned or changed, including unknown kinds.
 */
export interface WorkspaceNotificationAuthorizationResolver {
  authorizeWorkspace(input: { accountId: string; workspaceId: string }): Promise<boolean>;
  resolveNotification(
    input: {
      accountId: string;
      workspaceId?: string;
      notification: WorkspaceNotificationRecord;
    }
  ): Promise<WorkspaceNotificationResolution>;
}

export interface WorkspaceNotificationResolution {
  allowed: boolean;
  actionState?: WorkspaceNotificationActionState;
  title?: string;
  summary?: string;
  target?: WorkspaceNotificationTarget | null;
}

export interface WorkspaceNotificationView {
  id: string;
  kind: WorkspaceNotificationKind;
  createdAt: string;
  readAt: string | null;
  title: string;
  summary: string;
  target: WorkspaceNotificationTarget | null;
  actionState: WorkspaceNotificationActionState;
}

export interface WorkspaceNotificationPage {
  items: WorkspaceNotificationView[];
  nextCursor: string | null;
}

export interface WorkspaceNotificationSummary {
  unreadCount: number;
  asOf: string;
}

export interface WorkspaceNotificationWorkspaceSummary {
  workspaceId: string;
  unreadCount: number;
  asOf: string;
}

export interface WorkspaceNotificationReadResult {
  updatedIds: string[];
  alreadyReadIds: string[];
  readAt: string;
}

export interface WorkspaceNotificationProjectionTransaction {
  /** Must use INSERT ... ON CONFLICT DO NOTHING for create projection. */
  insertNotification(notification: WorkspaceNotificationRecord): Promise<"inserted" | "existing">;
  /** Marks the locked outbox row in the same transaction as notification inserts. */
  markOutboxProcessed(processedAt: string): Promise<void>;
}

/**
 * Storage is deliberately injected. The production adapter can bind these
 * methods to PostgreSQL/RLS without moving authorization into this service.
 */
export interface WorkspaceNotificationStore {
  listPendingOutboxes(input: { now: string; limit: number }): Promise<readonly WorkspaceNotificationOutbox[]>;
  withOutboxTransaction<T>(
    outboxId: string,
    action: (transaction: WorkspaceNotificationProjectionTransaction, outbox: WorkspaceNotificationOutbox) => Promise<T>
  ): Promise<T>;
  /** Updates attempts/next_attempt_at only; processedAt must remain NULL. */
  markOutboxFailure(input: {
    outboxId: string;
    attempts: number;
    nextAttemptAt: string;
    lastErrorCode: string;
  }): Promise<void>;
  listNotifications(input: {
    accountId: string;
    workspaceId?: string;
    invitationOnly?: boolean;
  }): Promise<readonly WorkspaceNotificationRecord[]>;
  getNotifications(input: {
    accountId: string;
    notificationIds: readonly string[];
  }): Promise<readonly WorkspaceNotificationRecord[]>;
  /** Must lock all requested rows and update only rows whose readAt is NULL. */
  markNotificationsRead(input: {
    accountId: string;
    workspaceId?: string;
    notificationIds: readonly string[];
    readAt: string;
  }): Promise<readonly WorkspaceNotificationRecord[]>;
}

export interface WorkspaceNotificationServiceOptions {
  clock?: () => Date;
  maxPageSize?: number;
  maxReadBatchSize?: number;
  maxProjectionBatchSize?: number;
}

export interface WorkspaceNotificationProjectionResult {
  processedIds: string[];
  failed: Array<{ outboxId: string; errorCode: string }>;
}

const defaultPageSize = 30;
const maxPageSize = 100;
const maxReadBatchSize = 100;
const maxProjectionBatchSize = 100;
const maxDisplayTitleLength = 200;
const maxDisplaySummaryLength = 20_000;
const notificationActionRequiredSet = new Set<string>(workspaceNotificationActionRequiredKinds);
const knownKindSet = new Set<string>(workspaceNotificationKinds);

/**
 * Build the outbox metadata that a state-transition Core writes in its own
 * transaction. Empty recipient sets intentionally produce no outbox row.
 */
export function buildWorkspaceNotificationOutbox(
  input: WorkspaceNotificationOutboxInput
): WorkspaceNotificationOutbox | undefined {
  if (!Array.isArray(input.recipientAccountIds)) {
    throw new WorkspaceServerError("workspace_notification_recipients_invalid", 400);
  }
  if (input.recipientAccountIds.length === 0) return undefined;
  const recipients = uniqueOpaqueIds(input.recipientAccountIds, "account_id_invalid");
  if (recipients.length === 0) return undefined;
  const workspaceId = optionalOpaqueId(input.workspaceId, "workspace_id_invalid");
  const roomId = optionalOpaqueId(input.roomId, "room_id_invalid");
  if (roomId && !workspaceId) throw new WorkspaceServerError("workspace_notification_workspace_required", 400);
  const kind = normalizeKind(input.kind);
  if (kind === "invitation") {
    if (roomId) throw new WorkspaceServerError("workspace_notification_invitation_room_forbidden", 400);
  } else if (knownKindSet.has(kind) && (workspaceId === undefined || roomId === undefined)) {
    throw new WorkspaceServerError("workspace_notification_room_required", 400);
  }
  const sourceKind = requireOpaqueId(input.sourceKind, "workspace_notification_source_kind_invalid");
  const sourceId = requireOpaqueId(input.sourceId, "workspace_notification_source_id_invalid");
  const sourceRevision = normalizeRevision(input.sourceRevision);
  const action = input.action ?? "create";
  if (action !== "create" && action !== "invalidate") {
    throw new WorkspaceServerError("workspace_notification_action_invalid", 400);
  }
  const createdAt = normalizeTimestamp(input.createdAt ?? new Date().toISOString(), "workspace_notification_created_at_invalid");
  const id = input.id
    ? requireOpaqueId(input.id, "workspace_notification_outbox_id_invalid")
    : stableId("outbox", { workspaceId: workspaceId ?? null, roomId: roomId ?? null, sourceKind, sourceId, sourceRevision, kind, action, recipients });
  return {
    id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(roomId === undefined ? {} : { roomId }),
    sourceKind,
    sourceId,
    sourceRevision,
    kind,
    action,
    recipientAccountIds: recipients,
    createdAt,
    processedAt: null,
    attempts: 0,
    nextAttemptAt: createdAt,
    lastErrorCode: null
  };
}

export class WorkspaceNotificationService {
  private readonly clock: () => Date;
  private readonly pageSize: number;
  private readonly readBatchSize: number;
  private readonly projectionBatchSize: number;

  constructor(
    private readonly store: WorkspaceNotificationStore,
    private readonly authorization: WorkspaceNotificationAuthorizationResolver,
    options: WorkspaceNotificationServiceOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.pageSize = boundedOption(options.maxPageSize, defaultPageSize, maxPageSize, "workspace_notification_page_size_invalid");
    this.readBatchSize = boundedOption(options.maxReadBatchSize, maxReadBatchSize, maxReadBatchSize, "workspace_notification_read_batch_size_invalid");
    this.projectionBatchSize = boundedOption(options.maxProjectionBatchSize, maxProjectionBatchSize, maxProjectionBatchSize, "workspace_notification_projection_batch_size_invalid");
  }

  /** Project due outbox rows. A failed transaction stays retryable. */
  async projectOutbox(input: { limit?: number; now?: string } = {}): Promise<WorkspaceNotificationProjectionResult> {
    const limit = boundedOption(input.limit, this.projectionBatchSize, maxProjectionBatchSize, "workspace_notification_projection_limit_invalid", 400);
    const now = normalizeTimestamp(input.now ?? this.clock().toISOString(), "workspace_notification_time_invalid");
    const pending = await this.store.listPendingOutboxes({ now, limit });
    const processedIds: string[] = [];
    const failed: Array<{ outboxId: string; errorCode: string }> = [];
    for (const candidate of pending) {
      const candidateId = typeof candidate?.id === "string" ? candidate.id : "unknown";
      try {
        const outbox = normalizeOutbox(candidate);
        await this.store.withOutboxTransaction(outbox.id, async (transaction, lockedOutbox) => {
          const locked = normalizeOutbox(lockedOutbox);
          if (locked.processedAt) return;
          if (locked.action === "create") {
            for (const recipientAccountId of locked.recipientAccountIds) {
              await transaction.insertNotification({
                // Keep the projection key independent from the outbox row ID:
                // a duplicate outbox for the same source transition must still
                // resolve to the same recipient notification.
                id: stableId("notification", {
                  recipientAccountId,
                  workspaceId: locked.workspaceId ?? null,
                  sourceKind: locked.sourceKind,
                  sourceId: locked.sourceId,
                  sourceRevision: locked.sourceRevision,
                  kind: locked.kind
                }),
                recipientAccountId,
                ...(locked.workspaceId === undefined ? {} : { workspaceId: locked.workspaceId }),
                ...(locked.roomId === undefined ? {} : { roomId: locked.roomId }),
                kind: locked.kind,
                sourceKind: locked.sourceKind,
                sourceId: locked.sourceId,
                sourceRevision: locked.sourceRevision,
                createdAt: locked.createdAt,
                readAt: null
              });
            }
          }
          // `invalidate` intentionally creates no new row. The resolver reads
          // current source state and renders the existing row as resolved.
          await transaction.markOutboxProcessed(now);
        });
        processedIds.push(outbox.id);
      } catch (error) {
        const outboxId = candidateId;
        const attempts = typeof candidate?.attempts === "number" && Number.isSafeInteger(candidate.attempts) && candidate.attempts >= 0
          ? candidate.attempts + 1
          : 1;
        const errorCode = errorCodeOf(error);
        const delaySeconds = Math.min(300, 2 ** Math.min(attempts, 9));
        const nextAttemptAt = new Date(new Date(now).getTime() + delaySeconds * 1_000).toISOString();
        await this.store.markOutboxFailure({ outboxId, attempts, nextAttemptAt, lastErrorCode: errorCode });
        failed.push({ outboxId, errorCode });
      }
    }
    return { processedIds, failed };
  }

  async projectPendingOutbox(input: { limit?: number; now?: string } = {}): Promise<WorkspaceNotificationProjectionResult> {
    return this.projectOutbox(input);
  }

  async listNotifications(
    context: WorkspaceNotificationReadContext,
    input: { unreadOnly?: boolean; limit?: number; cursor?: string } = {}
  ): Promise<WorkspaceNotificationPage> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    const workspaceId = requireOpaqueId(context.workspaceId, "workspace_id_invalid");
    const unreadOnly = input.unreadOnly === true;
    const limit = boundedOption(input.limit, this.pageSize, maxPageSize, "workspace_notification_limit_invalid", 400);
    await this.assertWorkspaceReadable(accountId, workspaceId);
    const cursor = decodeCursor(input.cursor, { accountId, workspaceId, unreadOnly });
    const records = await this.store.listNotifications({ accountId, workspaceId });
    const views = await this.resolveViews({ accountId, workspaceId }, records, unreadOnly, cursor);
    return pageViews(views, limit, (last) => encodeCursor({ accountId, workspaceId, unreadOnly, createdAt: last.createdAt, id: last.id }));
  }

  async list(context: WorkspaceNotificationReadContext, input: { unreadOnly?: boolean; limit?: number; cursor?: string } = {}): Promise<WorkspaceNotificationPage> {
    return this.listNotifications(context, input);
  }

  async notificationSummary(context: WorkspaceNotificationReadContext): Promise<WorkspaceNotificationSummary> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    const workspaceId = requireOpaqueId(context.workspaceId, "workspace_id_invalid");
    await this.assertWorkspaceReadable(accountId, workspaceId);
    const records = await this.store.listNotifications({ accountId, workspaceId });
    const views = await this.resolveViews({ accountId, workspaceId }, records, true);
    return { unreadCount: views.length, asOf: this.clock().toISOString() };
  }

  async summary(context: WorkspaceNotificationReadContext): Promise<WorkspaceNotificationSummary> {
    return this.notificationSummary(context);
  }

  async listWorkspaceNotificationSummaries(
    context: WorkspaceNotificationAccountContext,
    workspaceIds: readonly string[]
  ): Promise<WorkspaceNotificationWorkspaceSummary[]> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    if (!Array.isArray(workspaceIds) || workspaceIds.length < 1 || workspaceIds.length > 100) {
      throw new WorkspaceServerError("workspace_notification_workspace_ids_invalid", 400);
    }
    const uniqueWorkspaceIds = uniqueOpaqueIds(workspaceIds, "workspace_id_invalid");
    const asOf = this.clock().toISOString();
    const summaries: WorkspaceNotificationWorkspaceSummary[] = [];
    for (const workspaceId of uniqueWorkspaceIds) {
      if (!(await this.authorization.authorizeWorkspace({ accountId, workspaceId }))) continue;
      const records = await this.store.listNotifications({ accountId, workspaceId });
      const views = await this.resolveViews({ accountId, workspaceId }, records, true);
      summaries.push({ workspaceId, unreadCount: views.length, asOf });
    }
    return summaries;
  }

  async workspaceSummaries(
    context: WorkspaceNotificationAccountContext,
    workspaceIds: readonly string[]
  ): Promise<WorkspaceNotificationWorkspaceSummary[]> {
    return this.listWorkspaceNotificationSummaries(context, workspaceIds);
  }

  async listInvitationNotifications(
    context: WorkspaceNotificationAccountContext,
    input: { unreadOnly?: boolean; limit?: number; cursor?: string } = {}
  ): Promise<WorkspaceNotificationPage> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    const unreadOnly = input.unreadOnly === true;
    const limit = boundedOption(input.limit, this.pageSize, maxPageSize, "workspace_notification_limit_invalid", 400);
    const cursor = decodeCursor(input.cursor, { accountId, workspaceId: undefined, unreadOnly, invitationOnly: true });
    const records = await this.store.listNotifications({ accountId, invitationOnly: true });
    const views = await this.resolveViews({ accountId }, records, unreadOnly, cursor, true);
    return pageViews(views, limit, (last) => encodeCursor({ accountId, workspaceId: undefined, unreadOnly, invitationOnly: true, createdAt: last.createdAt, id: last.id }));
  }

  async invitations(
    context: WorkspaceNotificationAccountContext,
    input: { unreadOnly?: boolean; limit?: number; cursor?: string } = {}
  ): Promise<WorkspaceNotificationPage> {
    return this.listInvitationNotifications(context, input);
  }

  async markNotificationsRead(
    context: WorkspaceNotificationReadContext,
    notificationIds: readonly string[]
  ): Promise<WorkspaceNotificationReadResult> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    const workspaceId = requireOpaqueId(context.workspaceId, "workspace_id_invalid");
    await this.assertWorkspaceReadable(accountId, workspaceId);
    const ids = normalizeReadIds(notificationIds, this.readBatchSize);
    const records = await this.store.getNotifications({ accountId, notificationIds: ids });
    const recordById = assertAllReadTargets(records, ids, { accountId, workspaceId, invitationOnly: false });
    await this.authorizeAllForRead(accountId, workspaceId, ids.map((id) => recordById.get(id)!));
    return this.persistRead(accountId, workspaceId, ids, recordById);
  }

  async markRead(context: WorkspaceNotificationReadContext, notificationIds: readonly string[]): Promise<WorkspaceNotificationReadResult> {
    return this.markNotificationsRead(context, notificationIds);
  }

  async markInvitationNotificationsRead(
    context: WorkspaceNotificationAccountContext,
    notificationIds: readonly string[]
  ): Promise<WorkspaceNotificationReadResult> {
    const accountId = requireOpaqueId(context.accountId, "account_id_invalid");
    const ids = normalizeReadIds(notificationIds, this.readBatchSize);
    const records = await this.store.getNotifications({ accountId, notificationIds: ids });
    const recordById = assertAllReadTargets(records, ids, { accountId, invitationOnly: true });
    await this.authorizeAllForRead(accountId, undefined, ids.map((id) => recordById.get(id)!));
    return this.persistRead(accountId, undefined, ids, recordById);
  }

  async markInvitationRead(context: WorkspaceNotificationAccountContext, notificationIds: readonly string[]): Promise<WorkspaceNotificationReadResult> {
    return this.markInvitationNotificationsRead(context, notificationIds);
  }

  private async assertWorkspaceReadable(accountId: string, workspaceId: string): Promise<void> {
    if (!(await this.authorization.authorizeWorkspace({ accountId, workspaceId }))) {
      throw new WorkspaceServerError("workspace_notification_workspace_access_denied", 403);
    }
  }

  private async resolveViews(
    context: { accountId: string; workspaceId?: string },
    records: readonly WorkspaceNotificationRecord[],
    unreadOnly: boolean,
    cursor?: WorkspaceNotificationCursor,
    invitationOnly = false
  ): Promise<WorkspaceNotificationView[]> {
    const sorted = records
      .map(normalizeRecord)
      .filter((record) => record.recipientAccountId === context.accountId)
      .filter((record) => context.workspaceId === undefined || record.workspaceId === context.workspaceId)
      .filter((record) => !invitationOnly || record.kind === "invitation")
      .sort(compareNotificationRecords);
    const views: WorkspaceNotificationView[] = [];
    for (const record of sorted) {
      if (cursor && !isAfterCursor(record, cursor)) continue;
      const view = await this.resolveView(context, record);
      if (!view) continue;
      if (unreadOnly && (view.readAt !== null || view.actionState === "resolved")) continue;
      views.push(view);
    }
    return views;
  }

  private async resolveView(
    context: { accountId: string; workspaceId?: string },
    record: WorkspaceNotificationRecord
  ): Promise<WorkspaceNotificationView | undefined> {
    let resolution: WorkspaceNotificationResolution;
    try {
      resolution = await this.authorization.resolveNotification({ ...context, notification: record });
    } catch (error) {
      if (isHiddenAuthorizationError(error)) return undefined;
      throw error;
    }
    if (!resolution.allowed) return undefined;
    const actionState = normalizeActionState(resolution.actionState, record.kind);
    return {
      id: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      readAt: record.readAt,
      title: safeDisplayText(resolution.title, defaultTitle(record.kind), maxDisplayTitleLength),
      summary: safeDisplayText(resolution.summary, defaultSummary(record.kind), maxDisplaySummaryLength),
      target: safeTarget(resolution.target)
        ?? defaultTarget(record),
      actionState
    };
  }

  private async authorizeAllForRead(
    accountId: string,
    workspaceId: string | undefined,
    records: WorkspaceNotificationRecord[]
  ): Promise<void> {
    const results = await Promise.all(records.map(async (notification) => {
      try {
        return await this.authorization.resolveNotification({ accountId, ...(workspaceId === undefined ? {} : { workspaceId }), notification });
      } catch (error) {
        if (isHiddenAuthorizationError(error)) return { allowed: false };
        throw error;
      }
    }));
    if (results.some((result) => !result.allowed)) {
      throw new WorkspaceServerError("workspace_notification_read_denied", 403);
    }
  }

  private async persistRead(
    accountId: string,
    workspaceId: string | undefined,
    notificationIds: readonly string[],
    previousById: ReadonlyMap<string, WorkspaceNotificationRecord>
  ): Promise<WorkspaceNotificationReadResult> {
    const requestedReadAt = this.clock().toISOString();
    const updated = (await this.store.markNotificationsRead({ accountId, ...(workspaceId === undefined ? {} : { workspaceId }), notificationIds, readAt: requestedReadAt })).map(normalizeRecord);
    const byId = new Map(updated.map((record) => [record.id, record]));
    if (notificationIds.some((id) => !byId.has(id))) {
      throw new WorkspaceServerError("workspace_notification_read_not_applied", 503);
    }
    const updatedIds: string[] = [];
    const alreadyReadIds: string[] = [];
    for (const id of notificationIds) {
      const record = byId.get(id)!;
      const previous = previousById.get(id)!;
      if (record.readAt === null) {
        throw new WorkspaceServerError("workspace_notification_read_not_applied", 503);
      }
      if (previous.readAt !== null && record.readAt !== previous.readAt) {
        throw new WorkspaceServerError("workspace_notification_read_timestamp_changed", 409);
      }
      if (previous.readAt === null) updatedIds.push(id);
      else alreadyReadIds.push(id);
    }
    // Return the first requested row's persisted timestamp. This keeps the
    // operation response stable when a replay contains already-read rows.
    return { updatedIds, alreadyReadIds, readAt: byId.get(notificationIds[0]!)!.readAt! };
  }
}

interface WorkspaceNotificationCursor {
  accountId: string;
  workspaceId?: string;
  unreadOnly: boolean;
  invitationOnly?: boolean;
  createdAt: string;
  id: string;
}

function normalizeOutbox(value: WorkspaceNotificationOutbox): WorkspaceNotificationOutbox {
  if (!value || typeof value !== "object") throw new WorkspaceServerError("workspace_notification_outbox_invalid", 500);
  const id = requireOpaqueId(value.id, "workspace_notification_outbox_id_invalid");
  const workspaceId = optionalOpaqueId(value.workspaceId, "workspace_id_invalid");
  const roomId = optionalOpaqueId(value.roomId, "room_id_invalid");
  if (roomId && !workspaceId) throw new WorkspaceServerError("workspace_notification_workspace_required", 500);
  const sourceKind = requireOpaqueId(value.sourceKind, "workspace_notification_source_kind_invalid");
  const sourceId = requireOpaqueId(value.sourceId, "workspace_notification_source_id_invalid");
  const sourceRevision = normalizeRevision(value.sourceRevision);
  const kind = normalizeKind(value.kind);
  if (kind === "invitation" && roomId) throw new WorkspaceServerError("workspace_notification_invitation_room_forbidden", 500);
  if (knownKindSet.has(kind) && kind !== "invitation" && (workspaceId === undefined || roomId === undefined)) {
    throw new WorkspaceServerError("workspace_notification_room_required", 500);
  }
  if (value.action !== "create" && value.action !== "invalidate") throw new WorkspaceServerError("workspace_notification_action_invalid", 500);
  if (!Array.isArray(value.recipientAccountIds)) throw new WorkspaceServerError("workspace_notification_recipients_invalid", 500);
  const recipients = uniqueOpaqueIds(value.recipientAccountIds, "account_id_invalid");
  if (recipients.length !== value.recipientAccountIds.length) throw new WorkspaceServerError("workspace_notification_recipients_invalid", 500);
  if (recipients.length === 0) throw new WorkspaceServerError("workspace_notification_recipients_invalid", 500);
  const createdAt = normalizeTimestamp(value.createdAt, "workspace_notification_created_at_invalid");
  const processedAt = value.processedAt === null ? null : normalizeTimestamp(value.processedAt, "workspace_notification_processed_at_invalid");
  const nextAttemptAt = normalizeTimestamp(value.nextAttemptAt, "workspace_notification_next_attempt_at_invalid");
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0) throw new WorkspaceServerError("workspace_notification_attempts_invalid", 500);
  return {
    id,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(roomId === undefined ? {} : { roomId }),
    sourceKind,
    sourceId,
    sourceRevision,
    kind,
    action: value.action,
    recipientAccountIds: recipients,
    createdAt,
    processedAt,
    attempts: value.attempts,
    nextAttemptAt,
    lastErrorCode: value.lastErrorCode === null ? null : requireOpaqueId(value.lastErrorCode, "workspace_notification_error_code_invalid")
  };
}

function normalizeRecord(value: WorkspaceNotificationRecord): WorkspaceNotificationRecord {
  if (!value || typeof value !== "object") throw new WorkspaceServerError("workspace_notification_record_invalid", 500);
  const id = requireOpaqueId(value.id, "workspace_notification_id_invalid");
  const recipientAccountId = requireOpaqueId(value.recipientAccountId, "account_id_invalid");
  const workspaceId = optionalOpaqueId(value.workspaceId, "workspace_id_invalid");
  const roomId = optionalOpaqueId(value.roomId, "room_id_invalid");
  if (roomId && !workspaceId) throw new WorkspaceServerError("workspace_notification_workspace_required", 500);
  const kind = normalizeKind(value.kind);
  if (knownKindSet.has(kind) && kind !== "invitation" && (workspaceId === undefined || roomId === undefined)) {
    throw new WorkspaceServerError("workspace_notification_room_required", 500);
  }
  if (kind === "invitation" && roomId) throw new WorkspaceServerError("workspace_notification_invitation_room_forbidden", 500);
  const sourceKind = requireOpaqueId(value.sourceKind, "workspace_notification_source_kind_invalid");
  const sourceId = requireOpaqueId(value.sourceId, "workspace_notification_source_id_invalid");
  const sourceRevision = normalizeRevision(value.sourceRevision);
  const createdAt = normalizeTimestamp(value.createdAt, "workspace_notification_created_at_invalid");
  const readAt = value.readAt === null ? null : normalizeTimestamp(value.readAt, "workspace_notification_read_at_invalid");
  return { id, recipientAccountId, ...(workspaceId === undefined ? {} : { workspaceId }), ...(roomId === undefined ? {} : { roomId }), kind, sourceKind, sourceId, sourceRevision, createdAt, readAt };
}

function assertAllReadTargets(
  records: readonly WorkspaceNotificationRecord[],
  ids: readonly string[],
  options: { accountId: string; workspaceId?: string; invitationOnly: boolean }
): Map<string, WorkspaceNotificationRecord> {
  const map = new Map<string, WorkspaceNotificationRecord>();
  for (const record of records) {
    const normalized = normalizeRecord(record);
    if (map.has(normalized.id)) throw new WorkspaceServerError("workspace_notification_read_denied", 403);
    map.set(normalized.id, normalized);
  }
  if (map.size !== ids.length || ids.some((id) => {
    const record = map.get(id);
    if (!record || record.recipientAccountId !== options.accountId) return true;
    if (options.invitationOnly) return record.kind !== "invitation";
    return (record.kind === "invitation" && record.workspaceId === undefined) || record.workspaceId !== options.workspaceId;
  })) {
    throw new WorkspaceServerError("workspace_notification_read_denied", 403);
  }
  return map;
}

function normalizeReadIds(value: readonly string[], max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new WorkspaceServerError("workspace_notification_ids_invalid", 400);
  }
  const ids = value.map((id) => requireOpaqueId(id, "workspace_notification_id_invalid"));
  if (new Set(ids).size !== ids.length) throw new WorkspaceServerError("workspace_notification_ids_invalid", 400);
  return ids;
}

function normalizeKind(value: unknown): WorkspaceNotificationKind {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new WorkspaceServerError("workspace_notification_kind_invalid", 400);
  }
  return value;
}

function normalizeRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new WorkspaceServerError("workspace_notification_revision_invalid", 400);
  }
  return value;
}

function normalizeTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string") throw new WorkspaceServerError(code, 400);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new WorkspaceServerError(code, 400);
  return value;
}

function optionalOpaqueId(value: unknown, code: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireOpaqueId(value, code);
}

function requireOpaqueId(value: unknown, code: string): string {
  if (typeof value !== "string") throw new WorkspaceServerError(code, 400);
  return assertOpaqueId(value, code);
}

function uniqueOpaqueIds(values: readonly string[], code: string): string[] {
  const unique = new Set<string>();
  for (const value of values) unique.add(requireOpaqueId(value, code));
  return [...unique].sort();
}

function boundedOption(value: number | undefined, fallback: number, max: number, code: string, status = 500): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > max) throw new WorkspaceServerError(code, status);
  return normalized;
}

function stableId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40);
  return `${prefix}_${digest}`;
}

function compareNotificationRecords(left: WorkspaceNotificationRecord, right: WorkspaceNotificationRecord): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function isAfterCursor(record: WorkspaceNotificationRecord, cursor: WorkspaceNotificationCursor): boolean {
  return record.createdAt < cursor.createdAt || record.createdAt === cursor.createdAt && record.id < cursor.id;
}

function pageViews(
  views: WorkspaceNotificationView[],
  limit: number,
  cursorFactory: (view: WorkspaceNotificationView) => string
): WorkspaceNotificationPage {
  const hasNext = views.length > limit;
  const items = views.slice(0, limit);
  return { items, nextCursor: hasNext ? cursorFactory(items[items.length - 1]!) : null };
}

function encodeCursor(cursor: WorkspaceNotificationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string | undefined,
  expected: { accountId: string; workspaceId?: string; unreadOnly: boolean; invitationOnly?: boolean }
): WorkspaceNotificationCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<WorkspaceNotificationCursor>;
    if (parsed.accountId !== expected.accountId
      || parsed.workspaceId !== expected.workspaceId
      || parsed.unreadOnly !== expected.unreadOnly
      || parsed.invitationOnly !== expected.invitationOnly
      || typeof parsed.createdAt !== "string"
      || typeof parsed.id !== "string") {
      throw new Error("cursor_binding_mismatch");
    }
    return { accountId: parsed.accountId, ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }), unreadOnly: parsed.unreadOnly, ...(parsed.invitationOnly ? { invitationOnly: true } : {}), createdAt: normalizeTimestamp(parsed.createdAt, "workspace_notification_cursor_invalid"), id: requireOpaqueId(parsed.id, "workspace_notification_cursor_invalid") };
  } catch (error) {
    if (error instanceof WorkspaceServerError && error.code === "workspace_notification_cursor_invalid") throw error;
    throw new WorkspaceServerError("workspace_notification_cursor_invalid", 400);
  }
}

function normalizeActionState(value: WorkspaceNotificationActionState | undefined, kind: WorkspaceNotificationKind): WorkspaceNotificationActionState {
  if (value === "not_required" || value === "pending" || value === "resolved") return value;
  return notificationActionRequiredSet.has(kind) ? "pending" : "not_required";
}

function safeDisplayText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || value.includes("\0")) return fallback;
  return value;
}

function safeTarget(value: WorkspaceNotificationTarget | null | undefined): WorkspaceNotificationTarget | null {
  if (!value || typeof value !== "object") return null;
  try {
    switch (value.kind) {
      case "room": return { kind: "room", roomId: requireOpaqueId(value.roomId, "workspace_notification_target_invalid") };
      case "work": return { kind: "work", roomId: requireOpaqueId(value.roomId, "workspace_notification_target_invalid"), workId: requireOpaqueId(value.workId, "workspace_notification_target_invalid"), ...(value.messageId === undefined ? {} : { messageId: requireOpaqueId(value.messageId, "workspace_notification_target_invalid") }) };
      case "knowledge": return { kind: "knowledge", roomId: requireOpaqueId(value.roomId, "workspace_notification_target_invalid"), resourceId: requireOpaqueId(value.resourceId, "workspace_notification_target_invalid") };
      case "interaction_request": return { kind: "interaction_request", roomId: requireOpaqueId(value.roomId, "workspace_notification_target_invalid"), requestId: requireOpaqueId(value.requestId, "workspace_notification_target_invalid") };
      case "invitation": return { kind: "invitation", invitationId: requireOpaqueId(value.invitationId, "workspace_notification_target_invalid") };
      default: return null;
    }
  } catch {
    return null;
  }
}

function defaultTarget(record: WorkspaceNotificationRecord): WorkspaceNotificationTarget | null {
  if (record.kind === "invitation") return { kind: "invitation", invitationId: record.sourceId };
  if (record.kind === "work_completed" || record.kind === "work_failed") {
    return record.roomId ? { kind: "work", roomId: record.roomId, workId: record.sourceId } : null;
  }
  if (record.kind === "approval_required" || record.kind === "input_required") {
    return record.roomId ? { kind: "interaction_request", roomId: record.roomId, requestId: record.sourceId } : null;
  }
  return record.roomId ? { kind: "room", roomId: record.roomId } : null;
}

function defaultTitle(kind: WorkspaceNotificationKind): string {
  switch (kind) {
    case "work_completed": return "仕事が完了しました";
    case "work_failed": return "仕事に失敗しました";
    case "approval_required": return "承認が必要です";
    case "input_required": return "入力が必要です";
    case "invitation": return "Workspaceへの招待があります";
    default: return "新しい通知があります";
  }
}

function defaultSummary(kind: WorkspaceNotificationKind): string {
  switch (kind) {
    case "work_completed": return "依頼した仕事の結果を確認できます。";
    case "work_failed": return "依頼した仕事の失敗結果を確認できます。";
    case "approval_required": return "対象の承認を確認してください。";
    case "input_required": return "対象の入力を確認してください。";
    case "invitation": return "招待内容を確認してください。";
    default: return "新しい通知を確認してください。";
  }
}

function errorCodeOf(error: unknown): string {
  if (error instanceof WorkspaceServerError && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(error.code)) return error.code;
  return "workspace_notification_projection_failed";
}

function isHiddenAuthorizationError(error: unknown): boolean {
  return error instanceof WorkspaceServerError && (error.status === 403 || error.status === 404);
}
