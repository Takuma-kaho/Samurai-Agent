#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime } from "../packages/runtime/src/index.ts";
import { WorkspaceStore } from "../packages/workspace-store/src/index.ts";

const options = parseArgs(process.argv.slice(2));
const summary = await verifyGatewayRecovery(options);

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

process.exitCode = summary.ok ? 0 : 1;

function parseArgs(args) {
  const options = {
    json: false,
    dryRunOnly: false,
    keepWorkspace: false,
    expiredAgeMs: positiveInt(process.env.SAMURAI_GATEWAY_RECOVERY_EXPIRED_AGE_MS) ?? 60_000
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run-only") {
      options.dryRunOnly = true;
    } else if (arg === "--keep-workspace") {
      options.keepWorkspace = true;
    } else if (arg === "--expired-age-ms") {
      options.expiredAgeMs = positiveInt(args[++index]) ?? options.expiredAgeMs;
    } else if (arg.startsWith("--expired-age-ms=")) {
      options.expiredAgeMs = positiveInt(arg.slice("--expired-age-ms=".length)) ?? options.expiredAgeMs;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function verifyGatewayRecovery(options) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-gateway-recovery-"));
  let store;
  let closed = false;
  try {
    store = await WorkspaceStore.create({ rootDir: workspaceRoot });
    const runtime = new AgentRuntime(store);
    const checkedAt = new Date().toISOString();
    const expiredAt = new Date(Date.parse(checkedAt) - options.expiredAgeMs).toISOString();
    const sourceIdentity = "gateway-recovery-probe";
    const lockKey = `webhook:${sourceIdentity}:main`;

    const blocked = await runtime.handleGatewayInbound({
      channel: "webhook",
      source_identity: sourceIdentity,
      source_label: "Gateway Recovery Probe",
      body: "Gateway recovery probe"
    });
    if (!blocked.pairing) {
      throw new Error("gateway_recovery_probe_pairing_missing");
    }

    await store.saveGatewayPairing({
      ...blocked.pairing,
      expires_at: expiredAt,
      updated_at: expiredAt
    });
    await store.acquireGatewayConcurrencyLock({
      lockKey,
      scope: "session",
      policyId: "gateway-recovery-probe",
      ownerRef: {
        kind: "gateway_inbound",
        id: blocked.inbound.id,
        uri: `gateway-inbound/${blocked.inbound.id}`
      },
      ttlMs: 1_000,
      now: expiredAt
    });

    const preview = await runtime.repairGatewayState({ dryRun: true, now: checkedAt });
    const previewPairing = await store.getGatewayPairing(blocked.pairing.id);
    const previewLock = await store.getGatewayConcurrencyLock(lockKey);
    const applied = options.dryRunOnly
      ? undefined
      : await runtime.repairGatewayState({ dryRun: false, now: checkedAt });
    const finalPairing = await store.getGatewayPairing(blocked.pairing.id);
    const finalLock = await store.getGatewayConcurrencyLock(lockKey);

    await runtime.shutdownMcpProcessPool();
    await store.close();
    closed = true;

    const previewActions = summarizeActions(preview.actions);
    const appliedActions = summarizeActions(applied?.actions ?? []);
    const checks = {
      dry_run_planned_expire_pairing: previewActions.expire_pairing.planned === 1,
      dry_run_planned_expire_concurrency_lock: previewActions.expire_concurrency_lock.planned === 1,
      dry_run_preserved_pairing: previewPairing?.status === "pending",
      dry_run_preserved_lock: previewLock?.status === "acquired",
      apply_expired_pairing: options.dryRunOnly || finalPairing?.status === "expired",
      apply_expired_lock: options.dryRunOnly || finalLock?.status === "expired",
      apply_count: options.dryRunOnly || applied?.applied_count === 2,
      external_effects_confirmed: false
    };

    return {
      checked_at: checkedAt,
      ok: Object.values(checks).every((value) => value === true || value === false) && Object.entries(checks)
        .filter(([key]) => key !== "external_effects_confirmed")
        .every(([, value]) => value === true),
      dry_run_only: options.dryRunOnly,
      external_effects_confirmed: false,
      temporary_workspace: true,
      workspace_root: options.keepWorkspace ? workspaceRoot : undefined,
      probe: {
        channel: "webhook",
        source_identity: sourceIdentity,
        pairing_id: blocked.pairing.id,
        inbound_id: blocked.inbound.id,
        lock_key: lockKey
      },
      checks,
      preview: {
        dry_run: preview.dry_run,
        action_count: preview.actions.length,
        applied_count: preview.applied_count,
        actions: previewActions
      },
      applied: applied ? {
        dry_run: applied.dry_run,
        action_count: applied.actions.length,
        applied_count: applied.applied_count,
        actions: appliedActions
      } : undefined,
      final_state: {
        pairing_status: finalPairing?.status,
        lock_status: finalLock?.status
      }
    };
  } finally {
    if (store && !closed) {
      await store.close().catch(() => undefined);
    }
    if (!options.keepWorkspace) {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function summarizeActions(actions) {
  const summary = {
    expire_pairing: { planned: 0, applied: 0, skipped: 0 },
    expire_concurrency_lock: { planned: 0, applied: 0, skipped: 0 }
  };
  for (const action of actions) {
    if (summary[action.action]) {
      summary[action.action][action.status] += 1;
    }
  }
  return summary;
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function printSummary(summary) {
  console.log(`Gateway recovery verification: ${summary.ok ? "pass" : "fail"}`);
  console.log(`dry_run_only=${summary.dry_run_only ? "yes" : "no"} external_effects_confirmed=no`);
  console.log(`preview actions=${summary.preview.action_count} applied=${summary.applied?.applied_count ?? 0}`);
  console.log(`final pairing=${summary.final_state.pairing_status ?? "unknown"} lock=${summary.final_state.lock_status ?? "unknown"}`);
  if (summary.workspace_root) {
    console.log(`workspace=${summary.workspace_root}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-gateway-recovery.mjs [options]

Verifies Gateway repair on a temporary workspace without external service calls.

Options:
  --json                  Output machine-readable JSON.
  --dry-run-only          Only verify repair preview behavior.
  --keep-workspace        Keep the temporary workspace and print its path.
  --expired-age-ms <ms>   Age used for synthetic expired pairing/lock state.
`);
}
