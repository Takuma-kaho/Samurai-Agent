import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { agentDmValueSchema } from "../room/work-contracts.js";

const Input = z.object({ agent_id: z.string().trim().min(1).max(512) }).strict();
const Output = agentDmValueSchema;

export type AgentDmOpenInput = z.infer<typeof Input>;
export interface AgentDmOpenPorts {
  openAgentDm(context: TrustedDomainContext, input: { agentId: string }): Promise<z.infer<typeof Output>>;
}

const agentDmOpen = defineCommand<AgentDmOpenPorts>()({
  id: "agent.dm.open", version: "1.0", availability: "active", title: "Open Agent DM",
  description: "Create or retrieve the caller's private Room-backed DM with one registered Agent.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["chat", "status_timeline"], resourceKinds: ["room", "agent", "agent_dm"],
  proposedEffects: ["Open or reuse a private Agent DM Room without sharing another person's history."], outputResourceKind: "agent_dm", uiDisplayCategory: "agent",
  provenance: [{ source: "samurai", commit_sha: "room-agent-collaboration-v1", reference_file: "docs/designs/room-agent-work.md", decision: "adapted", reason: "An Agent DM is a deduplicated private Room using normal Room authorization, not a separate unrestricted conversation store." }],
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleAgentDmOpen(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const value = await ports.openAgentDm(context, { agentId: input.agent_id });
      return { ok: true, value: Output.parse(value) };
    } };
  }
});

export default agentDmOpen;
