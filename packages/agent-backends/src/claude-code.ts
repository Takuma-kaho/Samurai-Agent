import { ExternalCliBackend } from "./external-cli.js";
import type { ExternalCliBackendOptions } from "./external-cli.js";
import type { BackendOutputEvent, BackendToolBridge } from "./contract.js";
import { createCliOutputDecoder } from "./cli-parser.js";
import { createClaudeStreamDecoder } from "./claude-code-decoder.js";
import type { ExternalCliProvider } from "./provider-decoder-helpers.js";
import path from "node:path";

/** Claude Code's stream-json command/session contract. */
export class ClaudeCodeBackend extends ExternalCliBackend {
  readonly execution_owner = "backend" as const;

  constructor(options: Omit<ExternalCliBackendOptions, "id" | "kind" | "label"> = {}) {
    super({
      id: "claude-code",
      kind: "claude_code",
      label: "Claude Code",
      resumeArgs: ["--resume", "{backend_session_id}", "--output-format", "stream-json"],
      ...options
    }, createClaudeCodeProvider());
  }
}

export function claudeCodeSessionId(event: Record<string, unknown>): string | undefined {
  const sessionId = typeof event.session_id === "string" ? event.session_id.trim() : "";
  return sessionId || undefined;
}

export function createClaudeCodeProvider(): ExternalCliProvider {
  return {
    createDecoder: (helpers) => createClaudeStreamDecoder(helpers),
    prepareArgs: ({ args, toolBridge, artifactMcpScript }) => {
      if (!toolBridge?.enabled || toolBridge.tools.length === 0) return args;
      return injectClaudeMcpArgs(args, toolBridge, artifactMcpScript);
    },
    sessionId: claudeCodeSessionId
  };
}

export function parseClaudeCodeOutputEvents(line: string): BackendOutputEvent[] {
  return createClaudeCodeOutputDecoder()(line, "stdout");
}

export function parseClaudeCodeOutputLine(line: string): BackendOutputEvent | undefined {
  return parseClaudeCodeOutputEvents(line)[0];
}

function createClaudeCodeOutputDecoder(): ReturnType<typeof createCliOutputDecoder> {
  const provider = createClaudeCodeProvider();
  return createCliOutputDecoder("claude_code", provider.createDecoder, provider.sessionId);
}

function injectClaudeMcpArgs(args: string[], bridge: BackendToolBridge, artifactMcpScript: string | undefined): string[] {
  return insertBeforeStdinPrompt(args, [
    "--mcp-config",
    JSON.stringify({
      mcpServers: {
        [bridge.server_name]: {
          command: "node",
          args: [artifactMcpScriptPath(artifactMcpScript)]
        }
      }
    })
  ]);
}

function insertBeforeStdinPrompt(args: string[], injectedArgs: string[]): string[] {
  const promptIndex = args.lastIndexOf("-");
  return promptIndex >= 0
    ? [...args.slice(0, promptIndex), ...injectedArgs, ...args.slice(promptIndex)]
    : [...args, ...injectedArgs];
}

function artifactMcpScriptPath(explicitPath: string | undefined): string {
  return explicitPath && path.isAbsolute(explicitPath)
    ? explicitPath
    : path.resolve(process.cwd(), explicitPath || "scripts/samurai-artifact-mcp.mjs");
}
