// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserInteractionSchema } from "../../value-objects/browser.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "action": z.enum(["navigate", "click", "input"]).default("navigate"),
  "selector": z.string().trim().min(1).max(4_096).optional(),
  "url": z.string().trim().url().max(8_192),
  "value": z.string().max(100_000).optional()
}).strict().superRefine((input, context) => {
  if (input.action !== "navigate" && input.selector === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["selector"], message: "selector is required for click and input actions" });
  }
  if (input.action === "input" && input.value === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "value is required for input actions" });
  }
  if (input.action === "navigate" && (input.selector !== undefined || input.value !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: "navigate actions cannot include selector or value" });
  }
  if (input.action === "click" && input.value !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "click actions cannot include value" });
  }
});
const Output = runtimeWriteValueSchema(browserInteractionSchema);

export interface BrowserInteractionRequest {
  url: string;
  action: "navigate" | "click" | "input";
  selector?: string;
  value?: string;
}

export interface BrowserInteractPorts {
  interactWithBrowser(input: BrowserInteractionRequest): Promise<z.infer<typeof browserInteractionSchema>>;
  ensureBrowserSession(): Promise<SessionRecord>;
  createBrowserEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  stableBrowserHash(value: unknown): string;
  runBrowserMutation(input: {
    session: SessionRecord;
    envelope: MessageEnvelope;
    operationName: string;
    proposedEffects: string[];
    execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof browserInteractionSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
  }): Promise<{ resource: z.infer<typeof browserInteractionSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const browserInteract = defineCommand<BrowserInteractPorts>()({
  ...{
  "kind": "command",
  "id": "browser.interact",
  "version": "5.0",
  "availability": "active",
  "runtimeRequirements": ["browser_adapter"],
  "title": "Interact with browser",
  "description": "Navigate or perform a potentially externally visible click or input through a configured real browser adapter.",
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
    "Navigate or perform a potentially externally visible browser interaction through the configured adapter."
  ],
  "outputResourceKind": "browser_page",
  "uiDisplayCategory": "browser",
  "providerToolNames": [
    "browser.interact"
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
      execute: async function handleBrowserInteract(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureBrowserSession();
        const envelope = ports.createBrowserEnvelope(session, `browser.interact: ${input.url}`);
        const operationName = input.action === "navigate" ? "browser.navigate" : "browser.interact";
        const proposedEffects = input.action === "navigate"
          ? [`browser.navigate ${input.url} without mutating external state.`]
          : [`browser.interact ${input.action} ${input.url} may mutate external state and requires approval.`];
        const value = await ports.runBrowserMutation({
          session,
          envelope,
          operationName,
          proposedEffects,
          execute: async () => {
            const resource = await ports.interactWithBrowser({
              url: input.url,
              action: input.action,
              ...(input.selector === undefined ? {} : { selector: input.selector }),
              ...(input.value === undefined ? {} : { value: input.value })
            });
            const ref: ResourceRef = {
              kind: "browser_page",
              id: ports.stableBrowserHash(resource.url),
              uri: resource.url,
              label: resource.title || resource.url
            };
            return { resource, ref, summary: `Completed browser ${input.action} through ${resource.adapterId}.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default browserInteract;
