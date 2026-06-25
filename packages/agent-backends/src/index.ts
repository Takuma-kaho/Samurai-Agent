import {
  type AgentBackendKind,
  type BackendEventType,
  type JsonValue,
  type MessageRecord,
  type ResourceRef,
  type SupportedLocale
} from "@samurai-agent/core-schemas";
import { spawn } from "node:child_process";

export interface MemoryCandidateLike {
  id?: string;
  topic?: string;
  content: string;
}

export interface BackendRunInput {
  run_id: string;
  session_id: string;
  input_message_id: string;
  user_input: string;
  input_locale: SupportedLocale;
  output_locale: SupportedLocale;
  active_memory: MemoryCandidateLike[];
  knowledge_wiki?: Array<{
    id: string;
    slug: string;
    title: string;
    content: string;
  }>;
  selected_skills?: Array<{
    id: string;
    title: string;
    description: string;
    tags: string[];
    required_capabilities: string[];
    content?: string;
  }>;
  session_search?: Array<{
    kind: string;
    id: string;
    title: string;
    summary: string;
  }>;
  available_tools?: string[];
  recent_messages: MessageRecord[];
  metadata: Record<string, JsonValue>;
}

export interface BackendOutputEvent {
  event_type: BackendEventType;
  payload: Record<string, JsonValue>;
  resource_refs?: ResourceRef[];
  tool_call_id?: string;
}

export interface AgentBackend {
  readonly id: string;
  readonly kind: AgentBackendKind;
  readonly label: string;
  getStatus?(): AgentBackendStatus;
  runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent>;
  resumeRun?(runId: string, input: Record<string, JsonValue>): AsyncIterable<BackendOutputEvent>;
  cancelRun?(runId: string): Promise<void>;
}

export interface AgentBackendStatus {
  id: string;
  kind: AgentBackendKind;
  label: string;
  configured: boolean;
  reason?: string;
}

export class AgentBackendRegistry {
  private readonly backends = new Map<string, AgentBackend>();

  constructor(backends: AgentBackend[] = []) {
    for (const backend of backends) {
      this.register(backend);
    }
  }

  register(backend: AgentBackend): void {
    this.backends.set(backend.id, backend);
  }

  get(id: string): AgentBackend | undefined {
    return this.backends.get(id);
  }

  require(id = "samurai-native"): AgentBackend {
    const backend = this.get(id);
    if (!backend) {
      throw new Error(`Agent backend not registered: ${id}`);
    }
    return backend;
  }

  list(): AgentBackend[] {
    return [...this.backends.values()];
  }

  statuses(): AgentBackendStatus[] {
    return this.list().map((backend) =>
      backend.getStatus?.() ?? {
        id: backend.id,
        kind: backend.kind,
        label: backend.label,
        configured: true
      }
    );
  }
}

export class MockBackend implements AgentBackend {
  readonly id = "mock";
  readonly kind = "mock" as const;
  readonly label = "Mock Backend";

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield {
      event_type: "run_started",
      payload: { input_summary: summarize(input.user_input) }
    };
    yield {
      event_type: "text_delta",
      payload: { text: `Mock response: ${input.user_input}` }
    };
    yield {
      event_type: "run_completed",
      payload: { output_summary: "Mock response completed." }
    };
  }
}

export interface ExternalCliBackendOptions {
  id: string;
  kind: Extract<AgentBackendKind, "claude_code" | "codex" | "external">;
  label: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export class ExternalCliBackend implements AgentBackend {
  readonly id: string;
  readonly kind: ExternalCliBackendOptions["kind"];
  readonly label: string;
  private readonly command?: string;
  private readonly args: string[];
  private readonly timeoutMs: number;

  constructor(options: ExternalCliBackendOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.label = options.label;
    this.command = options.command?.trim() || undefined;
    this.args = options.args ?? [];
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  getStatus(): AgentBackendStatus {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      configured: Boolean(this.command),
      ...(this.command ? {} : { reason: "command_not_configured" })
    };
  }

  async *runTurn(input: BackendRunInput): AsyncIterable<BackendOutputEvent> {
    yield {
      event_type: "run_started",
      payload: {
        backend_id: this.id,
        input_summary: summarize(input.user_input)
      }
    };

    if (!this.command) {
      yield {
        event_type: "run_failed",
        payload: {
          error_code: "backend_not_configured",
          message: `${this.label} command is not configured.`,
          reason: "not_configured",
          retryable: false
        }
      };
      return;
    }

    const result = await runCommand({
      command: this.command,
      args: this.args,
      input: input.user_input,
      timeoutMs: this.timeoutMs
    });

    if (result.stdout.trim()) {
      yield {
        event_type: "text_delta",
        payload: { text: result.stdout.trim() }
      };
    }

    if (result.exitCode === 0) {
      yield {
        event_type: "run_completed",
        payload: {
          output_summary: summarize(result.stdout) || `${this.label} completed.`,
          stderr_summary: summarize(result.stderr)
        }
      };
      return;
    }

    yield {
      event_type: "run_failed",
      payload: {
        error_code: result.timedOut ? "backend_timeout" : "backend_failed",
        message: `${this.label} failed.`,
        reason: result.timedOut ? "timeout" : "exit_code",
        retryable: result.timedOut,
        exit_code: result.exitCode,
        stderr_summary: summarize(result.stderr)
      }
    };
  }
}

export class ClaudeCodeBackend extends ExternalCliBackend {
  constructor(options: Omit<ExternalCliBackendOptions, "id" | "kind" | "label"> = {}) {
    super({
      id: "claude-code",
      kind: "claude_code",
      label: "Claude Code",
      ...options
    });
  }
}

export class CodexBackend extends ExternalCliBackend {
  constructor(options: Omit<ExternalCliBackendOptions, "id" | "kind" | "label"> = {}) {
    super({
      id: "codex",
      kind: "codex",
      label: "Codex",
      ...options
    });
  }
}

interface CommandRunInput {
  command: string;
  args: string[];
  input: string;
  timeoutMs: number;
}

interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runCommand(input: CommandRunInput): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr: stderr || error.message,
        exitCode: null,
        timedOut: false
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin.on("error", () => {
      // Spawn errors are normalized through the child "error" event.
    });
    try {
      child.stdin.end(input.input);
    } catch {
      // The child "error" or "close" event will produce a normalized run_failed event.
    }
  });
}

function summarize(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}
