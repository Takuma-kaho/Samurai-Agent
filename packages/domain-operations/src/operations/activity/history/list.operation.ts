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
    return { execute: async function handleActivityHistoryList(context: TrustedDomainContext, request: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: { items: await ports.listActivityHistory({ context, request }) } };
    } };
  }
});

export default activityHistoryList;
