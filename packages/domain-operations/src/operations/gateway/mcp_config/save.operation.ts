// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import {
  ResourceRefSchema,
  SecretRefSchema,
  type JsonValue,
  type ResourceRef,
  type SecretRef
} from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { gatewayMcpConfigValueSchema } from "../../../value-objects/gateway.js";

const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const boundedStringMapSchema = z.record(environmentVariableNameSchema, z.string().max(32_768))
  .refine((values) => Object.keys(values).length <= 128, "gateway_mcp_environment_too_large")
  .default({});
const boundedMetadataSchema = z.record(domainJsonValueSchema)
  .refine((metadata) => Object.keys(metadata).length <= 128, "gateway_mcp_metadata_too_large");
const secretFileSchema = z.object({
  secret_ref_id: z.string().trim().min(1).max(256),
  filename: z.string().trim().min(1).max(255).refine((value) => !value.includes("/") && !value.includes("\\"), "gateway_mcp_secret_filename_invalid"),
  env: environmentVariableNameSchema,
  mode: z.number().int().min(0).max(0o777).optional()
}).strict();
const stdioSchema = z.object({
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(256).default([]),
  cwd: z.string().trim().min(1).max(4_096).optional(),
  env: boundedStringMapSchema,
  secret_env: z.record(environmentVariableNameSchema, z.string().trim().min(1).max(256))
    .refine((values) => Object.keys(values).length <= 128, "gateway_mcp_secret_environment_too_large")
    .default({}),
  secret_files: z.array(secretFileSchema).max(64).default([]),
  framing: z.enum(["json_lines", "content_length"]).default("json_lines"),
  initialize: z.boolean().default(true),
  timeout_ms: z.number().int().min(1).max(3_600_000).optional()
}).strict();
const httpSchema = z.object({
  endpoint_url: z.string().url().max(8_192),
  headers: boundedStringMapSchema,
  secret_headers: z.record(z.string().trim().min(1).max(256), z.string().trim().min(1).max(256))
    .refine((values) => Object.keys(values).length <= 128, "gateway_mcp_secret_headers_too_large")
    .default({}),
  timeout_ms: z.number().int().min(1).max(3_600_000).optional()
}).strict();
const baseInputShape = {
  /** Omit to create a server-owned config identifier. */
  id: z.string().trim().min(1).max(256).optional(),
  server_name: z.string().trim().min(1).max(128),
  enabled: z.boolean().optional(),
  allowed_tools: z.array(z.string().trim().min(1).max(256)).max(1_024).optional(),
  /** `null` deliberately clears the previously configured resource reference. */
  config_ref: ResourceRefSchema.nullable().optional(),
  secret_refs: z.array(SecretRefSchema).max(128).optional(),
  metadata: boundedMetadataSchema.optional()
};
const Input = z.discriminatedUnion("transport", [
  z.object({ ...baseInputShape, transport: z.literal("stdio"), stdio: stdioSchema, http: z.never().optional() }).strict(),
  z.object({ ...baseInputShape, transport: z.literal("http"), http: httpSchema, stdio: z.never().optional() }).strict()
]);
const Output = gatewayMcpConfigValueSchema;

export type GatewayMcpConfigSaveInput = z.infer<typeof Input>;

interface GatewayMcpConfigSaveRequestBase {
  id?: string;
  serverName: string;
  enabled?: boolean;
  allowedTools?: string[];
  configRef?: ResourceRef | null;
  secretRefs?: SecretRef[];
  metadata?: Record<string, JsonValue>;
}

interface GatewayMcpStdioSaveRequest {
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  secretEnvironment: Record<string, string>;
  secretFiles: Array<{ secretRefId: string; filename: string; environmentName: string; mode?: number }>;
  framing: "json_lines" | "content_length";
  initialize: boolean;
  timeoutMs?: number;
}

interface GatewayMcpHttpSaveRequest {
  endpointUrl: string;
  headers: Record<string, string>;
  secretHeaders: Record<string, string>;
  timeoutMs?: number;
}

export type GatewayMcpConfigSaveRequest = GatewayMcpConfigSaveRequestBase & (
  | { transport: "stdio"; stdio: GatewayMcpStdioSaveRequest }
  | { transport: "http"; http: GatewayMcpHttpSaveRequest }
);

export interface GatewayMcpConfigSavePorts {
  saveGatewayMcpConfig(request: GatewayMcpConfigSaveRequest): Promise<z.infer<typeof Output>>;
}

const gatewayMcpConfigSave = defineCommand<GatewayMcpConfigSavePorts>()({
  ...{
  "kind": "command",
  "id": "gateway.mcp_config.save",
  "version": "4.0",
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
      execute: async function handleGatewayMcpConfigSave(_context: TrustedDomainContext, input: GatewayMcpConfigSaveInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const common: GatewayMcpConfigSaveRequestBase = {
          id: input.id,
          serverName: input.server_name,
          enabled: input.enabled,
          allowedTools: input.allowed_tools,
          configRef: input.config_ref,
          secretRefs: input.secret_refs,
          metadata: input.metadata
        };
        const request: GatewayMcpConfigSaveRequest = input.transport === "stdio"
          ? {
              ...common,
              transport: "stdio",
              stdio: {
                command: input.stdio.command,
                args: input.stdio.args,
                cwd: input.stdio.cwd,
                environment: input.stdio.env,
                secretEnvironment: input.stdio.secret_env,
                secretFiles: input.stdio.secret_files.map((file) => ({
                  secretRefId: file.secret_ref_id,
                  filename: file.filename,
                  environmentName: file.env,
                  mode: file.mode
                })),
                framing: input.stdio.framing,
                initialize: input.stdio.initialize,
                timeoutMs: input.stdio.timeout_ms
              }
            }
          : {
              ...common,
              transport: "http",
              http: {
                endpointUrl: input.http.endpoint_url,
                headers: input.http.headers,
                secretHeaders: input.http.secret_headers,
                timeoutMs: input.http.timeout_ms
              }
            };
        const value = await ports.saveGatewayMcpConfig(request);
        return { ok: true, value };
      }
    };
  }
});

export default gatewayMcpConfigSave;
