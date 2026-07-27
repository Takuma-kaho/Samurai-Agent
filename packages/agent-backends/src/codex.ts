import { ExternalCliBackend } from "./external-cli.js";
import type { ExternalCliBackendOptions } from "./external-cli.js";
import type { BackendOutputEvent, BackendToolBridge } from "./contract.js";
import { createCliOutputDecoder } from "./cli-parser.js";
import { createCodexStreamDecoder, readCodexOutputLastMessage } from "./codex-decoder.js";
import type { ExternalCliProvider } from "./provider-decoder-helpers.js";
import path from "node:path";

/** Codex exec --json arguments and native thread/session contract. */
export class CodexBackend extends ExternalCliBackend {
  readonly execution_owner = "backend" as const;

  constructor(options: Omit<ExternalCliBackendOptions, "id" | "kind" | "label"> = {}) {
    const args = normalizeCodexExecArgs(options.args);
    const resumeArgs = normalizeCodexExecArgs(options.resumeArgs);
    super({
      id: "codex",
      kind: "codex",
      label: "Codex",
      ...options,
      args: args ?? ["exec", "--json", "--output-last-message", "{output_last_message_path}", "-"],
      resumeArgs: resumeArgs ?? ["exec", "resume", "{backend_session_id}", "--json", "--output-last-message", "{output_last_message_path}", "-"]
    }, createCodexProvider());
  }
}

export function normalizeCodexExecArgs(args: string[] | undefined): string[] | undefined {
  if (!args || args.length === 0 || args[0] !== "exec") return args;
  let normalized = args.includes("--json") ? [...args] : insertBeforeStdinPrompt([...args], ["--json"]);
  if (!normalized.includes("--output-last-message")) {
    const stdinIndex = normalized.lastIndexOf("-");
    const outputArgs = ["--output-last-message", "{output_last_message_path}"];
    normalized = stdinIndex >= 0
      ? [...normalized.slice(0, stdinIndex), ...outputArgs, ...normalized.slice(stdinIndex)]
      : [...normalized, ...outputArgs];
  } else if (!normalized.includes("{output_last_message_path}")) {
    const outputFlagIndex = normalized.indexOf("--output-last-message");
    normalized = [...normalized.slice(0, outputFlagIndex + 1), "{output_last_message_path}", ...normalized.slice(outputFlagIndex + 1)];
  }
  return normalized;
}

function insertBeforeStdinPrompt(args: string[], injectedArgs: string[]): string[] {
  const promptIndex = args.lastIndexOf("-");
  return promptIndex >= 0 ? [...args.slice(0, promptIndex), ...injectedArgs, ...args.slice(promptIndex)] : [...args, ...injectedArgs];
}

export function createCodexProvider(): ExternalCliProvider {
  return {
    createDecoder: (helpers) => createCodexStreamDecoder(helpers),
    prepareArgs: ({ args, workingDirectory, toolBridge, artifactMcpScript }) => {
      let prepared = injectCodexWorkingDirectoryArgs(args, workingDirectory);
      if (toolBridge?.enabled && toolBridge.tools.length > 0) {
        prepared = injectCodexMcpArgs(prepared, toolBridge, artifactMcpScript);
      }
      return prepared;
    },
    sessionId: (value) => {
      const threadId = typeof value.thread_id === "string" ? value.thread_id.trim() : "";
      return threadId || undefined;
    },
    outputLastMessage: readCodexOutputLastMessage,
    processFailure: (stderr) => /Not inside a trusted directory|--skip-git-repo-check|outside a Git repository|not.*git repository/i.test(stderr)
      ? { code: "backend_execution_root_not_ready", message: "Codex could not run because the Workspace execution root is not ready." }
      : undefined
  };
}

export function parseCodexOutputEvents(line: string): BackendOutputEvent[] {
  return createCodexOutputDecoder()(line, "stdout");
}

export function parseCodexOutputLine(line: string): BackendOutputEvent | undefined {
  return parseCodexOutputEvents(line)[0];
}

function createCodexOutputDecoder(): ReturnType<typeof createCliOutputDecoder> {
  const provider = createCodexProvider();
  return createCliOutputDecoder("codex", provider.createDecoder, provider.sessionId);
}

function injectCodexWorkingDirectoryArgs(args: string[], workingDirectory: string | undefined): string[] {
  if (!workingDirectory || args.includes("-C") || args.includes("--cd") || args.some((arg) => arg.startsWith("--cd="))) return args;
  return insertBeforeStdinPrompt(args, ["-C", workingDirectory]);
}

function injectCodexMcpArgs(args: string[], bridge: BackendToolBridge, artifactMcpScript: string | undefined): string[] {
  const scriptPath = artifactMcpScriptPath(artifactMcpScript);
  const mcpArgs = [
    "-c",
    `mcp_servers.${bridge.server_name}.command="node"`,
    "-c",
    `mcp_servers.${bridge.server_name}.args=${tomlStringArray([scriptPath])}`,
    "-c",
    `mcp_servers.${bridge.server_name}.env_vars=${tomlStringArray(["SAMURAI_TOOL_BRIDGE_URL", bridge.token_env])}`
  ];
  return insertBeforeStdinPrompt(args, mcpArgs);
}

function artifactMcpScriptPath(explicitPath: string | undefined): string {
  return explicitPath && path.isAbsolute(explicitPath)
    ? explicitPath
    : path.resolve(process.cwd(), explicitPath || "scripts/samurai-artifact-mcp.mjs");
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(",")}]`;
}
