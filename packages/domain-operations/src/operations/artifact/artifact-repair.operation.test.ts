import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import artifactRepair from "./repair.operation.js";

const context: TrustedDomainContext = { inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test" };
const artifact: ArtifactRecord = {
  id: "artifact_1", title: "Notes", kind: "markdown", locale: "ja", source_locales: ["ja"],
  file_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/notes.md", label: "Notes" },
  metadata: {}, source_operation_id: "operation_create", created_by: "backend",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z"
};
const operation = { id: "operation_1" } as never;

describe("artifact.repair handler", () => {
  it("owns lookup and recorded revision-source repair", async () => {
    const repairArtifactRevisionSource = vi.fn(async () => ({ repaired: true }));
    const runArtifactMutation = vi.fn(async (input) => { const executed = await input.execute(operation); return { resource: executed.resource, operation, activity: [], ...executed.extra }; });
    const handler = artifactRepair.createHandler({
      artifactContract: () => ({ id: "artifact.repair", proposed_effects: ["Repair"] }),
      getArtifact: async () => artifact, repairArtifactRevisionSource,
      artifactNotFoundError: () => new Error("artifact_not_found"), runArtifactMutation
    });

    const result = await handler.execute(context, { artifact_id: artifact.id });

    expect(runArtifactMutation).toHaveBeenCalledWith(expect.objectContaining({ operationName: "artifact.repair", targetResourceRefs: [artifact.file_ref] }));
    expect(repairArtifactRevisionSource).toHaveBeenCalledWith(artifact.id);
    expect(result.value.repair.repaired).toBe(true);
  });

  it("does not begin repair for a missing artifact", async () => {
    const repairArtifactRevisionSource = vi.fn();
    const handler = artifactRepair.createHandler({
      artifactContract: () => ({ id: "artifact.repair", proposed_effects: [] }), getArtifact: async () => undefined,
      repairArtifactRevisionSource,
      artifactNotFoundError: () => new Error("artifact_not_found"), runArtifactMutation: async () => { throw new Error("unexpected"); }
    });

    await expect(handler.execute(context, { artifact_id: "missing" })).rejects.toThrow("artifact_not_found");
    expect(repairArtifactRevisionSource).not.toHaveBeenCalled();
  });
});
