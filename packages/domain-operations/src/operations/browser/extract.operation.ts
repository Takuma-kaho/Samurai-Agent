// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { browserExtractValueSchema } from "../../value-objects/browser.js";

const Input = z.object({
  "url": z.string().trim().url().max(8192)
}).strict();
const Output = browserExtractValueSchema;

export type BrowserExtractInput = z.infer<typeof Input>;
export type BrowserExtractOutput = z.infer<typeof Output>;

export interface BrowserExtractPorts extends DomainQueryPorts {
  extractBrowserPage: ReadCapability<(input: Pick<BrowserExtractInput, "url">) => Promise<BrowserExtractOutput> | BrowserExtractOutput>;
}

const browserExtract = defineQuery<BrowserExtractPorts>()({
  ...{
  "kind": "query",
  "id": "browser.extract",
  "version": "2.0",
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
        return { ok: true, value: Output.parse(await ports.extractBrowserPage({ url: input.url })) };
      }
    };
  }
});

export default browserExtract;
