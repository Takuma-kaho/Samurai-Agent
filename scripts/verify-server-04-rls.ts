import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  accountIdFromPublicKey,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  WorkspaceBundleV3Service,
  WorkspaceLearningService,
  WorkspaceLearningWorker,
  WorkspaceServerStore,
  type WorkspaceKnowledgeReviewPort
} from "../packages/workspace-server/src/index.ts";

interface ProbeTarget {
  label: "hosted" | "self_host";
  databaseUrl: string;
  adminDatabaseUrl: string;
  runtimeRole: string;
}

interface ProbeAccount {
  id: string;
  publicKey: string;
}

const targets: ProbeTarget[] = [
  targetFromEnvironment("HOSTED", "hosted"),
  targetFromEnvironment("SELF_HOST", "self_host")
];

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("server04_probe_destructive_confirmation_required");
}

for (const target of targets) await runProbe(target);

function targetFromEnvironment(prefix: "HOSTED" | "SELF_HOST", label: ProbeTarget["label"]): ProbeTarget {
  const databaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`];
  const adminDatabaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`];
  const runtimeRole = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error(`server04_probe_${label}_configuration_missing`);
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runProbe(target: ProbeTarget): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `workspace_learning04_${target.label}_${suffix}`;
  const restoredWorkspaceId = `workspace_learning04_restore_${suffix}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "samurai-server04-"));
  const owner = accountIdentity();
  const otherRoomMember = accountIdentity();
  const roomExecutor = accountIdentity();
  const accounts = [owner, otherRoomMember, roomExecutor];
  const database = new PostgresWorkspaceDatabase({ databaseUrl: target.databaseUrl, runtimeRole: target.runtimeRole });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({ databaseAdminUrl: target.adminDatabaseUrl, runtimeRole: target.runtimeRole });
  let stage = "setup";
  try {
    await adminDatabase.migrate();
    await database.assertReady();
    const store = new WorkspaceServerStore({
      database,
      mode: target.label,
      ...(target.label === "self_host" ? { selfHostWorkspaceId: workspaceId, selfHostInitialAdminId: owner.id } : {}),
      storageRoot: root,
      invitationTokenSecret: "x".repeat(32)
    });
    for (const account of accounts) {
      await store.registerAccount({ id: account.id, publicKey: account.publicKey, displayName: account.id });
    }
    const created = await store.createWorkspace({
      id: workspaceId,
      name: "Learning loop probe",
      ownerAccountId: owner.id,
      operationId: operationId("create"),
      hostingMode: target.label,
      databasePlacement: target.label === "hosted" ? "shared" : "dedicated"
    });
    const ownerContext = (operationIdValue: string) => ({ workspaceId, accountId: owner.id, operationId: operationIdValue });
    const rootRoom = created.defaultRoom;
    await store.setWorkspaceMember(ownerContext(operationId("other-workspace-member")), {
      accountId: otherRoomMember.id, role: "member", state: "active", expectedVersion: 0
    });
    await store.setWorkspaceMember(ownerContext(operationId("executor-workspace-member")), {
      accountId: roomExecutor.id, role: "member", state: "active", expectedVersion: 0
    });
    await store.setRoomMember(ownerContext(operationId("executor-root-room-member")), {
      roomId: rootRoom.id, accountId: roomExecutor.id, role: "member", state: "active", expectedVersion: 0
    });
    const otherRoom = (await store.createRoom(ownerContext(operationId("other-room")), {
      name: "Other Room", expectedWorkspaceVersion: (await store.getWorkspace({ workspaceId, accountId: owner.id })).version
    })).room;
    await store.setRoomMember(ownerContext(operationId("other-room-member")), {
      roomId: otherRoom.id, accountId: otherRoomMember.id, role: "member", state: "active", expectedVersion: 0
    });

    const learning = new WorkspaceLearningService(store);
    const configured = await learning.updateSettings(ownerContext(operationId("settings")), {
      scope: { kind: "workspace" }, enabled: true, engineId: "local_engine", model: "test_model",
      currencyLimit: 50, tokenLimit: 5000, expectedVersion: 0
    });
    assert(configured.settings.engineId === "local_engine", "server04_workspace_engine_not_saved");
    const executorDirectSettingsWrite = await database.withContext({ workspaceId, accountId: roomExecutor.id }, async (sql) => {
      const result = await sql.query<{ id: string }>(
        "UPDATE workspace_learning_settings SET enabled = FALSE WHERE workspace_id = $1 AND id = 'workspace' RETURNING id",
        [workspaceId]
      );
      return result.rows.length;
    });
    assert(executorDirectSettingsWrite === 0, "server04_room_executor_mutated_workspace_settings");

    const activity = await learning.ingestActivity(ownerContext(operationId("activity")), {
      roomId: rootRoom.id, groupKey: "deploy_group", sourceKind: "probe", sourceId: "run_one",
      instructionSummary: "Deploy the release", resultSummary: "Verification passed", outcome: "completed",
      verificationState: "confirmed", failureState: "none", reusableCompletion: true
    });
    assert(activity.eligible && activity.job?.status === "queued", "server04_activity_did_not_enqueue_review");

    const worker = new WorkspaceLearningWorker(learning, createResourceReviewPort());
    const reviewed = await worker.runOne({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    assert(reviewed?.status === "completed", "server04_review_not_completed");
    const resources = await learning.listResources({ workspaceId, accountId: owner.id }, { scope: { kind: "room", roomId: rootRoom.id } });
    const learned = resources.find((resource) => resource.title === "Verified deployment")!;
    assert(Boolean(learned), "server04_review_resource_missing");
    assert(learned.scope.kind === "room" && learned.scope.roomId === rootRoom.id, "server04_review_resource_cross_room");
    assert(learned.state === "provisional" && Boolean(learned.sourceJobId) && Boolean(learned.sourceAttemptId), "server04_review_resource_provenance_missing");

    await expectCode("workspace_learning_resource_not_found", async () => {
      await learning.getResource({ workspaceId, accountId: otherRoomMember.id }, learned.id);
    });

    const use = await learning.recordResourceUse(ownerContext(operationId("resource-use")), {
      resourceId: learned.id, resourceVersion: learned.version, activityId: activity.activity.id,
      outcome: "confirmed_success", summary: "The retrieved procedure worked"
    });
    assert(Boolean(use.job), "server04_resource_use_did_not_enqueue_review");
    await expectCode("workspace_learning_resource_use_already_recorded", async () => {
      await learning.recordResourceUse(ownerContext(operationId("resource-use-duplicate")), {
        resourceId: learned.id, resourceVersion: learned.version, activityId: activity.activity.id,
        outcome: "confirmed_success", summary: "The retrieved procedure worked"
      });
    });
    const immutableHistory = await database.withContext({ workspaceId, accountId: owner.id }, async (sql) => {
      const [resources, versions, evidence, uses] = await Promise.all([
        sql.query<{ id: string }>(
          "DELETE FROM workspace_learning_resources WHERE workspace_id = $1 AND id = $2 RETURNING id",
          [workspaceId, learned.id]
        ),
        sql.query<{ id: string }>(
          "UPDATE workspace_learning_resource_versions SET reason = 'mutated' WHERE workspace_id = $1 AND resource_id = $2 RETURNING id",
          [workspaceId, learned.id]
        ),
        sql.query<{ id: string }>(
          "UPDATE workspace_learning_evidence SET summary = 'mutated' WHERE workspace_id = $1 AND resource_id = $2 RETURNING id",
          [workspaceId, learned.id]
        ),
        sql.query<{ id: string }>(
          "UPDATE workspace_learning_resource_uses SET summary = 'mutated' WHERE workspace_id = $1 AND resource_id = $2 RETURNING id",
          [workspaceId, learned.id]
        )
      ]);
      return { resources: resources.rows.length, versions: versions.rows.length, evidence: evidence.rows.length, uses: uses.rows.length };
    });
    assert(immutableHistory.resources === 0 && immutableHistory.versions === 0 && immutableHistory.evidence === 0 && immutableHistory.uses === 0, "server04_learning_history_mutable");
    const privateLearningHistory = await database.withContext({ workspaceId, accountId: otherRoomMember.id }, async (sql) => {
      const [evidence, uses] = await Promise.all([
        sql.query<{ id: string }>("SELECT id FROM workspace_learning_evidence WHERE workspace_id = $1 AND resource_id = $2", [workspaceId, learned.id]),
        sql.query<{ id: string }>("SELECT id FROM workspace_learning_resource_uses WHERE workspace_id = $1 AND resource_id = $2", [workspaceId, learned.id])
      ]);
      return { evidence: evidence.rows.length, uses: uses.rows.length };
    });
    assert(privateLearningHistory.evidence === 0 && privateLearningHistory.uses === 0, "server04_learning_evidence_cross_room_visible");
    const usedReview = await new WorkspaceLearningWorker(learning, noChangeReviewPort()).runOne({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    assert(usedReview?.status === "completed", "server04_resource_use_review_not_completed");

    // A Room member can settle a Job through the narrow reservation function,
    // but cannot directly alter Workspace settings.
    const executorActivity = await learning.ingestActivity(ownerContext(operationId("executor-activity")), {
      roomId: rootRoom.id, groupKey: "executor_group", sourceKind: "probe", sourceId: "member_run",
      instructionSummary: "Apply a checked procedure", resultSummary: "Verified", outcome: "completed",
      verificationState: "confirmed", failureState: "none", reusableCompletion: true
    });
    const executorReview = await new WorkspaceLearningWorker(learning, noChangeReviewPort()).runOne(
      { workspaceId, accountId: roomExecutor.id }, { workerId: "learning_worker_member" }
    );
    assert(executorActivity.job?.id === executorReview?.id && executorReview?.status === "completed", "server04_room_executor_cannot_settle_review");

    const feedbackActivity = await learning.ingestActivity(ownerContext(operationId("feedback-activity")), {
      roomId: rootRoom.id, groupKey: "feedback_group", sourceKind: "probe", sourceId: "feedback_one",
      instructionSummary: "Apply the procedure", resultSummary: "Verified again", outcome: "completed",
      verificationState: "confirmed", failureState: "none"
    });
    const unknownUse = await learning.recordResourceUse(ownerContext(operationId("resource-use-unknown")), {
      resourceId: learned.id, resourceVersion: learned.version, activityId: feedbackActivity.activity.id,
      outcome: "unknown", summary: "Outcome pending"
    });
    const confirmedUse = await learning.recordResourceUse(ownerContext(operationId("resource-use-confirmed")), {
      resourceId: learned.id, resourceVersion: learned.version, activityId: feedbackActivity.activity.id,
      outcome: "confirmed_success", summary: "Outcome later confirmed"
    });
    assert(confirmedUse.use.supersedesUseId === unknownUse.use.id && Boolean(confirmedUse.job), "server04_resource_use_confirmation_not_append_only");
    const feedbackReview = await new WorkspaceLearningWorker(learning, noChangeReviewPort()).runOne({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    assert(feedbackReview?.status === "completed", "server04_resource_use_confirmation_review_not_completed");

    const fixed = await learning.setResourceFixed(ownerContext(operationId("fixed")), {
      resourceId: learned.id, fixed: true, expectedVersion: learned.version, reason: "Human fixed this procedure"
    });
    const correction = await learning.ingestActivity(ownerContext(operationId("correction")), {
      roomId: rootRoom.id, groupKey: "correction_group", sourceKind: "probe", sourceId: "run_two",
      correctionOfActivityId: activity.activity.id, instructionSummary: "Correct a detail", resultSummary: "A different procedure was found",
      outcome: "completed", verificationState: "confirmed", failureState: "none"
    });
    assert(correction.job?.priority === "high", "server04_correction_not_high_priority");
    const fixedAttempt = await new WorkspaceLearningWorker(learning, fixedUpdateReviewPort(learned.id, fixed.resource.version)).runOne({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    assert(fixedAttempt?.status === "failed", "server04_fixed_resource_failure_not_terminal");
    const afterFixed = await learning.getResource({ workspaceId, accountId: owner.id }, learned.id);
    assert(afterFixed.aiUpdateLocked && afterFixed.version === fixed.resource.version, "server04_fixed_resource_changed_by_ai");

    // A configuration block is durable history, but not a failed model call.
    // Re-enabling the same scope resumes the exact grouped Job.
    const beforeDisable = await learning.getEffectiveSettings({ workspaceId, accountId: owner.id }, rootRoom.id);
    const disabled = await learning.updateSettings(ownerContext(operationId("learning-disabled")), {
      scope: { kind: "workspace" }, enabled: false, expectedVersion: beforeDisable.version
    });
    const blockedActivity = await learning.ingestActivity(ownerContext(operationId("blocked-activity")), {
      roomId: rootRoom.id, groupKey: "blocked_group", sourceKind: "probe", sourceId: "disabled_engine",
      instructionSummary: "Save a verified note", resultSummary: "Verified", outcome: "completed",
      verificationState: "confirmed", failureState: "none", reusableCompletion: true
    });
    const blockedClaim = await learning.claimNextJob({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    if (!blockedClaim) throw new Error("server04_configuration_block_missing");
    assert(blockedClaim.job.id === blockedActivity.job?.id && blockedClaim.job.status === "blocked" && blockedClaim.attempt === undefined && blockedClaim.job.attemptCount === 0, "server04_configuration_block_consumed_attempt");
    await learning.updateSettings(ownerContext(operationId("learning-enabled")), {
      scope: { kind: "workspace" }, enabled: true, expectedVersion: disabled.settings.version
    });
    const resumed = await new WorkspaceLearningWorker(learning, noChangeReviewPort()).runOne({ workspaceId, accountId: owner.id }, { workerId: "learning_worker" });
    if (!resumed) throw new Error("server04_configuration_block_resume_missing");
    assert(resumed.id === blockedActivity.job?.id && resumed.status === "completed", "server04_configuration_block_not_resumed");

    const bundlePublicEvent = await store.appendPublicEvent(ownerContext(operationId("public-event")), {
      eventType: "workspace.agent.changed",
      actor: { kind: "human", id: owner.id },
      resources: [{ kind: "agent", id: "agent_bundle_probe", uri: "samurai://agent/agent_bundle_probe", label: "Bundle Agent" }],
      correlationId: "learning04_public_event_correlation",
      payload: { agent_id: "agent_bundle_probe", action: "patched" }
    });
    assert(!bundlePublicEvent.replayed && bundlePublicEvent.event.scope.roomId === undefined, "server04_workspace_public_event_not_created");

    stage = "bundle_v3";
    const bundles = new WorkspaceBundleV3Service(store);
    const bundleDirectory = path.join(root, "source.bundle");
    await bundles.export(ownerContext(operationId("bundle-export")), { destination: bundleDirectory });
    const membershipRows = (await readFile(path.join(bundleDirectory, "memberships.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { created_at?: unknown; updated_at?: unknown });
    assert(
      membershipRows.length > 0 && membershipRows.every((row) => typeof row.created_at === "string"
        && Number.isFinite(new Date(row.created_at).getTime())
        && typeof row.updated_at === "string"
        && Number.isFinite(new Date(row.updated_at).getTime())),
      "server04_bundle_membership_timestamp_not_serialized"
    );
    const restoreStore = target.label === "self_host"
      ? new WorkspaceServerStore({
        database,
        mode: "self_host",
        selfHostWorkspaceId: restoredWorkspaceId,
        selfHostInitialAdminId: owner.id,
        storageRoot: path.join(root, "restored-store"),
        invitationTokenSecret: "x".repeat(32)
      })
      : store;
    const imported = await new WorkspaceBundleV3Service(restoreStore).importNew({ accountId: owner.id, operationId: operationId("bundle-import") }, {
      sourceDirectory: bundleDirectory, targetWorkspaceId: restoredWorkspaceId, targetWorkspaceName: "Restored learning loop"
    });
    const restoredEvents = await restoreStore.listPublicEvents(
      { workspaceId: imported.workspaceId, accountId: owner.id },
      { limit: 100 }
    );
    const restoredPublicEvent = restoredEvents.events.find((event) => event.eventType === "workspace.agent.changed");
    if (!restoredPublicEvent) throw new Error("server04_bundle_public_event_missing");
    assert(restoredPublicEvent.scope.workspaceId === imported.workspaceId && restoredPublicEvent.scope.roomId === undefined, "server04_bundle_workspace_event_scope_changed");
    assert(restoredPublicEvent.eventId === bundlePublicEvent.event.eventId && restoredPublicEvent.occurredAt === bundlePublicEvent.event.occurredAt, "server04_bundle_public_event_identity_changed");
    assert(restoredPublicEvent.eventVersion === "1.0" && restoredPublicEvent.actor.kind === "human" && restoredPublicEvent.actor.id === owner.id, "server04_bundle_public_event_actor_changed");
    assert(restoredPublicEvent.cursor === bundlePublicEvent.event.cursor && restoredPublicEvent.correlationId === "learning04_public_event_correlation", "server04_bundle_public_event_cursor_changed");
    assert(restoredPublicEvent.resources.length === 1 && restoredPublicEvent.resources[0]?.kind === "agent" && restoredPublicEvent.resources[0]?.id === "agent_bundle_probe", "server04_bundle_public_event_resources_changed");
    assert(restoredPublicEvent.payload.agent_id === "agent_bundle_probe" && restoredPublicEvent.payload.action === "patched", "server04_bundle_public_event_payload_changed");
    await verifyImportSessionEventPolicy(database, adminDatabase, workspaceId, restoredWorkspaceId, otherRoomMember, roomExecutor);
    const restored = await new WorkspaceLearningService(restoreStore).listResources({ workspaceId: imported.workspaceId, accountId: owner.id }, { scope: { kind: "room", roomId: rootRoom.id }, includeArchived: true });
    assert(restored.some((resource) => resource.title === "Verified deployment"), "server04_bundle_learning_roundtrip_failed");
    console.log(`[Server04] ${target.label}: learning, RLS, fixed state, feedback, and restore probe passed`);
  } catch (error) {
    throw new Error(`server04_probe_${target.label}_${stage}:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await cleanup(adminDatabase, [workspaceId, restoredWorkspaceId], accounts.map((account) => account.id));
    await database.close();
    await adminDatabase.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createResourceReviewPort(): WorkspaceKnowledgeReviewPort {
  return {
    id: "local_engine",
    model: "test_model",
    maxUsage: { currency: 2, tokens: 100 },
    async review(snapshot) {
      const evidence = snapshot.activities.at(-1)?.id;
      if (!evidence) throw new Error("server04_review_activity_missing");
      return {
        reviewer: "probe", summary: "Create verified deployment knowledge", usage: { currency: 1, tokens: 25 },
        mutations: [{ kind: "create", resourceKind: "knowledge", title: "Verified deployment", content: "Run the checked deployment procedure.", reason: "Confirmed release", confidence: 0.9, evidenceActivityIds: [evidence] }]
      };
    }
  };
}

function noChangeReviewPort(): WorkspaceKnowledgeReviewPort {
  return {
    id: "local_engine",
    model: "test_model",
    maxUsage: { currency: 2, tokens: 100 },
    async review() { return { reviewer: "probe", summary: "No change", mutations: [] }; }
  };
}

function fixedUpdateReviewPort(resourceId: string, expectedVersion: number): WorkspaceKnowledgeReviewPort {
  return {
    id: "local_engine",
    model: "test_model",
    maxUsage: { currency: 2, tokens: 100 },
    async review(snapshot) {
      const evidence = snapshot.activities.at(-1)?.id;
      if (!evidence) throw new Error("server04_correction_activity_missing");
      return {
        reviewer: "probe", summary: "This must be rejected because it is fixed",
        mutations: [{ kind: "update", resourceId, expectedVersion, title: "Changed", content: "AI must not save this", reason: "Contradiction", evidenceActivityIds: [evidence] }]
      };
    }
  };
}

async function cleanup(adminDatabase: PostgresWorkspaceAdminDatabase, workspaceIds: string[], accountIds: string[]): Promise<void> {
  await adminDatabase.withAdmin(async (sql) => {
    const tables = [
      // A learned Resource may retain its source Job/Attempt. Remove the
      // Resource history before its provenance rows, matching the guarded
      // import-abort cleanup order in the schema.
      "workspace_learning_resource_uses", "workspace_learning_resource_links", "workspace_learning_evidence", "workspace_learning_resource_versions", "workspace_learning_resources", "workspace_learning_job_attempts", "workspace_learning_jobs", "workspace_learning_activities", "workspace_learning_settings",
      "workspace_audit_entries", "workspace_bundles", "workspace_transfers", "workspace_invitations", "workspace_jobs", "workspace_events", "workspace_operations", "workspace_file_transactions", "workspace_files", "workspace_records", "room_members", "rooms", "workspace_members", "workspace_import_sessions", "workspaces"
    ];
    for (const workspaceId of workspaceIds) {
      for (const table of tables) {
        const workspaceColumn = table === "workspaces" ? "id" : "workspace_id";
        await sql.query(`DELETE FROM ${table} WHERE ${workspaceColumn} = $1`, [workspaceId]);
      }
    }
    await sql.query("DELETE FROM account_operations WHERE account_id = ANY($1::TEXT[])", [accountIds]);
    await sql.query("DELETE FROM accounts WHERE id = ANY($1::TEXT[])", [accountIds]);
  });
}

async function verifyImportSessionEventPolicy(
  database: PostgresWorkspaceDatabase,
  adminDatabase: PostgresWorkspaceAdminDatabase,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  validAccount: ProbeAccount,
  mismatchedAccount: ProbeAccount
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const validSessionId = `import_policy_valid_${suffix}`;
  const expiredSessionId = `import_policy_expired_${suffix}`;
  const completedSessionId = `import_policy_completed_${suffix}`;
  const abortedSessionId = `import_policy_aborted_${suffix}`;
  const failedSessionId = `import_policy_failed_${suffix}`;
  const wrongWorkspaceSessionId = `import_policy_wrong_workspace_${suffix}`;
  const insertSession = async (workspaceId: string, sessionId: string, accountId: string, state: string, expiresAt: string) => {
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        "INSERT INTO workspace_import_sessions(workspace_id, id, account_id, state, expires_at) VALUES ($1, $2, $3, $4, $5::TIMESTAMPTZ)",
        [workspaceId, sessionId, accountId, state, expiresAt]
      );
    });
  };
  const insertWorkspaceEvent = (workspaceId: string, account: ProbeAccount, importId: string | undefined, eventId: string) =>
    database.withContext({ workspaceId, accountId: account.id, ...(importId ? { importId } : {}) }, async (sql) => {
      await sql.query(
        `INSERT INTO workspace_events(
           workspace_id, room_id, kind, operation_id, payload,
           event_id, event_version, actor_kind, actor_id, organization_id, cursor, correlation_id, resources
         ) VALUES ($1, NULL, 'workspace.import.policy.probe', $2, '{}'::JSONB,
                   $3, '1.0', 'system', NULL, NULL, $4, $5, '[]'::JSONB)`,
        [workspaceId, `import_policy_operation_${eventId}`, eventId, `cursor_${eventId}`, `correlation_${eventId}`]
      );
    });

  await insertSession(targetWorkspaceId, validSessionId, validAccount.id, "writing", new Date(Date.now() + 60_000).toISOString());
  await insertWorkspaceEvent(targetWorkspaceId, validAccount, validSessionId, `event_policy_valid_${suffix}`);

  await insertSession(targetWorkspaceId, expiredSessionId, validAccount.id, "writing", new Date(Date.now() - 60_000).toISOString());
  await expectRlsRejection("expired_import_session", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, expiredSessionId, `event_policy_expired_${suffix}`));

  await insertSession(targetWorkspaceId, completedSessionId, validAccount.id, "completed", new Date(Date.now() + 60_000).toISOString());
  await expectRlsRejection("completed_import_session", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, completedSessionId, `event_policy_completed_${suffix}`));

  await insertSession(targetWorkspaceId, abortedSessionId, validAccount.id, "aborted", new Date(Date.now() + 60_000).toISOString());
  await expectRlsRejection("aborted_import_session", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, abortedSessionId, `event_policy_aborted_${suffix}`));

  await insertSession(targetWorkspaceId, failedSessionId, validAccount.id, "failed", new Date(Date.now() + 60_000).toISOString());
  await expectRlsRejection("failed_import_session", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, failedSessionId, `event_policy_failed_${suffix}`));

  await expectRlsRejection("import_session_account_mismatch", () => insertWorkspaceEvent(targetWorkspaceId, mismatchedAccount, validSessionId, `event_policy_account_mismatch_${suffix}`));

  await insertSession(sourceWorkspaceId, wrongWorkspaceSessionId, validAccount.id, "writing", new Date(Date.now() + 60_000).toISOString());
  await expectRlsRejection("import_session_workspace_mismatch", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, wrongWorkspaceSessionId, `event_policy_workspace_mismatch_${suffix}`));

  await expectRlsRejection("missing_import_session", () => insertWorkspaceEvent(targetWorkspaceId, validAccount, undefined, `event_policy_missing_${suffix}`));
}

async function expectRlsRejection(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes("row-level security policy")) return;
    throw new Error(`${label}_unexpected_error:${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label}_accepted`);
}

function accountIdentity(): ProbeAccount {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { id: accountIdFromPublicKey(publicKeyPem), publicKey: publicKeyPem };
}

function operationId(label: string): string {
  return `learning04_${label}_${randomUUID()}`;
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error(`server04_expected_${code}`);
}

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
