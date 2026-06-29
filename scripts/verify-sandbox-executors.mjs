#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDefaultGatewayBoundaryPolicy,
  createSandboxCommandAdapter,
  executeSandboxCommand,
  inspectSandboxExecutorCapabilities
} from "../packages/gateway/src/index.ts";

const rootDir = process.cwd();
const options = parseArgs(process.argv.slice(2));
const capabilities = inspectSandboxExecutorCapabilities({ timeoutMs: options.timeoutMs });
const selected = selectedBackends(options.backend);
const results = [];

for (const backend of selected) {
  results.push(await verifySandboxBackend(backend, options, capabilities));
}

const summary = {
  checked_at: new Date().toISOString(),
  run_requested: options.run,
  external_effects_confirmed: options.confirmExternalEffects,
  timeout_ms: options.timeoutMs,
  results
};

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printSummary(summary);
}

process.exitCode = exitCode(summary);

function parseArgs(args) {
  const options = {
    backend: process.env.SAMURAI_SANDBOX_E2E_BACKEND || "all",
    run: process.env.SAMURAI_SANDBOX_E2E_RUN === "true",
    confirmExternalEffects: process.env.SAMURAI_SANDBOX_E2E_CONFIRM_EXTERNAL_EFFECTS === "true",
    json: false,
    timeoutMs: positiveInt(process.env.SAMURAI_SANDBOX_E2E_TIMEOUT_MS) ?? 20_000,
    dockerImage: process.env.SAMURAI_SANDBOX_E2E_DOCKER_IMAGE,
    sshTarget: process.env.SAMURAI_SANDBOX_E2E_SSH_TARGET,
    remoteTarget: process.env.SAMURAI_SANDBOX_E2E_REMOTE_TARGET,
    remoteWorkspaceRoot: process.env.SAMURAI_SANDBOX_E2E_REMOTE_WORKSPACE_ROOT
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--run") {
      options.run = true;
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
    } else if (arg === "--docker-image") {
      options.dockerImage = args[++index] || options.dockerImage;
    } else if (arg.startsWith("--docker-image=")) {
      options.dockerImage = arg.slice("--docker-image=".length);
    } else if (arg === "--ssh-target") {
      options.sshTarget = args[++index] || options.sshTarget;
    } else if (arg.startsWith("--ssh-target=")) {
      options.sshTarget = arg.slice("--ssh-target=".length);
    } else if (arg === "--remote-target") {
      options.remoteTarget = args[++index] || options.remoteTarget;
    } else if (arg.startsWith("--remote-target=")) {
      options.remoteTarget = arg.slice("--remote-target=".length);
    } else if (arg === "--remote-workspace-root") {
      options.remoteWorkspaceRoot = args[++index] || options.remoteWorkspaceRoot;
    } else if (arg.startsWith("--remote-workspace-root=")) {
      options.remoteWorkspaceRoot = arg.slice("--remote-workspace-root=".length);
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
    return ["none", "docker", "ssh", "remote"];
  }
  const ids = normalized.split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (!["none", "docker", "ssh", "remote"].includes(id)) {
      throw new Error(`Unknown sandbox backend: ${id}`);
    }
  }
  return ids;
}

async function verifySandboxBackend(backend, options, capabilities) {
  const capability = capabilities.find((item) => item.backend === backend) ?? {
    backend,
    available: false,
    reason: "probe_failed",
    detail: "capability probe missing"
  };
  const result = {
    backend,
    capability,
    run: { status: "skipped", reason: options.run ? "run_not_started" : "run_not_requested" }
  };

  if (!options.run) {
    return result;
  }
  if (backend !== "none" && !options.confirmExternalEffects) {
    result.run = { status: "blocked", reason: "external_effects_confirmation_required" };
    return result;
  }
  if (!capability.available) {
    result.run = { status: "failed", reason: "executor_unavailable", error: capability.detail ?? capability.reason };
    return result;
  }
  const metadata = sandboxMetadata(backend, options);
  const missingTarget = requiredTargetReason(backend, metadata);
  if (missingTarget) {
    result.run = { status: "blocked", reason: missingTarget };
    return result;
  }

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "samurai-sandbox-e2e-"));
  try {
    const policy = createSandboxPolicy(backend, metadata, options.timeoutMs);
    const output = await executeSandboxCommand(policy, {
      command: "sh",
      args: ["-lc", "printf sandbox-ok"],
      timeout_ms: options.timeoutMs
    }, createSandboxCommandAdapter(), {
      workspaceRoot,
      env: process.env,
      fileRoot: rootDir
    });
    result.run = {
      status: output.status === "completed" ? "passed" : output.status,
      reason: output.reason,
      exit_code: output.exit_code,
      stdout: output.stdout,
      stderr: output.stderr,
      error: output.error
    };
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
  return result;
}

function sandboxMetadata(backend, options) {
  if (backend === "docker") {
    return Object.fromEntries(Object.entries({
      docker_image: options.dockerImage
    }).filter(([, value]) => Boolean(value)));
  }
  if (backend === "ssh") {
    return Object.fromEntries(Object.entries({
      ssh_target: options.sshTarget,
      remote_workspace_root: options.remoteWorkspaceRoot
    }).filter(([, value]) => Boolean(value)));
  }
  if (backend === "remote") {
    return Object.fromEntries(Object.entries({
      remote_target: options.remoteTarget,
      remote_workspace_root: options.remoteWorkspaceRoot
    }).filter(([, value]) => Boolean(value)));
  }
  return {};
}

function requiredTargetReason(backend, metadata) {
  if (backend === "ssh" && !metadata.ssh_target) {
    return "ssh_target_required";
  }
  if (backend === "remote" && !metadata.remote_target) {
    return "remote_target_required";
  }
  return "";
}

function createSandboxPolicy(backend, metadata, timeoutMs) {
  const policy = createDefaultGatewayBoundaryPolicy({
    source_channel: "local_cli",
    session_key: `sandbox-e2e:${backend}`,
    allowed_tools: ["sandbox.exec"],
    now: new Date().toISOString()
  });
  return {
    ...policy,
    sandbox: {
      ...policy.sandbox,
      mode: "all",
      backend,
      workspace_access: "read_write",
      network_access: backend === "none" ? "none" : "external",
      timeout_ms: timeoutMs,
      metadata
    }
  };
}

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function printSummary(summary) {
  console.log("Sandbox executor verification");
  console.log(`run=${summary.run_requested ? "yes" : "no"} external_effects_confirmed=${summary.external_effects_confirmed ? "yes" : "no"} timeout=${summary.timeout_ms}ms`);
  for (const result of summary.results) {
    console.log(`- ${result.backend}: available=${result.capability.available ? "yes" : "no"} reason=${result.capability.reason} run=${result.run.status}`);
    if (result.run.reason) {
      console.log(`  run reason: ${result.run.reason}`);
    }
    if (result.run.stdout) {
      console.log(`  stdout: ${result.run.stdout}`);
    }
  }
}

function printHelp() {
  console.log(`Usage: node scripts/verify-sandbox-executors.mjs [options]

Options:
  --backend none|docker|ssh|remote|all  Sandbox backend selection. Comma-separated values are allowed.
  --run                                 Execute the fixed sandbox probe command.
  --confirm-external-effects            Required with --run for docker/ssh/remote process/network effects.
  --timeout-ms <ms>                     Command timeout for probe/run.
  --docker-image <image>                Docker image for docker run. Default uses gateway adapter default.
  --ssh-target <target>                 SSH target for ssh backend.
  --remote-target <target>              SSH target for remote backend.
  --remote-workspace-root <path>        Remote workspace root for ssh/remote backend.
  --json                                Print machine-readable JSON.
`);
}

function exitCode(summary) {
  let code = 0;
  for (const result of summary.results) {
    if (summary.run_requested && result.run.status !== "passed") {
      code = 1;
    }
  }
  return code;
}
