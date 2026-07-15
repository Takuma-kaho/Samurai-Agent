// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { curatorRunValueSchema } from "../../value-objects/learning-run.js";

const Input = z.object({
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "text": z.string() .optional()
}).strict();
const Output = curatorRunValueSchema;

export interface CuratorRunPorts {
  executeCuratorRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const curatorRun = defineCommand<CuratorRunPorts>()({
  ...{
  "kind": "command",
  "id": "curator.run",
  "version": "1.0",
  "availability": "active",
  "title": "Run Curator",
  "description": "Run evaluation-aware Memory and Skill curation after creating a snapshot.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "reflection_run",
    "memory",
    "skill",
    "learning_snapshot"
  ],
  "proposedEffects": [
    "Curate learning resources after a restorable snapshot."
  ],
  "outputResourceKind": "reflection_run",
  "uiDisplayCategory": "memory",
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
      execute: async function handleCuratorRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeCuratorRun(context, input);
      }
    };
  }
});

export default curatorRun;
