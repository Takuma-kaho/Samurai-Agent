// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { sessionValueSchema } from "../../value-objects/system-records.js";

const Input = z.object({
  "output_locale": SupportedLocaleSchema.optional(),
  "title": z.string().trim().min(1).max(512).optional(),
  "ui_locale": SupportedLocaleSchema.optional()
}).strict();
const Output = sessionValueSchema;

export interface SessionCreatePorts {
  createSession(input: { title?: string; uiLocale?: z.infer<typeof SupportedLocaleSchema>; outputLocale?: z.infer<typeof SupportedLocaleSchema> }): Promise<z.infer<typeof Output>> | z.infer<typeof Output>;
}

const sessionCreate = defineCommand<SessionCreatePorts>()({
  ...{
  "kind": "command",
  "id": "session.create",
  "version": "2.0",
  "availability": "active",
  "title": "Create session",
  "description": "Create a persistent Chat session.",
  "sources": [
    "runtime_api",
    "surface_operation",
    "gateway_inbound",
    "automation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "session"
  ],
  "proposedEffects": [
    "Create a persistent Chat session."
  ],
  "outputResourceKind": "session",
  "uiDisplayCategory": "chat",
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
      execute: async function handleSessionCreate(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.createSession({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.ui_locale === undefined ? {} : { uiLocale: input.ui_locale }),
          ...(input.output_locale === undefined ? {} : { outputLocale: input.output_locale })
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});

export default sessionCreate;
