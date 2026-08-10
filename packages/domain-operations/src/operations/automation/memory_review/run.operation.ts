// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { automationMemoryReviewRunValueSchema } from "../../../value-objects/automation-run.js";

const Input = z.object({}).strict();
const Output = automationMemoryReviewRunValueSchema;

export interface AutomationMemoryReviewRunPorts {
  /** Core09 deliberately leaves this legacy kind stopped until a Session-free executor exists. */
  sessionlessMemoryReviewUnsupported(): never;
}

const automationMemoryReviewRun = defineCommand<AutomationMemoryReviewRunPorts>()({
  ...{
  "kind": "command",
  "id": "automation.memory_review.run",
  "version": "4.0",
  "availability": "active",
  "title": "Run memory review",
  "description": "Keep the legacy memory review automation safely stopped until it has a Session-free executor.",
  "sources": [
    "runtime_api",
    "automation",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "automation_run",
    "reflection_run",
    "memory"
  ],
  "proposedEffects": [
    "Run the scheduled memory review automation."
  ],
  "outputResourceKind": "reflection_run",
  "uiDisplayCategory": "automation",
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
      execute: async function handleAutomationMemoryReviewRun(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.sessionlessMemoryReviewUnsupported();
      }
    };
  }
});

export default automationMemoryReviewRun;
