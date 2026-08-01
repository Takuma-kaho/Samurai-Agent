import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { agentValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1).max(200).optional(), role: z.string().trim().min(1).max(500).optional(), instructions: z.string().trim().min(1).max(20_000).optional(), enabled: z.boolean().optional() }).strict().refine((value) => value.name !== undefined || value.role !== undefined || value.instructions !== undefined || value.enabled !== undefined, "agent_patch_empty");
const Output = agentValueSchema;
export interface AgentPatchPorts { patchAgent(input: z.infer<typeof Input>): Promise<z.infer<typeof Output>>; }
const agentPatch = defineCommand<AgentPatchPorts>()({
  id: "agent.patch", version: "1.0", availability: "active", title: "Update Agent", description: "Update Agent identity, role, instructions, or enabled state.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["agent"], proposedEffects: ["Update an Agent."], outputResourceKind: "agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Backend binding has its own persistent operation." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentPatch(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.patchAgent(input)) }; } }; }
});
export default agentPatch;
