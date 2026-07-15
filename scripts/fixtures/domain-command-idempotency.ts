import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { domainCommandEntries } from "../../packages/action-catalog/src/index";
import { nowIso, stableHash, type DomainCommandExecutionRecord } from "../../packages/core-schemas/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DomainCommandConflictError, DomainCommandOutcomeUnknownError, DomainCommandReplayError, DurableDomainCommandBus } from "../../packages/runtime/src/commands/domain-command-bus";

const root = await mkdtemp(path.join(tmpdir(), "samurai-domain-command-evidence-"));
const store = await WorkspaceStore.create({ rootDir: root });

try {
  let missingKeyHandlerCalls = 0;
  for (const command of domainCommandEntries) {
    await assert.rejects(new DurableDomainCommandBus(store).execute({
      commandId: command.id, contractVersion: command.contract_version, inputSource: "runtime_api", payload: {}
    }, async () => { missingKeyHandlerCalls += 1; return {}; }), (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_key_required");
  }
  assert.equal(missingKeyHandlerCalls, 0);
  const buses = Array.from({ length: 10 }, () => new DurableDomainCommandBus(store));
  let sideEffects = 0;
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
    buses[index % buses.length].execute({
      commandId: "test.increment",
      inputSource: "runtime_api",
      payload: { value: 1 },
      idempotencyKey: "same-command"
    }, async () => {
      sideEffects += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { result_id: "result-1", value: sideEffects };
    })
  ));

  assert.equal(sideEffects, 1);
  assert.deepEqual([...new Set(results.map((result) => result.result_id))], ["result-1"]);
  assert.deepEqual([...new Set(results.map((result) => result.value))], [1]);

  const replay = await new DurableDomainCommandBus(store).execute({
    commandId: "test.increment",
    inputSource: "runtime_api",
    payload: { value: 1 },
    idempotencyKey: "same-command"
  }, async () => {
    throw new Error("completed command must not run again");
  });
  assert.deepEqual(replay, { result_id: "result-1", value: 1 });

  await assert.rejects(
    new DurableDomainCommandBus(store).execute({
      commandId: "test.increment",
      inputSource: "runtime_api",
      payload: { value: 2 },
      idempotencyKey: "same-command"
    }, async () => ({ result_id: "invalid" })),
    DomainCommandConflictError
  );

  for (const changed of [
    { workspaceId: "workspace-b" },
    { sessionId: "session-b" },
    { actorId: "actor-b" },
    { contractVersion: "2.0" }
  ]) {
    const key = `scope-${Object.keys(changed)[0]}`;
    const base = {
      commandId: "test.scope", contractVersion: "1.0", inputSource: "runtime_api", payload: { value: 1 },
      idempotencyKey: key, workspaceId: "workspace-a", sessionId: "session-a", actorId: "actor-a"
    };
    await new DurableDomainCommandBus(store).execute(base, async () => ({ ok: true }));
    await assert.rejects(new DurableDomainCommandBus(store).execute({ ...base, ...changed }, async () => ({ ok: false })), DomainCommandConflictError);
  }

  const failedInput = { commandId: "test.failed", inputSource: "runtime_api", payload: {}, idempotencyKey: "typed-failure" };
  const typedFailure = Object.assign(new Error("typed failure"), { code: "typed_failure", retryable: false, details: { reason: "fixture" } });
  await assert.rejects(
    new DurableDomainCommandBus(store).execute(failedInput, async () => { throw typedFailure; }),
    (error: unknown) => error === typedFailure
  );
  let replayedHandlerCalls = 0;
  await assert.rejects(
    new DurableDomainCommandBus(store).execute(failedInput, async () => { replayedHandlerCalls += 1; return {}; }),
    (error: unknown) => error instanceof DomainCommandReplayError && error.code === "typed_failure" && error.retryable === false
  );
  assert.equal(replayedHandlerCalls, 0);

  const heartbeatInput = { commandId: "test.heartbeat", inputSource: "runtime_api", payload: {}, idempotencyKey: "live-heartbeat" };
  let heartbeatSideEffects = 0;
  const primary = new DurableDomainCommandBus(store, 1_200).execute(heartbeatInput, async () => {
    heartbeatSideEffects += 1;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return { completed: true };
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const follower = new DurableDomainCommandBus(store, 1_200).execute(heartbeatInput, async () => {
    heartbeatSideEffects += 1;
    return { completed: false };
  });
  assert.deepEqual(await Promise.all([primary, follower]), [{ completed: true }, { completed: true }]);
  assert.equal(heartbeatSideEffects, 1);

  const staleAt = new Date(Date.now() - 1_000).toISOString();
  const staleInput = (key: string, executionClass: "internal" | "external") => ({
    commandId: `test.${executionClass}`,
    inputSource: "runtime_api",
    payload: { value: 1 },
    idempotencyKey: key,
    executionClass
  });
  const staleRecord = (input: ReturnType<typeof staleInput>, phase: DomainCommandExecutionRecord["phase"]): DomainCommandExecutionRecord => ({
    id: `execution-${input.idempotencyKey}`,
    idempotency_key: input.idempotencyKey,
    command_id: input.commandId,
    input_source: input.inputSource,
    correlation_id: `correlation-${input.idempotencyKey}`,
    payload_hash: stableHash({
      command_id: input.commandId,
      contract_version: "unknown",
      workspace_id: null,
      session_id: null,
      actor_id: null,
      payload: input.payload
    }),
    phase,
    status: "running",
    heartbeat_at: staleAt,
    created_at: staleAt,
    updated_at: staleAt
  });

  const externalInput = staleInput("external-stale", "external");
  await store.claimDomainCommandExecution(staleRecord(externalInput, "external_running"));
  let externalReplayCalls = 0;
  await assert.rejects(
    new DurableDomainCommandBus(store, 10).execute(externalInput, async () => {
      externalReplayCalls += 1;
      return { unsafe: true };
    }),
    DomainCommandOutcomeUnknownError
  );
  assert.equal(externalReplayCalls, 0);
  assert.equal((await store.getDomainCommandExecution(externalInput.idempotencyKey))?.status, "outcome_unknown");

  for (const phase of ["claimed", "internal_running"] as const) {
    const internalInput = staleInput(`internal-stale-${phase}`, "internal");
    await store.claimDomainCommandExecution(staleRecord(internalInput, phase));
    let reclaimedCalls = 0;
    const reclaimed = await new DurableDomainCommandBus(store, 10).execute(internalInput, async () => {
      reclaimedCalls += 1;
      return { reclaimed: phase };
    });
    assert.deepEqual(reclaimed, { reclaimed: phase });
    assert.equal(reclaimedCalls, 1);
  }

  const casInput = staleInput("cas-heartbeat", "internal");
  const observed = staleRecord(casInput, "internal_running");
  await store.claimDomainCommandExecution(observed);
  const newerHeartbeat = nowIso();
  assert.equal(await store.heartbeatDomainCommandExecution(observed.id, newerHeartbeat), true);
  assert.equal(await store.compareAndSetDomainCommandExecution({
    id: observed.id,
    expectedStatus: "running",
    expectedHeartbeatAt: observed.heartbeat_at,
    next: { ...observed, status: "outcome_unknown", updated_at: nowIso() }
  }), false);

  const workerScript = process.env.SAMURAI_DOMAIN_IDEMPOTENCY_WORKER;
  assert.ok(workerScript, "multi-process worker was not provided by the verifier");
  const sideEffectFile = path.join(root, "multi-process-effects.log");
  await writeFile(sideEffectFile, "", "utf8");
  const workerResults = await Promise.all(Array.from({ length: 10 }, () => runWorker(workerScript, root, sideEffectFile)));
  assert.deepEqual([...new Set(workerResults.map((result) => result.result_id))], ["multi-process-result"]);
  const multiProcessEffects = (await readFile(sideEffectFile, "utf8")).trim().split("\n").filter(Boolean);
  assert.equal(multiProcessEffects.length, 1);

  const crashWorker = process.env.SAMURAI_DOMAIN_CRASH_WORKER;
  assert.ok(crashWorker, "crash worker was not provided by the verifier");
  assert.equal(await runCrashWorker(crashWorker, root, "before_handler"), 91);
  await new Promise((resolve) => setTimeout(resolve, 125));
  let crashBeforeCalls = 0;
  const crashBeforeResult = await new DurableDomainCommandBus(store, 100).execute({
    commandId: "test.before_handler",
    inputSource: "runtime_api",
    payload: { mode: "before_handler" },
    idempotencyKey: "crash-before-handler",
    executionClass: "internal"
  }, async () => {
    crashBeforeCalls += 1;
    return { completed: true };
  });
  assert.deepEqual(crashBeforeResult, { completed: true });
  assert.equal(crashBeforeCalls, 1);

  const externalEffectFile = path.join(root, "crash-after-external.log");
  await writeFile(externalEffectFile, "", "utf8");
  assert.equal(await runCrashWorker(crashWorker, root, "after_external", externalEffectFile), 92);
  await new Promise((resolve) => setTimeout(resolve, 125));
  let crashAfterReplayCalls = 0;
  await assert.rejects(new DurableDomainCommandBus(store, 100).execute({
    commandId: "test.after_external",
    inputSource: "runtime_api",
    payload: { mode: "after_external" },
    idempotencyKey: "crash-after-external",
    executionClass: "external"
  }, async () => {
    crashAfterReplayCalls += 1;
    return { unsafe: true };
  }), DomainCommandOutcomeUnknownError);
  assert.equal(crashAfterReplayCalls, 0);
  assert.equal((await readFile(externalEffectFile, "utf8")).trim().split("\n").filter(Boolean).length, 1);

  assert.equal(await runCrashWorker(crashWorker, root, "during_internal_transaction"), 93);
  const transactionMarker = new Database(path.join(root, "workspace.sqlite"), { readonly: true });
  const partialRows = transactionMarker.prepare("SELECT count(*) AS count FROM domain_crash_fixture WHERE id = ?").get("partial") as { count: number };
  transactionMarker.close();
  assert.equal(partialRows.count, 0);

  const migrationRoot = await mkdtemp(path.join(tmpdir(), "samurai-domain-command-migration-"));
  await mkdir(migrationRoot, { recursive: true });
  const migrationDatabase = new Database(path.join(migrationRoot, "workspace.sqlite"));
  migrationDatabase.exec("CREATE TABLE domain_command_executions (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, command_id TEXT NOT NULL, input_source TEXT NOT NULL, payload_hash TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  const migrationInput = { commandId: "test.legacy", inputSource: "runtime_api", payload: { value: 1 }, idempotencyKey: "legacy-running", executionClass: "external" as const };
  const migrationHash = stableHash({ command_id: migrationInput.commandId, contract_version: "unknown", workspace_id: null, session_id: null, actor_id: null, payload: migrationInput.payload });
  migrationDatabase.prepare("INSERT INTO domain_command_executions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)").run("legacy-id", migrationInput.idempotencyKey, migrationInput.commandId, migrationInput.inputSource, migrationHash, "running", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  migrationDatabase.close();
  const migratedStore = await WorkspaceStore.create({ rootDir: migrationRoot });
  let migratedHandlerCalls = 0;
  await assert.rejects(new DurableDomainCommandBus(migratedStore, 10).execute(migrationInput, async () => { migratedHandlerCalls += 1; return {}; }), DomainCommandOutcomeUnknownError);
  assert.equal(migratedHandlerCalls, 0);
  assert.equal((await migratedStore.getDomainCommandExecution(migrationInput.idempotencyKey))?.status, "outcome_unknown");
  await migratedStore.close();
  await rm(migrationRoot, { recursive: true, force: true });

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    gates: ["ID01", "ID02", "ID03", "ID04", "ID05", "ID06", "ID07", "ID08", "ID09", "ID10", "ID11", "ID12", "ID13", "ID14", "ID15"],
    commands_requiring_key: domainCommandEntries.length,
    parallel_requests: 100,
    workers: buses.length,
    side_effects: sideEffects,
    result_ids: ["result-1"],
    durable_replay: true,
    mismatched_payload_rejected: true,
    scope_and_version_reuse_rejected: true,
    typed_failure_replayed: true,
    live_heartbeat_not_marked_unknown: true,
    internal_stale_reclaimed: true,
    external_stale_outcome_unknown: true,
    stale_cas_protected: true,
    multi_process_workers: workerResults.length,
    multi_process_side_effects: multiProcessEffects.length,
    crash_before_reclaimed: true,
    crash_during_transaction_partial_rows: partialRows.count,
    crash_after_external_outcome_unknown: true,
    legacy_migration_outcome_unknown: true
  })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

function runWorker(script: string, workspaceRoot: string, sideEffectFile: string): Promise<{ result_id: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SAMURAI_WORKER_ROOT: workspaceRoot,
        SAMURAI_WORKER_SIDE_EFFECT_FILE: sideEffectFile
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`multi_process_worker_failed:${code}:${stderr}`));
      try {
        resolve(JSON.parse(stdout.trim()) as { result_id: string });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function runCrashWorker(script: string, workspaceRoot: string, mode: "before_handler" | "during_internal_transaction" | "after_external", sideEffectFile?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SAMURAI_WORKER_ROOT: workspaceRoot,
        SAMURAI_CRASH_MODE: mode,
        ...(sideEffectFile ? { SAMURAI_WORKER_SIDE_EFFECT_FILE: sideEffectFile } : {})
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => stderr ? reject(new Error(`crash_worker_stderr:${stderr}`)) : resolve(code));
  });
}
