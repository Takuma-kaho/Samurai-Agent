import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { getEventListeners } from "node:events";
import { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentBackendRegistry,
  buildExternalBackendPrompt,
  ClaudeCodeBackend,
  CodexBackend,
  parseClaudeCodeOutputEvents,
  parseClaudeCodeOutputLine,
  parseCodexOutputEvents,
  parseCodexOutputLine,
  externalBackendEnv,
  ExternalCliBackend,
  MockBackend,
  parseCliOutputEvents,
  parseCliOutputLine,
  resolveExternalCommandProbe,
  type BackendOutputEvent,
  type BackendRunInput
} from "./index";
import { safeChildEnvironment } from "./process-runner";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent backend registry", () => {
  it("does not inherit application secrets into external child environments", () => {
    const environment = safeChildEnvironment({
      PATH: "/usr/bin",
      SAMURAI_PHASE13_CANARY: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      HOME: "/tmp/samurai-home"
    });

    expect(environment).toMatchObject({ PATH: "/usr/bin" });
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("SAMURAI_PHASE13_CANARY");
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("does not pass host authentication capabilities even when explicitly requested", async () => {
    const environment = safeChildEnvironment({
      PATH: "/usr/bin",
      HOME: "/tmp/samurai-home",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      DOCKER_HOST: "unix:///var/run/docker.sock"
    });
    expect(environment).not.toHaveProperty("HOME");
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("DOCKER_HOST");
  });

  it("reports lifecycle support and connection state for registered backends", () => {
    const registry = new AgentBackendRegistry([
      new MockBackend(),
      new ExternalCliBackend({
        id: "codex-test",
        kind: "codex",
        label: "Codex Test"
      })
    ]);

    const statuses = registry.statuses();
    expect(statuses.find((status) => status.id === "mock")).toMatchObject({
      configured: true,
      enabled: true,
      connection_state: "ready",
      supports: {
        start_session: true,
        resume_run: false,
        cancel_run: false,
        stream_events: false
      }
    });
    expect(statuses.find((status) => status.id === "codex-test")).toMatchObject({
      configured: false,
      enabled: false,
      connection_state: "unconfigured",
      reason: "command_not_configured",
      active_run_count: 0,
      metadata: {
        command_probe: {
          configured: false,
          resolved: false,
          reason: "command_not_configured"
        }
      }
    });
    expect(new ClaudeCodeBackend().execution_owner).toBe("backend");
    expect(new CodexBackend().execution_owner).toBe("backend");
    expect(new ExternalCliBackend({ id: "external-test", kind: "external", label: "External Test" }).execution_owner).toBe("tool_bridge");
  });

  it("probes external CLI command availability without spawning it", async () => {
    const missing = new ExternalCliBackend({
      id: "missing-cli",
      kind: "external",
      label: "Missing CLI",
      command: "samurai-missing-cli-for-test"
    });
    const missingStatus = missing.getStatus();
    const missingEvents = await collectEvents(missing.runTurn(backendInput()));

    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-probe-"));
    roots.push(root);
    const executable = path.join(root, "backend-probe");
    await writeFile(executable, "#!/bin/sh\nprintf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'\nprintf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"ok\"}}\\n'\n", "utf8");
    await chmod(executable, 0o755);
    const directProbe = resolveExternalCommandProbe(executable);

    expect(missingStatus).toMatchObject({
      configured: true,
      enabled: false,
      connection_state: "degraded",
      reason: "command_not_found",
      metadata: {
        command_probe: {
          configured: true,
          command_name: "samurai-missing-cli-for-test",
          path_kind: "path_lookup",
          resolved: false,
          reason: "command_not_found"
        }
      }
    });
    expect(missingEvents).toContainEqual(expect.objectContaining({
      event_type: "run_failed",
      terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
      payload: expect.objectContaining({
        error_code: "backend_command_not_found",
        reason: "command_not_found",
        retryable: false,
        command_name: "samurai-missing-cli-for-test"
      })
    }));
    expect(directProbe).toMatchObject({
      configured: true,
      command_name: "backend-probe",
      path_kind: "direct_path",
      resolved: true
    });
  });

  it("does not start Mock or CLI work for an already-aborted signal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-already-aborted-"));
    roots.push(root);
    const executable = path.join(root, "must-not-run");
    const marker = path.join(root, "spawned");
    await writeFile(executable, `#!/bin/sh\nprintf spawned > "${marker}"\n`, "utf8");
    await chmod(executable, 0o755);
    const controller = new AbortController();
    controller.abort();
    const input = { ...backendInput("already-aborted"), abort_signal: controller.signal };

    const mockEvents = await collectEvents(new MockBackend().runTurn(input));
    const cli = new ExternalCliBackend({ id: "aborted-cli", kind: "external", label: "Aborted CLI", command: executable });
    const cliEvents = await collectEvents(cli.runTurn(input));

    expect(mockEvents).toHaveLength(1);
    expect(cliEvents).toHaveLength(1);
    expect(mockEvents[0]?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
    expect(cliEvents[0]?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
    await expect(access(marker)).rejects.toThrow();
    expect(cli.getStatus().active_run_count).toBe(0);
  });

  it("does not synthesize run_started before a provider start event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-abort-before-spawn-"));
    roots.push(root);
    const executable = path.join(root, "no-provider-start");
    const marker = path.join(root, "spawned");
    await writeFile(executable, `#!/bin/sh\nprintf spawned > "${marker}"\nexit 0\n`, "utf8");
    await chmod(executable, 0o755);
    const controller = new AbortController();
    const backend = new ExternalCliBackend({ id: "abort-before-spawn-cli", kind: "external", label: "Abort Before Spawn CLI", command: executable });
    const iterator = backend.runTurn({ ...backendInput("run-abort-before-spawn"), abort_signal: controller.signal })[Symbol.asyncIterator]();

    const first = await iterator.next();

    expect(first.value?.event_type).toBe("run_failed");
    expect(first.value?.terminal_evidence).toEqual({ kind: "failed", source: "process_exit", error: { code: "backend_terminal_missing", message: "Backend exited without a terminal event.", retryable: false, causeCategory: "process" } });
    expect((await iterator.next()).done).toBe(true);
    expect(await fileExists(marker)).toBe(true);
    controller.abort();
    expect(backend.getStatus().active_run_count).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("keeps task capabilities unverified until diagnostics supplies evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-capability-probe-"));
    roots.push(root);
    const executable = path.join(root, "backend-capability");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    const unverified = new ExternalCliBackend({
      id: "capability-unverified",
      kind: "external",
      label: "Capability Unverified",
      command: executable
    }).getStatus();
    const verified = new ExternalCliBackend({
      id: "capability-verified",
      kind: "codex",
      label: "Capability Verified",
      command: executable,
      capabilityProbeResults: [{
        capability_id: "web_search",
        state: "available",
        source: "backend_native",
        mode: "live",
        probe_version: "fixture-v1",
        evidence_summary: "Fixture emitted a normalized search source event."
      }]
    }).getStatus();

    expect(unverified.capabilities).toContainEqual(expect.objectContaining({
      capability_id: "web_search",
      state: "unverified",
      reason: "capability_not_probed"
    }));
    expect(verified.capabilities).toContainEqual(expect.objectContaining({
      backend_id: "capability-verified",
      capability_id: "web_search",
      state: "available",
      mode: "live",
      probe_version: "fixture-v1"
    }));
    expect(verified.capabilities).toContainEqual(expect.objectContaining({
      capability_id: "browser_screenshot",
      state: "unverified"
    }));
  });

  it("runs external CLI turns from the requested working directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-cwd-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    const workingDirectory = path.join(workspaceRoot, "project");
    await mkdir(workingDirectory, { recursive: true });
    const executable = path.join(root, "backend-cwd");
    await writeFile(executable, [
      "#!/bin/sh",
      "printf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'",
      "printf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"cwd:%s workspace:%s\"}}\\n' \"$PWD\" \"$SAMURAI_WORKSPACE_ROOT\""
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "cwd-backend",
      kind: "external",
      label: "CWD Backend",
      command: executable
    });

    const events = await collectEvents(backend.runTurn({
      ...backendInput("run_cwd"),
      workspace_root: workspaceRoot,
      working_directory: workingDirectory
    }));
    const realWorkingDirectory = await realpath(workingDirectory);

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "run_completed",
        payload: expect.objectContaining({
          output_summary: `cwd:${realWorkingDirectory} workspace:${workspaceRoot}`
        })
      })
    ]));
  });

  it("does not replay external CLI events from process memory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stream-"));
    roots.push(root);
    const executable = path.join(root, "backend-stream");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '{\"event_type\":\"run_started\",\"payload\":{\"backend_id\":\"stream-cli\",\"input_summary\":\"probe backend\"}}\\n'",
        "printf '{\"event_type\":\"text_delta\",\"payload\":{\"text\":\"hello\"},\"source_event_id\":\"provider-1\",\"source_sequence\":1}\\n'",
        "printf '{\"event_type\":\"tool_call_output\",\"tool_call_id\":\"tool_1\",\"payload\":{\"status\":\"ok\"},\"source_sequence\":1}\\n'",
        "printf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "stream-cli",
      kind: "external",
      label: "Stream CLI",
      command: executable
    });
    const status = backend.getStatus();
    const runEvents = await collectEvents(backend.runTurn(backendInput("run_stream")));

    expect(status.supports).toMatchObject({
      start_session: false,
      resume_run: false,
      cancel_run: true,
      stream_events: false
    });
    expect(runEvents.map((event) => event.event_type)).toEqual([
      "run_started",
      "text_delta",
      "tool_call_output",
      "run_completed"
    ]);
    expect(runEvents[0]?.payload).toMatchObject({
      backend_id: "stream-cli",
      input_summary: "probe backend"
    });
    expect(runEvents[0]?.payload).not.toHaveProperty("locale_contract");
    expect(runEvents.map((event) => event.source_sequence)).toEqual([undefined, 1, 1, undefined]);
    expect(runEvents[1]?.source_event_id).toBe("provider-1");
    expect(runEvents[2]?.source_event_id).toBeUndefined();
    expect(runEvents[0]?.source_event_id).toBeUndefined();
    expect(runEvents[3]?.source_event_id).toBeUndefined();
    expect(backend.streamEvents).toBeUndefined();
    expect((backend as unknown as { eventStreams?: unknown }).eventStreams).toBeUndefined();
  });

  it("does not retain replay or generated Session state after a run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-bounded-stream-"));
    roots.push(root);
    const executable = path.join(root, "bounded-stream-backend");
    await writeFile(executable, "#!/bin/sh\ncat >/dev/null\nprintf '{\"event_type\":\"run_started\",\"backend_session_id\":\"bounded-session\",\"payload\":{}}\\n'\nprintf '{\"event_type\":\"run_completed\",\"backend_session_id\":\"bounded-session\",\"payload\":{\"output_summary\":\"done\"}}\\n'\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "bounded-stream-cli",
      kind: "external",
      label: "Bounded Stream CLI",
      command: executable
    });
    await collectEvents(backend.runTurn(backendInput("bounded-run-0")));

    expect(backend.streamEvents).toBeUndefined();
    expect((backend as unknown as { eventStreams?: unknown }).eventStreams).toBeUndefined();
    expect((backend as unknown as { backendSessionIds?: unknown }).backendSessionIds).toBeUndefined();
  });

  it("does not expose an in-memory active event stream registry", () => {
    const backend = new ExternalCliBackend({ id: "active-stream-cli", kind: "external", label: "Active Stream CLI" });
    expect(backend.streamEvents).toBeUndefined();
    expect((backend as unknown as { eventStreams?: unknown }).eventStreams).toBeUndefined();
  });

  it("does not invent source identity after a process restart", async () => {
    const original = new ExternalCliBackend({
      id: "restart-identity-cli",
      kind: "external",
      label: "Restart Identity CLI",
      command: "samurai-missing-cli-for-restart-identity-test",
    });
    const restarted = new ExternalCliBackend({
      id: "restart-identity-cli",
      kind: "external",
      label: "Restart Identity CLI",
    });

    const beforeRestart = await collectEvents(original.runTurn(backendInput("restart-run")));
    expect(beforeRestart[0]?.source_event_id).toBeUndefined();
    expect(restarted.streamEvents).toBeUndefined();
    expect((restarted as unknown as { backendSessionIds?: unknown }).backendSessionIds).toBeUndefined();
  });

  it("keeps stderr as diagnostics and never turns it into progress Events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stderr-progress-"));
    roots.push(root);
    const executable = path.join(root, "backend-stderr-progress");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf 'Searching project files\\n' >&2",
        "printf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'",
        "printf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "stderr-progress-cli",
      kind: "external",
      label: "Stderr Progress CLI",
      command: executable
    });

    const events = await collectEvents(backend.runTurn(backendInput("run_stderr_progress")));

    expect(events.some((event) => event.event_type === "host_progress")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("Searching project files");
  });

  it("does not generate timer-based progress while an external backend is silent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-silent-"));
    roots.push(root);
    const executable = path.join(root, "backend-silent");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "sleep 3",
        "printf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'",
        "printf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "silent-cli",
      kind: "external",
      label: "Silent CLI",
      command: executable
    });

    const events = await collectEvents(backend.runTurn(backendInput("run_silent")));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "run_completed"]);
    expect(events.some((event) => event.event_type === "host_progress")).toBe(false);
    expect(events.at(-1)?.event_type).toBe("run_completed");
  });

  it("reports an available CLI as unverified without a stream compatibility probe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stream-probe-"));
    roots.push(root);
    const executable = path.join(root, "backend-stream-probe");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--stream-probe\" ]; then",
      "  printf '{\"event_type\":\"text_delta\",\"payload\":{\"text\":\"probe-ok\"}}\\n'",
        "  exit 0",
        "fi",
        "printf 'human version output\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "probe-cli",
      kind: "external",
      label: "Probe CLI",
      command: executable,
    });

    const status = backend.getStatus();

    expect(status).toMatchObject({
      connection_state: "unverified",
      supports: { stream_events: false }
    });
    expect(status.metadata).not.toHaveProperty("stream_probe");
  });

  it("maps CLI JSON lines to canonical backend events", () => {
    expect(parseCliOutputLine(JSON.stringify({ event_type: "text_delta", payload: { text: "hello" } }))).toEqual({
      event_type: "text_delta",
      payload: { text: "hello" }
    });
    expect(parseCliOutputLine(JSON.stringify({ event_type: "tool_call_output", tool_call_id: "tool_1", payload: { status: "ok" } }))).toEqual({
      event_type: "tool_call_output",
      payload: { status: "ok", tool_call_id: "tool_1" },
      tool_call_id: "tool_1"
    });
    expect(parseCliOutputLine(JSON.stringify({ event_type: "backend_native_input_submitted", payload: { submitted_at: "2026-01-01T00:00:00.000Z", has_input: true } }))).toEqual({
      event_type: "backend_native_input_submitted",
      payload: { submitted_at: "2026-01-01T00:00:00.000Z", has_input: true }
    });
    expect(parseCliOutputLine(JSON.stringify({ event_type: "run_completed", backend_session_id: "native-session-1", payload: { output_summary: "done" } }))).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      backend_session_id: "native-session-1",
      payload: {
        output_summary: "done"
      }
    });
    expect(parseCliOutputLine("plain text")).toMatchObject({
      event_type: "backend_protocol_diagnostic",
      payload: { reason: "invalid_json" }
    });
  });

  it("converts provider failures into stable terminal evidence", () => {
    expect(parseCliOutputLine(JSON.stringify({ event_type: "run_failed", payload: { error_code: "provider_denied", message: "denied", reason: "provider_denied", retryable: false } }))).toMatchObject({
      event_type: "run_failed",
      terminal_evidence: { kind: "failed", source: "provider_terminal_response", error: { code: "provider_denied", message: "denied", retryable: false, causeCategory: "provider" } },
      payload: {
        error_code: "provider_denied",
        message: "denied",
        reason: "provider_denied",
        retryable: false
      }
    });
  });

  it("distinguishes bare process exits from provider terminal responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-exit-evidence-"));
    roots.push(root);
    const completedCommand = path.join(root, "completed");
    const failedCommand = path.join(root, "failed");
    await writeFile(completedCommand, "#!/bin/sh\nexit 0\n", "utf8");
    await writeFile(failedCommand, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(completedCommand, 0o755);
    await chmod(failedCommand, 0o755);
    const completed = await collectEvents(new ExternalCliBackend({ id: "exit-ok", kind: "external", label: "Exit OK", command: completedCommand }).runTurn(backendInput("run-exit-ok")));
    const failed = await collectEvents(new ExternalCliBackend({ id: "exit-failed", kind: "external", label: "Exit Failed", command: failedCommand }).runTurn(backendInput("run-exit-failed")));
    expect(completed.at(-1)?.terminal_evidence).toEqual({ kind: "failed", source: "process_exit", error: { code: "backend_terminal_missing", message: "Backend exited without a terminal event.", retryable: false, causeCategory: "process" } });
    expect(failed.at(-1)?.terminal_evidence).toEqual({ kind: "failed", source: "process_exit", error: { code: "backend_failed", message: "Exit Failed failed.", retryable: false, causeCategory: "process" } });
  });

  it("uses not_started only when the child never obtains a process id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-spawn-failure-"));
    roots.push(root);
    const executable = path.join(root, "missing-interpreter");
    await writeFile(executable, "#!/samurai/missing/interpreter\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "spawn-failure-cli", kind: "external", label: "Spawn Failure CLI", command: executable });

    const events = await collectEvents(backend.runTurn(backendInput("run-spawn-failure")));

    expect(events.at(-1)).toMatchObject({
      terminal_evidence: { kind: "not_started", source: "preflight_rejection" },
      payload: { error_code: "backend_spawn_failed", reason: "spawn_failed" }
    });
    await waitFor(() => backend.getStatus().active_run_count === 0);
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("keeps a post-spawn child error diagnostic and lets close decide the terminal", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-post-spawn-error-"));
    roots.push(root);
    const executable = path.join(root, "post-spawn-error");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'run_completed', payload: { output_summary: 'done' } }) + '\\n');\nsetTimeout(() => process.exit(0), 100);\n", "utf8");
    await chmod(executable, 0o755);
    const prototype = ChildProcess.prototype as unknown as { emit(event: string | symbol, ...args: unknown[]): boolean };
    const originalEmit = prototype.emit;
    let injected = false;
    const emitSpy = vi.spyOn(prototype, "emit").mockImplementation(function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
      const emitted = originalEmit.call(this, event, ...args);
      if (!injected && event === "spawn" && this.pid !== undefined) {
        injected = true;
        queueMicrotask(() => originalEmit.call(this, "error", new Error("Bearer child-secret failed at /Users/person/private/socket")));
      }
      return emitted;
    });
    try {
      const backend = new ExternalCliBackend({ id: "post-spawn-error-cli", kind: "external", label: "Post Spawn Error CLI", command: executable });

      const events = await collectEvents(backend.runTurn(backendInput("run-post-spawn-error")));
      const terminal = events.at(-1);
      const diagnostic = String(terminal?.payload.process_error_summary ?? "");

      expect(injected).toBe(true);
      expect(terminal?.terminal_evidence).toEqual({ kind: "completed", source: "provider_terminal_response" });
      expect(events.some((event) => event.terminal_evidence?.kind === "not_started")).toBe(false);
      expect(diagnostic).toContain("[redacted]");
      expect(diagnostic).toContain("[path]");
      expect(diagnostic).not.toContain("child-secret");
      expect(diagnostic).not.toContain("/Users/person");
      expect(backend.getStatus().active_run_count).toBe(0);
    } finally {
      emitSpy.mockRestore();
    }
  });

  it("redacts secrets and absolute paths from process diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-safe-diagnostic-"));
    roots.push(root);
    const executable = path.join(root, "safe-diagnostic");
    await writeFile(executable, "#!/bin/sh\nprintf 'Bearer secret-token api_key=supersecret token=plain-secret /workspace/file /mnt/data /usr/bin/tool /Library/App https://example.test/api\\n' >&2\nexit 7\n", "utf8");
    await chmod(executable, 0o755);
    const events = await collectEvents(new ExternalCliBackend({ id: "safe-diagnostic-cli", kind: "external", label: "Safe Diagnostic CLI", command: executable }).runTurn(backendInput("run-safe-diagnostic")));
    const summary = String(events.at(-1)?.payload.stderr_summary ?? "");

    expect(summary).toContain("[redacted]");
    expect(summary).toContain("[path]");
    expect(summary).not.toContain("secret-token");
    expect(summary).not.toContain("supersecret");
    expect(summary).not.toContain("plain-secret");
    expect(summary).not.toContain("/workspace");
    expect(summary).not.toContain("/mnt/data");
    expect(summary).not.toContain("/usr/bin");
    expect(summary).not.toContain("/Library/App");
    expect(summary).toContain("https://example.test/api");
  });

  it("keeps cancellation as requested until process exit confirms cancellation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-cancel-evidence-"));
    roots.push(root);
    const executable = path.join(root, "long-running");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.kill(process.pid, 'SIGKILL'));\nprocess.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');\nsetInterval(() => {}, 1000);\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "cancel-cli", kind: "external", label: "Cancel CLI", command: executable });
    const iterator = backend.runTurn(backendInput("run-cancel"))[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
    }
    expect(ready).toBe(true);
    await expect(backend.cancelRun?.("run-cancel")).resolves.toEqual({ kind: "requested" });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "cancelled", source: "process_exit" });
    expect(events.at(-1)?.payload.signal).toBe("SIGKILL");
  });

  it("propagates an in-flight AbortSignal to the owned child and waits for close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-abort-running-"));
    roots.push(root);
    const executable = path.join(root, "abort-running");
    const stopped = path.join(root, "stopped");
    const pidFile = path.join(root, "pid");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const [stopped, pidFile] = process.argv.slice(2);",
      "fs.writeFileSync(pidFile, String(process.pid));",
      "process.on('SIGTERM', () => { fs.writeFileSync(stopped, 'stopped'); process.exit(143); });",
      "process.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const controller = new AbortController();
    const backend = new ExternalCliBackend({ id: "abort-running-cli", kind: "external", label: "Abort Running CLI", command: executable, args: [stopped, pidFile] });
    const iterator = backend.runTurn({ ...backendInput("run-abort-running"), abort_signal: controller.signal })[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    try {
      let ready = false;
      while (!ready) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
      }
      expect(ready).toBe(true);
      expect(backend.getStatus().active_run_count).toBe(1);

      controller.abort();
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }

      expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "cancelled", source: "process_exit" });
      expect(await fileExists(stopped)).toBe(true);
      expect(backend.getStatus().active_run_count).toBe(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      await cleanupCliFixture(backend, iterator, pidFile);
    }
  });

  it("marks a bare natural exit 0 as cancelled when cancel stops the child", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-cancel-natural-close-"));
    roots.push(root);
    const executable = path.join(root, "cancel-then-complete");
    const signalMarker = path.join(root, "sigterm-received");
    const release = path.join(root, "release");
    const pidFile = path.join(root, "pid");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const [signalMarker, release, pidFile] = process.argv.slice(2);",
      "fs.writeFileSync(pidFile, String(process.pid));",
      "process.on('SIGTERM', () => { fs.writeFileSync(signalMarker, 'requested'); });",
      "process.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');",
      "const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); } }, 5);"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "cancel-natural-close-cli", kind: "external", label: "Cancel Natural Close CLI", command: executable, args: [signalMarker, release, pidFile] });
    const iterator = backend.runTurn(backendInput("run-cancel-natural-close"))[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    try {
      let ready = false;
      while (!ready) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
      }
      expect(ready).toBe(true);
      await expect(backend.cancelRun?.("run-cancel-natural-close")).resolves.toEqual({ kind: "requested" });
      await waitFor(() => fileExists(signalMarker));
      await writeFile(release, "release", "utf8");
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        events.push(next.value);
      }

      expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "cancelled", source: "process_exit" });
      expect(events.filter((event) => event.terminal_evidence)).toHaveLength(1);
      expect(backend.getStatus().active_run_count).toBe(0);
    } finally {
      await cleanupCliFixture(backend, iterator, pidFile, release);
    }
  });

  it("holds provider terminal evidence until the owned child has closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-terminal-close-"));
    roots.push(root);
    const executable = path.join(root, "terminal-then-linger");
    const marker = path.join(root, "terminal-written");
    const release = path.join(root, "release");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const marker = process.argv[2];",
      "const release = process.argv[3];",
      "process.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'run_completed', payload: { output_summary: 'done' } }) + '\\n');",
      "fs.writeFileSync(marker, 'terminal');",
      "const timer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(timer); process.exit(0); } }, 5);"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "terminal-close-cli", kind: "external", label: "Terminal Close CLI", command: executable, args: [marker, release] });
    const iterator = backend.runTurn(backendInput("run-terminal-close"))[Symbol.asyncIterator]();
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
    }
    await waitFor(() => fileExists(marker));
    expect(backend.getStatus().active_run_count).toBe(1);
    let terminalDelivered = false;
    const terminalPromise = iterator.next().then((next) => { terminalDelivered = true; return next; });
    await Promise.resolve();
    expect(terminalDelivered).toBe(false);

    await writeFile(release, "release", "utf8");
    const terminal = await terminalPromise;
    expect(terminal.value?.terminal_evidence).toEqual({ kind: "completed", source: "provider_terminal_response" });
    expect((await iterator.next()).done).toBe(true);
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("cleans an early-returned consumer without treating SIGTERM as terminal evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-early-return-"));
    roots.push(root);
    const executable = path.join(root, "early-return");
    const marker = path.join(root, "sigterm-received");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const marker = process.argv[2];",
      "process.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');",
      "process.on('SIGTERM', () => { fs.writeFileSync(marker, 'stopped'); process.exit(143); });",
      "setInterval(() => {}, 1000);"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "early-return-cli", kind: "external", label: "Early Return CLI", command: executable, args: [marker] });
    const iterator = backend.runTurn(backendInput("run-early-return"))[Symbol.asyncIterator]();
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
    }
    expect(backend.getStatus().active_run_count).toBe(1);
    await iterator.return?.();
    await waitFor(() => fileExists(marker));
    // The runner may need its SIGTERM grace window before the child close
    // event releases the active-run record on a contended CI worker.
    await waitFor(() => backend.getStatus().active_run_count === 0, 3_500);
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("force-stops an early-returned child that ignores SIGTERM after the grace period", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-early-return-drain-"));
    roots.push(root);
    const executable = path.join(root, "early-return-drain");
    const release = path.join(root, "release");
    const pidFile = path.join(root, "pid");
    const drainedAfterSignal = path.join(root, "drained-after-signal");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const [release, pidFile, drainedAfterSignal] = process.argv.slice(2);",
      "fs.writeFileSync(pidFile, String(process.pid));",
      "let signalled = false;",
      "process.on('SIGTERM', () => { signalled = true; });",
      "const releaseTimer = setInterval(() => { if (fs.existsSync(release)) { clearInterval(releaseTimer); process.exit(0); } }, 5);",
      "process.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');",
      "process.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');",
      "const chunk = Buffer.alloc(65536);",
      "const pump = () => {",
      "  if (fs.existsSync(release)) return;",
      "  if (process.stdout.write(chunk)) { setImmediate(pump); return; }",
      "  process.stdout.once('drain', () => {",
      "    if (signalled) fs.writeFileSync(drainedAfterSignal, 'drained');",
      "    setImmediate(pump);",
      "  });",
      "};",
      "pump();"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "early-return-drain-cli", kind: "external", label: "Early Return Drain CLI", command: executable, args: [release, pidFile, drainedAfterSignal] });
    const iterator = backend.runTurn(backendInput("run-early-return-drain"))[Symbol.asyncIterator]();
    let returned = false;
    try {
      let ready = false;
      while (!ready) {
        const next = await iterator.next();
        if (next.done) break;
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
      }

      await iterator.return?.();
      returned = true;
      expect(backend.getStatus().active_run_count).toBe(1);
      await waitFor(() => fileExists(drainedAfterSignal));
      await waitFor(() => backend.getStatus().active_run_count === 0, 3_500);
      expect(backend.getStatus().active_run_count).toBe(0);
    } finally {
      await writeFile(release, "release", "utf8").catch(() => undefined);
      if (!returned) await iterator.return?.().catch(() => undefined);
      try {
        await waitFor(() => backend.getStatus().active_run_count === 0);
      } catch {
        const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
        await waitFor(() => backend.getStatus().active_run_count === 0);
      }
    }
  });

  it("does not lose a confirmed provider completion when cancel races close", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-cancel-race-"));
    roots.push(root);
    const executable = path.join(root, "completed-then-close");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ event_type: 'run_started', payload: {} }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'text_delta', payload: { text: 'READY' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'run_completed', payload: { output_summary: 'done' } }) + '\\n');\nprocess.stdout.write(JSON.stringify({ event_type: 'run_failed', payload: { error_code: 'late_error', message: 'late provider failure', reason: 'late_provider_failure', retryable: false } }) + '\\n');\nprocess.on('SIGTERM', () => process.exit(143));\nsetInterval(() => {}, 1000);\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "cancel-race-cli", kind: "external", label: "Cancel Race CLI", command: executable });
    const iterator = backend.runTurn(backendInput("run-cancel-race"))[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY";
    }
    expect(ready).toBe(true);
    expect(events.some((event) => event.terminal_evidence)).toBe(false);
    await expect(backend.cancelRun?.("run-cancel-race")).resolves.toEqual({ kind: "requested" });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.filter((event) => event.terminal_evidence).map((event) => event.terminal_evidence)).toEqual([{ kind: "completed", source: "provider_terminal_response" }]);
    expect(events.filter((event) => event.event_type === "run_completed" || event.event_type === "run_failed")).toHaveLength(1);
  });

  it("keeps the first typed provider completion when process close is later nonzero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-terminal-conflict-"));
    roots.push(root);
    const executable = path.join(root, "completed-then-nonzero");
    await writeFile(executable, "#!/bin/sh\nprintf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'\nprintf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"done\"}}\\n'\nexit 9\n", "utf8");
    await chmod(executable, 0o755);

    const backend = new ExternalCliBackend({ id: "terminal-conflict-cli", kind: "external", label: "Terminal Conflict CLI", command: executable });
    const events = await collectEvents(backend.runTurn(backendInput("run-terminal-conflict")));

    expect(events.filter((event) => event.terminal_evidence)).toHaveLength(1);
    expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "failed", source: "process_exit", error: { code: "backend_failed", message: "Terminal Conflict CLI failed.", retryable: false, causeCategory: "process" } });
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("does not expose a replay API when runtime stream state is unavailable", async () => {
    const backend = new ExternalCliBackend({ id: "missing-stream", kind: "external", label: "Missing Stream", command: process.execPath });
    expect(backend.streamEvents).toBeUndefined();
    expect(backend.getStatus().supports.stream_events).toBe(false);
  });

  it("maps Claude-style stream JSON content blocks to canonical backend events", () => {
    const events = parseClaudeCodeOutputEvents(JSON.stringify({
      type: "assistant",
      session_id: "claude-session-1",
      source_event_id: "claude-raw-1",
      source_sequence: 9,
      message: {
        content: [
          { type: "text", text: "調査しました" },
          { type: "tool_use", id: "tool_1", name: "mcp__docs__search", input: { q: "samurai" } }
        ]
      }
    }));
    const result = parseClaudeCodeOutputLine(JSON.stringify({
      type: "result",
      session_id: "claude-session-1",
      source_event_id: "claude-result-1",
      source_sequence: 10,
      result: "done",
      is_error: false
    }));

    expect(events).toEqual([
      {
        event_type: "text_delta",
        source_event_id: "claude-raw-1:part:1",
        source_sequence: 9,
        backend_session_id: "claude-session-1",
        payload: {
          provider_event_type: "assistant",
          text: "調査しました"
        }
      },
      {
        event_type: "tool_call_started",
        source_event_id: "claude-raw-1:part:2",
        source_sequence: 9,
        tool_call_id: "tool_1",
        backend_session_id: "claude-session-1",
        payload: {
          provider_event_type: "assistant",
          tool_call_id: "tool_1",
          provider_tool_name: "mcp__docs__search",
          input: { q: "samurai" },
          action_id: "mcp.call",
          server_name: "docs",
          tool_name: "search"
        }
      }
    ]);
    expect(result).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      source_event_id: "claude-result-1",
      source_sequence: 10,
      backend_session_id: "claude-session-1",
      payload: {
        provider_event_type: "result",
        output_summary: "done"
      }
    });
  });

  it("accepts only positive safe provider sequences without inventing identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-invalid-sequence-"));
    roots.push(root);
    const executable = path.join(root, "invalid-sequence");
    await writeFile(executable, [
      "#!/bin/sh",
      "printf '{\"event_type\":\"text_delta\",\"payload\":{\"text\":\"hello\"},\"source_sequence\":0}\\n'",
      "printf '{\"event_type\":\"run_started\",\"payload\":{}}\\n'",
      "printf '{\"event_type\":\"run_completed\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "invalid-sequence-cli", kind: "external", label: "Invalid Sequence CLI", command: executable });

    const events = await collectEvents(backend.runTurn(backendInput("run-invalid-sequence")));
    const text = events.find((event) => event.event_type === "text_delta");

    expect(text?.source_sequence).toBeUndefined();
    expect(text?.source_event_id).toBeUndefined();
    expect(parseCliOutputLine(JSON.stringify({ event_type: "text_delta", payload: { text: "bad" }, source_sequence: Number.MAX_SAFE_INTEGER + 1 }) )?.source_sequence).toBeUndefined();
  });

  it("normalizes delegated search and subagent tool metadata", () => {
    const claude = parseClaudeCodeOutputEvents(JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "tool_use", id: "search_1", name: "WebSearch", input: { query: "Samurai", source: "https://example.test/source" } },
        { type: "tool_use", id: "agent_1", name: "Agent", input: { description: "Inspect tests" } }
      ] }
    }));
    const codex = parseCodexOutputEvents(JSON.stringify({
      type: "item.completed",
      item: { type: "web_search", id: "search_2", mode: "live", sources: [{ url: "https://example.test/result" }] }
    }));

    expect(claude[0]).toMatchObject({ event_type: "tool_call_started", payload: { capability_id: "web_search", source_urls: ["https://example.test/source"] } });
    expect(claude[1]).toMatchObject({ event_type: "tool_call_started", payload: { capability_id: "subagent_delegate", child_task_summary: "Inspect tests", parent_relation: "backend_internal" } });
    expect(codex[0]).toMatchObject({ event_type: "tool_call_output", payload: { capability_id: "web_search", search_mode: "live", source_urls: ["https://example.test/result"] } });
  });

  it("runs configured Claude-style native resume commands with backend session ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-resume-"));
    roots.push(root);
    const executable = path.join(root, "backend-resume");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"%s\"}\\n' \"$2\"",
        "printf '{\"type\":\"assistant\",\"session_id\":\"%s\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"resumed\"}]}}\\n' \"$2\"",
        "printf '{\"type\":\"result\",\"session_id\":\"%s\",\"result\":\"resume ok\"}\\n' \"$2\""
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ClaudeCodeBackend({
      command: executable,
      resumeArgs: ["--resume", "{backend_session_id}"]
    });

    const events = await collectEvents(backend.resumeRun("run_resume", { backend_session_id: "claude-session-2", answer: "続けて" }));

    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_completed"]);
    expect(events[0]).toMatchObject({ event_type: "run_started", backend_session_id: "claude-session-2" });
    expect(events[1]).toMatchObject({ backend_session_id: "claude-session-2", payload: { text: "resumed" } });
    expect(events[2]).toMatchObject({ backend_session_id: "claude-session-2", payload: { output_summary: "resume ok" } });
  });

  it("reports missing native resume sessions as confirmed preflight rejection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-resume-missing-"));
    roots.push(root);
    const executable = path.join(root, "backend-resume-missing");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ClaudeCodeBackend({ command: executable, resumeArgs: ["--resume", "{backend_session_id}"] });
    const events = await collectEvents(backend.resumeRun("run_resume_missing"));
    expect(events).toContainEqual(expect.objectContaining({
      event_type: "run_failed",
      terminal_evidence: { kind: "not_started", source: "preflight_rejection" }
    }));
  });

  it("maps Codex-style JSONL stream events to canonical backend events", () => {
    const started = parseCodexOutputLine(JSON.stringify({
      type: "thread.started",
      thread_id: "codex-thread-1"
    }));
    const assistant = parseCodexOutputEvents(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: {
        id: "msg_1",
        type: "agent_message",
        text: "調べました"
      }
    }));
    const commandStart = parseCodexOutputLine(JSON.stringify({
      type: "item.started",
      thread_id: "codex-thread-1",
      item: { id: "call_1", type: "command_execution", command: "pnpm test" }
    }));
    const commandEnd = parseCodexOutputLine(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: { id: "call_1", type: "command_execution", status: "completed", exit_code: 0, aggregated_output: "ok" }
    }));
    const completed = parseCodexOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-1",
      output_summary: "done"
    }));
    const reasoning = parseCodexOutputEvents(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: "差分の原因を確認しました"
      }
    }));
    const emptyReasoning = parseCodexOutputEvents(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: {
        id: "rs_empty",
        type: "reasoning",
        summary: []
      }
    }));

    expect(started).toEqual({
      event_type: "run_started",
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "thread.started",
        provider_thread_id: "codex-thread-1"
      }
    });
    expect(assistant).toEqual([{
      event_type: "text_delta",
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "item.completed",
        item_type: "agent_message",
        text: "調べました"
      }
    }]);
    expect(commandStart).toEqual({
      event_type: "tool_call_started",
      tool_call_id: "call_1",
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "item.started",
        provider_tool_name: "command_execution",
        tool_call_id: "call_1",
        input: "pnpm test"
      }
    });
    expect(commandEnd).toEqual({
      event_type: "tool_call_output",
      tool_call_id: "call_1",
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "item.completed",
        provider_tool_name: "command_execution",
        tool_call_id: "call_1",
        status: "completed",
        exit_code: 0,
        output: "ok"
      }
    });
    expect(completed).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "turn.completed",
        output_summary: "done"
      }
    });
    expect(reasoning).toEqual([{
      event_type: "agent_reasoning",
      backend_session_id: "codex-thread-1",
      payload: {
        provider_event_type: "item.completed",
        item_type: "reasoning",
        text: "差分の原因を確認しました"
      }
    }]);
    expect(emptyReasoning).toEqual([]);
  });

  it("does not turn Codex completion-only events into assistant text", () => {
    expect(parseCodexOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-empty"
    }), "codex")).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      backend_session_id: "codex-thread-empty",
      payload: {
        provider_event_type: "turn.completed"
      }
    });
    expect(parseCodexOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-empty",
      output_summary: "Codex completed."
    }), "codex")).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      backend_session_id: "codex-thread-empty",
      payload: {
        provider_event_type: "turn.completed",
        output_summary: "Codex completed."
      }
    });
  });

  it("parses current Codex assistant output item types as text", () => {
    const direct = parseCodexOutputLine(JSON.stringify({
      type: "output_message",
      thread_id: "codex-thread-output",
      content: [{ type: "output_text", text: "本文です" }]
    }));
    const item = parseCodexOutputLine(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-output",
      item: {
        id: "msg-output",
        type: "agent_message",
        text: "続きの本文です"
      }
    }));

    expect(direct).toMatchObject({
      event_type: "backend_protocol_diagnostic",
      payload: { reason: "unknown_event", raw_type: "output_message" }
    });
    expect(item).toEqual({
      event_type: "text_delta",
      backend_session_id: "codex-thread-output",
      payload: {
        provider_event_type: "item.completed",
        item_type: "agent_message",
        text: "続きの本文です"
      }
    });
  });

  it("runs Codex native resume commands with saved thread ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-resume-"));
    roots.push(root);
    const executable = path.join(root, "codex-fixture");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '{\"type\":\"thread.started\",\"thread_id\":\"%s\"}\\n' \"$3\"",
        "printf '{\"type\":\"item.completed\",\"thread_id\":\"%s\",\"item\":{\"id\":\"msg-resume\",\"type\":\"agent_message\",\"text\":\"resumed codex\"}}\\n' \"$3\"",
        "printf '{\"type\":\"turn.completed\",\"thread_id\":\"%s\",\"output_summary\":\"resume ok\"}\\n' \"$3\""
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({
      command: executable
    });
    const status = backend.getStatus();

    const events = await collectEvents(backend.resumeRun("run_codex_resume", { backend_session_id: "codex-thread-2", answer: "続けて" }));

    expect(status).toMatchObject({
      supports: {
        resume_run: true
      },
      metadata: {
        args_count: 5
      }
    });
    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_completed"]);
    expect(events[0]?.payload).toMatchObject({
      provider_event_type: "thread.started"
    });
    expect(events[0]?.backend_session_id).toBe("codex-thread-2");
    expect(events[1]?.payload).toMatchObject({
      text: "resumed codex"
    });
    expect(events[1]?.backend_session_id).toBe("codex-thread-2");
    expect(events[2]?.payload).toMatchObject({
      output_summary: "resume ok"
    });
    expect(events[2]?.backend_session_id).toBe("codex-thread-2");
  });

  it("normalizes legacy Codex exec args to keep JSON streaming enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-args-"));
    roots.push(root);
    const executable = path.join(root, "codex-argv");
    const argvFile = path.join(root, "argv.txt");
    const quotedArgvFile = argvFile.replaceAll("'", "'\\''");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" > '${quotedArgvFile}'`,
        "printf '{\"type\":\"thread.started\",\"thread_id\":\"codex-fixture\"}\\n'",
        "printf '{\"type\":\"turn.completed\",\"thread_id\":\"codex-fixture\",\"output_summary\":\"done\"}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({
      command: executable,
      args: ["exec", "-"]
    });

    await collectEvents(backend.runTurn(backendInput("run_codex_args")));
    const argsText = await readFile(argvFile, "utf8");
    expect(argsText).toContain("exec --json --output-last-message");
  });

  it("passes the Samurai Workspace root to Codex with -C instead of skip-git-repo-check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-cd-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const executable = path.join(root, "codex-argv-cd");
    const argvFile = path.join(root, "argv.txt");
    const quotedArgvFile = argvFile.replaceAll("'", "'\\''");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" > '${quotedArgvFile}'`,
        "printf '{\"type\":\"thread.started\",\"thread_id\":\"codex-fixture\"}\\n'",
        "printf '{\"type\":\"turn.completed\",\"thread_id\":\"codex-fixture\",\"output_summary\":\"done\"}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({
      command: executable,
      args: ["exec", "--json", "-"]
    });

    await collectEvents(backend.runTurn({
      ...backendInput("run_codex_cd"),
      workspace_root: workspaceRoot,
      working_directory: workspaceRoot
    }));
    const argsText = await readFile(argvFile, "utf8");

    expect(argsText).toContain(`-C ${workspaceRoot}`);
    expect(argsText).not.toContain("--skip-git-repo-check");
  });

  it("passes locale and workspace context to external backend commands", () => {
    const input: BackendRunInput = {
      run_id: "run_1",
      session_id: "session_1",
      room_id: "room_1",
      agent_context: {
        id: "agent_1",
        name: "Research Agent",
        role: "Research",
        instructions: "Inspect evidence and report the result.",
        authority: "supporting_context"
      },
      backend_session_key: "room_1:session_1:agent_1:codex",
      input_message_id: "message_1",
      envelope: {
        id: "message_1",
        source: "web",
        actor_identity: "owner",
        session_key: "web:owner:test",
        user_intent: "月次レポートを書いて",
        input_locale: "ja",
        output_locale: "ja",
        attachments: [],
        metadata: {},
        received_at: "2026-01-01T00:00:00.000Z"
      },
      user_input: "月次レポートを書いて",
      input_locale: "ja",
      output_locale: "ja",
      active_memory: [{ topic: "tone", content: "Use concise Japanese.", state: "active" }],
      collection_notes: [{
        collection_id: "reports",
        file_path: "collections/reports/notes/README.md",
        content: "Monthly reports use bullet summaries.",
        role: "context_only"
      }],
      recent_messages: [],
      metadata: {
        backend_session_id: "codex-session-1"
      },
      expected_outputs: ["artifact"],
      tool_bridge: {
        enabled: true,
        server_name: "samurai",
        endpoint_url: "http://127.0.0.1:4317/api/backend-runs/run_1/tool-calls",
        token: "secret-bridge-token",
        token_env: "SAMURAI_TOOL_BRIDGE_TOKEN",
        tools: [{
          name: "samurai.artifact.create",
          provider_tool_name: "mcp__samurai__artifact_create",
          title: "Create Samurai Artifact",
          description: "Create a Samurai Artifact.",
          input_schema: {
            type: "object",
            required: ["title", "content"]
          }
        }]
      }
    };

    const prompt = buildExternalBackendPrompt(input);
    const env = externalBackendEnv(input);

    expect(prompt).toContain("Reference context for this turn:");
    expect(prompt).not.toContain("Samurai Agent backend contract");
    expect(prompt).not.toContain("Reply in output_locale");
    expect(prompt).toContain("Collection note refs (context only)");
    expect(prompt).toContain("collections/reports/notes/README.md");
    expect(prompt).not.toContain("Monthly reports use bullet summaries.");
    expect(prompt).toContain("Samurai tool bridge:");
    expect(prompt).toContain("artifact_create");
    expect(prompt).toContain("Use the Samurai artifact tool");
    expect(prompt).not.toContain("secret-bridge-token");
    expect(env).toMatchObject({
      SAMURAI_RUN_ID: "run_1",
      SAMURAI_SESSION_ID: "session_1",
      SAMURAI_ROOM_ID: "room_1",
      SAMURAI_AGENT_ID: "agent_1",
      SAMURAI_BACKEND_SESSION_KEY: "room_1:session_1:agent_1:codex",
      SAMURAI_BACKEND_SESSION_ID: "codex-session-1",
      SAMURAI_TOOL_BRIDGE_URL: "http://127.0.0.1:4317/api/backend-runs/run_1/tool-calls",
      SAMURAI_TOOL_BRIDGE_TOKEN: "secret-bridge-token"
    });
    expect(env).not.toHaveProperty("SAMURAI_INPUT_LOCALE");
    expect(env).not.toHaveProperty("SAMURAI_OUTPUT_LOCALE");
  });

  it("tells external backends to use Collection bridge tools instead of direct collection files", () => {
    const input: BackendRunInput = {
      ...backendInput("run_collection_prompt"),
      expected_outputs: ["collection_schema"],
      tool_bridge: {
        enabled: true,
        server_name: "samurai",
        endpoint_url: "http://127.0.0.1:4317/api/backend-runs/run_collection_prompt/tool-calls",
        token: "bridge-token",
        token_env: "SAMURAI_TOOL_BRIDGE_TOKEN",
        tools: [{
          name: "samurai.collection.schema.save",
          provider_tool_name: "mcp__samurai__collection_schema_save",
          title: "Save Samurai Collection Schema",
          description: "Save a validated CollectionSchema.",
          input_schema: { type: "object" }
        }, {
          name: "samurai.collection.record.create",
          provider_tool_name: "mcp__samurai__collection_record_create",
          title: "Create Samurai Collection Record",
          description: "Create a schema-validated Collection record.",
          input_schema: { type: "object" }
        }]
      }
    };

    const prompt = buildExternalBackendPrompt(input);

    expect(prompt).toContain("collection_schema");
    expect(prompt).toContain("collection_record_create");
    expect(prompt).toContain("built-in table/gallery/calendar/kanban/dashboard views are the default route");
    expect(prompt).toContain("Do not write collections/*/schema.json directly.");
    expect(prompt).toContain("Do not write collections/*/records/*.json directly.");
    expect(prompt).toContain("Do not create or edit collections/* files directly.");
  });

  it("includes light-chat workspace attachments and their temporary working copies", () => {
    const base = backendInput("run_attachment_prompt");
    const input: BackendRunInput = {
      ...base,
      envelope: {
        ...base.envelope,
        attachments: [{ kind: "file", id: "sha256-file", uri: "attachments/report.txt", label: "report.txt" }]
      },
      temporary_context: [{
        id: "workspace_attachment_1", kind: "workspace_file", label: "report.txt", source_name: "attachments/report.txt",
        mime_type: "application/octet-stream", file_path: "attachments/workspace-report.txt",
        created_at: "2026-08-22T00:00:00.000Z", expires_at: "2026-08-22T00:10:00.000Z"
      }],
      context_intent: "light_chat"
    };
    const prompt = buildExternalBackendPrompt(input);
    expect(prompt).toContain("Workspace attachments for this turn:");
    expect(prompt).toContain("attachments/report.txt");
    expect(prompt).toContain("attachments/workspace-report.txt");
  });

  it("injects run-scoped Samurai Artifact MCP config into Codex and Claude Code CLI args", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-mcp-"));
    roots.push(root);
    const executable = path.join(root, "backend-argv");
    const argvFile = path.join(root, "argv.txt");
    const quotedArgvFile = argvFile.replaceAll("'", "'\\''");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" > '${quotedArgvFile}'`,
        "case \"$1\" in",
        "  exec) printf '{\"type\":\"thread.started\",\"thread_id\":\"codex-fixture\"}\\n'; printf '{\"type\":\"turn.completed\",\"thread_id\":\"codex-fixture\",\"output_summary\":\"done\"}\\n' ;;",
        "  *) printf '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-fixture\"}\\n'; printf '{\"type\":\"result\",\"session_id\":\"claude-fixture\",\"result\":\"done\"}\\n' ;;",
        "esac"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const toolBridgeInput: BackendRunInput = {
      ...backendInput("run_mcp"),
      expected_outputs: ["artifact"],
      tool_bridge: {
        enabled: true,
        server_name: "samurai",
        endpoint_url: "http://127.0.0.1:4317/api/backend-runs/run_mcp/tool-calls",
        token: "bridge-token",
        token_env: "SAMURAI_TOOL_BRIDGE_TOKEN",
        tools: [{
          name: "samurai.artifact.create",
          provider_tool_name: "mcp__samurai__artifact_create",
          title: "Create Samurai Artifact",
          description: "Create a Samurai Artifact.",
          input_schema: {
            type: "object",
            required: ["title", "content"]
          }
        }]
      }
    };
    const codex = new CodexBackend({
      command: executable,
      artifactMcpScript: "scripts/samurai-artifact-mcp.mjs"
    });
    const claude = new ClaudeCodeBackend({
      command: executable,
      args: ["-p", "--output-format", "stream-json"],
      artifactMcpScript: "scripts/samurai-artifact-mcp.mjs"
    });

    await collectEvents(codex.runTurn(toolBridgeInput));
    const codexArgs = await readFile(argvFile, "utf8");
    await collectEvents(claude.runTurn(toolBridgeInput));
    const claudeArgs = await readFile(argvFile, "utf8");

    expect(codexArgs).toContain("mcp_servers.samurai.command");
    expect(codexArgs).toContain("mcp_servers.samurai.args");
    expect(codexArgs).toContain("mcp_servers.samurai.env_vars");
    expect(codexArgs).toContain("--output-last-message");
    expect(codexArgs).toContain("scripts/samurai-artifact-mcp.mjs");
    expect(codexArgs).not.toContain("bridge-token");
    expect(claudeArgs).toContain("--mcp-config");
    expect(claudeArgs).toContain("mcpServers");
    expect(claudeArgs).toContain("samurai");
    expect(claudeArgs).toContain("scripts/samurai-artifact-mcp.mjs");
    expect(claudeArgs).not.toContain("bridge-token");
  });

  it("uses Codex's official output-last-message when JSONL has no answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-last-message-"));
    roots.push(root);
    const executable = path.join(root, "codex-last-message-fixture");
    const argsFile = path.join(root, "args.txt");
    const quotedArgsFile = argsFile.replaceAll("'", "'\\''");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "last_message=''",
        "prev=''",
        "for arg in \"$@\"; do",
        "  if [ \"$prev\" = \"--output-last-message\" ]; then last_message=\"$arg\"; fi",
        "  prev=\"$arg\"",
        "done",
        `printf '%s\\n' "$last_message" > '${quotedArgsFile}'`,
        "printf '{\"type\":\"thread.started\",\"thread_id\":\"codex-thread-empty\"}\\n'",
        "printf '{\"type\":\"turn.completed\",\"thread_id\":\"codex-thread-empty\",\"output_summary\":\"Codex completed.\"}\\n'",
        "printf '作業メモを作成しました。\\n' > \"$last_message\""
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({ command: executable });

    const events = await collectEvents(backend.runTurn(backendInput("run_last_message")));
    const outputPath = (await readFile(argsFile, "utf8")).trim();
    const text = events
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("");

    expect(outputPath).toMatch(/last-message\.txt$/);
    expect(text).toBe("作業メモを作成しました。");
    expect(events.at(-1)).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      backend_session_id: "codex-thread-empty",
      payload: {
        provider_event_type: "turn.completed",
        output_summary: "Codex completed."
      }
    });
    expect(events.at(-1)).not.toHaveProperty("source_sequence");
  });
});

async function collectEvents(events: AsyncIterable<BackendOutputEvent>): Promise<BackendOutputEvent[]> {
  const collected: BackendOutputEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function fileExists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("test_barrier_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function cleanupCliFixture(backend: ExternalCliBackend, iterator: AsyncIterator<BackendOutputEvent>, pidFile: string, release?: string): Promise<void> {
  if (release) await writeFile(release, "release", "utf8").catch(() => undefined);
  await iterator.return?.().catch(() => undefined);
  try {
    await waitFor(() => backend.getStatus().active_run_count === 0);
    return;
  } catch {
    const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    await waitFor(() => backend.getStatus().active_run_count === 0);
  }
}

function backendInput(runId = "run_probe"): BackendRunInput {
  return {
    run_id: runId,
    session_id: "session_probe",
    input_message_id: "message_probe",
    envelope: {
      id: "message_probe",
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:probe",
      user_intent: "probe backend",
      input_locale: "ja",
      output_locale: "ja",
      attachments: [],
      metadata: {},
      received_at: "2026-01-01T00:00:00.000Z"
    },
    user_input: "probe backend",
    input_locale: "ja",
    output_locale: "ja",
    active_memory: [],
    recent_messages: [],
    metadata: {}
  };
}
