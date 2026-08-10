import { NonSecretConnectionMetadataSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalAppConnectionWriteValueSchema } from "../../../value-objects/external-app-connection.js";

const Input = z.object({
  connection_id: z.string().trim().min(1),
  allowed_room_ids: z.array(z.string().trim().min(1)).min(1),
  ingress_classes: z.array(z.enum(["query", "domain_operation", "activity_ingest"])).min(1),
  non_secret_metadata: NonSecretConnectionMetadataSchema.optional()
}).strict();
const Output = externalAppConnectionWriteValueSchema;

export interface ExternalAppConnectionUpdateScopePorts {
  updateExternalAppConnectionScope(input: { context: TrustedDomainContext; request: z.infer<typeof Input> }): Promise<z.infer<typeof Output>>;
}

const externalAppConnectionUpdateScope = defineCommand<ExternalAppConnectionUpdateScopePorts>()({
  ...{
    kind: "command", id: "external_app.connection.update_scope", version: "1.0", availability: "active",
    title: "Update external app connection scope", description: "Narrow or replace allowed Rooms and formal ingress classes.",
    sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "optimistic_version",
    render: ["status_timeline"], resourceKinds: ["external_app_connection"],
    proposedEffects: ["Update external app Connection scopes without changing Room membership."], outputResourceKind: "external_app_connection", uiDisplayCategory: "gateway",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Connection scope is a narrowing cap, not an operation ACL." }]
  },
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleExternalAppConnectionUpdateScope(context: TrustedDomainContext, request: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: await ports.updateExternalAppConnectionScope({ context, request }) };
    } };
  }
});

export default externalAppConnectionUpdateScope;
