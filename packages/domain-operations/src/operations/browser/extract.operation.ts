// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineQuery, type DomainQueryPorts, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserExtractValueSchema } from "../../value-objects/browser.js";

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
  "url": z.string() .optional()
}).strict();
const Output = browserExtractValueSchema;

export interface BrowserExtractPorts extends DomainQueryPorts {
  executeBrowserExtract(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const browserExtract = defineQuery<BrowserExtractPorts>()({
  ...{
  "kind": "query",
  "id": "browser.extract",
  "version": "1.0",
  "availability": "active",
  "title": "Extract browser page",
  "description": "Extract text from a browser-readable page.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "read_only",
  "idempotency": "none",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "browser_page"
  ],
  "proposedEffects": [
    "Read browser_page without changing Workspace state."
  ],
  "outputResourceKind": "browser_page",
  "uiDisplayCategory": "browser",
  "providerToolNames": [
    "browser.extract"
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
      execute: async function handleBrowserExtract(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeBrowserExtract(context, input);
      }
    };
  }
});

export default browserExtract;
