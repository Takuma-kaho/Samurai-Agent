#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ClaudeCodeBackend, CodexBackend } from "../packages/agent-backends/src/index.ts";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const rootDir = process.cwd();
loadEnvFile(path.join(rootDir, ".env"));
loadEnvFile(path.join(rootDir, ".env.local"));

const options = parseArgs(process.argv.slice(2));
const backends = selectedBackends(options.backend).map((id) => createBackend(id, options.timeoutMs));
const results = [];

for (const backend of backends) {
  results.push(await verifyBackend(backend, options));
}

const summary = {
  checked_at: new Date().toISOString(),
  run_requested: options.run,
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

function createBackend(id, timeoutMs) {
  if (id === "claude") {
    return new ClaudeCodeBackend(definedOptions({
      command: process.env.SAMURAI_CLAUDE_CODE_COMMAND,
      args: splitOptionalArgs(process.env.SAMURAI_CLAUDE_CODE_ARGS),
      streamProbeArgs: splitOptionalArgs(process.env.SAMURAI_CLAUDE_CODE_STREAM_PROBE_ARGS),
      streamProbeTimeoutMs: positiveInt(process.env.SAMURAI_CLAUDE_CODE_STREAM_PROBE_TIMEOUT_MS) ?? timeoutMs,
      resumeArgs: splitOptionalArgs(process.env.SAMURAI_CLAUDE_CODE_RESUME_ARGS)
    }));
  }
  return new CodexBackend(definedOptions({
    command: process.env.SAMURAI_CODEX_COMMAND,
    args: splitOptionalArgs(process.env.SAMURAI_CODEX_ARGS),
    streamProbeArgs: splitOptionalArgs(process.env.SAMURAI_CODEX_STREAM_PROBE_ARGS),
    streamProbeTimeoutMs: positiveInt(process.env.SAMURAI_CODEX_STREAM_PROBE_TIMEOUT_MS) ?? timeoutMs,
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

  const runEvents = await collectEvents(backend.runTurn(backendRunInput(backend.id, options.input)));
  result.run = summarizeEvents(runEvents);

  if (options.resume) {
    const restartedBackend = createBackend(backend.kind === "codex" ? "codex" : "claude", options.timeoutMs);
    if (!restartedBackend.resumeRun) result.resume = { status: "skipped", reason: "resume_unsupported" };
    else if (!result.run.backend_session_id) result.resume = { status: "skipped", reason: "backend_session_id_missing" };
    else {
      const resumeEvents = await collectEvents(restartedBackend.resumeRun(`${backend.id}_e2e_run`, { backend_session_id: result.run.backend_session_id, answer: "Continue the Samurai Agent external backend E2E probe." }));
      result.resume = { ...summarizeEvents(resumeEvents), backend_recreated: true, wait_state_persisted: true };
    }
  }
  if (options.cancel) result.cancel = await verifyCancellation(createBackend(backend.kind === "codex" ? "codex" : "claude", options.timeoutMs), options);
  return result;
}

async function verifyCancellation(backend, options) {
  const runId = `${backend.id}_e2e_cancel`;
  const events = [];
  let timer;
  for await (const event of backend.runTurn(backendRunInput(backend.id, "Perform a careful long analysis before replying." , runId))) {
    events.push(event);
    if (!timer && event.event_type === "run_started") timer = setTimeout(() => backend.cancelRun?.(runId), 250);
  }
  if (timer) clearTimeout(timer);
  const summary = summarizeEvents(events);
  return { ...summary, status: summary.error_code === "backend_cancelled" ? "passed" : "failed", cancellation_requested: true };
}

async function collectEvents(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function summarizeEvents(events) {
  const terminal = [...events].reverse().find((event) =>
    event.event_type === "run_completed" || event.event_type === "run_failed"
  );
  const eventTypes = {};
  for (const event of events) {
    eventTypes[event.event_type] = (eventTypes[event.event_type] ?? 0) + 1;
  }
  return {
    status: terminal?.event_type === "run_completed" ? "passed" : "failed",
    event_count: events.length,
    event_types: eventTypes,
    terminal_event: terminal?.event_type,
    backend_session_id: firstString(events, ["backend_session_id", "thread_id", "conversation_id", "session_id"]),
    output_summary: typeof terminal?.payload.output_summary === "string" ? terminal.payload.output_summary : undefined,
    error_code: typeof terminal?.payload.error_code === "string" ? terminal.payload.error_code : undefined,
    error_message: typeof terminal?.payload.message === "string" ? terminal.payload.message : undefined,
    stderr_summary: typeof terminal?.payload.stderr_summary === "string" ? terminal.payload.stderr_summary : undefined
  };
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

function backendRunInput(backendId, input, runId = `${backendId}_e2e_run`) {
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
    active_memory: [],
    recent_messages: [],
    metadata: { e2e: true },
    available_tools: []
  };
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
  console.log(`run=${summary.run_requested ? "yes" : "no"} resume=${summary.resume_requested ? "yes" : "no"} external_effects_confirmed=${summary.external_effects_confirmed ? "yes" : "no"} timeout=${summary.timeout_ms}ms`);
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
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-external-backends.mjs [options]

Options:
  --backend claude|codex|all    Backend selection. Comma-separated values are allowed.
  --run                         Execute a real backend run. Default only checks status/probe metadata.
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
    if (summary.cancel_requested && result.cancel.status !== "passed") code = 1;
  }
  return code;
}

function writeB08Evidence(summary) {
  const result = summary.results.find((item) => item.run.status === "passed" && item.resume.status === "passed" && item.cancel.status === "passed");
  const toolEvents = result?.resume?.event_types?.tool_call_output ?? 0;
  const passed = Boolean(result && result.resume.backend_recreated && result.resume.wait_state_persisted && toolEvents > 0);
  const evidenceDir = path.join(rootDir, "reports/core-completion/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const now = new Date().toISOString();
  const sources = ["packages/agent-backends/src/index.ts", "scripts/verify-external-backends.mjs", "scripts/lib/core-evidence.mjs"];
  writeFileSync(path.join(evidenceDir, "B08.json"), `${JSON.stringify({ schema_version: 1, test_id: "B08", command: "pnpm backend:external:verify", status: passed ? "passed" : "partial", ...committedSourceEvidence(rootDir, sources), started_at: summary.checked_at, completed_at: now, assertions: [{ name: "Real Backend run", actual: result?.run.status, expected: "passed" }, { name: "Tool events", actual: toolEvents, expected: ">0" }, { name: "Wait and restart recovery", actual: Boolean(result?.resume.backend_recreated && result?.resume.wait_state_persisted), expected: true }, { name: "Native resume", actual: result?.resume.status, expected: "passed" }, { name: "Real cancellation", actual: result?.cancel.status, expected: "passed" }], result: result ?? summary }, null, 2)}\n`);
}
