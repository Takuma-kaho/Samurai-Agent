import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import { agentValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ id: z.string().trim().min(1) }).strict();
const Output = agentValueSchema;
export interface AgentViewPorts extends DomainQueryPorts { viewAgent: ReadCapability<(context: TrustedDomainContext, id: string) => Promise<z.infer<typeof Output>>>; }
const agentView = defineQuery<AgentViewPorts>()({
  id: "agent.view", version: "1.0", availability: "active", title: "View Agent", description: "Read one Agent.",
  sources: ["runtime_api"], render: ["status_timeline"], resourceKinds: ["agent"], proposedEffects: ["Read an Agent."], outputResourceKind: "agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Read Agent records through the Runtime boundary." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentView(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.viewAgent(context, input.id)) }; } }; }
});
export default agentView;
