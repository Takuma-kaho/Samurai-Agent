// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { sandboxExecValueSchema } from "../../value-objects/tool-execution.js";

const Input = z.object({
  "command": z.string(),
  "args": z.array(z.string()).optional(),
  "cwd": z.string().optional(),
  "env": z.record(z.string()).optional(),
  "stdin": z.string().optional(),
  "secret_env": z.record(z.string()).optional(),
  "timeout_ms": z.number().int().positive().optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = sandboxExecValueSchema;

export interface SandboxExecPorts {
  executeSandboxExec(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const sandboxExec = defineCommand<SandboxExecPorts>()({
  ...{
  "kind": "command",
  "id": "sandbox.exec",
  "version": "2.0",
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
      execute: async function handleSandboxExec(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeSandboxExec(context, input);
      }
    };
  }
});

export default sandboxExec;
