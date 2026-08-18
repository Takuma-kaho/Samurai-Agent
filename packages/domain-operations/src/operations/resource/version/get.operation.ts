// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";

const ResourceKind = z.enum(["artifact", "collection_schema", "collection_record", "wiki", "skill", "memory"]);
// Keep this as a union rather than a custom refinement. The same distinction
// must be visible in the published JSON Schema used by external MCP clients.
const Input = z.union([
  z.object({
    resource_kind: z.enum(["artifact", "collection_schema", "wiki", "skill", "memory"]),
    resource_id: z.string().trim().min(1).max(512)
  }).strict(),
  z.object({
    resource_kind: z.literal("collection_record"),
    resource_id: z.string().trim().min(1).max(512),
    collection_id: z.string().trim().min(1).max(512)
  }).strict()
]);
const Output = z.object({
  resource_key: z.string().trim().min(1),
  resource_kind: ResourceKind,
  resource_id: z.string().trim().min(1),
  version: z.number().int().positive()
}).strict();

export type ResourceVersionGetInput = z.infer<typeof Input>;
export type ResourceVersionGetOutput = z.infer<typeof Output>;

export interface ResourceVersionGetPorts extends DomainQueryPorts {
  getResourceVersion: ReadCapability<(context: TrustedDomainContext, input: ResourceVersionGetInput) => Promise<ResourceVersionGetOutput>>;
}

const resourceVersionGet = defineQuery<ResourceVersionGetPorts>()({
  id: "resource.version.get",
  version: "1.0",
  availability: "active",
  title: "Get resource version",
  description: "Read one current Room-scoped resource version without exposing the Workspace Store.",
  sources: ["runtime_api", "external_app"],
  render: ["status_timeline"],
  resourceKinds: ["artifact", "collection_schema", "collection_record", "wiki", "skill", "memory"],
  proposedEffects: ["Read one current resource version without changing Workspace state."],
  outputResourceKind: "resource_version",
  uiDisplayCategory: "workspace",
  provenance: [{ source: "samurai", commit_sha: "workspace-server-05", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "MCP gets versions through the same Room-authorized Query boundary as all Workspace reads." }],
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleResourceVersionGet(context: TrustedDomainContext, input: ResourceVersionGetInput): Promise<DomainResult<ResourceVersionGetOutput>> {
        return { ok: true, value: Output.parse(await ports.getResourceVersion(context, input)) };
      }
    };
  }
});

export default resourceVersionGet;
