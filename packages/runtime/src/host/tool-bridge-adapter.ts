import { randomBytes } from "node:crypto";
import type { BackendToolBridge } from "@samurai-agent/agent-backends";
import type { AgentBackendKind } from "@samurai-agent/core-schemas";
import { samuraiToolBridgeDescriptors } from "../provider-tool-bridge-composition.js";

export interface ToolBridgePort {
  create(input: { backendKind: AgentBackendKind; runId: string; gatewayBoundaryPresent: boolean }): BackendToolBridge | undefined;
}

export class EnvironmentToolBridgeAdapter implements ToolBridgePort {
  create(input: { backendKind: AgentBackendKind; runId: string; gatewayBoundaryPresent: boolean }): BackendToolBridge | undefined {
    if (input.gatewayBoundaryPresent || !["claude_code", "codex", "external"].includes(input.backendKind)) return undefined;
    const explicit = process.env.SAMURAI_TOOL_BRIDGE_URL?.trim();
    const endpoint = explicit ? explicit.replace(/\{run_id\}/g, encodeURIComponent(input.runId)) : `http://127.0.0.1:${process.env.PORT?.trim() || "4317"}/api/backend-runs/${encodeURIComponent(input.runId)}/tool-calls`;
    return { enabled: true, server_name: "samurai", endpoint_url: endpoint, token: randomBytes(32).toString("hex"), token_env: "SAMURAI_TOOL_BRIDGE_TOKEN", tools: samuraiToolBridgeDescriptors };
  }
}
