#!/usr/bin/env node
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { register } from "tsx/esm/api";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

register();
const { ClaudeCodeBackend, CodexBackend } = await import("../packages/agent-backends/src/index.ts");
const execFileAsync = promisify(execFile);

const rootDir = process.cwd();
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, ".env.local"));

const options = parseArgs(process.argv.slice(2));
const backends = selectedBackends(options.backend).map((id) => createBackend(id));
const results = [];

for (const backend of backends) {
  results.push(await verifyBackend(backend, options));
}

const summary = {
  checked_at: new Date().toISOString(),
  run_requested: options.run,
  live_requested: options.live,
  resume_requested: options.resume,
  cancel_requested: options.cancel,
  require_configured: options.requireConfigured,
  external_effects_confirmed: options.confirmExternalEffects,
  timeout_ms: options.timeoutMs,
  results
};

if (options.evidence) writeB08Evidence(summary);

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

process.exitCode = exitCode(summary);

function parseArgs(args) {
  const options = {
    backend: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_BACKEND || "all",
    run: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_RUN === "true",
    live: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_LIVE === "true",
    resume: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_RESUME === "true",
    cancel: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_CANCEL === "true",
    requireConfigured: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_REQUIRE_CONFIGURED === "true",
    confirmExternalEffects: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_CONFIRM_EXTERNAL_EFFECTS === "true",
    json: false,
    evidence: false,
    timeoutMs: positiveInt(process.env.SAMURAI_EXTERNAL_BACKEND_E2E_TIMEOUT_MS) ?? 20_000,
    input: process.env.SAMURAI_EXTERNAL_BACKEND_E2E_INPUT || "Samurai Agent external backend E2E probe. Reply with one short sentence."
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--run") {
      options.run = true;
    } else if (arg === "--live") {
      options.live = true;
      options.run = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--cancel") {
      options.cancel = true;
    } else if (arg === "--evidence") {
      options.evidence = true;
    } else if (arg === "--require-configured") {
      options.requireConfigured = true;
    } else if (arg === "--confirm-external-effects") {
      options.confirmExternalEffects = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--backend") {
      options.backend = args[++index] || options.backend;
    } else if (arg.startsWith("--backend=")) {
      options.backend = arg.slice("--backend=".length);
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInt(args[++index]) ?? options.timeoutMs;
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = positiveInt(arg.slice("--timeout-ms=".length)) ?? options.timeoutMs;
    } else if (arg === "--input") {
      options.input = args[++index] || options.input;
    } else if (arg.startsWith("--input=")) {
      options.input = arg.slice("--input=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function selectedBackends(value) {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "all") {
    return ["claude", "codex"];
  }
  const ids = normalized.split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (id !== "claude" && id !== "codex") {
      throw new Error(`Unknown backend: ${id}`);
    }
  }
  return ids;
}

function createBackend(id) {
  if (id === "claude") {
    return new ClaudeCodeBackend(definedOptions({
      command: process.env.SAMURAI_CLAUDE_CODE_COMMAND,
      args: splitOptionalArgs(process.env.SAMURAI_CLAUDE_CODE_ARGS),
      resumeArgs: splitOptionalArgs(process.env.SAMURAI_CLAUDE_CODE_RESUME_ARGS)
    }));
  }
  return new CodexBackend(definedOptions({
    command: process.env.SAMURAI_CODEX_COMMAND,
    args: splitOptionalArgs(process.env.SAMURAI_CODEX_ARGS),
    resumeArgs: splitOptionalArgs(process.env.SAMURAI_CODEX_RESUME_ARGS)
  }));
}

async function verifyBackend(backend, options) {
  const status = backend.getStatus ? await backend.getStatus() : undefined;
  const result = {
    backend_id: backend.id,
    backend_kind: backend.kind,
    label: backend.label,
    status: status ? {
      configured: status.configured,
      enabled: status.enabled,
      connection_state: status.connection_state,
      supports: status.supports,
      error_code: status.error_code,
      metadata: status.metadata
    } : undefined,
    run: { status: "skipped", reason: options.run ? "backend_unconfigured" : "run_not_requested" },
    live: { status: options.live ? "unverified" : "skipped", reason: options.live ? "live_not_run" : "live_not_requested" },
    resume: { status: "skipped", reason: options.resume ? "run_not_completed" : "resume_not_requested" },
    cancel: { status: "skipped", reason: options.cancel ? "run_not_started" : "cancel_not_requested" }
  };

  if (!options.run || !status?.configured || status.enabled === false) {
    return result;
  }
  if (!options.confirmExternalEffects) {
    result.run = { status: "blocked", reason: "external_effects_confirmation_required" };
    if (options.resume) {
      result.resume = { status: "skipped", reason: "run_blocked" };
    }
    return result;
  }

  if (options.live) {
    result.live = await verifyLiveVersion(backend, options);
  }
  const runCollection = await collectRunEvents(backend, backendRunInput(backend.id, options.input), options.timeoutMs);
  result.run = summarizeEvents(runCollection.events, runCollection.process_close_confirmed);
  if (runCollection.timed_out) result.run = { ...result.run, status: "failed", error_code: "backend_timeout", error_message: "Backend run exceeded the verification timeout." };

  if (options.resume) {
    const restartedBackend = createBackend(backend.kind === "codex" ? "codex" : "claude");
    if (!restartedBackend.resumeRun) result.resume = { status: "skipped", reason: "resume_unsupported" };
    else if (!result.run.backend_session_id) result.resume = { status: "skipped", reason: "backend_session_id_missing" };
    else {
      const resumeCollection = await collectRunEvents(restartedBackend, backendRunInput(backend.id, "Continue the Samurai Agent external backend E2E probe.", `${backend.id}_e2e_run`, result.run.backend_session_id), options.timeoutMs, (input) => restartedBackend.resumeRun(`${backend.id}_e2e_run`, { backend_session_id: input.backend_session_id, answer: "Continue the Samurai Agent external backend E2E probe.", abort_signal: input.abort_signal }));
      result.resume = { ...summarizeEvents(resumeCollection.events, resumeCollection.process_close_confirmed), backend_recreated: true };
      if (resumeCollection.timed_out) result.resume = { ...result.resume, status: "failed", error_code: "backend_timeout", error_message: "Backend resume exceeded the verification timeout." };
      if (result.resume.backend_session_id && result.resume.backend_session_id !== result.run.backend_session_id) {
        result.resume = { ...result.resume, status: "failed", error_code: "backend_session_conflict", error_message: "Resume emitted a different native Session ID." };
      }
    }
  }
  if (options.cancel) result.cancel = await verifyCancellation(createBackend(backend.kind === "codex" ? "codex" : "claude"), options);
  if (options.live && result.live.status === "passed" && result.run.status === "passed" && result.run.process_close_confirmed === true && (!options.resume || (result.resume.status === "passed" && result.resume.process_close_confirmed === true))) {
    backend.recordLiveVerification?.({ version: result.live.version, verified_at: new Date().toISOString(), effective_args: result.live.effective_args });
    const verifiedStatus = backend.getStatus?.();
    if (verifiedStatus) result.status = { ...result.status, connection_state: verifiedStatus.connection_state, metadata: verifiedStatus.metadata };
    result.live = { ...result.live, status: "passed", evidence: { initial_event: result.run.initial_event, raw_jsonl_shape: result.run.raw_jsonl_shape, session_id: result.run.backend_session_id, terminal_event: result.run.terminal_event, close_observed: result.run.process_close_confirmed } };
  }
  return result;
}

async function verifyCancellation(backend, options) {
  const runId = `${backend.id}_e2e_cancel`;
  const events = [];
  const controller = new AbortController();
  let cancelTimer;
  let deadlineTimer;
  let processCloseConfirmed = false;
  let cancellationRequested = false;
  let timedOut = false;
  let cancellationResult;
  let cancellationError;
  let cancellationPromise;
  deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    for await (const event of backend.runTurn({
      ...backendRunInput(backend.id, "Perform a careful long analysis before replying.", runId),
      abort_signal: controller.signal
    })) {
      events.push(event);
      if (!cancelTimer && event.event_type === "run_started") {
        cancelTimer = setTimeout(() => {
          cancellationRequested = true;
          cancellationPromise = Promise.resolve(backend.cancelRun?.(runId) ?? { kind: "unsupported" }).then(
            (result) => {
              cancellationResult = result;
              return result;
            },
            (error) => {
              cancellationError = error;
              return undefined;
            }
          );
        }, 250);
      }
    }
    processCloseConfirmed = true;
  } finally {
    clearTimeout(cancelTimer);
    clearTimeout(deadlineTimer);
  }
  if (cancellationPromise) await cancellationPromise;
  const summary = summarizeEvents(events, processCloseConfirmed);
  if (timedOut) {
    return { ...summary, status: "failed", error_code: "backend_timeout", error_message: "Backend cancellation exceeded the verification timeout.", cancellation_requested: cancellationRequested };
  }
  if (cancellationError) {
    return { ...summary, status: "failed", error_code: "backend_cancel_failed", error_message: safeEvidenceText(cancellationError?.message), cancellation_requested: cancellationRequested };
  }
  return {
    ...summary,
    status: summary.error_code === "backend_cancelled" && cancellationRequested && cancellationResult?.kind !== "unsupported" ? "passed" : "failed",
    cancellation_requested: cancellationRequested,
    cancellation_result: cancellationResult?.kind
  };
}

async function verifyLiveVersion(backend, options) {
  const command = backend.id === "codex" ? process.env.SAMURAI_CODEX_COMMAND : process.env.SAMURAI_CLAUDE_CODE_COMMAND;
  if (!command?.trim()) return { status: "unverified", reason: "command_not_configured" };
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: options.timeoutMs, maxBuffer: 64 * 1024 });
    const version = safeEvidenceText(stdout) || "version_unreported";
    return { status: "passed", version, effective_args: effectiveArgsForBackend(backend.id) };
  } catch (error) {
    return { status: "unverified", reason: "version_probe_failed", error_message: safeEvidenceText(error?.message) };
  }
}

function effectiveArgsForBackend(backendId) {
  const raw = backendId === "codex" ? process.env.SAMURAI_CODEX_ARGS : process.env.SAMURAI_CLAUDE_CODE_ARGS;
  return splitOptionalArgs(raw)?.map((arg) => /token|secret|password|api[_-]?key|authorization/i.test(arg) ? "[redacted-arg]" : arg) ?? [];
}

async function collectRunEvents(backend, input, timeoutMs, resumeFactory) {
  const controller = new AbortController();
  let timedOut = false;
  let processCloseConfirmed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const runInput = { ...input, abort_signal: controller.signal };
  const iterable = resumeFactory
    ? resumeFactory(runInput)
    : backend.runTurn(runInput);
  const events = [];
  try {
    for await (const event of iterable) events.push(event);
    processCloseConfirmed = true;
  } finally {
    clearTimeout(timer);
  }
  return { events, timed_out: timedOut, process_close_confirmed: processCloseConfirmed };
}

function summarizeEvents(events, processCloseConfirmed = false) {
  const terminal = [...events].reverse().find((event) =>
    event.event_type === "run_completed" || event.event_type === "run_failed"
  );
  const eventTypes = {};
  for (const event of events) {
    eventTypes[event.event_type] = (eventTypes[event.event_type] ?? 0) + 1;
  }
  const verifiedToolResultCount = events.filter((event) =>
    event.event_type === "tool_call_output"
    && typeof event.payload?.status === "string"
    && event.payload.status.trim().length > 0
  ).length;
  return {
    status: terminal?.event_type === "run_completed" ? "passed" : "failed",
    event_count: events.length,
    event_types: eventTypes,
    verified_tool_result_count: verifiedToolResultCount,
    terminal_event: terminal?.event_type,
    backend_session_id: firstEventSessionId(events),
    process_close_confirmed: processCloseConfirmed,
    output_summary: typeof terminal?.payload.output_summary === "string" ? terminal.payload.output_summary : undefined,
    error_code: typeof terminal?.payload.error_code === "string" ? terminal.payload.error_code : undefined,
    error_message: typeof terminal?.payload.message === "string" ? terminal.payload.message : undefined,
    stderr_summary: typeof terminal?.payload.stderr_summary === "string" ? terminal.payload.stderr_summary : undefined,
    initial_event: events[0] ? { event_type: events[0].event_type, source_event_id: events[0].source_event_id, payload_keys: Object.keys(events[0].payload ?? {}).sort() } : undefined,
    raw_jsonl_shape: events.map((event) => ({ event_type: event.event_type, source_event_id: event.source_event_id, payload_keys: Object.keys(event.payload ?? {}).sort() }))
  };
}

function firstEventSessionId(events) {
  for (const event of events) {
    const direct = event.backend_session_id;
    if (typeof direct === "string" && direct.trim()) return direct;
    const value = firstString([event], ["provider_thread_id", "thread_id", "conversation_id", "session_id"]);
    if (value) return value;
  }
  return undefined;
}

function firstString(events, keys) {
  for (const event of events) {
    for (const key of keys) {
      const value = event.payload?.[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function backendRunInput(backendId, input, runId = `${backendId}_e2e_run`, backendSessionId) {
  return {
    run_id: runId,
    session_id: `${backendId}_e2e_session`,
    input_message_id: `${backendId}_e2e_message`,
    envelope: {
      id: `${backendId}_e2e_message`,
      source: "web",
      actor_identity: "owner",
      session_key: `web:owner:${backendId}-e2e`,
      user_intent: input,
      attachments: [],
      input_locale: "en",
      output_locale: "en",
      metadata: { e2e: true },
      received_at: new Date().toISOString()
    },
    user_input: input,
    input_locale: "en",
    output_locale: "en",
    ...(backendSessionId ? { backend_session_id: backendSessionId } : {}),
    active_memory: [],
    recent_messages: [],
    metadata: { e2e: true },
    available_tools: []
  };
}

function safeEvidenceText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?[^\s,}]+/gi, "credential=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function splitOptionalArgs(value) {
  if (!value || !value.trim()) {
    return undefined;
  }
  return value.split(" ").map((item) => item.trim()).filter(Boolean);
}

function definedOptions(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(filePath);
      return;
    } catch {
      // Fall through to existing environment. Verification should not fail just because an optional env file is malformed.
    }
  }
}

function printSummary(summary) {
  console.log("External backend verification");
  console.log(`run=${summary.run_requested ? "yes" : "no"} live=${summary.live_requested ? "yes" : "no"} resume=${summary.resume_requested ? "yes" : "no"} external_effects_confirmed=${summary.external_effects_confirmed ? "yes" : "no"} timeout=${summary.timeout_ms}ms`);
  for (const result of summary.results) {
    const status = result.status;
    console.log(`- ${result.backend_id}: configured=${status?.configured ?? false} state=${status?.connection_state ?? "unknown"} run=${result.run.status}`);
    if (result.run.reason) {
      console.log(`  run reason: ${result.run.reason}`);
    }
    if (result.run.terminal_event) {
      console.log(`  events: ${result.run.event_count} terminal=${result.run.terminal_event} session=${result.run.backend_session_id ?? "none"}`);
    }
    if (summary.resume_requested) {
      console.log(`  resume=${result.resume.status}${result.resume.reason ? ` reason=${result.resume.reason}` : ""}`);
    }
    if (summary.live_requested) console.log(`  live=${result.live.status}${result.live.reason ? ` reason=${result.live.reason}` : ""}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-external-backends.mjs [options]

Options:
  --backend claude|codex|all    Backend selection. Comma-separated values are allowed.
  --run                         Execute a real backend run. Default only checks status/probe metadata.
  --live                        Verify version, JSONL Session/terminal/close evidence, and mark the connection ready only after success.
  --confirm-external-effects    Required with --run to allow authenticated CLI/network/quota effects.
  --resume                      After a run, attempt native resume when a backend session id is observed.
  --cancel                      Start and cancel a real backend run.
  --evidence                    Write B08 evidence when the full flow passes.
  --require-configured          Return non-zero when selected backends are not configured.
  --timeout-ms <ms>             Command timeout for real run/probe.
  --input <text>                Probe prompt.
  --json                        Print machine-readable JSON.
`);
}

function exitCode(summary) {
  let code = 0;
  for (const result of summary.results) {
    if (summary.require_configured && !result.status?.configured) {
      code = 1;
    }
    if (summary.run_requested && result.status?.configured && result.run.status !== "passed") {
      code = 1;
    }
    if (summary.resume_requested && result.resume.status === "failed") {
      code = 1;
    }
    if (summary.live_requested && result.live.status !== "passed") code = 1;
    if (summary.cancel_requested && result.cancel.status !== "passed") code = 1;
  }
  return code;
}

function writeB08Evidence(summary) {
  const result = summary.results.find((item) => item.live.status !== "skipped" || item.run.status !== "skipped" || item.resume.status !== "skipped" || item.cancel.status !== "skipped") ?? summary.results[0];
  const toolResults = (result?.run?.verified_tool_result_count ?? 0) + (result?.resume?.verified_tool_result_count ?? 0);
  const sameNativeSession = Boolean(
    result?.run?.backend_session_id
    && result.resume?.backend_session_id
    && result.resume.backend_session_id === result.run.backend_session_id
  );
  const processCloseConfirmed = Boolean(
    result?.run?.process_close_confirmed
    && result.resume?.process_close_confirmed
    && result.cancel?.process_close_confirmed
  );
  const passed = Boolean(
    summary.live_requested
    && result?.live.status === "passed"
    && result.run.status === "passed"
    && result.resume.status === "passed"
    && result.cancel.status === "passed"
    && result.resume.backend_recreated
    && sameNativeSession
    && toolResults > 0
    && processCloseConfirmed
  );
  const evidenceDir = path.join(rootDir, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const now = new Date().toISOString();
  const sources = [
    "packages/core-schemas/src/index.ts",
    "packages/agent-backends/src/index.ts",
    "packages/agent-backends/src/contract.ts",
    "packages/agent-backends/src/process-runner.ts",
    "packages/agent-backends/src/external-cli.ts",
    "packages/agent-backends/src/cli-parser.ts",
    "packages/agent-backends/src/provider-decoder-helpers.ts",
    "packages/agent-backends/src/claude-code-decoder.ts",
    "packages/agent-backends/src/codex-decoder.ts",
    "packages/agent-backends/src/claude-code.ts",
    "packages/agent-backends/src/codex.ts",
    "scripts/verify-external-backends.mjs",
    "scripts/lib/core-evidence.mjs"
  ];
  writeFileSync(path.join(evidenceDir, "B08.json"), `${JSON.stringify({
    schema_version: 1,
    test_id: "B08",
    command: "pnpm backend:external:verify",
    status: passed ? "passed" : "partial",
    ...(!passed ? { reason: "live_unverified" } : {}),
    ...committedSourceEvidence(rootDir, sources),
    started_at: summary.checked_at,
    completed_at: now,
    assertions: [
      { name: "Explicit live verification requested", actual: summary.live_requested, expected: true },
      { name: "Live verification", actual: result?.live.status, expected: "passed" },
      { name: "Real Backend run", actual: result?.run.status, expected: "passed" },
      { name: "Native resume", actual: result?.resume.status, expected: "passed" },
      { name: "Real cancellation", actual: result?.cancel.status, expected: "passed" },
      { name: "Native Session is preserved", actual: sameNativeSession, expected: true },
      { name: "Tool results with explicit status", actual: toolResults, expected: ">0" },
      { name: "Process close", actual: processCloseConfirmed, expected: true }
    ],
    result: result ?? summary
  }, null, 2)}\n`);
}
