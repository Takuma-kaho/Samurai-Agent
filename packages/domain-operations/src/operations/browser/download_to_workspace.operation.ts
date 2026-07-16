// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { browserDownloadSchema } from "../../value-objects/browser.js";
import { runtimeWriteValueSchema } from "../../value-objects/runtime-write.js";

const Input = z.object({
  "output_path": z.string().trim().min(1).optional(),
  "url": z.string().url()
}).strict();
const Output = runtimeWriteValueSchema(browserDownloadSchema);

export interface BrowserDownloadToWorkspacePorts {
  readBrowserPage(url: string): Promise<Omit<z.infer<typeof browserDownloadSchema>, "file_path" | "snapshot_kind">>;
  ensureBrowserSession(): Promise<SessionRecord>;
  createBrowserEnvelope(session: SessionRecord, content: string): MessageEnvelope;
  stableBrowserHash(value: unknown): string;
  resolveBrowserWorkspacePath(path: string): { absolutePath: string; relativePath: string };
  ensureBrowserWorkspaceParent(path: string): Promise<void>;
  readBrowserWorkspaceText(path: string): Promise<string | undefined>;
  writeBrowserWorkspaceFile(path: string, content: string): Promise<void>;
  createBrowserRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runBrowserMutation(input: {
    session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[];
    execute(operation: OperationRecord): Promise<{ resource: z.infer<typeof browserDownloadSchema>; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }>;
  }): Promise<{ resource: z.infer<typeof browserDownloadSchema>; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
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
        const session = await ports.ensureBrowserSession();
        const envelope = ports.createBrowserEnvelope(session, `browser.download_to_workspace: ${input.url}`);
        const value = await ports.runBrowserMutation({
          session, envelope, operationName: "browser.download_to_workspace",
          proposedEffects: [`browser.download_to_workspace ${input.url} without mutating external state.`],
          execute: async (operation) => {
            const page = await ports.readBrowserPage(input.url);
            const target = ports.resolveBrowserWorkspacePath(input.output_path ?? `browser/${ports.stableBrowserHash(input.url)}.txt`);
            await ports.ensureBrowserWorkspaceParent(target.absolutePath);
            const before = await ports.readBrowserWorkspaceText(target.absolutePath);
            await ports.writeBrowserWorkspaceFile(target.absolutePath, page.text);
            const ref: ResourceRef = { kind: "file", id: target.relativePath, uri: target.relativePath, label: target.relativePath };
            const rollbackPoint = await ports.createBrowserRollback(operation, [ref], { path: target.relativePath, content: before ?? null }, { path: target.relativePath, content: page.text });
            return { resource: { ...page, file_path: target.relativePath, snapshot_kind: "html_snapshot" }, ref, rollbackPoint, summary: `Saved an HTML/text snapshot from ${input.url} into the workspace.` };
          }
        });
        return { ok: true, value };
      }
    };
  }
});

export default browserDownloadToWorkspace;
