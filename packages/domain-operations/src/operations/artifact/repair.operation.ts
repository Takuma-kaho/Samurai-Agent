// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, ArtifactRecord, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactRepairWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({ "artifact_id": z.string().trim().min(1) }).strict();
const Output = artifactRepairWriteValueSchema;

export interface ArtifactRepairPorts {
  artifactContract(id: "artifact.repair"): { id: string; proposed_effects: string[] };
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  repairArtifactRevisionSource(id: string): Promise<{ repaired: boolean }>;
  artifactNotFoundError(): Error;
  runArtifactMutation(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: { repair: { repaired: boolean } } }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[]; repair: { repaired: boolean } }>;
}

const artifactRepair = defineCommand<ArtifactRepairPorts>()({
  ...{
  "kind": "command",
  "id": "artifact.repair",
  "version": "3.0",
  "availability": "active",
  "title": "Repair artifact source",
  "description": "Repair a missing current Artifact file from its verified content blob.",
  "sources": [
    "runtime_api",
    "scheduled_context"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "artifact"
  ],
  "resourceKinds": [
    "artifact",
    "artifact_revision"
  ],
  "proposedEffects": [
    "Restore a missing Artifact revision file from its verified content blob."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleArtifactRepair(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const contract = ports.artifactContract("artifact.repair");
        const artifact = await ports.getArtifact(input.artifact_id);
        if (!artifact) throw ports.artifactNotFoundError();
        const value = await ports.runArtifactMutation({ trustedContext: context, inputSummary: `Repair artifact source: ${artifact.title}`, operationName: contract.id, proposedEffects: contract.proposed_effects, targetResourceRefs: [artifact.file_ref], execute: async () => {
          const repair = await ports.repairArtifactRevisionSource(input.artifact_id);
          return { resource: artifact, ref: artifact.file_ref, summary: repair.repaired ? `Repaired artifact ${artifact.title}.` : `Artifact ${artifact.title} did not require repair.`, extra: { repair } };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default artifactRepair;
