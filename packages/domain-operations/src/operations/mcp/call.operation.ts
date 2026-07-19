// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { type JsonValue } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { mcpCallValueSchema } from "../../value-objects/tool-execution.js";

const toolInputSchema = z.record(domainJsonValueSchema)
  .refine((value) => Object.keys(value).length <= 128, "mcp_tool_input_too_large")
  .default({});
const Input = z.object({
  server_name: z.string().trim().min(1).max(128),
  tool_name: z.string().trim().min(1).max(256),
  input: toolInputSchema,
  metadata: z.object({
    tool_call_id: z.string().trim().min(1).max(256).optional()
  }).strict().default({})
}).strict();
const Output = mcpCallValueSchema;

export type McpCallInput = z.infer<typeof Input>;

export interface McpCallRequest {
  serverName: string;
  toolName: string;
  input: Record<string, JsonValue>;
  toolCallId?: string;
}

export interface McpCallPorts {
  executeMcpCall(context: TrustedDomainContext, request: McpCallRequest): Promise<z.infer<typeof Output>>;
}

const mcpCall = defineCommand<McpCallPorts>()({
  ...{
  "kind": "command",
  "id": "mcp.call",
  "version": "3.0",
  "availability": "active",
  "title": "Call MCP tool",
  "description": "Call an MCP tool through stored Gateway MCP configuration.",
  "sources": [
    "provider_tool_call"
  ],
  "effect": "external_effect",
  "idempotency": "external",
  "concurrency": "external_idempotency",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "mcp_server",
    "mcp_tool"
  ],
  "proposedEffects": [
    "Call an MCP tool through the Gateway boundary."
  ],
  "outputResourceKind": "mcp_tool",
  "uiDisplayCategory": "gateway",
  "providerToolNames": [
    "mcp.call"
  ],
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleMcpCall(context: TrustedDomainContext, input: McpCallInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: McpCallRequest = {
          serverName: input.server_name,
          toolName: input.tool_name,
          input: input.input,
          toolCallId: input.metadata.tool_call_id
        };
        const value = await ports.executeMcpCall(context, request);
        return { ok: true, value };
      }
    };
  }
});

export default mcpCall;
