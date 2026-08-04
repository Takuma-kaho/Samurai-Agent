import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { agentValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({}).strict();
const Output = z.array(agentValueSchema);
export interface AgentListPorts extends DomainQueryPorts { listAgents: ReadCapability<(context: TrustedDomainContext) => Promise<z.infer<typeof Output>>>; }
const agentList = defineQuery<AgentListPorts>()({
  id: "agent.list", version: "1.0", availability: "active", title: "List Agents", description: "List stable Agents in the current Workspace.",
  sources: ["runtime_api"], render: ["table"], resourceKinds: ["agent"], proposedEffects: ["Read Agents."], outputResourceKind: "agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Read Agent records through the Runtime boundary." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.listAgents(context)) }; } }; }
});
export default agentList;
