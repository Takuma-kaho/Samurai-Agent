import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { workspaceMemberValueSchema } from "../../value-objects/room-permissions.js";

const Input = z.object({}).strict();
const Output = z.array(workspaceMemberValueSchema);
export interface WorkspaceMemberListPorts extends DomainQueryPorts { listWorkspaceMembers: ReadCapability<(context: TrustedDomainContext) => Promise<z.infer<typeof Output>>>; }
const workspaceMemberList = defineQuery<WorkspaceMemberListPorts>()({
  id: "workspace.member.list", version: "1.0", availability: "active", title: "List Workspace members", description: "List current Workspace members.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["workspace_member"], proposedEffects: ["Read Workspace members."], outputResourceKind: "workspace_member", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Membership administration is distinct from Room access." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleWorkspaceMemberList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listWorkspaceMembers(context)) }; } }; }
});
export default workspaceMemberList;
