// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { GatewayMcpConfigRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayMcpConfigValueSchema } from "../../../value-objects/gateway.js";

const Input: z.ZodType<
  GatewayMcpConfigRecord,
  z.ZodTypeDef,
  z.input<typeof gatewayMcpConfigValueSchema>
> = gatewayMcpConfigValueSchema;
const Output = gatewayMcpConfigValueSchema;

export interface GatewayMcpConfigSavePorts {
  executeGatewayMcpConfigSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const gatewayMcpConfigSave = defineCommand<GatewayMcpConfigSavePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.mcp_config.save",
  "version": "2.0",
  "availability": "active",
  "title": "Save Gateway MCP config",
  "description": "Save a validated Gateway MCP server configuration.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "gateway_mcp_config"
  ],
  "proposedEffects": [
    "Save a Gateway MCP server configuration."
  ],
  "outputResourceKind": "gateway_mcp_config",
  "uiDisplayCategory": "gateway",
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
      execute: async function handleGatewayMcpConfigSave(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeGatewayMcpConfigSave(context, input);
      }
    };
  }
});

export default gatewayMcpConfigSave;
