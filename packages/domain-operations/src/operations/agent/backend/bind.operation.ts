import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { agentValueSchema } from "../../../value-objects/room-agent.js";

const Input = z.object({ id: z.string().trim().min(1), backend_id: z.string().trim().min(1), expected_version: z.number().int().positive().optional() }).strict();
const Output = agentValueSchema;
export interface AgentBackendBindPorts { bindAgentBackend(context: TrustedDomainContext, input: { id: string; backendId: string; expectedVersion?: number }): Promise<z.infer<typeof Output>>; }
const agentBackendBind = defineCommand<AgentBackendBindPorts>()({
  id: "agent.backend.bind", version: "1.1", availability: "active", title: "Bind Agent Backend", description: "Persistently change the Backend selected by one Agent.",
  sources: ["runtime_api", "surface_operation"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
  render: ["status_timeline"], resourceKinds: ["agent"], proposedEffects: ["Change an Agent Backend binding."], outputResourceKind: "agent", uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Only this operation changes the durable Agent Backend binding." }],
  input: Input, output: Output,
  createHandler(ports) { return { execute: async function handleAgentBackendBind(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> { return { ok: true, value: Output.parse(await ports.bindAgentBackend(context, { id: input.id, backendId: input.backend_id, ...(input.expected_version === undefined ? {} : { expectedVersion: input.expected_version }) })) }; } }; }
});
export default agentBackendBind;
