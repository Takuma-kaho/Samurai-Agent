// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserScreenshotSchema } from "../../value-objects/browser.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "output_path": z.string().trim().min(1).optional(),
  "url": z.string().url()
}).strict();
const Output = runtimeWriteValueSchema(browserScreenshotSchema);

export interface BrowserScreenshotPorts {
  captureBrowserScreenshot(url: string): Promise<{ adapterId: string; bytes: Uint8Array; mimeType: "image/png" | "image/jpeg"; width?: number; height?: number }>;
  ensureBrowserSession(): Promise<SessionRecord>;
  createBrowserEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  stableBrowserHash(value: unknown): string;
  browserBytesToBase64(bytes: Uint8Array): string;
  resolveBrowserWorkspacePath(path: string): { absolutePath: string; relativePath: string };
  ensureBrowserWorkspaceParent(path: string): Promise<void>;
  readBrowserWorkspaceBytes(path: string): Promise<Uint8Array | undefined>;
  writeBrowserWorkspaceFile(path: string, content: Uint8Array): Promise<void>;
  createBrowserRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runBrowserMutation(input: {
    session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[];
    execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof browserScreenshotSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
  }): Promise<{ resource: z.infer<typeof browserScreenshotSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const browserScreenshot = defineCommand<BrowserScreenshotPorts>()({
  ...{
  "kind": "command",
  "id": "browser.screenshot",
  "version": "3.0",
  "availability": "active",
  "runtimeRequirements": ["browser_adapter"],
  "title": "Capture browser screenshot",
  "description": "Capture a real viewport image through a configured screenshot-capable adapter.",
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
    "Capture a real browser viewport image into the workspace."
  ],
  "outputResourceKind": "file",
  "uiDisplayCategory": "browser",
  "providerToolNames": [
    "browser.screenshot"
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
      execute: async function handleBrowserScreenshot(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const session = await ports.ensureBrowserSession();
        const envelope = ports.createBrowserEnvelope(session, `browser.screenshot: ${input.url}`);
        const value = await ports.runBrowserMutation({
          session, envelope, operationName: "browser.screenshot",
          proposedEffects: [`browser.screenshot ${input.url} without mutating external state.`],
          execute: async (operation) => {
            const capture = await ports.captureBrowserScreenshot(input.url);
            const extension = capture.mimeType === "image/jpeg" ? "jpg" : "png";
            const target = ports.resolveBrowserWorkspacePath(input.output_path ?? `browser/${ports.stableBrowserHash(input.url)}.${extension}`);
            await ports.ensureBrowserWorkspaceParent(target.absolutePath);
            const before = await ports.readBrowserWorkspaceBytes(target.absolutePath);
            await ports.writeBrowserWorkspaceFile(target.absolutePath, capture.bytes);
            const ref: ResourceRef = { kind: "file", id: target.relativePath, uri: target.relativePath, label: target.relativePath };
            const rollbackPoint = await ports.createBrowserRollback(operation, [ref], { path: target.relativePath, content: before ? ports.browserBytesToBase64(before) : null }, { path: target.relativePath, content_hash: ports.stableBrowserHash(capture.bytes) });
            const resource = { url: input.url, file_path: target.relativePath, screenshot_ref: target.relativePath, adapter_id: capture.adapterId, mime_type: capture.mimeType, width: capture.width, height: capture.height };
            return { resource, ref, rollbackPoint, summary: `Captured a real browser screenshot from ${input.url}.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default browserScreenshot;
