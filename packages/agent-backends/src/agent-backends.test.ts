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
  externalBackendEnv,
  ExternalCliBackend,
  MockBackend,
  parseCliOutputEvents,
  parseCliOutputLine,
  resolveExternalCommandProbe,
  type BackendOutputEvent,
  type BackendRunInput
} from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent backend registry", () => {
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
    await writeFile(executable, "#!/bin/sh\nprintf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"ok\"}}\\n'\n", "utf8");
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

  it("does not spawn CLI work when abort follows the emitted run_started event", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-abort-before-spawn-"));
    roots.push(root);
    const executable = path.join(root, "must-not-spawn");
    const marker = path.join(root, "spawned");
    await writeFile(executable, `#!/bin/sh\nprintf spawned > "${marker}"\n`, "utf8");
    await chmod(executable, 0o755);
    const controller = new AbortController();
    const backend = new ExternalCliBackend({ id: "abort-before-spawn-cli", kind: "external", label: "Abort Before Spawn CLI", command: executable });
    const iterator = backend.runTurn({ ...backendInput("run-abort-before-spawn"), abort_signal: controller.signal })[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value?.event_type).toBe("run_started");
    controller.abort();
    const terminal = await iterator.next();

    expect(terminal.value?.terminal_evidence).toEqual({ kind: "cancelled", source: "owned_loop_return" });
    expect((await iterator.next()).done).toBe(true);
    expect(await fileExists(marker)).toBe(false);
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
      "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"cwd:%s workspace:%s\"}}\\n' \"$PWD\" \"$SAMURAI_WORKSPACE_ROOT\""
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

  it("buffers external CLI events for streamEvents replay", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stream-"));
    roots.push(root);
    const executable = path.join(root, "backend-stream");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '{\"type\":\"assistant_delta\",\"text\":\"hello\",\"source_event_id\":\"provider-1\",\"source_sequence\":1}\\n'",
        "printf '{\"type\":\"tool_result\",\"tool_call_id\":\"tool_1\",\"payload\":{\"status\":\"ok\"},\"source_sequence\":1}\\n'"
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
    const replayedEvents = await collectEvents(backend.streamEvents("run_stream"));

    expect(status.supports).toMatchObject({
      start_session: true,
      resume_run: false,
      cancel_run: true,
      stream_events: true
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
    expect(replayedEvents).toEqual(runEvents);
    expect(runEvents.map((event) => event.source_sequence)).toEqual([undefined, 1, 1, undefined]);
    expect(runEvents[1]?.source_event_id).toBe("provider-1");
    expect(runEvents[2]?.source_event_id).toBeUndefined();
    expect(runEvents[0]?.source_event_id).toMatch(/^run_stream:adapter-stream:.+:adapter:1$/);
    expect(runEvents[3]?.source_event_id).toMatch(/^run_stream:adapter-stream:.+:adapter:2$/);
    expect(new Set(runEvents.map((event) => event.source_event_id ?? `sequence:${event.source_sequence}`)).size).toBe(runEvents.length);
  });

  it("bounds settled replay state without reusing generated source identities", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-bounded-stream-"));
    roots.push(root);
    const executable = path.join(root, "bounded-stream-backend");
    await writeFile(executable, "#!/bin/sh\ncat >/dev/null\nprintf '{\"type\":\"result\",\"backend_session_id\":\"bounded-session\",\"result\":\"done\"}\\n'\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "bounded-stream-cli",
      kind: "external",
      label: "Bounded Stream CLI",
      command: executable
    });
    const first = await collectEvents(backend.runTurn(backendInput("bounded-run-0")));
    for (let index = 1; index <= 50; index += 1) {
      await collectEvents(backend.runTurn(backendInput(`bounded-run-${index}`)));
    }

    const evictedReplay = await collectEvents(backend.streamEvents("bounded-run-0"));
    const resumed = await collectEvents(backend.resumeRun("bounded-run-0"));
    const firstIds = first.map((event) => event.source_event_id);

    expect(evictedReplay[0]?.terminal_evidence).toEqual({ kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true });
    expect(resumed[0]?.source_event_id).toMatch(/^bounded-run-0:adapter-stream:.+:adapter:1$/);
    expect(firstIds).not.toContain(resumed[0]?.source_event_id);
    expect((backend as unknown as { eventStreams: Map<string, unknown> }).eventStreams.size).toBeLessThanOrEqual(50);
    const sessionIds = (backend as unknown as { backendSessionIds: Map<string, string> }).backendSessionIds;
    expect(sessionIds.size).toBeLessThanOrEqual(50);
    expect(sessionIds.has("bounded-run-0")).toBe(false);
  });

  it("does not evict active event streams or strand their waiters", () => {
    const backend = new ExternalCliBackend({ id: "active-stream-cli", kind: "external", label: "Active Stream CLI" });
    const internals = backend as unknown as {
      beginEventStream(runId: string): { settled: boolean; waiters: Array<() => void> };
      eventStreams: Map<string, { settled: boolean; waiters: Array<() => void> }>;
    };
    for (let index = 0; index <= 50; index += 1) {
      const state = internals.beginEventStream(`active-run-${index}`);
      state.waiters.push(() => {});
    }

    expect(internals.eventStreams.size).toBe(51);
    expect([...internals.eventStreams.values()].every((state) => !state.settled && state.waiters.length === 1)).toBe(true);
  });

  it("does not reuse adapter source identity after a process restart", async () => {
    const original = new ExternalCliBackend({
      id: "restart-identity-cli",
      kind: "external",
      label: "Restart Identity CLI",
      command: "samurai-missing-cli-for-restart-identity-test",
      sourceIdentityFactory: () => "boot-a"
    });
    const restarted = new ExternalCliBackend({
      id: "restart-identity-cli",
      kind: "external",
      label: "Restart Identity CLI",
      sourceIdentityFactory: () => "boot-b"
    });

    const beforeRestart = await collectEvents(original.runTurn(backendInput("restart-run")));
    const afterRestart = await collectEvents(restarted.resumeRun("restart-run"));

    expect(beforeRestart[0]?.source_event_id).toBe("restart-run:adapter-stream:boot-a:adapter:1");
    expect(afterRestart[0]?.source_event_id).toBe("restart-run:adapter-stream:boot-b:adapter:1");
    expect(afterRestart[0]?.source_event_id).not.toBe(beforeRestart[0]?.source_event_id);
  });

  it("maps safe stderr progress to host progress without exposing raw stderr text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stderr-progress-"));
    roots.push(root);
    const executable = path.join(root, "backend-stderr-progress");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf 'Searching project files\\n' >&2",
        "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "stderr-progress-cli",
      kind: "codex",
      label: "Stderr Progress CLI",
      command: executable
    });

    const events = await collectEvents(backend.runTurn(backendInput("run_stderr_progress")));

    expect(events).toContainEqual(expect.objectContaining({
      event_type: "host_progress",
      payload: expect.objectContaining({
        display_kind: "activity",
        text: "コードを検索",
        provider_stream: "stderr"
      })
    }));
    expect(JSON.stringify(events)).not.toContain("Searching project files");
  });

  it("emits a waiting progress event when an external backend is initially silent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-silent-"));
    roots.push(root);
    const executable = path.join(root, "backend-silent");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "sleep 3",
        "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({
      id: "silent-cli",
      kind: "codex",
      label: "Silent CLI",
      command: executable
    });

    const events = await collectEvents(backend.runTurn(backendInput("run_silent")));

    expect(events.map((event) => event.event_type)).toContain("host_progress");
    expect(events).toContainEqual(expect.objectContaining({
      event_type: "host_progress",
      payload: expect.objectContaining({
        text: "実行部からの応答を待っています"
      })
    }));
    expect(events.at(-1)?.event_type).toBe("run_completed");
  });

  it("runs optional external CLI stream compatibility probes for status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-stream-probe-"));
    roots.push(root);
    const executable = path.join(root, "backend-stream-probe");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--stream-probe\" ]; then",
        "  printf '{\"type\":\"assistant_delta\",\"text\":\"probe-ok\"}\\n'",
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
      streamProbeArgs: ["--stream-probe"],
      streamProbeTimeoutMs: 1_000
    });

    const status = backend.getStatus();

    expect(status).toMatchObject({
      connection_state: "ready",
      metadata: {
        stream_probe: {
          enabled: true,
          status: "compatible",
          event_count: 1,
          first_event_type: "text_delta",
          exit_code: 0
        }
      }
    });
  });

  it("maps CLI JSON lines to canonical backend events", () => {
    expect(parseCliOutputLine(JSON.stringify({ type: "assistant_delta", text: "hello" }))).toEqual({
      event_type: "text_delta",
      payload: { type: "assistant_delta", text: "hello" }
    });
    expect(parseCliOutputLine(JSON.stringify({ type: "tool_result", tool_call_id: "tool_1", payload: { status: "ok" } }))).toEqual({
      event_type: "tool_call_output",
      payload: { status: "ok" },
      tool_call_id: "tool_1"
    });
    expect(parseCliOutputLine(JSON.stringify({ type: "resume_input", payload: { status: "submitted" } }))).toEqual({
      event_type: "backend_native_input_submitted",
      payload: { status: "submitted" }
    });
    expect(parseCliOutputLine(JSON.stringify({ type: "result", conversation_id: "native-session-1", payload: { output_summary: "done" } }))).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: {
        provider_event_type: "result",
        output_summary: "done",
        backend_session_id: "native-session-1"
      }
    });
    expect(parseCliOutputLine("plain text")).toEqual({
      event_type: "text_delta",
      payload: { text: "plain text\n" }
    });
  });

  it("converts provider failures into stable terminal evidence", () => {
    expect(parseCliOutputLine(JSON.stringify({ type: "result", is_error: true, error_code: "provider_denied", message: "denied" }))).toEqual({
      event_type: "run_failed",
      terminal_evidence: { kind: "failed", source: "provider_terminal_response", error: { code: "provider_denied", message: "denied", retryable: false, causeCategory: "provider" } },
      payload: {
        provider_event_type: "result",
        output_summary: "Backend result reported an error.",
        error_code: "provider_denied",
        reason: "result_error",
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
    expect(completed.at(-1)?.terminal_evidence).toEqual({ kind: "completed", source: "process_exit" });
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
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('READY\\n');\nsetTimeout(() => process.exit(0), 100);\n", "utf8");
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
      expect(terminal?.terminal_evidence).toEqual({ kind: "completed", source: "process_exit" });
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
    await writeFile(executable, "#!/bin/sh\nprintf 'Bearer secret-token api_key=supersecret /workspace/file /mnt/data /usr/bin/tool /Library/App https://example.test/api\\n' >&2\nexit 7\n", "utf8");
    await chmod(executable, 0o755);
    const events = await collectEvents(new ExternalCliBackend({ id: "safe-diagnostic-cli", kind: "external", label: "Safe Diagnostic CLI", command: executable }).runTurn(backendInput("run-safe-diagnostic")));
    const summary = String(events.at(-1)?.payload.stderr_summary ?? "");

    expect(summary).toContain("[redacted]");
    expect(summary).toContain("[path]");
    expect(summary).not.toContain("secret-token");
    expect(summary).not.toContain("supersecret");
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
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('READY\\n');\nprocess.on('SIGTERM', () => process.exit(143));\nsetInterval(() => {}, 1000);\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "cancel-cli", kind: "external", label: "Cancel CLI", command: executable });
    const iterator = backend.runTurn(backendInput("run-cancel"))[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
    }
    expect(ready).toBe(true);
    await expect(backend.cancelRun?.("run-cancel")).resolves.toEqual({ kind: "requested" });
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
    }
    expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "cancelled", source: "process_exit" });
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
      "process.stdout.write('READY\\n');",
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
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
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

  it("keeps a bare natural exit 0 completed when cancel races process close", async () => {
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
      "process.stdout.write('READY\\n');",
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
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
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

      expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "completed", source: "process_exit" });
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
      "process.stdout.write('READY\\n');",
      "process.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n');",
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
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
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
      "process.stdout.write('READY\\n');",
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
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
    }
    expect(backend.getStatus().active_run_count).toBe(1);
    await iterator.return?.();
    await waitFor(() => fileExists(marker));
    await waitFor(() => backend.getStatus().active_run_count === 0);
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("keeps draining an early-returned child that ignores SIGTERM until real close", async () => {
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
      "process.stdout.write('READY\\n');",
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
        ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
      }

      await iterator.return?.();
      returned = true;
      expect(backend.getStatus().active_run_count).toBe(1);
      await waitFor(() => fileExists(drainedAfterSignal));
      await writeFile(release, "release", "utf8");
      await waitFor(() => backend.getStatus().active_run_count === 0);
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
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('READY\\n');\nprocess.stdout.write(JSON.stringify({ type: 'result', result: 'done' }) + '\\n');\nprocess.stdout.write(JSON.stringify({ type: 'result', is_error: true, error_code: 'late_error', message: 'late provider failure' }) + '\\n');\nprocess.on('SIGTERM', () => process.exit(143));\nsetInterval(() => {}, 1000);\n", "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "cancel-race-cli", kind: "external", label: "Cancel Race CLI", command: executable });
    const iterator = backend.runTurn(backendInput("run-cancel-race"))[Symbol.asyncIterator]();
    const events: BackendOutputEvent[] = [];
    let ready = false;
    while (!ready) {
      const next = await iterator.next();
      if (next.done) break;
      events.push(next.value);
      ready = next.value.event_type === "text_delta" && next.value.payload.text === "READY\n";
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
    await writeFile(executable, "#!/bin/sh\nprintf '{\"type\":\"result\",\"result\":\"done\"}\\n'\nexit 9\n", "utf8");
    await chmod(executable, 0o755);

    const backend = new ExternalCliBackend({ id: "terminal-conflict-cli", kind: "external", label: "Terminal Conflict CLI", command: executable });
    const events = await collectEvents(backend.runTurn(backendInput("run-terminal-conflict")));

    expect(events.filter((event) => event.terminal_evidence)).toHaveLength(1);
    expect(events.at(-1)?.terminal_evidence).toEqual({ kind: "completed", source: "provider_terminal_response" });
    expect(backend.getStatus().active_run_count).toBe(0);
  });

  it("reports missing stream state as indeterminate when runtime state is unavailable", async () => {
    const backend = new ExternalCliBackend({ id: "missing-stream", kind: "external", label: "Missing Stream", command: process.execPath });
    const events = await collectEvents(backend.streamEvents?.("unknown-run") ?? (async function* () {})());
    expect(events[0]?.terminal_evidence).toEqual({ kind: "indeterminate", reason: "runtime_state_unavailable", providerStarted: true, mayHaveSideEffects: true });
  });

  it("maps Claude-style stream JSON content blocks to canonical backend events", () => {
    const events = parseCliOutputEvents(JSON.stringify({
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
    const result = parseCliOutputLine(JSON.stringify({
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
        source_event_id: "provider-id:claude-raw-1:part:1",
        source_sequence: 9,
        payload: {
          backend_session_id: "claude-session-1",
          provider_event_type: "assistant",
          text: "調査しました"
        }
      },
      {
        event_type: "tool_call_started",
        source_event_id: "provider-id:claude-raw-1:part:2",
        source_sequence: 9,
        tool_call_id: "tool_1",
        payload: {
          backend_session_id: "claude-session-1",
          provider_event_type: "assistant",
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
      payload: {
        backend_session_id: "claude-session-1",
        provider_event_type: "result",
        output_summary: "done"
      }
    });
  });

  it("accepts only positive safe provider sequences and assigns adapter identity otherwise", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-invalid-sequence-"));
    roots.push(root);
    const executable = path.join(root, "invalid-sequence");
    await writeFile(executable, [
      "#!/bin/sh",
      "printf '{\"type\":\"assistant_delta\",\"text\":\"hello\",\"source_sequence\":0}\\n'",
      "printf '{\"type\":\"result\",\"result\":\"done\"}\\n'"
    ].join("\n"), "utf8");
    await chmod(executable, 0o755);
    const backend = new ExternalCliBackend({ id: "invalid-sequence-cli", kind: "external", label: "Invalid Sequence CLI", command: executable });

    const events = await collectEvents(backend.runTurn(backendInput("run-invalid-sequence")));
    const text = events.find((event) => event.event_type === "text_delta");

    expect(text?.source_sequence).toBeUndefined();
    expect(text?.source_event_id).toMatch(/^run-invalid-sequence:adapter-stream:.+:adapter:\d+$/);
    expect(parseCliOutputLine(JSON.stringify({ type: "assistant_delta", text: "bad", source_sequence: Number.MAX_SAFE_INTEGER + 1 }))?.source_sequence).toBeUndefined();
  });

  it("normalizes delegated search and subagent tool metadata", () => {
    const claude = parseCliOutputEvents(JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "tool_use", id: "search_1", name: "WebSearch", input: { query: "Samurai", source: "https://example.test/source" } },
        { type: "tool_use", id: "agent_1", name: "Agent", input: { description: "Inspect tests" } }
      ] }
    }));
    const codex = parseCliOutputEvents(JSON.stringify({
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

    expect(events.map((event) => event.event_type)).toEqual(["text_delta", "run_completed"]);
    expect(events[0]?.payload).toMatchObject({
      backend_session_id: "claude-session-2",
      text: "resumed"
    });
    expect(events[1]?.payload).toMatchObject({
      backend_session_id: "claude-session-2",
      output_summary: "resume ok"
    });
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
    const started = parseCliOutputLine(JSON.stringify({
      type: "thread.started",
      thread_id: "codex-thread-1"
    }));
    const assistant = parseCliOutputEvents(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "調べました" }]
      }
    }));
    const commandStart = parseCliOutputLine(JSON.stringify({
      type: "exec_command.begin",
      thread_id: "codex-thread-1",
      call_id: "call_1",
      command: "pnpm test"
    }));
    const commandEnd = parseCliOutputLine(JSON.stringify({
      type: "exec_command.end",
      thread_id: "codex-thread-1",
      call_id: "call_1",
      exit_code: 0,
      stdout: "ok"
    }));
    const completed = parseCliOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-1",
      output_summary: "done"
    }));
    const reasoning = parseCliOutputEvents(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-1",
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "差分の原因を確認しました" }]
      }
    }));
    const emptyReasoning = parseCliOutputEvents(JSON.stringify({
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
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "thread.started",
        provider_thread_id: "codex-thread-1"
      }
    });
    expect(assistant).toEqual([{
      event_type: "text_delta",
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "item.completed",
        item_type: "message",
        text: "調べました"
      }
    }]);
    expect(commandStart).toEqual({
      event_type: "tool_call_started",
      tool_call_id: "call_1",
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "exec_command.begin",
        provider_tool_name: "exec_command",
        action_id: "sandbox.exec",
        input: {
          command: "pnpm test",
          args: null
        }
      }
    });
    expect(commandEnd).toEqual({
      event_type: "tool_call_output",
      tool_call_id: "call_1",
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "exec_command.end",
        provider_tool_name: "exec_command",
        action_id: "sandbox.exec",
        status: "completed",
        exit_code: 0,
        stdout: "ok",
        stderr: "",
        output: "ok"
      }
    });
    expect(completed).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "turn.completed",
        output_summary: "done"
      }
    });
    expect(reasoning).toEqual([{
      event_type: "agent_reasoning",
      payload: {
        backend_session_id: "codex-thread-1",
        provider_event_type: "item.completed",
        item_type: "reasoning",
        text: "差分の原因を確認しました"
      }
    }]);
    expect(emptyReasoning).toEqual([]);
  });

  it("does not turn Codex completion-only events into assistant text", () => {
    expect(parseCliOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-empty"
    }))).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: {
        backend_session_id: "codex-thread-empty",
        provider_event_type: "turn.completed"
      }
    });
    expect(parseCliOutputLine(JSON.stringify({
      type: "turn.completed",
      thread_id: "codex-thread-empty",
      output_summary: "Codex completed."
    }))).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      payload: {
        backend_session_id: "codex-thread-empty",
        provider_event_type: "turn.completed"
      }
    });
  });

  it("parses current Codex assistant output item types as text", () => {
    const direct = parseCliOutputLine(JSON.stringify({
      type: "output_message",
      thread_id: "codex-thread-output",
      content: [{ type: "output_text", text: "本文です" }]
    }));
    const item = parseCliOutputLine(JSON.stringify({
      type: "item.completed",
      thread_id: "codex-thread-output",
      item: {
        type: "agent_message",
        content: [{ type: "output_text", text: "続きの本文です" }]
      }
    }));

    expect(direct).toEqual({
      event_type: "text_delta",
      payload: {
        backend_session_id: "codex-thread-output",
        provider_event_type: "output_message",
        text: "本文です"
      }
    });
    expect(item).toEqual({
      event_type: "text_delta",
      payload: {
        backend_session_id: "codex-thread-output",
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
        "printf '{\"type\":\"item.completed\",\"thread_id\":\"%s\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"resumed codex\"}]}}\\n' \"$3\"",
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
        args_count: 3
      }
    });
    expect(events.map((event) => event.event_type)).toEqual(["run_started", "text_delta", "run_completed"]);
    expect(events[0]?.payload).toMatchObject({
      backend_session_id: "codex-thread-2",
      provider_event_type: "thread.started"
    });
    expect(events[1]?.payload).toMatchObject({
      backend_session_id: "codex-thread-2",
      text: "resumed codex"
    });
    expect(events[2]?.payload).toMatchObject({
      backend_session_id: "codex-thread-2",
      output_summary: "resume ok"
    });
  });

  it("normalizes legacy Codex exec args to keep JSON streaming enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-args-"));
    roots.push(root);
    const executable = path.join(root, "codex-argv");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\"",
        "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({
      command: executable,
      args: ["exec", "-"]
    });

    const text = (await collectEvents(backend.runTurn(backendInput("run_codex_args"))))
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("\n");

    expect(text).toContain("exec --json -");
  });

  it("passes the Samurai Workspace root to Codex with -C instead of skip-git-repo-check", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-cd-"));
    roots.push(root);
    const workspaceRoot = path.join(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const executable = path.join(root, "codex-argv-cd");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\"",
        "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({
      command: executable,
      args: ["exec", "--json", "-"]
    });

    const text = (await collectEvents(backend.runTurn({
      ...backendInput("run_codex_cd"),
      workspace_root: workspaceRoot,
      working_directory: workspaceRoot
    })))
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("\n");

    expect(text).toContain(`-C ${workspaceRoot}`);
    expect(text).not.toContain("--skip-git-repo-check");
  });

  it("passes locale and workspace context to external backend commands", () => {
    const input: BackendRunInput = {
      run_id: "run_1",
      session_id: "session_1",
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

  it("injects run-scoped Samurai Artifact MCP config into Codex and Claude Code CLI args", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-mcp-"));
    roots.push(root);
    const executable = path.join(root, "backend-argv");
    await writeFile(
      executable,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\"",
        "printf '{\"type\":\"result\",\"payload\":{\"output_summary\":\"done\"}}\\n'"
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

    const codexText = (await collectEvents(codex.runTurn(toolBridgeInput)))
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("\n");
    const claudeText = (await collectEvents(claude.runTurn(toolBridgeInput)))
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("\n");

    expect(codexText).toContain("mcp_servers.samurai.command");
    expect(codexText).toContain("mcp_servers.samurai.args");
    expect(codexText).toContain("mcp_servers.samurai.env_vars");
    expect(codexText).toContain("--output-last-message");
    expect(codexText).toContain("scripts/samurai-artifact-mcp.mjs");
    expect(codexText).not.toContain("bridge-token");
    expect(claudeText).toContain("--mcp-config");
    expect(claudeText).toContain("\"mcpServers\"");
    expect(claudeText).toContain("\"samurai\"");
    expect(claudeText).toContain("scripts/samurai-artifact-mcp.mjs");
    expect(claudeText).not.toContain("bridge-token");
  });

  it("uses Codex output-last-message as fallback text when JSON stream has no body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-codex-last-message-"));
    roots.push(root);
    const executable = path.join(root, "codex-last-message-fixture");
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
        "printf '{\"type\":\"turn.completed\",\"thread_id\":\"codex-thread-empty\",\"output_summary\":\"Codex completed.\"}\\n'",
        "printf '作業メモを作成しました。\\n' > \"$last_message\""
      ].join("\n"),
      "utf8"
    );
    await chmod(executable, 0o755);
    const backend = new CodexBackend({ command: executable });

    const events = await collectEvents(backend.runTurn(backendInput("run_last_message")));
    const text = events
      .filter((event) => event.event_type === "text_delta")
      .map((event) => event.payload.text)
      .join("");

    expect(text).toContain("作業メモを作成しました。");
    expect(events.at(-1)).toEqual({
      event_type: "run_completed",
      terminal_evidence: { kind: "completed", source: "provider_terminal_response" },
      source_event_id: expect.stringMatching(
        /^run_last_message:adapter-stream:backend_stream_[^:]+:adapter:\d+$/
      ),
      payload: {
        backend_session_id: "codex-thread-empty",
        provider_event_type: "turn.completed"
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
