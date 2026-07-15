// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { rollbackRestoreValueSchema } from "../../value-objects/rollback.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "rollback_point_id": z.string(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional()
}).strict();
const Output = rollbackRestoreValueSchema;

export interface RollbackRestorePorts {
  executeRollbackRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const rollbackRestore = defineCommand<RollbackRestorePorts>()({
  ...{
  "kind": "command",
  "id": "rollback.restore",
  "version": "1.0",
  "availability": "active",
  "title": "Restore rollback point",
  "description": "Restore a reversible local workspace snapshot.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "rollback_point",
    "file"
  ],
  "proposedEffects": [
    "Restore a reversible local workspace snapshot from a rollback point."
  ],
  "outputResourceKind": "rollback_point",
  "uiDisplayCategory": "run_history",
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
      execute: async function handleRollbackRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeRollbackRestore(context, input);
      }
    };
  }
});

export default rollbackRestore;
