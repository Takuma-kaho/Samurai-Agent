#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const options = parseArgs(process.argv.slice(2));
const gates = buildGates(options);
const manualGates = [
  {
    id: "external-backend-run-resume",
    label: "External backend run/resume",
    status: "manual_opt_in_required",
    effect: "authenticated_external_service",
    reason: "Requires explicit confirmation because it may use authenticated external services, network, and provider quota.",
    command: "pnpm run backend:external:verify -- --run --confirm-external-effects --resume --require-configured --backend <id>",
    confirmation_flag: "--confirm-external-effects",
    runbook: "plans/backend-external-e2e-runbook.md"
  },
  {
    id: "external-sandbox-run",
    label: "External sandbox run",
    status: "manual_opt_in_required",
    effect: "external_sandbox",
    reason: "Docker, SSH, and remote sandbox runs can create remote or container side effects.",
    command: "pnpm run sandbox:verify -- --run --confirm-external-effects --backend docker|ssh|remote",
    confirmation_flag: "--confirm-external-effects",
    runbook: "plans/backend-external-e2e-runbook.md"
  },
  {
    id: "external-channel-service-e2e",
    label: "External channel service E2E",
    status: "manual_opt_in_required",
    effect: "external_channel_service",
    reason: "Requires real Slack, Telegram, LINE, or Email provider credentials and may send or receive live messages.",
    command: "manual: run the channel service E2E checklist in plans/backend-external-e2e-runbook.md",
    confirmation_flag: "--confirm-external-effects",
    runbook: "plans/backend-external-e2e-runbook.md"
  }
];

const results = options.list
  ? gates.map((gate) => plannedGate(gate))
  : [];

if (!options.list) {
  for (const gate of gates) {
    results.push(await runGate(gate, options));
  }
}

const summary = {
  checked_at: new Date().toISOString(),
  planned_only: options.list,
  external_effects_confirmed: false,
  timeout_ms: options.timeoutMs,
  // A skipped gate is an unverified gate, not a successful release check.
  // `--list` is only a plan and is therefore the sole mode that can finish
  // without every executable gate passing.
  ok: options.list
    ? results.every((result) => result.status === "planned" || result.status === "unverified")
    : results.every((result) => result.status === "passed"),
  gates: results,
  manual_gates: manualGates,
  profiles: releaseProfiles(manualGates)
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

process.exitCode = summary.ok ? 0 : 1;

function parseArgs(args) {
  const options = {
    json: false,
    list: false,
    timeoutMs: positiveInt(process.env.SAMURAI_BACKEND_RELEASE_VERIFY_TIMEOUT_MS) ?? 300_000,
    skipTests: false,
    skipWebBuild: false,
    skipExternalProbes: false,
    skipSandboxProbes: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--skip-tests") {
      options.skipTests = true;
    } else if (arg === "--skip-web-build") {
      options.skipWebBuild = true;
    } else if (arg === "--skip-external-probes") {
      options.skipExternalProbes = true;
    } else if (arg === "--skip-sandbox-probes") {
      options.skipSandboxProbes = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = positiveInt(args[++index]) ?? options.timeoutMs;
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = positiveInt(arg.slice("--timeout-ms=".length)) ?? options.timeoutMs;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function buildGates(options) {
  const gates = [
    pnpmGate("typecheck", "Root workspace TypeScript typecheck", ["run", "typecheck"]),
    pnpmGate("full-tests", "Full Vitest suite", ["test"], { skipped: options.skipTests }),
    pnpmGate("i18n-check", "Locale key consistency", ["run", "i18n:check"]),
    pnpmGate("web-build", "Web production build", ["--filter", "@samurai-agent/web", "run", "build"], { skipped: options.skipWebBuild }),
    pnpmGate("desktop-verify", "Desktop architecture and IPC boundary", ["run", "desktop:verify"]),
    pnpmGate("desktop-build", "Desktop TypeScript build", ["run", "desktop:build"]),
    nodeGate("architecture-static", "Architecture boundary invariants", ["scripts/verify/architecture-invariants.mjs", "--strict"]),
    nodeGate("doctor", "Strict local workspace/backend doctor", ["scripts/doctor.mjs", "--strict"]),
    nodeGate("doctor-syntax", "Doctor script syntax", ["--check", "scripts/doctor.mjs"]),
    internalGate("public-naming-scan", "PUBLIC_NAMING forbidden source names", runPublicNamingScan),
    nodeGate("gateway-recovery-probe", "Gateway repair preview/apply on temporary workspace", ["--import", "tsx", "scripts/verify-gateway-recovery.mjs", "--json"])
  ];
  gates.push(nodeGate("external-channel-probe", "External channel readiness without live sends", ["scripts/verify-external-channels.mjs", "--json"], { skipped: options.skipExternalProbes }));
  gates.push(nodeGate("external-backend-status", "External backend command status without starting runs", ["scripts/verify-external-backends.mjs", "--json"], { skipped: options.skipExternalProbes }));
  gates.push(nodeGate("sandbox-capabilities", "Sandbox executor capability probe without external runs", ["--import", "tsx", "scripts/verify-sandbox-executors.mjs", "--json"], { skipped: options.skipSandboxProbes }));
  gates.push(nodeGate("sandbox-host-run", "Local host sandbox probe", ["--import", "tsx", "scripts/verify-sandbox-executors.mjs", "--backend", "none", "--run", "--json", "--timeout-ms", "5000"], { skipped: options.skipSandboxProbes }));
  return gates;
}

function releaseProfiles(manualGates) {
  const nonDestructiveGateIds = [
    "typecheck",
    "full-tests",
    "i18n-check",
    "web-build",
    "desktop-verify",
    "desktop-build",
    "architecture-static",
    "doctor",
    "doctor-syntax",
    "public-naming-scan",
    "gateway-recovery-probe",
    "external-channel-probe",
    "external-backend-status",
    "sandbox-capabilities",
    "sandbox-host-run"
  ];
  return [
    {
      id: "local_oss",
      label: "Local OSS Release",
      status: "available",
      non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
      required_gate_ids: nonDestructiveGateIds,
      manual_gate_ids: [],
      runbook: "plans/backend-external-e2e-runbook.md",
      notes: [
        "No authenticated external service calls are started by this profile.",
        "Use this before publishing local backend changes or opening a release PR."
      ]
    },
    {
      id: "production_ops",
      label: "Production Operations",
      status: "manual_opt_in_required",
      non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
      required_gate_ids: nonDestructiveGateIds,
      manual_gate_ids: manualGates.map((gate) => gate.id),
      runbook: "plans/backend-external-e2e-runbook.md",
      notes: [
        "Run the manual gates only after credentials, quotas, remote targets, and message side effects are approved.",
        "The verifier lists this profile but does not start authenticated external runs by itself."
      ]
    }
  ];
}

function pnpmGate(id, label, args, options = {}) {
  return {
    id,
    label,
    command: "pnpm",
    args,
    env: { CI: "true" },
    skipped: options.skipped === true
  };
}

function nodeGate(id, label, args, options = {}) {
  return {
    id,
    label,
    command: process.execPath,
    args,
    skipped: options.skipped === true
  };
}

function internalGate(id, label, run) {
  return {
    id,
    label,
    command: "internal",
    args: [id],
    run
  };
}

function plannedGate(gate) {
  return {
    id: gate.id,
    label: gate.label,
    command: renderCommand(gate),
    status: gate.skipped ? "unverified" : "planned",
    ...(gate.skipped ? { reason: "explicitly_skipped" } : {}),
    duration_ms: 0,
    exit_code: null
  };
}

async function runGate(gate, options) {
  if (gate.skipped) {
    return {
      id: gate.id,
      label: gate.label,
      command: renderCommand(gate),
      status: "unverified",
      reason: "explicitly_skipped",
      duration_ms: 0,
      exit_code: null
    };
  }
  const startedAt = Date.now();
  if (!options.json) {
    console.log(`\n[${gate.id}] ${renderCommand(gate)}`);
  }
  if (gate.run) {
    try {
      const output = await gate.run();
      return {
        id: gate.id,
        label: gate.label,
        command: renderCommand(gate),
        status: "passed",
        duration_ms: Date.now() - startedAt,
        exit_code: 0,
        stdout_tail: output
      };
    } catch (error) {
      return {
        id: gate.id,
        label: gate.label,
        command: renderCommand(gate),
        status: "failed",
        duration_ms: Date.now() - startedAt,
        exit_code: 1,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return new Promise((resolve) => {
    const child = spawn(gate.command, gate.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...gate.env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendTail(stdout, text);
      if (!options.json) {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendTail(stderr, text);
      if (!options.json) {
        process.stderr.write(text);
      }
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({
        id: gate.id,
        label: gate.label,
        command: renderCommand(gate),
        status: code === 0 && !timedOut ? "passed" : timedOut ? "timeout" : "failed",
        duration_ms: Date.now() - startedAt,
        exit_code: timedOut ? 124 : code,
        signal,
        ...(timedOut ? { reason: `deadline_exceeded:${options.timeoutMs}ms` } : {}),
        stdout_tail: stdout.trim(),
        stderr_tail: stderr.trim()
      });
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        id: gate.id,
        label: gate.label,
        command: renderCommand(gate),
        status: timedOut ? "timeout" : "failed",
        duration_ms: Date.now() - startedAt,
        exit_code: timedOut ? 1 : null,
        ...(timedOut ? { reason: `deadline_exceeded:${options.timeoutMs}ms` } : {}),
        error: error.message
      });
    });
  });
}

function renderCommand(gate) {
  if (gate.command === "internal") {
    return `internal:${gate.id}`;
  }
  return [gate.command === process.execPath ? "node" : gate.command, ...gate.args].join(" ");
}

function appendTail(current, chunk) {
  const next = current + chunk;
  return next.length > 6000 ? next.slice(next.length - 6000) : next;
}

function printSummary(summary) {
  console.log(`backend release readiness: ${summary.ok ? "pass" : "fail"}${summary.planned_only ? " (planned only)" : ""}`);
  for (const gate of summary.gates) {
    const suffix = gate.duration_ms ? ` (${gate.duration_ms}ms)` : "";
    console.log(`${gate.status === "passed" || gate.status === "planned" ? "ok" : gate.status}: ${gate.id}${suffix}`);
  }
  console.log("manual gates:");
  for (const gate of summary.manual_gates) {
    console.log(`- ${gate.id}: ${gate.command}`);
  }
  console.log("profiles:");
  for (const profile of summary.profiles) {
    const manual = profile.manual_gate_ids.length > 0 ? ` manual=${profile.manual_gate_ids.join(",")}` : "";
    console.log(`- ${profile.id}: ${profile.status}${manual}`);
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-backend-release-readiness.mjs [options]

Runs the non-destructive backend release-readiness gate:
  typecheck, full tests, i18n check, web build, doctor, gateway recovery probe,
  public naming scan, external backend dry probe, sandbox dry probe, and local host sandbox probe.

Options:
  --json                 Output machine-readable JSON.
  --list                 Print the gate plan without running commands.
  --skip-tests           Skip the full Vitest gate.
  --skip-web-build       Skip the web production build gate.
  --skip-external-probes Skip external channel readiness and backend dry status/probe.
  --skip-sandbox-probes  Skip sandbox capability and local host probe.
  --timeout-ms <ms>      Per-gate timeout. Default: 300000.
`);
}

function positiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function runPublicNamingScan() {
  const forbidden = [
    "Mulmo" + "Claude",
    "Hermes " + "Agent",
    "Open" + "Claw",
    "Mulmo" + "Script",
    "gui-chat-" + "protocol",
    "Claude Code " + "SDK"
  ];
  const targets = [
    "README.md",
    ".env.example",
    "package.json",
    "apps",
    "packages",
    "scripts",
    "web-front.md"
  ];
  const files = [];
  for (const target of targets) {
    files.push(...await listTextFiles(path.resolve(target)));
  }
  const violations = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const term of forbidden) {
      let offset = content.indexOf(term);
      while (offset !== -1) {
        const line = content.slice(0, offset).split(/\r?\n/).length;
        violations.push(`${path.relative(process.cwd(), file)}:${line}:${term}`);
        offset = content.indexOf(term, offset + term.length);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`PUBLIC_NAMING forbidden terms found:\n${violations.join("\n")}`);
  }
  return `checked_files=${files.length} forbidden_terms=${forbidden.length}`;
}

async function listTextFiles(target) {
  const info = await stat(target).catch(() => undefined);
  if (!info) {
    return [];
  }
  if (info.isFile()) {
    return shouldScanFile(target) ? [target] : [];
  }
  if (!info.isDirectory()) {
    return [];
  }
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".turbo" || entry.name.startsWith(".")) {
      continue;
    }
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTextFiles(child));
    } else if (entry.isFile() && shouldScanFile(child)) {
      files.push(child);
    }
  }
  return files;
}

function shouldScanFile(file) {
  return /\.(cjs|css|html|js|json|mjs|md|ts|tsx|vue|yaml|yml)$/.test(file);
}
