import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  accountIdFromPublicKey,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase
} from "../packages/workspace-server/src/index.ts";
import { PostgresRuntimeExecutionWorker } from "../apps/server/src/workers/postgres-runtime-execution-worker.ts";

type Target = { label: "hosted" | "self_host"; databaseUrl: string; adminDatabaseUrl: string; runtimeRole: string };

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("runtime_recovery_probe_destructive_confirmation_required");
}

for (const target of [targetFromEnv("HOSTED", "hosted"), targetFromEnv("SELF_HOST", "self_host")]) {
  await runTarget(target);
}

function targetFromEnv(prefix: "HOSTED" | "SELF_HOST", label: Target["label"]): Target {
  const databaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`];
  const adminDatabaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`];
  const runtimeRole = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error(`runtime_recovery_${label}_configuration_missing`);
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runTarget(target: Target): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `workspace_runtime_recovery_${target.label}_${suffix}`;
  const roomId = `room_runtime_recovery_${suffix}`;
  const queuedSessionId = `session_runtime_recovery_queued_${suffix}`;
  const runningSessionId = `session_runtime_recovery_running_${suffix}`;
  const queuedRunId = `run_runtime_recovery_queued_${suffix}`;
  const runningRunId = `run_runtime_recovery_running_${suffix}`;
  const queuedActivityId = `activity_runtime_recovery_queued_${suffix}`;
  const runningActivityId = `activity_runtime_recovery_running_${suffix}`;
  const owner = accountIdentity();
  const database = new PostgresWorkspaceDatabase({ databaseUrl: target.databaseUrl, runtimeRole: target.runtimeRole });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({ databaseAdminUrl: target.adminDatabaseUrl, runtimeRole: target.runtimeRole });
  try {
    await adminDatabase.migrate();
    await database.assertReady();
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("INSERT INTO accounts(id, public_key, display_name) VALUES ($1, $2, $3)", [owner.id, owner.publicKey, owner.id]);
      await sql.query(
        `INSERT INTO workspaces(id, name, state, hosting_mode, storage_namespace, database_placement, created_by)
         VALUES ($1, $1, 'active', $2, $3, $4, $5)`,
        [workspaceId, target.label, `probes/${workspaceId}`, target.label === "hosted" ? "shared" : "dedicated", owner.id]
      );
      await sql.query("INSERT INTO workspace_members(workspace_id, account_id, role, state) VALUES ($1, $2, 'owner', 'active')", [workspaceId, owner.id]);
      await sql.query("INSERT INTO rooms(workspace_id, id, name, created_by) VALUES ($1, $2, $2, $3)", [workspaceId, roomId, owner.id]);
      await sql.query("INSERT INTO room_members(workspace_id, room_id, account_id, role, state) VALUES ($1, $2, $3, 'owner', 'active')", [workspaceId, roomId, owner.id]);
      for (const [sessionId, runId, status, phase] of [
        [queuedSessionId, queuedRunId, "queued", "admitted"],
        [runningSessionId, runningRunId, "running", "backend_starting"]
      ] as const) {
        await sql.query(
          `INSERT INTO workspace_runtime_sessions(workspace_id, id, session_key, room_id, title, ui_locale, output_locale, created_at, updated_at)
           VALUES ($1, $2, $2, $3, $2, 'ja', 'ja', NOW(), NOW())`,
          [workspaceId, sessionId, roomId]
        );
        await sql.query(
          `INSERT INTO workspace_runtime_runs(
             workspace_id, id, session_id, room_id, backend_id, backend_kind, status, phase, current_attempt,
             started_at, input_summary, metadata
           ) VALUES ($1, $2, $3, $4, 'probe', 'samurai_native', $5, $6, 1, NOW() - INTERVAL '5 seconds', 'recovery probe', '{}'::JSONB)`,
          [workspaceId, runId, sessionId, roomId, status, phase]
        );
        await sql.query(
          `INSERT INTO workspace_runtime_reservations(workspace_id, session_id, run_id, status)
           VALUES ($1, $2, $3, 'held')`,
          [workspaceId, sessionId, runId]
        );
      }
      await sql.query(
        `INSERT INTO workspace_runtime_activities(workspace_id, id, room_id, status, idempotency_key, backend_run_id, record, created_at, updated_at)
         VALUES ($1, $2, $3, 'running', $2, $4, '{"status":"running"}'::JSONB, NOW(), NOW()),
                ($1, $5, $3, 'running', $5, $6, '{"status":"running"}'::JSONB, NOW(), NOW())`,
        [workspaceId, queuedActivityId, roomId, queuedRunId, runningActivityId, runningRunId]
      );
    });

    const worker = new PostgresRuntimeExecutionWorker(database, 0);
    const recovered = await worker.runTick(
      { workspaceId, accountId: owner.id, operationId: `runtime-recovery-probe-${suffix}` },
      { workerId: `runtime-recovery-worker-${suffix}`, maxRuns: 10, signal: new AbortController().signal }
    );
    if (recovered.recovered !== 2) throw new Error(`runtime_recovery_count_invalid:${target.label}:${recovered.recovered}`);

    const result = await database.withContext({ workspaceId, accountId: owner.id }, async (sql) => {
      const runs = await sql.query<{ id: string; status: string; phase: string; completed_at: string | null; error_code: string | null }>(
        "SELECT id, status, phase, completed_at, error_code FROM workspace_runtime_runs WHERE workspace_id = $1 ORDER BY id",
        [workspaceId]
      );
      const reservations = await sql.query<{ status: string }>("SELECT status FROM workspace_runtime_reservations WHERE workspace_id = $1 ORDER BY run_id", [workspaceId]);
      const events = await sql.query<{ run_id: string; event_type: string }>("SELECT run_id, event_type FROM workspace_runtime_events WHERE workspace_id = $1 ORDER BY run_id", [workspaceId]);
      const activities = await sql.query<{ id: string; status: string; record: Record<string, unknown> }>("SELECT id, status, record FROM workspace_runtime_activities WHERE workspace_id = $1 ORDER BY id", [workspaceId]);
      return { runs: runs.rows, reservations: reservations.rows, events: events.rows, activities: activities.rows };
    });
    const queued = result.runs.find((run) => run.id === queuedRunId);
    const running = result.runs.find((run) => run.id === runningRunId);
    if (!queued || queued.status !== "failed" || queued.phase !== "settled" || !queued.completed_at || queued.error_code !== "runtime_recovery_admission_interrupted") throw new Error(`runtime_recovery_admitted_run_invalid:${target.label}`);
    if (!running || running.status !== "outcome_unknown" || running.phase !== "settled" || running.completed_at !== null || running.error_code !== "runtime_recovery_outcome_unknown") throw new Error(`runtime_recovery_unknown_run_invalid:${target.label}`);
    if (result.reservations.length !== 2 || result.reservations.some((reservation) => reservation.status !== "released")) throw new Error(`runtime_recovery_reservation_not_released:${target.label}`);
    if (result.events.length !== 2 || result.events.some((event) => event.event_type !== "run_failed")) throw new Error(`runtime_recovery_events_missing:${target.label}`);
    if (result.activities.length !== 2 || !result.activities.some((activity) => activity.id === queuedActivityId && activity.status === "failed") || !result.activities.some((activity) => activity.id === runningActivityId && activity.status === "outcome_unknown")) throw new Error(`runtime_recovery_activity_settlement_invalid:${target.label}`);
    console.log(`[RuntimeRecovery] ${target.label}: PostgreSQL crash recovery and outcome_unknown settlement passed`);
  } finally {
    await adminDatabase.withAdmin(async (sql) => {
      for (const table of ["workspace_runtime_activities", "workspace_runtime_events", "workspace_runtime_reservations", "workspace_runtime_runs", "workspace_runtime_sessions", "room_members", "rooms", "workspace_members", "workspaces"]) {
        await sql.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
      }
      await sql.query("DELETE FROM accounts WHERE id = $1", [owner.id]);
    }).catch(() => undefined);
    await database.close();
    await adminDatabase.close();
  }
}

function accountIdentity(): { id: string; publicKey: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  return { id: accountIdFromPublicKey(publicKeyPem), publicKey: publicKeyPem };
}
