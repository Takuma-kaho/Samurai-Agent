import { NonSecretConnectionMetadataSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalAppConnectionWriteValueSchema } from "../../../value-objects/external-app-connection.js";

const DelegatedPrincipal = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), participant_id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("agent"), agent_id: z.string().trim().min(1), requested_by_participant_id: z.string().trim().min(1) }).strict()
]);
const Input = z.object({
  connector_id: z.string().trim().min(1).max(200),
  app_id: z.string().trim().min(1).max(200),
  delegated_principal: DelegatedPrincipal,
  allowed_room_ids: z.array(z.string().trim().min(1)).min(1),
  ingress_classes: z.array(z.enum(["query", "domain_operation", "activity_ingest"])).min(1),
  non_secret_metadata: NonSecretConnectionMetadataSchema.default({})
}).strict();
const Output = externalAppConnectionWriteValueSchema;

export interface ExternalAppConnectionCreatePorts {
  createExternalAppConnection(input: { context: TrustedDomainContext; request: z.infer<typeof Input> }): Promise<z.infer<typeof Output>>;
}

const externalAppConnectionCreate = defineCommand<ExternalAppConnectionCreatePorts>()({
  ...{
    kind: "command",
    id: "external_app.connection.create",
    version: "1.0",
    availability: "active",
    title: "Create external app connection",
    description: "Create a secret-free, narrowing external app Connection.",
    sources: ["runtime_api"],
    effect: "workspace_mutation",
    idempotency: "required",
    concurrency: "append_or_unique",
    render: ["status_timeline"],
    resourceKinds: ["external_app_connection"],
    proposedEffects: ["Create a narrowed external app Connection without adding Room membership."],
    outputResourceKind: "external_app_connection",
    uiDisplayCategory: "gateway",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Connection narrows current delegated Room authority and never stores credentials." }]
  },
  input: Input,
  output: Output,
  createHandler(ports) {
    return { execute: async function handleExternalAppConnectionCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      const request = {
        connector_id: input.connector_id,
        app_id: input.app_id,
        delegated_principal: input.delegated_principal,
        allowed_room_ids: input.allowed_room_ids,
        ingress_classes: input.ingress_classes,
        non_secret_metadata: input.non_secret_metadata
      };
      return { ok: true, value: await ports.createExternalAppConnection({ context, request }) };
    } };
  }
});

export default externalAppConnectionCreate;
