// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserPageSchema } from "../../value-objects/browser.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "url": z.string().url()
}).strict();
const Output = runtimeWriteValueSchema(browserPageSchema);

export interface BrowserNavigatePorts {
  readBrowserPage(url: string): Promise<z.infer<typeof browserPageSchema>>;
  ensureBrowserSession(): Promise<SessionRecord>;
  createBrowserEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  stableBrowserHash(value: unknown): string;
  runBrowserMutation(input: {
    session: SessionRecord;
    envelope: MessageEnvelope;
    operationName: string;
    proposedEffects: string[];
    execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof browserPageSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
  }): Promise<{ resource: z.infer<typeof browserPageSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const browserNavigate = defineCommand<BrowserNavigatePorts>()({
  ...{
  "kind": "command",
  "id": "browser.navigate",
  "version": "4.0",
  "availability": "active",
  "runtimeRequirements": ["browser_adapter"],
  "title": "Navigate browser page",
  "description": "Navigate or fetch a browser-readable page for workspace use.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "runtime_control",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "browser_page"
  ],
  "proposedEffects": [
    "Read a browser page without mutating external state."
  ],
  "outputResourceKind": "browser_page",
  "uiDisplayCategory": "browser",
  "providerToolNames": [
    "browser.navigate"
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
      execute: async function handleBrowserNavigate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureBrowserSession();
        const envelope = ports.createBrowserEnvelope(session, `browser.navigate: ${input.url}`);
        const value = await ports.runBrowserMutation({
          session,
          envelope,
          operationName: "browser.navigate",
          proposedEffects: [`browser.navigate ${input.url} without mutating external state.`],
          execute: async () => {
            const resource = await ports.readBrowserPage(input.url);
            const ref: ResourceRef = {
              kind: "browser_page",
              id: ports.stableBrowserHash(input.url),
              uri: input.url,
              label: resource.title || input.url
            };
            return { resource, ref, summary: `Read browser page ${input.url}.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default browserNavigate;
