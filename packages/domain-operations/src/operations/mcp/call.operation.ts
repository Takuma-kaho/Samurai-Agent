// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { mcpCallValueSchema } from "../../value-objects/tool-execution.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "server_name": z.string(),
  "tool_name": z.string(),
  "input": z.record(domainJsonValueSchema).optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = mcpCallValueSchema;

export interface McpCallPorts {
  executeMcpCall(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const mcpCall = defineCommand<McpCallPorts>()({
  ...{
  "kind": "command",
  "id": "mcp.call",
  "version": "1.0",
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
      execute: async function handleMcpCall(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeMcpCall(context, input);
      }
    };
  }
});

export default mcpCall;
