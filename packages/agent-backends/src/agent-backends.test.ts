import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_type: "run_completed",
        payload: expect.objectContaining({
          output_summary: `cwd:${workingDirectory} workspace:${workspaceRoot}`
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
        "printf '{\"type\":\"assistant_delta\",\"text\":\"hello\"}\\n'",
        "printf '{\"type\":\"tool_result\",\"tool_call_id\":\"tool_1\",\"payload\":{\"status\":\"ok\"}}\\n'"
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

  it("maps Claude-style stream JSON content blocks to canonical backend events", () => {
    const events = parseCliOutputEvents(JSON.stringify({
      type: "assistant",
      session_id: "claude-session-1",
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
      result: "done",
      is_error: false
    }));

    expect(events).toEqual([
      {
        event_type: "text_delta",
        payload: {
          backend_session_id: "claude-session-1",
          provider_event_type: "assistant",
          text: "調査しました"
        }
      },
      {
        event_type: "tool_call_started",
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
      payload: {
        backend_session_id: "claude-session-1",
        provider_event_type: "result",
        output_summary: "done"
      }
    });
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
      payload: {
        backend_session_id: "codex-thread-empty",
        provider_event_type: "turn.completed"
      }
    });
  });
});

async function collectEvents(events: AsyncIterable<BackendOutputEvent>): Promise<BackendOutputEvent[]> {
  const collected: BackendOutputEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
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
