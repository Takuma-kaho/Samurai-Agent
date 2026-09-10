import { z } from "zod";
import { ArtifactContentEncodingSchema, ArtifactRecordSchema, ArtifactRevisionRecordSchema } from "@samurai-agent/core-schemas";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../definition/index.js";

const Input = z.object({ id: z.string().trim().min(1) }).strict();
const Output = z.object({
  artifact: ArtifactRecordSchema,
  content: z.string(),
  content_bytes: z.array(z.number().int().min(0).max(255)).optional(),
  mime_type: z.string().trim().min(1).max(255).optional(),
  encoding: ArtifactContentEncodingSchema.optional(),
  revision: ArtifactRevisionRecordSchema.optional()
}).strict();

export interface ArtifactViewPorts extends DomainQueryPorts {
  viewArtifact: ReadCapability<(context: TrustedDomainContext, id: string) => Promise<z.infer<typeof Output>>>;
}

const artifactView = defineQuery<ArtifactViewPorts>()({
  id: "artifact.view", version: "1.0", availability: "active", title: "View Artifact", description: "Read an Artifact and its current body from the selected Room.",
  sources: ["runtime_api", "external_app"], render: ["artifact"], resourceKinds: ["artifact"], proposedEffects: ["Read an Artifact."], outputResourceKind: "artifact", uiDisplayCategory: "artifact",
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "domain-api", decision: "adapted", reason: "Expose the existing Room-scoped Artifact projection through the shared Query contract." }],
  input: Input, output: Output,
  createHandler(ports) {
    return {
      execute: async function handleArtifactView(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        return { ok: true, value: Output.parse(await ports.viewArtifact(context, input.id)) };
      }
    };
  }
});

export default artifactView;
