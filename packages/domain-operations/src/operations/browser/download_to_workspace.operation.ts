// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserDownloadSchema } from "../../value-objects/browser.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "action": z.string() .optional(),
  "envelope_id": z.string() .optional(),
  "input_locale": z.string() .optional(),
  "input_message_id": z.string() .optional(),
  "metadata": z.record(domainJsonValueSchema) .optional(),
  "output_locale": z.string() .optional(),
  "output_path": z.string() .optional(),
  "provider_tool_call": z.boolean() .optional(),
  "selector": z.string() .optional(),
  "session_id": z.string() .optional(),
  "source_operation_id": z.string() .optional(),
  "surface_operation_id": z.string() .optional(),
  "url": z.string() .optional(),
  "value": z.string() .optional()
}).strict();
const Output = runtimeWriteValueSchema(browserDownloadSchema);

export interface BrowserDownloadToWorkspacePorts {
  executeBrowserDownloadToWorkspace(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> | DomainResult<z.infer<typeof Output>>;
}

const browserDownloadToWorkspace = defineCommand<BrowserDownloadToWorkspacePorts>()({
  ...{
  "kind": "command",
  "id": "browser.download_to_workspace",
  "version": "2.0",
  "availability": "active",
  "title": "Download browser page",
  "description": "Download browser-readable content into the local workspace.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "browser_page",
    "file"
  ],
  "proposedEffects": [
    "Download browser-readable content into the local workspace."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "browser",
  "providerToolNames": [
    "browser.download_to_workspace"
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
      execute: async function handleBrowserDownloadToWorkspace(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return ports.executeBrowserDownloadToWorkspace(context, input);
      }
    };
  }
});

export default browserDownloadToWorkspace;
