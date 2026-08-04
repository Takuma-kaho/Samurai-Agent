import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { agentWorkspacePermissionValueSchema } from "../../value-objects/room-permissions.js";

// The operation itself names the only supported permission. Keeping a
// redundant literal in the public input would imply a generic permission
// system that Core 06 deliberately does not create.
const Input = z.object({ agent_id: z.string().trim().min(1), allowed: z.boolean() }).strict();
const Output = agentWorkspacePermissionValueSchema.nullable();
export interface AgentWorkspacePermissionSetPorts { setAgentRoomCreatePermission(context: TrustedDomainContext, input: { agentId: string; allowed: boolean }): Promise<z.infer<typeof Output>>; }
const agentWorkspacePermissionSet = defineCommand<AgentWorkspacePermissionSetPorts>()({
  id: "agent.workspace_permission.set", version: "1.0", availability: "active", title: "Set Agent Room creation permission", description: "Grant or revoke the explicit Agent Room creation permission.",
  sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition", render: ["status_timeline"], resourceKinds: ["agent_workspace_permission"], proposedEffects: ["Change Agent Room creation permission."], outputResourceKind: "agent_workspace_permission", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "core-06", reference_file: "SAMURAI_AGENT_MANUAL.md", decision: "adapted", reason: "Agents can create Rooms only through an explicit permission." }], input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentWorkspacePermissionSet(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse((await ports.setAgentRoomCreatePermission(context, { agentId: input.agent_id, allowed: input.allowed })) ?? null) }; } }; }
});
export default agentWorkspacePermissionSet;
