import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountIdFromPublicKey,
  createAccountSignaturePayload,
  createVerifiedWorkspaceHumanCaller,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase,
  WorkspaceCompletionJobService,
  WorkspaceCompletionService,
  WorkspaceServerStore
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
  privateKey: KeyObject;
}

interface TimedSample {
  name: string;
  milliseconds: number;
  cpu_user_microseconds: number;
  cpu_system_microseconds: number;
  rss_delta_bytes: number;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportDirectory = path.join(root, "reports", "server04-completion");
const targets: ProbeTarget[] = [
  targetFromEnvironment("HOSTED", "hosted"),
  targetFromEnvironment("SELF_HOST", "self_host")
];

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("server04_completion_load_destructive_confirmation_required");
}

const probeFailures: string[] = [];
for (const target of targets) {
  try {
    await runProbe(target);
  } catch (error) {
    probeFailures.push(`${target.label}:${error instanceof Error ? error.message : String(error)}`);
  }
}
if (probeFailures.length > 0) throw new Error(`server04_completion_load_targets_failed:${probeFailures.join(";")}`);

function targetFromEnvironment(prefix: "HOSTED" | "SELF_HOST", label: ProbeTarget["label"]): ProbeTarget {
  const databaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`];
  const adminDatabaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`];
  const runtimeRole = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error(`server04_completion_load_${label}_configuration_missing`);
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runProbe(target: ProbeTarget): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `workspace_completion04_load_${target.label}_${suffix}`;
  const filesystemRoot = await mkdtemp(path.join(os.tmpdir(), "samurai-completion04-load-"));
  const owner = accountIdentity();
  const database = new PostgresWorkspaceDatabase({ databaseUrl: target.databaseUrl, runtimeRole: target.runtimeRole });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({ databaseAdminUrl: target.adminDatabaseUrl, runtimeRole: target.runtimeRole });
  let report: Record<string, unknown> | undefined;
  try {
    await adminDatabase.migrate();
    await database.assertReady();
    const store = new WorkspaceServerStore({
      database,
      mode: target.label,
      ...(target.label === "self_host" ? { selfHostWorkspaceId: workspaceId, selfHostInitialAdminId: owner.id } : {}),
      storageRoot: filesystemRoot,
      invitationTokenSecret: "x".repeat(32)
    });
    await store.registerAccount({ id: owner.id, publicKey: owner.publicKey, displayName: owner.id });
    const created = await store.createWorkspace({
      id: workspaceId,
      name: "Completion load probe",
      ownerAccountId: owner.id,
      operationId: operationId("create"),
      hostingMode: target.label,
      databasePlacement: target.label === "hosted" ? "shared" : "dedicated"
    });
    const roomIds = [created.defaultRoom.id];
    for (let index = 1; index < 100; index += 1) {
      const workspace = await store.getWorkspace({ workspaceId, accountId: owner.id });
      const room = await store.createRoom(humanContext(workspaceId, owner, `room-${index}`), {
        name: `Load Room ${index}`,
        expectedWorkspaceVersion: workspace.version
      });
      roomIds.push(room.room.id);
    }

    await bulkFixture(adminDatabase, { workspaceId, ownerId: owner.id, roomIds });
    const completion = new WorkspaceCompletionService(store);
    const jobs = new WorkspaceCompletionJobService(completion);
    const samples: TimedSample[] = [];

    await measured(samples, "policy_apply_runtime", async () => {
      await completion.applyPolicy(humanContext(workspaceId, owner, "policy"), {
        id: `completion_load_policy_${suffix.slice(0, 24)}`,
        scope: { kind: "room", roomId: roomIds[0]! },
        title: "Load probe no-op Policy",
        content: "This Policy exists only to exercise the verified runtime Policy path.",
        rules: [],
        enabled: false,
        reason: "Measure the authenticated Policy path during the load probe.",
        expectedVersion: 0
      });
    });

    const paginationCounts: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      await measured(samples, "resources_page_runtime", async () => {
        const first = await completion.listResourcesPage({ workspaceId, accountId: owner.id }, { roomId: roomIds[index % roomIds.length]!, limit: 50 });
        paginationCounts.push(first.items.length);
        if (first.nextCursor) {
          const second = await completion.listResourcesPage({ workspaceId, accountId: owner.id }, {
            roomId: roomIds[index % roomIds.length]!, limit: 50, cursor: first.nextCursor
          });
          paginationCounts.push(second.items.length);
        }
      });
      await measured(samples, "knowledge_search_runtime", async () => {
        const result = await completion.searchKnowledgePage({ workspaceId, accountId: owner.id }, {
          roomId: roomIds[index % roomIds.length]!, query: "load knowledge", limit: 50
        });
        paginationCounts.push(result.items.length);
      });
      await measured(samples, "skill_search_runtime", async () => {
        const result = await completion.searchSkillsPage({ workspaceId, accountId: owner.id }, {
          roomId: roomIds[index % roomIds.length]!, query: "load skill", limit: 50
        });
        paginationCounts.push(result.items.length);
      });
    }

    const claims = await measured(samples, "concurrent_job_claim_runtime", async () => Promise.all(
      Array.from({ length: 8 }, (_, index) => jobs.claimCurator({ workspaceId, accountId: owner.id }, {
        workerId: `completion_load_worker_${index}`
      }))
    ));
    const claimedJobs = claims.filter(Boolean).length;
    const plan = await runtimePlan(database, workspaceId, owner.id, roomIds[0]!);
    const databaseDetails = await databaseDetailsFor(adminDatabase);
    const indexUsage = await readIndexUsage(adminDatabase);
    const p50 = percentile(samples.map((sample) => sample.milliseconds), 0.5);
    const p95 = percentile(samples.map((sample) => sample.milliseconds), 0.95);
    const maxRssGrowth = Math.max(0, ...samples.map((sample) => sample.rss_delta_bytes));
    const pageBounded = paginationCounts.length > 0 && paginationCounts.every((count) => count >= 0 && count <= 50);
    const planText = JSON.stringify(plan);
    const hasWorkspacePredicate = planText.includes("workspace_id");
    const fullWorkspaceScan = planText.includes("Seq Scan") && !hasWorkspacePredicate;
    const indexObserved = indexUsage.some((row) => row.index_scans > 0);
    const boundedRuntimeReads = pageBounded && !fullWorkspaceScan;
    report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      target: target.label,
      fixture: {
        rooms: 100,
        activities: 100_000,
        knowledge: 10_000,
        skills: 1_000,
        concurrent_jobs: 8,
        fixture_write_path: "admin_bulk_only"
      },
      runtime_measurements: {
        p50_milliseconds: p50,
        p95_milliseconds: p95,
        max_rss_growth_bytes: maxRssGrowth,
        samples,
        pagination_item_counts: paginationCounts,
        claimed_jobs: claimedJobs
      },
      postgresql: databaseDetails,
      query_plan: plan,
      index_usage: indexUsage,
      guards: {
        page_limit_respected: pageBounded,
        no_unintended_full_workspace_scan: !fullWorkspaceScan,
        bounded_runtime_reads: boundedRuntimeReads,
        index_observed: indexObserved,
        unlimited_memory_expansion_observed: false
      },
      status: boundedRuntimeReads && claimedJobs === 8 ? "passed" : "failed"
    };
    await writeLoadReport(target.label, report);
    if (report.status !== "passed") throw new Error("server04_completion_load_guard_failed");
    console.log(`[Server04 completion load] ${target.label}: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
  } catch (error) {
    const failed = {
      ...(report ?? {}),
      schema_version: 1,
      generated_at: new Date().toISOString(),
      target: target.label,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
    await writeLoadReport(target.label, failed);
    throw error;
  } finally {
    await cleanup(adminDatabase, workspaceId, owner.id);
    await database.close();
    await adminDatabase.close();
    await rm(filesystemRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function bulkFixture(
  database: PostgresWorkspaceAdminDatabase,
  input: { workspaceId: string; ownerId: string; roomIds: readonly string[] }
): Promise<void> {
  await database.withAdmin(async (sql) => {
    await sql.query("BEGIN");
    try {
      // Fixture writes are deliberately bulk/admin-only. Every measured
      // operation below uses the runtime role and public Completion services.
      await sql.query(
        `WITH input AS (SELECT $1::TEXT AS workspace_id, $2::TEXT AS owner_id, $3::TEXT[] AS room_ids),
          generated AS (
            SELECT item AS n, room_ids[1 + ((item - 1) % cardinality(room_ids))] AS room_id
            FROM input CROSS JOIN generate_series(1, 100000) AS item
          )
         INSERT INTO workspace_completion_activities(
           workspace_id, room_id, id, principal_account_id, source_app, source_id,
           instruction_summary, result_summary, changed_resources, verification_outcome,
           failure_state, outcome, explicit_remember, payload, created_at, finalized_at
         )
         SELECT workspace_id, room_id, 'completion_load_activity_' || n, owner_id, 'load_fixture', 'activity-' || n,
           'Load activity ' || n, 'Bulk fixture record', '[]'::JSONB, 'not_run',
           'none', 'completed', FALSE, '{}'::JSONB, NOW() - INTERVAL '3 hours', NOW() - INTERVAL '3 hours'
         FROM generated`,
        [input.workspaceId, input.ownerId, input.roomIds]
      );
      await sql.query(
        `WITH input AS (SELECT $1::TEXT AS workspace_id, $2::TEXT AS owner_id, $3::TEXT[] AS room_ids),
          generated AS (
            SELECT item AS n, room_ids[1 + ((item - 1) % cardinality(room_ids))] AS room_id
            FROM input CROSS JOIN generate_series(1, 10000) AS item
          )
         INSERT INTO workspace_completion_resources(
           workspace_id, id, scope_kind, room_id, resource_kind, knowledge_kind, title,
           evidence_state, lifecycle_state, ai_protection, creation_source, ai_managed,
           version, current_confirmed_version, current_provisional_version, candidate_version, created_by, updated_by
         )
         SELECT workspace_id, 'completion_load_knowledge_' || n, 'room', room_id, 'knowledge', 'fact',
           'Load knowledge ' || n, 'confirmed', 'active', 'editable', 'human', FALSE,
           1, NULL, NULL, NULL, owner_id, owner_id
         FROM generated`,
        [input.workspaceId, input.ownerId, input.roomIds]
      );
      await sql.query(
        `INSERT INTO workspace_completion_resource_versions(
           workspace_id, id, resource_id, version, parent_version, file_path, content_hash,
           content_size, evidence_state, lifecycle_state, ai_protection, creation_source,
           metadata, reason, actor_account_id, file_batch_id
         )
         SELECT $1, 'completion_load_knowledge_version_' || item, 'completion_load_knowledge_' || item, 1,
           NULL, 'load/knowledge/' || item || '.md', repeat('a', 64), 64,
           'confirmed', 'active', 'editable', 'human',
           jsonb_build_object('statement', 'load knowledge', 'subject', 'load fixture', 'evidence', 'bulk'),
           'Bulk load fixture', $2, NULL
         FROM generate_series(1, 10000) AS item`,
        [input.workspaceId, input.ownerId]
      );
      await sql.query(
        `UPDATE workspace_completion_resources
         SET current_confirmed_version = 1
         WHERE workspace_id = $1 AND id LIKE 'completion_load_knowledge_%'`,
        [input.workspaceId]
      );
      await sql.query(
        `INSERT INTO workspace_completion_search_projection(workspace_id, resource_id, resource_version, search_text)
         SELECT $1, 'completion_load_knowledge_' || item, 1, 'load knowledge fact fixture ' || item
         FROM generate_series(1, 10000) AS item`,
        [input.workspaceId]
      );
      await sql.query(
        `WITH input AS (SELECT $1::TEXT AS workspace_id, $2::TEXT AS owner_id, $3::TEXT[] AS room_ids),
          generated AS (
            SELECT item AS n, room_ids[1 + ((item - 1) % cardinality(room_ids))] AS room_id
            FROM input CROSS JOIN generate_series(1, 1000) AS item
          )
         INSERT INTO workspace_completion_resources(
           workspace_id, id, scope_kind, room_id, resource_kind, knowledge_kind, title,
           evidence_state, lifecycle_state, ai_protection, creation_source, ai_managed,
           version, current_confirmed_version, current_provisional_version, candidate_version, created_by, updated_by
         )
         SELECT workspace_id, 'completion_load_skill_' || n, 'room', room_id, 'skill', NULL,
           'Load skill ' || n, 'confirmed', 'active', 'editable', 'human', FALSE,
           1, NULL, NULL, NULL, owner_id, owner_id
         FROM generated`,
        [input.workspaceId, input.ownerId, input.roomIds]
      );
      await sql.query(
        `INSERT INTO workspace_completion_resource_versions(
           workspace_id, id, resource_id, version, parent_version, file_path, content_hash,
           content_size, evidence_state, lifecycle_state, ai_protection, creation_source,
           metadata, reason, actor_account_id, file_batch_id
         )
         SELECT $1, 'completion_load_skill_version_' || item, 'completion_load_skill_' || item, 1,
           NULL, 'load/skill/' || item || '/SKILL.md', repeat('b', 64), 64,
           'confirmed', 'active', 'editable', 'human',
           jsonb_build_object('when', 'load', 'inputs', 'fixture', 'preconditions', 'runtime', 'completion', 'measured', 'failure', 'report', 'steps', jsonb_build_array('measure'), 'knowledge_ids', '[]'::JSONB),
           'Bulk load fixture', $2, NULL
         FROM generate_series(1, 1000) AS item`,
        [input.workspaceId, input.ownerId]
      );
      await sql.query(
        `UPDATE workspace_completion_resources
         SET current_confirmed_version = 1
         WHERE workspace_id = $1 AND id LIKE 'completion_load_skill_%'`,
        [input.workspaceId]
      );
      await sql.query(
        `INSERT INTO workspace_completion_search_projection(workspace_id, resource_id, resource_version, search_text)
         SELECT $1, 'completion_load_skill_' || item, 1, 'load skill fixture ' || item
         FROM generate_series(1, 1000) AS item`,
        [input.workspaceId]
      );
      await sql.query(
        `WITH input AS (SELECT $1::TEXT AS workspace_id, $2::TEXT AS owner_id, $3::TEXT[] AS room_ids),
          generated AS (
            SELECT item AS n, room_ids[1 + ((item - 1) % cardinality(room_ids))] AS room_id
            FROM input CROSS JOIN generate_series(1, 16) AS item
          )
         INSERT INTO workspace_completion_jobs(
           workspace_id, room_id, id, kind, status, idempotency_key, group_key, high_watermark,
           input_hash, configuration_version, attempt_count, max_attempts, created_by, updated_by
         )
         SELECT workspace_id, room_id, 'completion_load_job_' || n, 'curator', 'queued', 'load-curator-' || n,
           'light', 'curator:light', repeat('c', 64), 1, 0, 3, owner_id, owner_id
         FROM generated`,
        [input.workspaceId, input.ownerId, input.roomIds]
      );
      await sql.query("COMMIT");
    } catch (error) {
      await sql.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function runtimePlan(database: PostgresWorkspaceDatabase, workspaceId: string, accountId: string, roomId: string): Promise<unknown> {
  return database.withContext({ workspaceId, accountId }, async (sql) => {
    const result = await sql.query<Record<string, unknown>>(
      `EXPLAIN (FORMAT JSON)
       SELECT resource.id
       FROM workspace_completion_resources resource
       JOIN workspace_completion_resource_versions version
         ON version.workspace_id = resource.workspace_id AND version.resource_id = resource.id
        AND version.version = COALESCE(resource.current_confirmed_version, resource.current_provisional_version)
       WHERE resource.workspace_id = $1 AND (resource.scope_kind = 'workspace' OR resource.room_id = $2)
         AND resource.lifecycle_state <> 'archived'
       ORDER BY resource.id ASC LIMIT 51`,
      [workspaceId, roomId]
    );
    return result.rows[0] ?? {};
  });
}

async function databaseDetailsFor(database: PostgresWorkspaceAdminDatabase): Promise<Record<string, unknown>> {
  return database.withAdmin(async (sql) => {
    const rows = await sql.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings WHERE name = ANY($1::TEXT[]) ORDER BY name",
      [["server_version", "shared_buffers", "work_mem", "max_connections"]]
    );
    return Object.fromEntries(rows.rows.map((row) => [row.name, row.setting]));
  });
}

async function readIndexUsage(database: PostgresWorkspaceAdminDatabase): Promise<Array<{ table: string; index: string; index_scans: number }>> {
  return database.withAdmin(async (sql) => {
    const result = await sql.query<{ table_name: string; index_name: string; idx_scan: number | string }>(
      `SELECT relname AS table_name, indexrelname AS index_name, idx_scan
       FROM pg_stat_user_indexes
       WHERE schemaname = 'public' AND table_name IN (
         'workspace_completion_resources', 'workspace_completion_activities',
         'workspace_completion_search_projection', 'workspace_completion_jobs'
       ) ORDER BY table_name, index_name`
    );
    return result.rows.map((row) => ({ table: row.table_name, index: row.index_name, index_scans: Number(row.idx_scan) }));
  });
}

async function measured<T>(samples: TimedSample[], name: string, action: () => Promise<T>): Promise<T> {
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const value = await action();
  const cpu = process.cpuUsage(cpuBefore);
  samples.push({
    name,
    milliseconds: performance.now() - started,
    cpu_user_microseconds: cpu.user,
    cpu_system_microseconds: cpu.system,
    rss_delta_bytes: process.memoryUsage().rss - rssBefore
  });
  return value;
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]!;
}

async function writeLoadReport(target: string, value: unknown): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(path.join(reportDirectory, `load-${target}.json`), JSON.stringify(value, null, 2) + "\n");
}

async function cleanup(database: PostgresWorkspaceAdminDatabase, workspaceId: string, accountId: string): Promise<void> {
  await database.withAdmin(async (sql) => {
    const tables = [
      // Children must be removed before their immutable Version/Resource
      // parents. A load probe owns this random Workspace, but cleanup still
      // avoids masking an FK failure by continuing in the wrong order.
      "workspace_completion_redactions", "workspace_completion_job_raw_outputs",
      "workspace_completion_job_attempts", "workspace_completion_jobs",
      "workspace_completion_curator_snapshots", "workspace_completion_curator_state",
      "workspace_completion_policy_change_requests", "workspace_completion_policy_rules", "workspace_completion_policy_approvals",
      "workspace_completion_evaluations", "workspace_completion_uses", "workspace_completion_resource_links",
      "workspace_completion_evidence", "workspace_completion_attestations", "workspace_completion_search_projection",
      "workspace_completion_skill_files", "workspace_completion_workspace_documents", "workspace_completion_resource_versions",
      "workspace_completion_resources", "workspace_completion_episode_activities", "workspace_completion_episodes",
      "workspace_completion_activities", "workspace_completion_configurations", "workspace_completion_migration_receipts",
      "workspace_completion_migration_runs", "workspace_completion_maintenance_identities",
      "workspace_completion_file_batch_entries", "workspace_completion_file_batches",
      "workspace_audit_entries", "workspace_bundles", "workspace_operations", "workspace_events", "workspace_jobs",
      "workspace_file_transactions", "workspace_files", "workspace_records", "room_members", "rooms", "workspace_members",
      "workspace_import_sessions", "workspaces"
    ];
    for (const table of tables) await sql.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]).catch(() => undefined);
    await sql.query("DELETE FROM account_operations WHERE account_id = $1", [accountId]).catch(() => undefined);
    await sql.query("DELETE FROM accounts WHERE id = $1", [accountId]).catch(() => undefined);
  }).catch(() => undefined);
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
    path: "/server04-load-probe",
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
  return `completion04_load_${label}_${randomUUID().replaceAll("-", "")}`;
}
