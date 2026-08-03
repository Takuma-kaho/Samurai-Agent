// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { curatorRunValueSchema } from "../../value-objects/learning-run.js";

const Input = z.object({
  "respect_idle_gate": z.boolean().optional(),
  "reason": z.enum(["replacement", "refutation", "environment_changed", "user_request", "restore", "archive"]).optional(),
  "resource_kind": z.enum(["memory", "wiki", "skill"]).optional(),
  "resource_id": z.string().trim().min(1).optional()
}).strict();
const Output = curatorRunValueSchema;

export interface CuratorRunPorts {
  runCurator(input: { respectIdleGate?: boolean; reason?: "replacement" | "refutation" | "environment_changed" | "user_request" | "restore" | "archive"; resourceKind?: "memory" | "wiki" | "skill"; resourceId?: string }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const curatorRun = defineCommand<CuratorRunPorts>()({
  ...{
  "kind": "command",
  "id": "curator.run",
  "version": "5.0",
  "availability": "active",
  "title": "Run Curator",
  "description": "Run a reason-driven Curator review without time-based Resource changes.",
  "sources": [
    "runtime_api"
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
    "Record a reason-driven review without automatic deletion, archive, merge, or Scope expansion."
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
      execute: async function handleCuratorRun(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.runCurator({
          ...(input.respect_idle_gate === undefined ? {} : { respectIdleGate: input.respect_idle_gate }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.resource_kind === undefined ? {} : { resourceKind: input.resource_kind }),
          ...(input.resource_id === undefined ? {} : { resourceId: input.resource_id })
        })) };
      }
    };
  }
});

export default curatorRun;
