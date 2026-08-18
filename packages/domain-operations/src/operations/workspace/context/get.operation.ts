// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({ room_id: z.string().trim().min(1).max(512) }).strict();
const Output = z.object({
  workspace: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    rules: z.array(z.string().min(1)).max(200),
    updated_at: z.string().datetime()
  }).strict(),
  room: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    purpose: z.string().min(1).optional(),
    work_goal: z.string().min(1).optional(),
    permissions: z.array(z.string().min(1)).max(20),
    prohibited: z.array(z.string().min(1)).max(20),
    updated_at: z.string().datetime()
  }).strict()
}).strict();

export type WorkspaceContextGetInput = z.infer<typeof Input>;
export type WorkspaceContextGetOutput = z.infer<typeof Output>;

export interface WorkspaceContextGetPorts extends DomainQueryPorts {
  getWorkspaceContext: ReadCapability<(context: TrustedDomainContext, input: WorkspaceContextGetInput) => Promise<WorkspaceContextGetOutput>>;
}

const workspaceContextGet = defineQuery<WorkspaceContextGetPorts>()({
  id: "workspace.context.get",
  version: "1.0",
  availability: "active",
  title: "Get Workspace startup context",
  description: "Read the human-owned Workspace label, rules, and current Room context for a bound external session.",
  sources: ["runtime_api", "external_app"],
  render: ["status_timeline"],
  resourceKinds: ["workspace", "room"],
  proposedEffects: ["Read current Workspace and Room context without changing Workspace state."],
  outputResourceKind: "workspace_context",
  uiDisplayCategory: "workspace",
  provenance: [{
    source: "samurai",
    commit_sha: "workspace-server-05",
    reference_file: "ARCHITECTURE.md",
    decision: "adapted",
    reason: "External startup context reads human-owned Workspace metadata through the same formal, Room-authorized Query boundary as other Workspace content."
  }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleWorkspaceContextGet(context: TrustedDomainContext, input: WorkspaceContextGetInput): Promise<DomainResult<WorkspaceContextGetOutput>> {
        return { ok: true, value: Output.parse(await ports.getWorkspaceContext(context, input)) };
      }
    };
  }
});

export default workspaceContextGet;
