import { AgentBackendKindSchema, BackendConnectionStateSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";

/**
 * Public backend availability is deliberately a small projection.  Runtime
 * capabilities, session policy, metadata, and diagnostics stay on the host
 * side of the Server boundary.
 */
export const agentBackendRecordSchema = z.object({
  id: z.string().trim().min(1).max(512),
  kind: AgentBackendKindSchema,
  label: z.string().trim().min(1).max(200),
  configured: z.boolean(),
  enabled: z.boolean(),
  connection_state: BackendConnectionStateSchema,
  reason: z.string().trim().min(1).max(256).optional()
}).strict();

const Input = z.object({}).strict();
const Output = z.array(agentBackendRecordSchema).max(100);

export interface AgentBackendListPorts extends DomainQueryPorts {
  listAgentBackends: ReadCapability<(context: TrustedDomainContext) => Promise<z.infer<typeof Output>>>;
}

const agentBackendList = defineQuery<AgentBackendListPorts>()({
  id: "agent.backend.list",
  version: "1.0",
  availability: "active",
  title: "List Agent Backends",
  description: "List safe availability projections for Agent Backends in the current Workspace.",
  sources: ["runtime_api"],
  render: ["table"],
  resourceKinds: ["agent_backend"],
  proposedEffects: ["Read Agent Backend availability."],
  outputResourceKind: "agent_backend",
  uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Expose only the host-owned backend availability projection." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleAgentBackendList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.listAgentBackends(context)) };
      }
    };
  }
});

export default agentBackendList;
