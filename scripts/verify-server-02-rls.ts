import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  accountIdFromPublicKey,
  canonicalJson,
  PostgresWorkspaceAdminDatabase,
  PostgresWorkspaceDatabase
} from "@samurai-agent/workspace-server";

interface ProbeTarget {
  label: "hosted" | "self_host";
  databaseUrl: string;
  adminDatabaseUrl: string;
  runtimeRole: string;
}

const targets: ProbeTarget[] = [
  targetFromEnvironment("HOSTED", "hosted"),
  targetFromEnvironment("SELF_HOST", "self_host")
];

if (process.env.SAMURAI_SERVER_VERIFY_ALLOW_DESTRUCTIVE_PROBE !== "yes") {
  throw new Error("server02_probe_destructive_confirmation_required");
}

for (const target of targets) await runProbe(target);

function targetFromEnvironment(prefix: "HOSTED" | "SELF_HOST", label: ProbeTarget["label"]): ProbeTarget {
  const databaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_URL`];
  const adminDatabaseUrl = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_ADMIN_URL`];
  const runtimeRole = process.env[`SAMURAI_SERVER_VERIFY_${prefix}_DATABASE_RUNTIME_ROLE`];
  if (!databaseUrl || !adminDatabaseUrl || !runtimeRole) throw new Error(`server02_probe_${label}_configuration_missing`);
  return { label, databaseUrl, adminDatabaseUrl, runtimeRole };
}

async function runProbe(target: ProbeTarget): Promise<void> {
  const database = new PostgresWorkspaceDatabase({
    databaseUrl: target.databaseUrl,
    runtimeRole: target.runtimeRole
  });
  const adminDatabase = new PostgresWorkspaceAdminDatabase({
    databaseAdminUrl: target.adminDatabaseUrl,
    runtimeRole: target.runtimeRole
  });
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceA = `workspace_rls_a_${suffix}`;
  const workspaceB = `workspace_rls_b_${suffix}`;
  const roomA = `room_rls_a_${suffix}`;
  const roomB = `room_rls_b_${suffix}`;
  const accountA = accountIdentity();
  const accountB = accountIdentity();
  try {
    await adminDatabase.migrate();
    await database.assertReady();
    await adminDatabase.withAdmin(async (sql) => {
      await sql.query("BEGIN");
      try {
        for (const account of [accountA, accountB]) {
          await sql.query("INSERT INTO accounts(id, public_key, display_name) VALUES ($1, $2, $3)", [account.id, account.publicKey, account.id]);
        }
        for (const [workspaceId, accountId] of [[workspaceA, accountA.id], [workspaceB, accountB.id]] as const) {
          await sql.query(
            `INSERT INTO workspaces(id, name, state, hosting_mode, storage_namespace, database_placement, created_by)
             VALUES ($1, $1, 'active', $2, $3, $4, $5)`,
            [workspaceId, target.label, `probes/${workspaceId}`, target.label === "hosted" ? "shared" : "dedicated", accountId]
          );
          const roomId = workspaceId === workspaceA ? roomA : roomB;
          await sql.query("INSERT INTO workspace_members(workspace_id, account_id, role, state) VALUES ($1, $2, 'owner', 'active')", [workspaceId, accountId]);
          await sql.query("INSERT INTO rooms(workspace_id, id, name, created_by) VALUES ($1, $2, $2, $3)", [workspaceId, roomId, accountId]);
          await sql.query("INSERT INTO room_members(workspace_id, room_id, account_id, role, state) VALUES ($1, $2, $3, 'owner', 'active')", [workspaceId, roomId, accountId]);
          await sql.query(
            `INSERT INTO workspace_records(workspace_id, room_id, record_type, id, version, payload, search_text, content_hash, created_by, updated_by)
             VALUES ($1, $2, 'probe', 'record', 1, $3::JSONB, $4, $5, $6, $6)`,
            [workspaceId, roomId, canonicalJson({ workspaceId }), workspaceId, "0".repeat(64), accountId]
          );
          await sql.query(
            `INSERT INTO workspace_files(workspace_id, room_id, path, version, sha256, size, created_by, updated_by)
             VALUES ($1, $2, 'probe.txt', 1, $3, 0, $4, $4)`,
            [workspaceId, roomId, "1".repeat(64), accountId]
          );
          await sql.query(
            `INSERT INTO workspace_events(workspace_id, room_id, source_event_id, kind, operation_id, payload)
             VALUES ($1, $2, 1, 'workspace.probe', 'operation_probe', $3::JSONB)`,
            [workspaceId, roomId, canonicalJson({ workspaceId })]
          );
          await sql.query(
            `INSERT INTO workspace_jobs(workspace_id, room_id, id, kind, status, version, idempotency_key, payload, created_by, updated_by)
             VALUES ($1, $2, 'job_probe', 'probe', 'completed', 1, 'job_probe_key', $3::JSONB, $4, $4)`,
            [workspaceId, roomId, canonicalJson({ workspaceId }), accountId]
          );
          await sql.query(
            `INSERT INTO workspace_audit_entries(workspace_id, room_id, actor_account_id, action, outcome, operation_id, details)
             VALUES ($1, $2, $3, 'workspace.probe', 'completed', 'operation_probe', $4::JSONB)`,
            [workspaceId, roomId, accountId, canonicalJson({ workspaceId })]
          );
        }
        await sql.query("COMMIT");
      } catch (error) {
        await sql.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });

    const protectedTables = [
      "workspace_records",
      "workspace_files",
      "workspace_events",
      "workspace_jobs",
      "workspace_audit_entries"
    ] as const;
    const unscoped = await database.withContext({ accountId: accountA.id, workspaceId: workspaceA }, async (sql) => {
      const entries = await Promise.all(protectedTables.map(async (table) => {
        const rows = await sql.query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table} ORDER BY workspace_id`);
        return [table, rows.rows.map((row) => row.workspace_id)] as const;
      }));
      return Object.fromEntries(entries);
    });
    const explicitlyForeign = await database.withContext({ accountId: accountA.id, workspaceId: workspaceA }, async (sql) => {
      const entries = await Promise.all(protectedTables.map(async (table) => {
        const rows = await sql.query<{ workspace_id: string }>(`SELECT workspace_id FROM ${table} WHERE workspace_id = $1`, [workspaceB]);
        return [table, rows.rows] as const;
      }));
      return Object.fromEntries(entries);
    });
    let crossWorkspaceWriteRejected = false;
    try {
      await database.withContext({ accountId: accountA.id, workspaceId: workspaceA }, async (sql) => {
        await sql.query(
          `INSERT INTO workspace_records(workspace_id, room_id, record_type, id, version, payload, search_text, content_hash, created_by, updated_by)
           VALUES ($1, $2, 'probe', 'forbidden', 1, '{}'::JSONB, '', $3, $4, $4)`,
          [workspaceB, roomB, "0".repeat(64), accountA.id]
        );
      });
    } catch {
      crossWorkspaceWriteRejected = true;
    }
    const isolationFailed = protectedTables.some((table) => JSON.stringify(unscoped[table]) !== JSON.stringify([workspaceA]) || explicitlyForeign[table].length !== 0);
    if (isolationFailed || !crossWorkspaceWriteRejected) {
      throw new Error(`server02_rls_isolation_failed:${target.label}`);
    }
    console.log(`[Server02] ${target.label}: PostgreSQL RLS cross-Workspace denial passed`);
  } finally {
    await adminDatabase.withAdmin(async (sql) => {
      for (const workspaceId of [workspaceA, workspaceB]) {
        for (const table of ["workspace_audit_entries", "workspace_jobs", "workspace_events", "workspace_files", "workspace_records", "room_members", "rooms", "workspace_members", "workspaces"]) {
          await sql.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [workspaceId]);
        }
      }
      await sql.query("DELETE FROM accounts WHERE id = ANY($1::TEXT[])", [[accountA.id, accountB.id]]);
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
