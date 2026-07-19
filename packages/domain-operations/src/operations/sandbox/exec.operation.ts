// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { sandboxExecValueSchema } from "../../value-objects/tool-execution.js";

const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128);
const environmentSchema = z.record(environmentVariableNameSchema, z.string().max(32_768))
  .refine((values) => Object.keys(values).length <= 128, "sandbox_environment_too_large")
  .default({});
const secretEnvironmentSchema = z.record(environmentVariableNameSchema, z.string().trim().min(1).max(256))
  .refine((values) => Object.keys(values).length <= 128, "sandbox_secret_environment_too_large")
  .default({});
const secretFileSchema = z.object({
  secret_ref_id: z.string().trim().min(1).max(256),
  filename: z.string().trim().min(1).max(255).refine((value) => !value.includes("/") && !value.includes("\\"), "sandbox_secret_filename_invalid"),
  env: environmentVariableNameSchema.optional(),
  mode: z.number().int().min(0).max(0o777).optional()
}).strict();
const Input = z.object({
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(256).default([]),
  cwd: z.string().trim().min(1).max(4_096).optional(),
  env: environmentSchema,
  stdin: z.string().max(1_000_000).optional(),
  secret_env: secretEnvironmentSchema,
  secret_files: z.array(secretFileSchema).max(64).default([]),
  timeout_ms: z.number().int().min(1).max(3_600_000).optional(),
  metadata: z.object({
    tool_call_id: z.string().trim().min(1).max(256).optional()
  }).strict().default({})
}).strict();
const Output = sandboxExecValueSchema;

export type SandboxExecInput = z.infer<typeof Input>;

export interface SandboxExecRequest {
  command: string;
  args: string[];
  cwd?: string;
  environment: Record<string, string>;
  stdin?: string;
  secretEnvironment: Record<string, string>;
  secretFiles: Array<{ secretRefId: string; filename: string; environmentName?: string; mode?: number }>;
  timeoutMs?: number;
  toolCallId?: string;
}

export interface SandboxExecPorts {
  executeSandboxExec(context: TrustedDomainContext, request: SandboxExecRequest): Promise<z.infer<typeof Output>>;
}

const sandboxExec = defineCommand<SandboxExecPorts>()({
  ...{
  "kind": "command",
  "id": "sandbox.exec",
  "version": "3.0",
  "availability": "active",
  "title": "Execute sandbox command",
  "description": "Execute a sandbox command inside the Gateway boundary.",
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
    "sandbox_execution",
    "gateway_sandbox_instance",
    "file"
  ],
  "proposedEffects": [
    "Execute a sandbox command inside the Gateway boundary."
  ],
  "outputResourceKind": "sandbox_execution",
  "uiDisplayCategory": "gateway",
  "providerToolNames": [
    "sandbox.exec"
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
      execute: async function handleSandboxExec(context: TrustedDomainContext, input: SandboxExecInput): Promise<DomainResult<z.infer<typeof Output>>> {
        const request: SandboxExecRequest = {
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          environment: input.env,
          stdin: input.stdin,
          secretEnvironment: input.secret_env,
          secretFiles: input.secret_files.map((file) => ({
            secretRefId: file.secret_ref_id,
            filename: file.filename,
            environmentName: file.env,
            mode: file.mode
          })),
          timeoutMs: input.timeout_ms,
          toolCallId: input.metadata.tool_call_id
        };
        const value = await ports.executeSandboxExec(context, request);
        return { ok: true, value };
      }
    };
  }
});

export default sandboxExec;
