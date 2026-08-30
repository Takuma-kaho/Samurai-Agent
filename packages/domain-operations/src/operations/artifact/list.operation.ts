import { z } from "zod";
import { ArtifactRecordSchema } from "@samurai-agent/core-schemas";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({}).strict();
const Output = z.array(ArtifactRecordSchema);

export interface ArtifactListPorts extends DomainQueryPorts {
  listArtifacts: ReadCapability<(context: TrustedDomainContext) => Promise<z.infer<typeof Output>>>;
}

const artifactList = defineQuery<ArtifactListPorts>()({
  id: "artifact.list", version: "1.0", availability: "active", title: "List Artifacts", description: "List visible Artifacts in the selected Room.",
  sources: ["runtime_api", "external_app"], render: ["table"], resourceKinds: ["artifact"], proposedEffects: ["Read Artifacts."], outputResourceKind: "artifact", uiDisplayCategory: "artifact",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "domain-api", decision: "adapted", reason: "Expose the existing Room-scoped Artifact projection through the shared Query contract." }],
  input: Input, output: Output,
  createHandler(ports) {
    return {
      execute: async function handleArtifactList(context: TrustedDomainContext, _input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.listArtifacts(context)) };
      }
    };
  }
});

export default artifactList;
