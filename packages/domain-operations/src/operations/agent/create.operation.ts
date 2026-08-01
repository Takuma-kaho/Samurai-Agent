import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { agentValueSchema } from "../../value-objects/room-agent.js";

const Input = z.object({ name: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(500), instructions: z.string().trim().min(1).max(20_000), backend_id: z.string().trim().min(1), enabled: z.boolean().default(true) }).strict();
const Output = agentValueSchema;
export interface AgentCreatePorts { createAgent(input: { name: string; role: string; instructions: string; backendId: string; enabled?: boolean }): Promise<z.infer<typeof Output>>; }
const agentCreate = defineCommand<AgentCreatePorts>()({
  id: "agent.create", version: "1.0", availability: "active", title: "Create Agent", description: "Create a stable Agent identity and select its Backend.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["status_timeline"], resourceKinds: ["agent"], proposedEffects: ["Create an Agent."], outputResourceKind: "agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Keep Agent identity separate from its replaceable Backend." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentCreate(_context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.createAgent({ name: input.name, role: input.role, instructions: input.instructions, backendId: input.backend_id, enabled: input.enabled })) }; } }; }
});
export default agentCreate;
