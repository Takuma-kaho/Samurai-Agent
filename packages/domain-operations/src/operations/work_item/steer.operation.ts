// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, requireRoomContext, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { workItemValueSchema } from "../../value-objects/work.js";

const Input = z.object({
  "instruction": z.string().trim().min(1).max(10_000).optional(),
  "work_item_id": z.string().trim().min(1).max(256)
}).strict();
const Output = workItemValueSchema;

export interface WorkItemSteerPorts {
  steerWorkItem(input: { workItemId: string; instruction?: string; roomId: string }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const workItemSteer = defineCommand<WorkItemSteerPorts>()({
  ...{
  "kind": "command",
  "id": "work_item.steer",
  "version": "2.0",
  "availability": "active",
  "title": "Steer work item",
  "description": "Persist a steering instruction on the current work item.",
  "sources": [
    "runtime_api",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "work_item"
  ],
  "proposedEffects": [
    "Add a steering instruction to the current work item."
  ],
  "outputResourceKind": "work_item",
  "uiDisplayCategory": "activity",
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
      execute: async function handleWorkItemSteer(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.steerWorkItem({
          workItemId: input.work_item_id,
          roomId: requireRoomContext(context, "work_item.steer"),
          ...(input.instruction === undefined ? {} : { instruction: input.instruction })
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});

export default workItemSteer;
