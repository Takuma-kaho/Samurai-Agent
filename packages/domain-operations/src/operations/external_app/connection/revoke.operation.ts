import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { externalAppConnectionWriteValueSchema } from "../../../value-objects/external-app-connection.js";

const Input = z.object({ connection_id: z.string().trim().min(1) }).strict();
const Output = externalAppConnectionWriteValueSchema;

export interface ExternalAppConnectionRevokePorts {
  revokeExternalAppConnection(input: { context: TrustedDomainContext; connectionId: string }): Promise<z.infer<typeof Output>>;
}

const externalAppConnectionRevoke = defineCommand<ExternalAppConnectionRevokePorts>()({
  ...{
    kind: "command", id: "external_app.connection.revoke", version: "1.0", availability: "active",
    title: "Revoke external app connection", description: "Revoke a Connection immediately without deleting its audit metadata.",
    sources: ["runtime_api"], effect: "workspace_mutation", idempotency: "required", concurrency: "state_transition",
    render: ["status_timeline"], resourceKinds: ["external_app_connection"],
    proposedEffects: ["Revoke external app Connection ingress."], outputResourceKind: "external_app_connection", uiDisplayCategory: "gateway",
    provenance: [{ source: "samurai", commit_sha: "core09", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Revocation is durable and cannot reactivate the same Connection." }]
  },
  input: Input, output: Output,
  createHandler(ports) {
    return { execute: async function handleExternalAppConnectionRevoke(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
      return { ok: true, value: await ports.revokeExternalAppConnection({ context, connectionId: input.connection_id }) };
    } };
  }
});

export default externalAppConnectionRevoke;
