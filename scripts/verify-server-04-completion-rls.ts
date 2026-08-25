import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  accountIdFromPublicKey,
  createAccountSignaturePayload,
  createInternalWorkspaceConnectionCaller,
  createInternalWorkspaceMaintenanceCaller,
  createVerifiedWorkspaceHumanCaller,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  renderWorkspaceCompletionDocument,
  verifyWorkspaceBundleV4,
  WorkspaceBundleV3Service,
  WorkspaceBundleV4Service,
  WorkspaceCompletionCuratorService,
  WorkspaceCompletionJobService,
  WorkspaceCompletionMaintenanceService,
  WorkspaceCompletionMigrationService,
  WorkspaceCompletionService,
  WorkspaceLearningService,
  WorkspaceServerStore
} from "../packages/workspace-server/src/index.ts";
import { createWorkspaceServerHttp } from "../apps/server/src/workspace-server/http-server.ts";

interface ProbeTarget {
  label: "hosted" | "self_host";
  databaseUrl: string;
  adminDatabaseUrl: string;
  runtimeRole: string;
}

interface ProbeAccount {
  id: string;
  publicKey: string;
  privateKey: KeyObject;
}

const targets: ProbeTarget[] = [
  targetFromEnvironment("HOSTED", "hosted"),
  targetFromEnvironment("SELF_HOST", "self_host")
];

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("server04_completion_probe_destructive_confirmation_required");
}

const probeFailures: string[] = [];
for (const target of targets) {
  try {
    await runProbe(target);
  } catch (error) {
    probeFailures.push(`${target.label}:${error instanceof Error ? error.message : String(error)}`);
  }
}
if (probeFailures.length > 0) throw new Error(`server04_completion_targets_failed:${probeFailures.join(";")}`);

interface ProbeStageFailure {
  stage: string;
  step: string;
  status: "failed" | "blocked";
  message: string;
  code?: string;
  primary_error_code?: string;
  cleanup_error_code?: string;
}

function safeProbeCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}

function probeErrorDetails(error: unknown): { code?: string; primary?: string; cleanup?: string; step?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { code?: unknown; details?: unknown; probeStep?: unknown };
  const details = value.details && typeof value.details === "object" ? value.details as Record<string, unknown> : {};
  return {
    code: safeProbeCode(value.code),
    primary: safeProbeCode(details.primary_error_code),
    cleanup: safeProbeCode(details.cleanup_error_code),
    step: typeof value.probeStep === "string" ? value.probeStep : undefined
  };
}

/**
 * A Completion probe contains several independent product paths. Do not let
 * one failed path hide later paths which can still be checked safely against
 * the committed database state. A skipped stage is never reported as passed.
 */
async function collectProbeStage(failures: ProbeStageFailure[], stage: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const details = probeErrorDetails(error);
    failures.push({
      stage,
      step: details.step ?? stage,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
      ...(details.code ? { code: details.code } : {}),
      ...(details.primary ? { primary_error_code: details.primary } : {}),
      ...(details.cleanup ? { cleanup_error_code: details.cleanup } : {})
    });
  }
}

/** Keep a later regression actionable: the deep report names the individual
 * product operation, while collectProbeStage still lets unrelated stages run. */
async function runProbeStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const details = probeErrorDetails(error);
    const wrapped = new Error(`${step}:${error instanceof Error ? error.message : String(error)}`) as Error & {
      code?: string;
      details?: Record<string, unknown>;
      probeStep?: string;
    };
    Object.assign(wrapped, {
      probeStep: step,
      ...(details.code ? { code: details.code } : {}),
      ...((details.primary || details.cleanup) ? {
        details: {
          ...(details.primary ? { primary_error_code: details.primary } : {}),
          ...(details.cleanup ? { cleanup_error_code: details.cleanup } : {})
        }
      } : {})
    });
    throw wrapped;
  }
}

function targetFromEnvironment(prefix: "HOSTED" | "SELF_HOST", label: ProbeTarget["label"]): ProbeTarget {
  const databaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`];
  const adminDatabaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`];
  const runtimeRole = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error(`server04_completion_probe_${label}_configuration_missing`);
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runProbe(target: ProbeTarget): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `workspace_completion04_${target.label}_${suffix}`;
  const restoredWorkspaceId = `workspace_completion04_restore_${suffix}`;
  const v3SourceWorkspaceId = `workspace_completion04_v3_source_${suffix}`;
  const v3ImportedWorkspaceId = `workspace_completion04_v3_${suffix}`;
  const v3RestoredWorkspaceId = `workspace_completion04_v3_restore_${suffix}`;
  const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion04-"));
  const owner = accountIdentity();
  const otherRoomMember = accountIdentity();
  const maintenanceAccount = accountIdentity();
  const accounts = [owner, otherRoomMember, maintenanceAccount];
  const database = new PostgresWorkspaceDatabase({ databaseUrl: target.databaseUrl, runtimeRole: target.runtimeRole });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({ databaseAdminUrl: target.adminDatabaseUrl, runtimeRole: target.runtimeRole });
  let stage = "resources_policy";
  let probeFailure: Error | undefined;
  let cleanupFailure: Error | undefined;
  const stageFailures: ProbeStageFailure[] = [];
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
      name: "Completion probe",
      ownerAccountId: owner.id,
      operationId: operationId("create"),
      hostingMode: target.label,
      databasePlacement: target.label === "hosted" ? "shared" : "dedicated"
    });
    const ownerContext = (label: string) => humanContext(workspaceId, owner, label);
    const rootRoom = created.defaultRoom;
    await store.setWorkspaceMember(ownerContext("other-workspace-member"), {
      accountId: otherRoomMember.id, role: "member", state: "active", expectedVersion: 0
    });
    const privateRoom = (await store.createRoom(ownerContext("private-room"), {
      name: "Other Room", expectedWorkspaceVersion: (await store.getWorkspace({ workspaceId, accountId: owner.id })).version
    })).room;
    await store.setRoomMember(ownerContext("other-room-member"), {
      roomId: privateRoom.id, accountId: otherRoomMember.id, role: "member", state: "active", expectedVersion: 0
    });

    const completion = new WorkspaceCompletionService(store);
    const jobs = new WorkspaceCompletionJobService(completion);
    const knowledgeId = `completion_knowledge_${suffix.slice(0, 24)}`;
    const knowledge = await completion.createResource(ownerContext("knowledge"), {
      id: knowledgeId,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "decision",
      title: "File backed decision",
      content: "Keep the durable body in the Workspace file tree.",
      metadata: { source: "probe" },
      reason: "Human authored decision"
    });
    const body = await completion.getResourceBody({ workspaceId, accountId: owner.id }, knowledge.resource.id);
    let expectedKnowledgeContent = body.content;
    assert(body.content === "Keep the durable body in the Workspace file tree.", "server04_completion_file_body_missing");
    const physical = await completion.files.inspectPhysicalFile(workspaceId, body.version.filePath);
    assert(physical.sha256 === body.version.contentHash, "server04_completion_file_hash_mismatch");
    await expectCode("workspace_completion_resource_not_found", async () => {
      await completion.getResource({ workspaceId, accountId: otherRoomMember.id }, knowledge.resource.id);
    });
    if (target.label === "hosted") {
      await expectCode("workspace_completion_physical_import_self_host_required", async () => {
        await completion.preparePhysicalResourceEdit(ownerContext("physical-hosted-reject"), knowledge.resource.id);
      });
    } else {
      await completion.preparePhysicalResourceEdit(ownerContext("physical-prepare"), knowledge.resource.id);
      await writeFile(
        path.join(root, "workspaces", workspaceId, "files", body.version.filePath),
        renderWorkspaceCompletionDocument({
          id: knowledge.resource.id,
          title: "File backed decision",
          resourceKind: "knowledge",
          metadata: body.version.metadata,
          body: "Imported from a Self-host physical file edit."
        })
      );
      const detected = await completion.inspectPhysicalResourceEdit({ workspaceId, accountId: owner.id }, knowledge.resource.id);
      assert(detected.changed, "server04_completion_physical_edit_not_detected");
      const physicalImported = await completion.importPhysicalResourceEdit(ownerContext("physical-import"), {
        resourceId: knowledge.resource.id,
        expectedVersion: knowledge.resource.version,
        reason: "Self-host owner imported a local file edit"
      });
      assert(physicalImported.resource.version === 2, "server04_completion_physical_import_version_missing");
      const importedBody = await completion.getResourceBody({ workspaceId, accountId: owner.id }, knowledge.resource.id);
      const originalBody = await completion.getResourceBody({ workspaceId, accountId: owner.id }, knowledge.resource.id, 1);
      assert(importedBody.content === "Imported from a Self-host physical file edit.", "server04_completion_physical_import_body_missing");
      assert(originalBody.content === "Keep the durable body in the Workspace file tree.", "server04_completion_physical_import_history_missing");
      assert((await completion.listEvidence({ workspaceId, accountId: owner.id }, knowledge.resource.id)).some((evidence) => evidence.kind === "physical_file_import"), "server04_completion_physical_import_evidence_missing");
      expectedKnowledgeContent = importedBody.content;
    }

    const skill = await completion.createResource(ownerContext("skill"), {
      id: `completion_skill_${suffix.slice(0, 24)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "skill",
      title: "Probe skill",
      content: "# SKILL\n\nRun the checked procedure.",
      metadata: {
        when: "when the probe runs",
        inputs: "a Workspace",
        preconditions: "Room access",
        completion: "the procedure is checked",
        failure: "stop and preserve evidence",
        steps: ["read", "apply", "verify"],
        knowledge_ids: [knowledge.resource.id]
      },
      supportFiles: [
        { path: "references/checklist.md", content: Buffer.from("# Checklist\n", "utf8") },
        { path: "scripts/nested/verify.bin", content: Buffer.from([0, 255, 1, 2, 3]) },
        { path: "templates/card.txt", content: Buffer.from("template", "utf8") }
      ],
      reason: "Human authored Skill"
    });
    const skillFiles = await completion.listSkillFiles({ workspaceId, accountId: owner.id }, skill.resource.id);
    assert(skillFiles.length === 3 && skillFiles.some((file) => file.relativePath === "scripts/nested/verify.bin"), "server04_completion_skill_package_missing");
    const copiedSkill = await completion.copyResource(ownerContext("skill-copy"), {
      resourceId: skill.resource.id,
      targetScope: { kind: "room", roomId: privateRoom.id },
      targetResourceId: `completion_skill_copy_${suffix.slice(0, 20)}`,
      expectedVersion: skill.resource.version,
      reason: "Copy the whole Skill package."
    });
    const copiedFiles = await completion.listSkillFiles({ workspaceId, accountId: owner.id }, copiedSkill.resource.id);
    const copiedBinary = await completion.getSkillFile({ workspaceId, accountId: owner.id }, copiedSkill.resource.id, "scripts/nested/verify.bin");
    assert(copiedFiles.length === 3 && Buffer.compare(copiedBinary.content, Buffer.from([0, 255, 1, 2, 3])) === 0, "server04_completion_skill_copy_package_incomplete");
    const collisionId = `completion_skill_move_collision_${suffix.slice(0, 16)}`;
    await completion.createResource(ownerContext("skill-move-collision"), {
      id: collisionId,
      scope: { kind: "room", roomId: privateRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Move collision guard",
      content: "This target forces a move transaction to fail safely.",
      metadata: {},
      reason: "Failure recovery probe."
    });
    await expectCode("workspace_completion_resource_version_conflict", async () => {
      await completion.moveResource(ownerContext("skill-move-collision"), {
        resourceId: skill.resource.id,
        targetRoomId: privateRoom.id,
        targetResourceId: collisionId,
        expectedVersion: skill.resource.version,
        reason: "This move must not archive the source."
      });
    });
    const sourceAfterFailedMove = await completion.getResource({ workspaceId, accountId: owner.id }, skill.resource.id);
    assert(sourceAfterFailedMove.resource.lifecycleState !== "archived", "server04_completion_skill_failed_move_archived_source");
    const movedSkill = await completion.moveResource(ownerContext("skill-move"), {
      resourceId: skill.resource.id,
      targetRoomId: privateRoom.id,
      targetResourceId: `completion_skill_move_${suffix.slice(0, 20)}`,
      expectedVersion: skill.resource.version,
      reason: "Move the whole Skill package."
    });
    const movedFiles = await completion.listSkillFiles({ workspaceId, accountId: owner.id }, movedSkill.resource.id);
    const movedBinary = await completion.getSkillFile({ workspaceId, accountId: owner.id }, movedSkill.resource.id, "scripts/nested/verify.bin");
    const archivedSource = await completion.getResource({ workspaceId, accountId: owner.id }, skill.resource.id);
    assert(movedFiles.length === 3 && Buffer.compare(movedBinary.content, Buffer.from([0, 255, 1, 2, 3])) === 0 && archivedSource.resource.lifecycleState === "archived", "server04_completion_skill_move_package_incomplete");

    const profile = await completion.writeWorkspaceDocument(ownerContext("profile"), {
      kind: "profile", content: "The owner prefers evidence-backed changes.", expectedVersion: 0
    });
    assert(profile.version === 1, "server04_completion_profile_version_missing");
    const soul = await completion.writeWorkspaceDocument(ownerContext("soul"), {
      kind: "soul", content: "Protect Room boundaries and preserve evidence.", expectedVersion: 0
    });
    assert(soul.version === 1, "server04_completion_soul_version_missing");
    const workspaceKnowledge = await completion.createResource(ownerContext("workspace-knowledge"), {
      id: `completion_workspace_knowledge_${suffix.slice(0, 20)}`,
      scope: { kind: "workspace" },
      kind: "knowledge",
      knowledgeKind: "decision",
      title: "Workspace-wide decision",
      content: "Every Workspace member may read this decision regardless of Room membership.",
      metadata: { scope: "workspace" },
      reason: "Workspace owner shared this decision."
    });
    const sharedBody = await completion.getResourceBody({ workspaceId, accountId: otherRoomMember.id }, workspaceKnowledge.resource.id);
    assert(sharedBody.content.includes("Every Workspace member"), "server04_completion_workspace_common_resource_hidden");
    const otherProfile = await completion.getWorkspaceDocument({ workspaceId, accountId: otherRoomMember.id }, "profile");
    const otherSoul = await completion.getWorkspaceDocument({ workspaceId, accountId: otherRoomMember.id }, "soul");
    assert(otherProfile.content.includes("evidence-backed") && otherSoul.content.includes("Room boundaries"), "server04_completion_workspace_documents_hidden");
    const otherVisible = await completion.listResourcesPage({ workspaceId, accountId: otherRoomMember.id }, { roomId: privateRoom.id, limit: 50 });
    assert(otherVisible.items.some((resource) => resource.id === workspaceKnowledge.resource.id) && !otherVisible.items.some((resource) => resource.id === knowledge.resource.id), "server04_completion_batch_scope_visibility_mismatch");
    const appliedPolicy = await verifyHttpPolicyIngress({
      target,
      storageRoot: root,
      workspaceId,
      owner,
      roomId: rootRoom.id,
      completion,
      suffix
    });
    assert(appliedPolicy.resource.kind === "policy", "server04_completion_policy_not_saved");
    const startup = await completion.getStartupContext({ workspaceId, accountId: owner.id }, { roomId: rootRoom.id, operation: "resource.create" });
    assert(startup.profile?.includes("evidence-backed"), "server04_completion_profile_not_loaded");

    stage = "review_setup";
    const activity = await completion.ingestActivity(ownerContext("activity"), {
      roomId: rootRoom.id,
      sourceApp: "probe",
      sourceId: "run_one",
      instructionSummary: "Perform the checked procedure",
      resultSummary: "The procedure succeeded",
      verificationOutcome: "confirmed",
      failureState: "none",
      outcome: "completed",
      explicitRemember: false
    });
    assert(!activity.eligible && !activity.job, "server04_completion_activity_unexpected_review_job");
    await collectProbeStage(stageFailures, "review_and_attestation", async () => {
    const snapshot = await completion.createReviewSnapshot({ workspaceId, accountId: owner.id }, activity.episode.id);
    const reviewed = await completion.applyReviewResult(ownerContext("review"), {
      snapshot,
      result: {
        reviewer: "probe",
        summary: "Record an evidence-backed provisional result.",
        candidates: [{
          kind: "knowledge",
          resourceKind: "knowledge",
          knowledgeKind: "experience_rule",
          title: "Verified probe procedure",
          content: "Use the file-backed procedure after a confirmed Activity.",
          metadata: {
            source: "review",
            conditions: "A confirmed Activity records a reusable procedure.",
            action: "Use the file-backed procedure for the same Room.",
            likely_result: "The procedure can be reused with its evidence."
          },
          evidenceActivityIds: [activity.activity.id],
          reason: "Confirmed result"
        }]
      }
    });
    assert(reviewed.resources.length === 1 && reviewed.resources[0]?.evidenceState === "provisional", "server04_completion_review_not_provisional");

    stage = "review_snapshot";
    // A Review must retain every Activity through the advertised high
    // watermark, rather than silently keeping the first 100. Only the final
    // Activity requests a Review, so the Worker has one deterministic Job.
    const longReviewKey = `review_101_${suffix.slice(0, 20)}`;
    let longReviewEpisodeId: string | undefined;
    let longReviewFinalJobId: string | undefined;
    for (let index = 0; index < 101; index += 1) {
      const item = await completion.ingestActivity(ownerContext(`review-101-${index}`), {
        roomId: rootRoom.id,
        sourceApp: "probe",
        sourceId: `review-101-${index}`,
        externalEpisodeKey: longReviewKey,
        instructionSummary: `Review all activity ${index}.`,
        resultSummary: "This is a cursor-pagination verification record.",
        verificationOutcome: "not_run",
        failureState: "none",
        outcome: "completed",
        explicitRemember: index === 100
      });
      longReviewEpisodeId = item.episode.id;
      if (index === 100) {
        assert(item.eligible && item.job?.status === "queued", "server04_completion_review_final_job_missing");
        longReviewFinalJobId = item.job.id;
      } else {
        assert(!item.eligible && !item.job, "server04_completion_review_unexpected_queued_job");
      }
    }
    if (!longReviewEpisodeId || !longReviewFinalJobId) throw new Error("server04_completion_review_101_episode_missing");
    const longReviewSnapshot = await completion.createReviewSnapshot({ workspaceId, accountId: owner.id }, longReviewEpisodeId);
    assert(longReviewSnapshot.activityCount === 101 && longReviewSnapshot.activities.length === 101, "server04_completion_review_101_truncated");
    const exactWatermarkSnapshot = await completion.createReviewSnapshot({ workspaceId, accountId: owner.id }, longReviewEpisodeId, {
      highWatermarkActivityId: longReviewSnapshot.highWatermarkActivityId
    });
    assert(exactWatermarkSnapshot.digest === longReviewSnapshot.digest && exactWatermarkSnapshot.activityCount === 101, "server04_completion_review_high_watermark_mismatch");
    const workspaceKnowledgeBeforeStaleReview = await completion.getResource({ workspaceId, accountId: owner.id }, workspaceKnowledge.resource.id);
    await completion.updateResource(ownerContext("review-stale-human-update"), workspaceKnowledge.resource.id, {
      scope: { kind: "workspace" },
      kind: "knowledge",
      knowledgeKind: "decision",
      title: workspaceKnowledgeBeforeStaleReview.resource.title,
      content: "A human changed this Workspace decision after the Review snapshot.",
      metadata: { scope: "workspace", changed_after_review_snapshot: true },
      reason: "Protect the newer human Workspace decision.",
      expectedVersion: workspaceKnowledgeBeforeStaleReview.resource.version
    });
    await expectCode("workspace_completion_review_stale_input", async () => {
      await completion.applyReviewResult(ownerContext("review-stale-apply"), {
        snapshot: longReviewSnapshot,
        result: { reviewer: "probe", summary: "This old Review must not apply.", candidates: [] }
      });
    });
    const workspaceKnowledgeAfterStaleReview = await completion.getResource({ workspaceId, accountId: owner.id }, workspaceKnowledge.resource.id);
    assert(workspaceKnowledgeAfterStaleReview.resource.version === workspaceKnowledgeBeforeStaleReview.resource.version + 1, "server04_completion_review_stale_human_edit_lost");

    // An explicit snapshot cap must block the selected Job rather than give
    // an incomplete Episode to a Review Port.
    stage = "review_snapshot_cap";
    const reviewSnapshotCap = await completion.updateConfiguration(ownerContext("review-snapshot-cap"), {
      scope: { kind: "room", roomId: rootRoom.id },
      expectedVersion: 0,
      values: { reviewSnapshotMaxItems: 100 }
    });
    const cappedReview = await jobs.runOneReview(ownerContext("review-snapshot-cap-run"), {
      workerId: `completion_review_cap_${suffix.slice(0, 18)}`,
      port: { review: async () => { throw new Error("server04_completion_review_port_must_not_receive_partial_snapshot"); } }
    });
    assert(cappedReview.status === "blocked" && cappedReview.jobId === longReviewFinalJobId, "server04_completion_review_snapshot_cap_not_blocked");
    const blockedReview = (await jobs.listJobs({ workspaceId, accountId: owner.id }, { roomId: rootRoom.id, status: "blocked" }))
      .find((job) => job.id === longReviewFinalJobId);
    assert(Boolean(blockedReview?.blockedReason?.includes("workspace_completion_review_snapshot_limit_exceeded")), "server04_completion_review_snapshot_cap_reason_missing");

    // A restored or legacy Job can name an Activity that is no longer linked
    // to its Episode. It must become a visible blocked Job, never crash the
    // Worker before it has an Attempt to settle.
    stage = "review_stale_job";
    const staleEpisode = await completion.createEpisode(ownerContext("review-stale-job-episode"), {
      roomId: rootRoom.id,
      goal: "A deliberately stale Review Job.",
      sourceApp: "probe",
      externalEpisodeKey: `review_stale_${suffix.slice(0, 20)}`
    });
    const staleReviewJobId = `completion_job_stale_${suffix.slice(0, 24)}`;
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        `INSERT INTO workspace_completion_jobs(
           workspace_id, room_id, id, kind, status, idempotency_key, group_key, high_watermark,
           input_hash, configuration_version, max_attempts, created_by, updated_by
         ) VALUES ($1, $2, $3, 'review', 'queued', $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          workspaceId,
          rootRoom.id,
          staleReviewJobId,
          `review:stale:${suffix}`,
          staleEpisode.episode.id,
          longReviewSnapshot.highWatermarkActivityId,
          "0".repeat(64),
          reviewSnapshotCap.configuration.version,
          reviewSnapshotCap.configuration.values.reviewMaxAttempts,
          owner.id
        ]
      );
    });
    const staleReview = await jobs.runOneReview(ownerContext("review-stale-job-run"), {
      workerId: `completion_review_stale_${suffix.slice(0, 16)}`,
      port: { review: async () => { throw new Error("server04_completion_review_port_must_not_receive_stale_snapshot"); } }
    });
    assert(staleReview.status === "blocked" && staleReview.jobId === staleReviewJobId, "server04_completion_review_stale_job_not_blocked");
    const staleBlockedReview = (await jobs.listJobs({ workspaceId, accountId: owner.id }, { roomId: rootRoom.id, status: "blocked" }))
      .find((job) => job.id === staleReviewJobId);
    assert(
      Boolean(staleBlockedReview?.blockedReason?.includes("workspace_completion_review_stale_input")
        && staleBlockedReview.blockedReason.includes(staleEpisode.episode.id)
        && staleBlockedReview.blockedReason.includes(longReviewSnapshot.highWatermarkActivityId)),
      "server04_completion_review_stale_job_reason_missing"
    );

    const attestedFact = await completion.proposeResourceVersion(ownerContext("attestation-fact"), {
      id: `completion_attestation_fact_${suffix.slice(0, 20)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Attestation-bound fact",
      content: "Only a matching Port result may confirm this Fact.",
      metadata: { source: "attestation-probe" },
      reason: "Review proposed this Fact.",
      evidenceEpisodeId: activity.episode.id,
      evidenceActivityIds: [activity.activity.id]
    });
    assert(attestedFact.resource.evidenceState === "provisional", "server04_completion_self_claim_promoted_fact");
    const attestedFactBody = await completion.getResourceBody({ workspaceId, accountId: owner.id }, attestedFact.resource.id);
    const attestationRequest = (sourceRef: string) => ({
      workspaceId,
      scope: { kind: "room" as const, roomId: rootRoom.id },
      target: { resourceId: attestedFact.resource.id, resourceVersion: attestedFactBody.version.version },
      sourceRef,
      sourceVersion: "source-v1",
      expectedContentHash: attestedFactBody.version.contentHash,
      items: { verified_item_count: 1 }
    });
    const notRun = await completion.applyAttestation(ownerContext("attestation-not-run"), { request: attestationRequest("probe://not-run") });
    assert(notRun.attestation.outcome === "not_run", "server04_completion_attestation_unconfigured_not_run_missing");
    const mismatched = await new WorkspaceCompletionService(store, undefined, {
      attest: async () => ({
        outcome: "confirmed" as const,
        attestorId: "probe-attestor",
        sourceVersion: "wrong-source-version",
        observedContentHash: "f".repeat(64),
        attestedAt: new Date().toISOString(),
        failureReasons: []
      })
    }).applyAttestation(ownerContext("attestation-mismatch"), { request: attestationRequest("probe://mismatch") });
    assert(mismatched.attestation.outcome === "failed", "server04_completion_attestation_mismatch_confirmed");
    const confirmed = await new WorkspaceCompletionService(store, undefined, {
      attest: async (request) => ({
        outcome: "confirmed" as const,
        attestorId: "probe-attestor",
        sourceVersion: request.sourceVersion,
        observedContentHash: request.expectedContentHash,
        attestedAt: new Date().toISOString(),
        failureReasons: []
      })
    }).applyAttestation(ownerContext("attestation-confirmed"), { request: attestationRequest("probe://confirmed") });
    assert(confirmed.attestation.outcome === "confirmed", "server04_completion_attestation_confirmed_missing");
    const confirmedFact = await completion.getResource({ workspaceId, accountId: owner.id }, attestedFact.resource.id);
    assert(confirmedFact.resource.evidenceState === "confirmed" && confirmedFact.resource.currentConfirmedVersion === attestedFactBody.version.version, "server04_completion_attestation_fact_not_confirmed");
    await expectCode("workspace_completion_machine_attestation_required", async () => {
      await store.database.withContext(ownerContext("forged-machine-attestation"), async (sql) => {
        await sql.query(
          `INSERT INTO workspace_completion_evidence(workspace_id, id, resource_id, resource_version, kind, attestation_id, summary)
           VALUES ($1, $2, $3, $4, 'machine_attestation', $5, 'forged')`,
          [workspaceId, `completion_evidence_forged_${suffix.slice(0, 16)}`, attestedFact.resource.id, attestedFactBody.version.version, `completion_attestation_forged_${suffix.slice(0, 16)}`]
        );
      });
    });
    await expectCode("workspace_completion_secret_content_forbidden", async () => {
      await completion.recordJobRawOutput(ownerContext("secret-raw"), {
        jobId: "completion_job_probe", attemptId: "completion_attempt_probe", direction: "request", content: "api_key=" + ["sk-", "abcdefghijklmnopqrstuvwxyz1234567890"].join("")
      });
    });

    const firstPage = await completion.listResourcesPage({ workspaceId, accountId: owner.id }, { roomId: rootRoom.id, limit: 1 });
    assert(firstPage.items.length === 1 && firstPage.nextCursor, "server04_completion_pagination_missing");
    const secondPage = await completion.listResourcesPage({ workspaceId, accountId: owner.id }, { roomId: rootRoom.id, limit: 10, cursor: firstPage.nextCursor });
    assert(secondPage.items.length >= 2, "server04_completion_pagination_cursor_missing");
    });

    await collectProbeStage(stageFailures, "curator_and_maintenance", async () => {
    const curator = new WorkspaceCompletionCuratorService(completion);
    const maintenance = new WorkspaceCompletionMaintenanceService(completion, jobs, curator);

    // Curator plans carry the exact target/related versions and hashes. A
    // human edit while a semantic cassette is running makes the entire plan
    // stale; it must not leave even a single new Link behind.
    const curatorFirst = await completion.proposeResourceVersion(ownerContext("curator-first"), {
      id: `completion_curator_first_${suffix.slice(0, 18)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Curator first candidate",
      content: "First AI candidate for a stale-plan probe.",
      metadata: { statement: "First candidate", subject: "curator probe", evidence: "test fixture" },
      reason: "Curator stale input probe.",
      evidenceEpisodeId: activity.episode.id,
      evidenceActivityIds: [activity.activity.id]
    });
    const curatorSecond = await completion.proposeResourceVersion(ownerContext("curator-second"), {
      id: `completion_curator_second_${suffix.slice(0, 18)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Curator second candidate",
      content: "Second AI candidate for a stale-plan probe.",
      metadata: { statement: "Second candidate", subject: "curator probe", evidence: "test fixture" },
      reason: "Curator stale input probe.",
      evidenceEpisodeId: activity.episode.id,
      evidenceActivityIds: [activity.activity.id]
    });
    const seededCurator = await curator.runLight(ownerContext("curator-seed"), { roomId: rootRoom.id });
    assert(seededCurator.status === "seeded", "server04_completion_curator_seed_missing");
    await curator.setSemanticEnabled(ownerContext("curator-semantic-enable"), { roomId: rootRoom.id, enabled: true });
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        "UPDATE workspace_completion_activities SET created_at = NOW() - INTERVAL '3 hours', finalized_at = NOW() - INTERVAL '3 hours' WHERE workspace_id = $1 AND room_id = $2",
        [workspaceId, rootRoom.id]
      );
    });
    await expectCode("workspace_completion_curator_stale_input", async () => {
      await curator.runSemantic(ownerContext("curator-semantic-stale"), {
        roomId: rootRoom.id,
        port: {
          review: async () => {
            await completion.updateResource(ownerContext("curator-human-edit"), curatorFirst.resource.id, {
              scope: { kind: "room", roomId: rootRoom.id },
              kind: "knowledge",
              knowledgeKind: "fact",
              title: "Human changed curator candidate",
              content: "A human edit must make the in-flight Curator plan stale.",
              metadata: { statement: "Human edit", subject: "curator probe", evidence: "test fixture" },
              reason: "Human edit while the semantic plan was in flight.",
              expectedVersion: curatorFirst.resource.version
            });
            return {
              links: [{
                fromResourceId: curatorFirst.resource.id,
                toResourceId: curatorSecond.resource.id,
                relation: "derived_from",
                reason: "This old semantic result must not be saved."
              }]
            };
          }
        }
      });
    });
    const staleCuratorLink = await store.database.withContext({ workspaceId, accountId: owner.id }, async (sql) => {
      const result = await sql.query<{ count: number | string }>(
        "SELECT COUNT(*) AS count FROM workspace_completion_resource_links WHERE workspace_id = $1 AND from_resource_id = $2 AND to_resource_id = $3",
        [workspaceId, curatorFirst.resource.id, curatorSecond.resource.id]
      );
      return Number(result.rows[0]?.count ?? 0);
    });
    const humanChangedCuratorResource = await completion.getResource({ workspaceId, accountId: owner.id }, curatorFirst.resource.id);
    assert(staleCuratorLink === 0 && humanChangedCuratorResource.resource.version === curatorFirst.resource.version + 1, "server04_completion_curator_stale_plan_partially_applied");

    const duplicateFirst = await completion.proposeResourceVersion(ownerContext("curator-duplicate-first"), {
      id: `completion_curator_duplicate_first_${suffix.slice(0, 14)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Duplicate AI candidate",
      content: "Exactly duplicated AI body for rollback protection.",
      metadata: { statement: "Duplicate", subject: "curator probe", evidence: "test fixture" },
      reason: "Curator rollback probe.",
      evidenceEpisodeId: activity.episode.id,
      evidenceActivityIds: [activity.activity.id]
    });
    const duplicateSecond = await completion.proposeResourceVersion(ownerContext("curator-duplicate-second"), {
      id: `completion_curator_duplicate_second_${suffix.slice(0, 14)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Duplicate AI candidate",
      content: "Exactly duplicated AI body for rollback protection.",
      metadata: { statement: "Duplicate", subject: "curator probe", evidence: "test fixture" },
      reason: "Curator rollback probe.",
      evidenceEpisodeId: activity.episode.id,
      evidenceActivityIds: [activity.activity.id]
    });
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        "UPDATE workspace_completion_curator_state SET last_light_run_at = NOW() - INTERVAL '2 days', updated_at = NOW() WHERE workspace_id = $1 AND room_id = $2",
        [workspaceId, rootRoom.id]
      );
    });
    const appliedLight = await curator.runLight(ownerContext("curator-light-apply"), { roomId: rootRoom.id });
    const duplicateAction = appliedLight.actions.find((action) => action.kind === "archive_exact_duplicate"
      && (action.resourceId === duplicateFirst.resource.id || action.resourceId === duplicateSecond.resource.id));
    assert(appliedLight.status === "applied" && appliedLight.snapshotId && duplicateAction, "server04_completion_curator_duplicate_plan_missing");
    const archivedDuplicate = await completion.getResource({ workspaceId, accountId: owner.id }, duplicateAction.resourceId);
    assert(archivedDuplicate.resource.lifecycleState === "archived", "server04_completion_curator_duplicate_not_archived");
    await completion.setResourceFixed(ownerContext("curator-rollback-human-fixed"), {
      resourceId: archivedDuplicate.resource.id,
      fixed: true,
      expectedVersion: archivedDuplicate.resource.version,
      reason: "A human fixed this Resource after the Curator snapshot."
    });
    await expectCode("workspace_completion_curator_stale_input", async () => {
      await curator.rollbackSnapshot(ownerContext("curator-rollback-stale"), {
        roomId: rootRoom.id,
        snapshotId: appliedLight.snapshotId!
      });
    });
    const protectedAfterRollback = await completion.getResource({ workspaceId, accountId: owner.id }, archivedDuplicate.resource.id);
    assert(protectedAfterRollback.resource.lifecycleState === "archived" && protectedAfterRollback.resource.aiProtection === "fixed", "server04_completion_curator_rollback_overwrote_human_edit");

    await maintenance.configureIdentity(ownerContext("maintenance-configure"), { accountId: maintenanceAccount.id });
    const maintenanceResult = await runProbeStep("maintenance_tick", () => maintenance.runTick({
      workspaceId,
      accountId: maintenanceAccount.id,
      operationId: operationId("maintenance-tick")
    }, { workerId: "completion_maintenance_worker", maxRuns: 10 }));
    assert(maintenanceResult.queuedCuratorJobs >= 1, "server04_completion_maintenance_curator_not_queued");
    });

    await collectProbeStage(stageFailures, "migration_and_bundle_v4", async () => {
    // Starting a dedicated Run flips the Workspace to read-only before any
    // source snapshot. A normal Server write is therefore an explicit deny,
    // while only the matching Run capability may move it to rollback.
    const pausedMigrationContext = ownerContext("migration-read-only-start");
    const pausedMigrationRunId = `completion_migration_pause_${suffix.slice(0, 24)}`;
    await store.database.withContext(pausedMigrationContext, async (sql) => {
      const started = await sql.query<{ state: string }>(
        "SELECT samurai_begin_completion_migration_run($1, $2, $3) AS state",
        [workspaceId, pausedMigrationRunId, pausedMigrationContext.operationId]
      );
      assert(started.rows[0]?.state === "preparing", "server04_completion_migration_pause_not_started");
      const audit = await sql.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM workspace_audit_entries
           WHERE workspace_id = $1 AND action = 'workspace.completion.migration.begin'
             AND subject_kind = 'completion_migration_run' AND subject_id = $2
         ) AS exists`,
        [workspaceId, pausedMigrationRunId]
      );
      assert(audit.rows[0]?.exists === true, "server04_completion_migration_start_audit_missing");
    });
    await expectCode("workspace_completion_policy_denied", async () => {
      await completion.createResource(ownerContext("migration-normal-write-rejected"), {
        id: `completion_write_during_migration_${suffix.slice(0, 16)}`,
        scope: { kind: "room", roomId: rootRoom.id },
        kind: "knowledge",
        knowledgeKind: "fact",
        title: "Normal write during migration",
        content: "This must not be written while the source is frozen.",
        metadata: { statement: "blocked", subject: "migration", evidence: "probe" },
        reason: "Read-only migration probe."
      });
    });
    const pausedBackfillContext = {
      ...pausedMigrationContext,
      migrationRunId: pausedMigrationRunId,
      migrationOperation: "completion_backfill" as const
    };
    // The actual migrator derives a per-resource operation ID while retaining
    // the signed human caller. Exercise that exact transaction shape before
    // the wider migration so an RLS regression cannot hide behind a generic
    // migration failure.
    const pausedFileBatchContext = {
      ...pausedBackfillContext,
      operationId: operationId("migration-file-batch")
    };
    await store.database.withContext(pausedFileBatchContext, async (sql) => {
      await runProbeStep("migration_backfill_start", () => sql.query(
        "SELECT samurai_transition_completion_migration_run($1, $2, 'backfilling', '{}'::JSONB, $3, NULL, NULL)",
        [workspaceId, pausedMigrationRunId, "a".repeat(64)]
      ));
      const capability = await runProbeStep("migration_file_batch_capability", () => sql.query<{ allowed: boolean }>(
        "SELECT samurai_completion_migration_write_allowed($1) AS allowed",
        [workspaceId]
      ));
      assert(capability.rows[0]?.allowed === true, "server04_completion_migration_file_batch_capability_missing");
      const batchId = `completion_migration_capability_batch_${suffix.slice(0, 18)}`;
      await runProbeStep("migration_file_batch_insert", () => sql.query(
        `INSERT INTO workspace_completion_file_batches(workspace_id, id, scope_kind, room_id, status)
         VALUES ($1, $2, 'room', $3, 'db_committed')`,
        [workspaceId, batchId, rootRoom.id]
      ));
      await runProbeStep("migration_file_batch_entry_insert", () => sql.query(
        `INSERT INTO workspace_completion_file_batch_entries(workspace_id, batch_id, path, sha256, size)
         VALUES ($1, $2, 'migration-capability.txt', $3, 1)`,
        [workspaceId, batchId, "b".repeat(64)]
      ));
      await runProbeStep("migration_file_batch_rename", () => sql.query(
        "UPDATE workspace_completion_file_batches SET status = 'renamed' WHERE workspace_id = $1 AND id = $2",
        [workspaceId, batchId]
      ));
      await runProbeStep("migration_file_batch_reset", () => sql.query(
        "UPDATE workspace_completion_file_batches SET status = 'db_committed' WHERE workspace_id = $1 AND id = $2",
        [workspaceId, batchId]
      ));
      await runProbeStep("migration_file_batch_entry_delete", () => sql.query(
        "DELETE FROM workspace_completion_file_batch_entries WHERE workspace_id = $1 AND batch_id = $2",
        [workspaceId, batchId]
      ));
      await runProbeStep("migration_file_batch_delete", () => sql.query(
        "DELETE FROM workspace_completion_file_batches WHERE workspace_id = $1 AND id = $2",
        [workspaceId, batchId]
      ));
      await sql.query(
        "SELECT samurai_transition_completion_migration_run($1, $2, 'rolling_back', '{}'::JSONB, $3, NULL, NULL)",
        [workspaceId, pausedMigrationRunId, "a".repeat(64)]
      );
    });
    await store.database.withContext({ ...pausedBackfillContext, migrationOperation: "completion_rollback" as const }, async (sql) => {
      await sql.query(
        "SELECT samurai_transition_completion_migration_run($1, $2, 'rolled_back', '{}'::JSONB, $3, NULL, NULL)",
        [workspaceId, pausedMigrationRunId, "a".repeat(64)]
      );
    });
    const migrationPauseRecovered = await store.getWorkspace({ workspaceId, accountId: owner.id });
    assert(migrationPauseRecovered.state === "active", "server04_completion_migration_rollback_did_not_restore_active");

    // The old tables are read once, copied to file-backed Completion data,
    // verified against physical bodies, and never written by the migration.
    const legacy = new WorkspaceLearningService(store);
    const legacyResource = await legacy.putResource(ownerContext("legacy-resource"), {
      id: `legacy_knowledge_${suffix.slice(0, 24)}`,
      scope: { kind: "room", roomId: rootRoom.id },
      kind: "knowledge",
      title: "Legacy knowledge",
      content: "This old row must become a file-backed Completion Resource.",
      payload: { knowledge_kind: "fact" },
      reason: "Legacy probe"
    });
    const migration = new WorkspaceCompletionMigrationService(completion);
    const migrated = await runProbeStep("completion_legacy_migrate", () => migration.migrateLegacy(ownerContext("legacy-migrate")));
    assert(Boolean(migrated.verificationHash) && migrated.receiptId, "server04_completion_migration_not_verified");
    const migratedBody = await completion.getResourceBody({ workspaceId, accountId: owner.id }, legacyResource.resource.id);
    assert(migratedBody.content === "This old row must become a file-backed Completion Resource.", "server04_completion_migration_body_missing");

    const bundleDirectory = path.join(root, "source.bundle.v4");
    const bundles = new WorkspaceBundleV4Service(store);
    // Simulate only the old, provable error: an embedded base-v3 export left
    // a ledger row at a staging path. The pure snapshot has no DB side
    // effect, so its hash is exactly the one the following v4 export embeds.
    const previewBaseDirectory = path.join(root, "preview-base-v3");
    const previewBase = await new WorkspaceBundleV3Service(store).writePortableSnapshot(ownerContext("bundle-v4-preview"), {
      destination: previewBaseDirectory,
      includeLegacyLearning: false,
      excludeMembershipAccountIds: [maintenanceAccount.id]
    });
    await rm(previewBaseDirectory, { recursive: true, force: true });
    const legacyBundleId = `bundle_legacy_v3_${suffix.slice(0, 24)}`;
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query(
        `INSERT INTO workspace_bundles(workspace_id, id, format_version, path, sha256, record_counts, created_by)
         VALUES ($1, $2, 3, $3, $4, $5::JSONB, $6)`,
        [workspaceId, legacyBundleId, path.join(root, ".source.bundle.v4.staging-obsolete", "base-v3"), previewBase.manifest.integrity_hash, JSON.stringify(previewBase.manifest.record_counts), owner.id]
      );
    });
    const bundleExportContext = ownerContext("bundle-export");
    const exported = await runProbeStep("bundle_v4_export", () => bundles.export(bundleExportContext, { destination: bundleDirectory }));
    assert(exported.manifest.format_version === 4, "server04_completion_bundle_v4_missing");
    await verifyWorkspaceBundleV4(bundleDirectory);
    const retriedExport = await bundles.export(bundleExportContext, { destination: bundleDirectory });
    assert(retriedExport.manifest.integrity_hash === exported.manifest.integrity_hash, "server04_completion_bundle_v4_retry_changed_bundle");
    const v4Ledger = await store.database.withContext({ workspaceId, accountId: owner.id }, async (sql) => {
      const rows = await sql.query<{ format_version: number | string; path: string; sha256: string }>(
        "SELECT format_version, path, sha256 FROM workspace_bundles WHERE workspace_id = $1 AND format_version = 4 ORDER BY created_at ASC",
        [workspaceId]
      );
      const embedded = await sql.query<{ exists: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM workspace_bundles WHERE workspace_id = $1 AND path LIKE '%.staging-%/base-v3%') AS exists",
        [workspaceId]
      );
      return { rows: rows.rows, embedded: embedded.rows[0]?.exists === true };
    });
    assert(
      v4Ledger.rows.length === 1
        && v4Ledger.rows[0]?.path === bundleDirectory
        && v4Ledger.rows[0]?.sha256 === exported.manifest.integrity_hash
        && !v4Ledger.embedded,
      `server04_completion_bundle_v4_ledger_mismatch:${JSON.stringify({
        rows: v4Ledger.rows,
        embedded: v4Ledger.embedded,
        expected_path: bundleDirectory,
        expected_sha256: exported.manifest.integrity_hash
      })}`
    );
    const repairedLedger = await store.database.withContext({ workspaceId, accountId: owner.id }, async (sql) => sql.query<{ id: string; format_version: number | string }>(
      "SELECT id, format_version FROM workspace_bundles WHERE workspace_id = $1 AND id = $2",
      [workspaceId, legacyBundleId]
    ));
    assert(repairedLedger.rows[0]?.id === legacyBundleId && Number(repairedLedger.rows[0]?.format_version) === 4, "server04_completion_bundle_v4_legacy_ledger_not_repaired");
    const restoreStore = target.label === "self_host"
      ? new WorkspaceServerStore({
        database,
        mode: "self_host",
        selfHostWorkspaceId: restoredWorkspaceId,
        selfHostInitialAdminId: owner.id,
        storageRoot: root,
        invitationTokenSecret: "x".repeat(32)
      })
      : store;
    const imported = await runProbeStep("bundle_v4_import", () =>
      new WorkspaceBundleV4Service(restoreStore).importNew({ accountId: owner.id, operationId: operationId("bundle-import") }, {
        sourceDirectory: bundleDirectory,
        targetWorkspaceId: restoredWorkspaceId,
        targetWorkspaceName: "Restored completion probe"
      })
    );
    const restoredCompletion = new WorkspaceCompletionService(restoreStore);
    const restoredBody = await restoredCompletion.getResourceBody({ workspaceId: imported.workspaceId, accountId: owner.id }, knowledge.resource.id);
    assert(restoredBody.content === expectedKnowledgeContent, "server04_completion_bundle_v4_roundtrip_failed");
    const restoredSkillFiles = await restoredCompletion.listSkillFiles({ workspaceId: imported.workspaceId, accountId: owner.id }, movedSkill.resource.id);
    const restoredSkillBinary = await restoredCompletion.getSkillFile({ workspaceId: imported.workspaceId, accountId: owner.id }, movedSkill.resource.id, "scripts/nested/verify.bin");
    assert(restoredSkillFiles.length === 3 && Buffer.compare(restoredSkillBinary.content, Buffer.from([0, 255, 1, 2, 3])) === 0, "server04_completion_bundle_v4_skill_package_roundtrip_failed");
    const restoredMaintenance = await restoreStore.database.withContext({ workspaceId: imported.workspaceId, accountId: owner.id }, async (sql) => {
      const [marker, memberships] = await Promise.all([
        sql.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM workspace_completion_maintenance_identities WHERE workspace_id = $1) AS exists", [imported.workspaceId]),
        sql.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND account_id = $2
             UNION ALL
             SELECT 1 FROM room_members WHERE workspace_id = $1 AND account_id = $2
           ) AS exists`,
          [imported.workspaceId, maintenanceAccount.id]
        )
      ]);
      return { marker: marker.rows[0]?.exists === true, memberships: memberships.rows[0]?.exists === true };
    });
    assert(!restoredMaintenance.marker && !restoredMaintenance.memberships, "server04_completion_bundle_v4_maintenance_membership_restored");
    });

    await collectProbeStage(stageFailures, "bundle_v3_compatibility", async () => {
    // Compatibility is not merely "the v3 reader accepts a manifest". A
    // legacy portable Workspace is first restored through its old path, then
    // migrated to the file-backed Completion model, exported as v4, and
    // restored again without losing the old body.
    const v3SourceStore = target.label === "self_host"
      ? new WorkspaceServerStore({
        database,
        mode: "self_host",
        selfHostWorkspaceId: v3SourceWorkspaceId,
        selfHostInitialAdminId: owner.id,
        storageRoot: path.join(root, "v3-source-store"),
        invitationTokenSecret: "x".repeat(32)
      })
      : store;
    const v3Source = await v3SourceStore.createWorkspace({
      id: v3SourceWorkspaceId,
      name: "V3 source completion probe",
      ownerAccountId: owner.id,
      operationId: operationId("v3-source-create"),
      hostingMode: target.label,
      databasePlacement: target.label === "hosted" ? "shared" : "dedicated"
    });
    const v3SourceContext = (label: string) => humanContext(v3SourceWorkspaceId, owner, `v3-source-${label}`);
    const v3LegacyResource = await new WorkspaceLearningService(v3SourceStore).putResource(v3SourceContext("legacy-resource"), {
      id: `legacy_v3_knowledge_${suffix.slice(0, 20)}`,
      scope: { kind: "room", roomId: v3Source.defaultRoom.id },
      kind: "knowledge",
      title: "V3 legacy knowledge",
      content: "This V3 row must become a file-backed Completion Resource.",
      payload: { knowledge_kind: "fact" },
      reason: "V3 compatibility probe"
    });
    const v3Directory = path.join(root, "legacy.bundle.v3");
    await new WorkspaceBundleV3Service(v3SourceStore).export(v3SourceContext("export"), { destination: v3Directory });
    const v3MembershipRows = (await readFile(path.join(v3Directory, "memberships.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { created_at?: unknown; updated_at?: unknown });
    assert(
      v3MembershipRows.length > 0 && v3MembershipRows.every((row) => typeof row.created_at === "string"
        && Number.isFinite(new Date(row.created_at).getTime())
        && typeof row.updated_at === "string"
        && Number.isFinite(new Date(row.updated_at).getTime())),
      "server04_completion_v3_membership_timestamp_not_serialized"
    );
    const v3Store = target.label === "self_host"
      ? new WorkspaceServerStore({
        database,
        mode: "self_host",
        selfHostWorkspaceId: v3ImportedWorkspaceId,
        selfHostInitialAdminId: owner.id,
        storageRoot: path.join(root, "v3-import-store"),
        invitationTokenSecret: "x".repeat(32)
      })
      : store;
    const v3Imported = await new WorkspaceBundleV3Service(v3Store).importNew({ accountId: owner.id, operationId: operationId("v3-import") }, {
      sourceDirectory: v3Directory,
      targetWorkspaceId: v3ImportedWorkspaceId,
      targetWorkspaceName: "V3 compatibility completion probe"
    });
    const v3Completion = new WorkspaceCompletionService(v3Store);
    const v3Migrated = await runProbeStep("v3_completion_migrate", () => new WorkspaceCompletionMigrationService(v3Completion).migrateLegacy(
      humanContext(v3Imported.workspaceId, owner, "v3-completion-migrate")
    ));
    assert(Boolean(v3Migrated.verificationHash), "server04_completion_v3_migration_not_verified");
    const v3BundleDirectory = path.join(root, "v3-to-v4.bundle.v4");
    await new WorkspaceBundleV4Service(v3Store).export({
      workspaceId: v3Imported.workspaceId,
      accountId: owner.id,
      operationId: operationId("v3-v4-export")
    }, { destination: v3BundleDirectory });
    const v3RestoreStore = target.label === "self_host"
      ? new WorkspaceServerStore({
        database,
        mode: "self_host",
        selfHostWorkspaceId: v3RestoredWorkspaceId,
        selfHostInitialAdminId: owner.id,
        storageRoot: path.join(root, "v3-v4-restore-store"),
        invitationTokenSecret: "x".repeat(32)
      })
      : store;
    const v3Restored = await new WorkspaceBundleV4Service(v3RestoreStore).importNew({ accountId: owner.id, operationId: operationId("v3-v4-restore") }, {
      sourceDirectory: v3BundleDirectory,
      targetWorkspaceId: v3RestoredWorkspaceId,
      targetWorkspaceName: "V3 to V4 restored completion probe"
    });
    const v3RestoredLegacy = await new WorkspaceCompletionService(v3RestoreStore).getResourceBody({
      workspaceId: v3Restored.workspaceId,
      accountId: owner.id
    }, v3LegacyResource.resource.id);
    assert(v3RestoredLegacy.content === "This V3 row must become a file-backed Completion Resource.", "server04_completion_v3_to_v4_roundtrip_failed");
    });
    if (stageFailures.length > 0) {
      console.error(JSON.stringify({
        verifier: "server04-completion-rls",
        target: target.label,
        status: "failed",
        failed_stages: stageFailures
      }, null, 2));
      probeFailure = new Error(`server04_completion_probe_${target.label}_stages_failed:${JSON.stringify(stageFailures)}`);
    } else {
      console.log(`[Server04 completion] ${target.label}: file body, RLS, review, scheduler, migration, v3-to-v4, and Bundle v4 probes passed`);
    }
  } catch (error) {
    probeFailure = new Error(`server04_completion_probe_${target.label}_${stage}:${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try {
      await cleanup(adminDatabase, [workspaceId, restoredWorkspaceId, v3SourceWorkspaceId, v3ImportedWorkspaceId, v3RestoredWorkspaceId], accounts.map((account) => account.id));
    } catch (error) {
      cleanupFailure = error instanceof Error ? error : new Error(String(error));
    }
    await database.close().catch((error) => { cleanupFailure ??= error instanceof Error ? error : new Error(String(error)); });
    await adminDatabase.close().catch((error) => { cleanupFailure ??= error instanceof Error ? error : new Error(String(error)); });
    await rm(root, { recursive: true, force: true }).catch((error) => { cleanupFailure ??= error instanceof Error ? error : new Error(String(error)); });
  }
  if (probeFailure && cleanupFailure) throw new Error(`${probeFailure.message};cleanup:${cleanupFailure.message}`);
  if (probeFailure) throw probeFailure;
  if (cleanupFailure) throw new Error(`cleanup:${cleanupFailure.message}`);
}

async function verifyHttpPolicyIngress(input: {
  target: ProbeTarget;
  storageRoot: string;
  workspaceId: string;
  owner: ProbeAccount;
  roomId: string;
  completion: WorkspaceCompletionService;
  suffix: string;
}): Promise<{ resource: { kind: string } }> {
  const config = {
    mode: input.target.label,
    databaseUrl: input.target.databaseUrl,
    databaseRuntimeRole: input.target.runtimeRole,
    invitationTokenSecret: "x".repeat(32),
    storageRoot: input.storageRoot,
    selfHostBootstrapMode: "empty" as const,
    initialAdminDisplayName: input.owner.id,
    ...(input.target.label === "self_host" ? {
      selfHostWorkspaceId: input.workspaceId,
      initialAdminId: input.owner.id,
      initialAdminPublicKey: input.owner.publicKey
    } : {}),
    port: 0,
    bindAddress: "127.0.0.1",
    corsOrigins: [],
    publicNetwork: false
  };
  const server = await createWorkspaceServerHttp(config);
  try {
    const port = await listenLoopback(server.httpServer);
    const route = `/api/workspaces/${input.workspaceId}/completion/policies`;
    const policyId = `completion_policy_http_${input.suffix.slice(0, 24)}`;
    const body = {
      policy_id: policyId,
      scope_kind: "room",
      room_id: input.roomId,
      title: "HTTP verified policy",
      content: "Only a verified request may enable this policy.",
      rules: [{
        id: "deny_connection_probe",
        operation: "resource.create",
        effect: "deny",
        connectionId: "connection_probe",
        conditions: { caller_kind: "connection" }
      }],
      reason: "A signed human request reviewed this policy.",
      // These are deliberately ignored input fields. They must never become
      // the caller type, target Connection, or approval signature.
      caller_kind: "connection",
      connection_id: "connection_body_forgery",
      human_signature: "arbitrary-body-text"
    };
    const applied = await signedJsonRequest({ port, account: input.owner, workspaceId: input.workspaceId, path: route, body });
    assert(applied.response.status === 201, `server04_completion_http_policy_status_${applied.response.status}`);
    const saved = await applied.response.json() as { resource?: { kind?: string } };
    assert(saved.resource?.kind === "policy", "server04_completion_http_policy_not_saved");
    const approval = await input.completion.store.database.withContext({ workspaceId: input.workspaceId, accountId: input.owner.id }, async (sql) => {
      const result = await sql.query<{ signature: string; canonical_payload_hash: string }>(
        `SELECT approval.signature, approval.canonical_payload_hash
         FROM workspace_completion_policy_approvals approval
         WHERE approval.workspace_id = $1 AND approval.resource_id = $2`,
        [input.workspaceId, policyId]
      );
      return result.rows[0];
    });
    assert(approval?.signature === applied.signature, "server04_completion_http_policy_signature_not_preserved");
    assert(approval.signature !== body.human_signature && /^[a-f0-9]{64}$/.test(approval.canonical_payload_hash), "server04_completion_http_policy_body_signature_trusted");

    const forged = await signedJsonRequest({
      port,
      account: input.owner,
      workspaceId: input.workspaceId,
      path: route,
      body: { ...body, policy_id: `${policyId}_forged` },
      signatureOverride: "forged"
    });
    assert(forged.response.status === 401, "server04_completion_forged_http_signature_accepted");

    const unverifiedOperation = operationId("unverified-policy");
    await expectCode("workspace_completion_policy_verified_human_required", async () => {
      await input.completion.applyPolicy({
        workspaceId: input.workspaceId,
        accountId: input.owner.id,
        operationId: unverifiedOperation,
        caller: {
          kind: "human",
          principalAccountId: input.owner.id,
          requestId: `request_${randomUUID().replaceAll("-", "")}`,
          operationId: unverifiedOperation,
          timestamp: String(Date.now()),
          canonicalPayloadHash: "0".repeat(64),
          signature: "forged"
        }
      }, {
        id: `completion_policy_unverified_${input.suffix.slice(0, 16)}`,
        scope: { kind: "room", roomId: input.roomId },
        title: "Forged policy",
        content: "Must not save.",
        rules: [],
        reason: "This is an attack probe.",
        expectedVersion: 0
      });
    });

    const fakeConnectionOperation = operationId("fake-connection");
    const fakeConnectionContext = {
      workspaceId: input.workspaceId,
      accountId: input.owner.id,
      operationId: fakeConnectionOperation,
      caller: {
        kind: "connection" as const,
        principalAccountId: input.owner.id,
        connectionId: "connection_probe",
        requestId: `request_${randomUUID().replaceAll("-", "")}`,
        operationId: fakeConnectionOperation,
        timestamp: String(Date.now())
      }
    };
    await input.completion.createResource(fakeConnectionContext, {
      id: `completion_fake_connection_${input.suffix.slice(0, 20)}`,
      scope: { kind: "room", roomId: input.roomId },
      kind: "knowledge",
      knowledgeKind: "fact",
      title: "Untrusted caller is not a Connection",
      content: "The body cannot select Connection policy.",
      metadata: {},
      reason: "Ingress forgery probe"
    });

    const connectionOperation = operationId("trusted-connection");
    await expectCode("workspace_completion_policy_denied", async () => {
      await input.completion.createResource({
        workspaceId: input.workspaceId,
        accountId: input.owner.id,
        operationId: connectionOperation,
        caller: createInternalWorkspaceConnectionCaller({
          principalAccountId: input.owner.id,
          connectionId: "connection_probe",
          requestId: `request_${randomUUID().replaceAll("-", "")}`,
          operationId: connectionOperation,
          timestamp: String(Date.now())
        })
      }, {
        id: `completion_trusted_connection_${input.suffix.slice(0, 16)}`,
        scope: { kind: "room", roomId: input.roomId },
        kind: "knowledge",
        knowledgeKind: "fact",
        title: "Trusted Connection denied",
        content: "This must be rejected by the approved connection policy.",
        metadata: {},
        reason: "Connection policy probe"
      });
    });

    const maintenanceOperation = operationId("maintenance-policy");
    await expectCode("workspace_completion_policy_verified_human_required", async () => {
      await input.completion.applyPolicy({
        workspaceId: input.workspaceId,
        accountId: input.owner.id,
        operationId: maintenanceOperation,
        caller: createInternalWorkspaceMaintenanceCaller({ principalAccountId: input.owner.id, operationId: maintenanceOperation })
      }, {
        id: `completion_policy_maintenance_${input.suffix.slice(0, 16)}`,
        scope: { kind: "room", roomId: input.roomId },
        title: "Maintenance policy",
        content: "Must not save.",
        rules: [],
        reason: "Maintenance cannot approve Policy.",
        expectedVersion: 0
      });
    });
    return { resource: { kind: saved.resource.kind } };
  } finally {
    await server.close();
  }
}

async function signedJsonRequest(input: {
  port: number;
  account: ProbeAccount;
  workspaceId: string;
  path: string;
  body: Record<string, unknown>;
  signatureOverride?: string;
}): Promise<{ response: Response; signature: string }> {
  const requestId = `request_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(Date.now());
  const operation = operationId("http-policy");
  const payload = {
    method: "POST",
    path: input.path,
    workspaceId: input.workspaceId,
    operationId: operation,
    requestId,
    timestamp,
    body: input.body
  };
  const signature = sign(null, Buffer.from(createAccountSignaturePayload(payload)), input.account.privateKey).toString("base64url");
  const response = await fetch(`http://127.0.0.1:${input.port}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-samurai-account-id": input.account.id,
      "x-samurai-workspace-id": input.workspaceId,
      "x-samurai-operation-id": operation,
      "x-samurai-request-id": requestId,
      "x-samurai-timestamp": timestamp,
      "x-samurai-signature": input.signatureOverride ?? signature
    },
    body: JSON.stringify(input.body)
  });
  return { response, signature };
}

async function listenLoopback(server: HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server04_completion_http_address_missing");
  return address.port;
}

async function cleanup(adminDatabase: PostgresWorkspaceAdminDatabase, workspaceIds: string[], accountIds: string[]): Promise<void> {
  await adminDatabase.withAdmin(async (sql) => {
    const tables = [
      "workspace_completion_redactions", "workspace_completion_job_raw_outputs", "workspace_completion_search_projection",
      "workspace_completion_skill_files", "workspace_completion_policy_change_requests", "workspace_completion_policy_rules",
      "workspace_completion_policy_approvals", "workspace_completion_evaluations", "workspace_completion_uses",
      "workspace_completion_resource_links", "workspace_completion_evidence", "workspace_completion_attestations",
      "workspace_completion_curator_snapshots", "workspace_completion_curator_state", "workspace_completion_resource_versions",
      "workspace_completion_resources", "workspace_completion_episode_activities", "workspace_completion_job_attempts",
      "workspace_completion_jobs", "workspace_completion_episodes", "workspace_completion_activities", "workspace_completion_configurations",
      "workspace_completion_workspace_documents", "workspace_completion_file_batch_entries", "workspace_completion_file_batches",
      "workspace_completion_migration_receipts", "workspace_completion_migration_runs", "workspace_completion_maintenance_identities",
      "workspace_learning_resource_uses", "workspace_learning_resource_links", "workspace_learning_evidence",
      "workspace_learning_resource_versions", "workspace_learning_resources", "workspace_learning_job_attempts", "workspace_learning_jobs",
      "workspace_learning_activities", "workspace_learning_settings",
      "workspace_audit_entries", "workspace_bundles", "workspace_transfers", "workspace_invitations", "workspace_jobs", "workspace_events",
      "workspace_operations", "workspace_file_transactions", "workspace_files", "workspace_records", "room_members", "rooms",
      "workspace_members", "workspace_import_sessions", "workspaces"
    ];
    await sql.query("BEGIN");
    try {
      for (const workspaceId of workspaceIds) {
        // A Completion Resource points to its current immutable Versions.
        // Clear those pointers before deleting version rows, otherwise the
        // resource-to-version foreign keys prevent deterministic cleanup.
        await sql.query(
          `UPDATE workspace_completion_resources
           SET current_confirmed_version = NULL,
               current_provisional_version = NULL,
               candidate_version = NULL
           WHERE workspace_id = $1`,
          [workspaceId]
        );
        for (const table of tables) {
          const workspaceColumn = table === "workspaces" ? "id" : "workspace_id";
          await sql.query(`DELETE FROM ${table} WHERE ${workspaceColumn} = $1`, [workspaceId]);
        }
      }
      await sql.query("DELETE FROM account_operations WHERE account_id = ANY($1::TEXT[])", [accountIds]);
      await sql.query("DELETE FROM accounts WHERE id = ANY($1::TEXT[])", [accountIds]);
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

function accountIdentity(): ProbeAccount {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { id: accountIdFromPublicKey(publicKeyPem), publicKey: publicKeyPem, privateKey };
}

function humanContext(workspaceId: string, account: ProbeAccount, label: string) {
  const operation = operationId(label);
  const requestId = `request_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(Date.now());
  const payload = {
    method: "INTERNAL",
    path: "/server04-live-probe",
    workspaceId,
    operationId: operation,
    requestId,
    timestamp,
    body: { label }
  };
  const signature = sign(null, Buffer.from(createAccountSignaturePayload(payload)), account.privateKey).toString("base64url");
  return {
    workspaceId,
    accountId: account.id,
    operationId: operation,
    caller: createVerifiedWorkspaceHumanCaller({
      signed: { accountId: account.id, requestId, timestamp, signature },
      publicKey: account.publicKey,
      payload,
      operationId: operation
    })
  };
}

function operationId(label: string): string {
  return `completion04_${label}_${randomUUID().replaceAll("-", "")}`;
}

async function expectCode(code: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error && error.message.includes(code)) return;
    throw error;
  }
  throw new Error(`server04_completion_expected_${code}`);
}

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
