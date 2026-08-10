import { ActivityRecordSchema, ActivityRecordStatusSchema, TrustedWorkspaceSourceSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineQuery, type DomainQueryPorts, type DomainResult, type ReadCapability, type TrustedDomainContext } from "../../../definition/index.js";

const Input = z.object({
  principal_id: z.string().trim().min(1).optional(),
  source_kind: TrustedWorkspaceSourceSchema.shape.kind.optional(),
  source_id: z.string().trim().min(1).optional(),
  status: ActivityRecordStatusSchema.optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  limit: z.number().int().positive().max(200).optional()
}).strict();
const Output = z.object({ items: z.array(ActivityRecordSchema) }).strict();

export interface ActivityHistoryListPorts extends DomainQueryPorts {
  listActivityHistory: ReadCapability<(input: { context: TrustedDomainContext; request: z.infer<typeof Input> }) => Promise<z.infer<typeof Output>["items"]>>;
}

const activityHistoryList = defineQuery<ActivityHistoryListPorts>()({
  ...{
    kind: "query", id: "activity.history.list", version: "1.0", availability: "active",
    title: "List Activity history", description: "Read Room-scoped Activity evidence without mutating Workspace state.",
    sources: ["runtime_api", "external_app"], effect: "read_only", idempotency: "none", concurrency: "none",
    render: ["run_history", "status_timeline"], resourceKinds: ["activity"],
    proposedEffects: ["Read Activity history without creating Activity, Operation, or Job records."],
    outputResourceKind: "activity_history", uiDisplayCategory: "run_history",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Activity History is a Room-scoped evidence read model." }]
  },
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleActivityHistoryList(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const request = {
        ...(input.principal_id ? { principal_id: input.principal_id } : {}),
        ...(input.source_kind ? { source_kind: input.source_kind } : {}),
        ...(input.source_id ? { source_id: input.source_id } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.created_after ? { created_after: input.created_after } : {}),
        ...(input.created_before ? { created_before: input.created_before } : {}),
        ...(input.limit ? { limit: input.limit } : {})
      };
      return { ok: true, value: { items: await ports.listActivityHistory({ context, request }) } };
    } };
  }
});

export default activityHistoryList;
