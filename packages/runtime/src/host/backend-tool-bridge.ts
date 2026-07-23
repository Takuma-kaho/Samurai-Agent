import { randomBytes } from "node:crypto";
import type { BackendToolBridge } from "@samurai-agent/agent-backends";
import type { AgentBackendKind } from "@samurai-agent/core-schemas";
import { samuraiToolBridgeDescriptors } from "../provider-tool-bridge-composition";
import type { BackendContextIntent, BackendExpectedOutput } from "./turn-preparation-policy";

export function createBackendToolBridge(input: {
  backendKind: AgentBackendKind;
  runId: string;
  expectedOutputs: BackendExpectedOutput[];
  contextIntent: BackendContextIntent;
  gatewayBoundaryPresent: boolean;
}): BackendToolBridge | undefined {
  if (input.gatewayBoundaryPresent) return undefined;
  if (input.backendKind !== "claude_code" && input.backendKind !== "codex" && input.backendKind !== "external") return undefined;
  return {
    enabled: true,
    server_name: "samurai",
    endpoint_url: toolBridgeEndpointUrl(input.runId),
    token: randomBytes(32).toString("hex"),
    token_env: "SAMURAI_TOOL_BRIDGE_TOKEN",
    tools: samuraiToolBridgeDescriptors
  };
}

function toolBridgeEndpointUrl(runId: string): string {
  const explicit = process.env.SAMURAI_TOOL_BRIDGE_URL?.trim();
  if (explicit) return explicit.replace(/\{run_id\}/g, encodeURIComponent(runId));
  const port = process.env.PORT?.trim() || "4317";
  return `http://127.0.0.1:${port}/api/backend-runs/${encodeURIComponent(runId)}/tool-calls`;
}
