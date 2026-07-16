// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema, type ActivityInboxItem, ArtifactRecord, type JsonValue, type MessageEnvelope, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactWriteValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "content": z.string().min(1),
  "envelope_id": z.string().trim().min(1).optional(),
  "input_locale": SupportedLocaleSchema.optional(),
  "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": SupportedLocaleSchema.optional(),
  "session_id": z.string().trim().min(1).optional(),
  "title": z.string().trim().min(1).default("Untitled artifact"),
  "ui_locale": SupportedLocaleSchema.optional()
}).strict();
const Output = artifactWriteValueSchema;

export interface GraphCreatePorts {
  artifactContract(id: "graph.create"): { id: string; proposed_effects: string[] };
  validateGraphArtifactContent(content: string): void;
  createArtifactSession(input: { title: string; ui_locale?: z.infer<typeof SupportedLocaleSchema>; output_locale?: z.infer<typeof SupportedLocaleSchema> }): Promise<SessionRecord>;
  getArtifactSession(id: string): Promise<SessionRecord | undefined>; artifactSessionNotFoundError(): Error;
  createArtifactEnvelope(session: SessionRecord, content: string, inputLocale?: z.infer<typeof SupportedLocaleSchema>, outputLocale?: z.infer<typeof SupportedLocaleSchema>, metadata?: Record<string, JsonValue>, envelopeId?: string): MessageEnvelope;
  createArtifactDraft(input: { operation: OperationRecord; title: string; content: string; kind: "graph"; locale: z.infer<typeof SupportedLocaleSchema>; sourceLocales: z.infer<typeof SupportedLocaleSchema>[]; createdBy: string }): Promise<ArtifactRecord>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: Record<string, never> }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const graphCreate = defineCommand<GraphCreatePorts>()({
  ...{
  "kind": "command",
  "id": "graph.create",
  "version": "2.0",
  "availability": "active",
  "title": "Create graph",
  "description": "Create a validated node and edge graph as a revision-backed Artifact.",
  "sources": [
    "runtime_api",
    "provider_tool_call",
    "surface_operation"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "graph_view",
    "artifact"
  ],
  "resourceKinds": [
    "artifact",
    "artifact_revision"
  ],
  "proposedEffects": [
    "Create a validated graph Artifact in the Workspace."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "graph.create",
    "samurai.graph.create"
  ],
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
      execute: async function handleGraphCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        ports.validateGraphArtifactContent(input.content);
        const session = input.session_id
          ? await ports.getArtifactSession(input.session_id)
          : await ports.createArtifactSession({ title: input.title, ui_locale: input.ui_locale, output_locale: input.output_locale });
        if (!session) throw ports.artifactSessionNotFoundError();
        const inputLocale = input.input_locale ?? session.ui_locale;
        const outputLocale = input.output_locale ?? session.output_locale;
        const contract = ports.artifactContract("graph.create");
        const envelope = ports.createArtifactEnvelope(session, input.content, inputLocale, outputLocale, input.metadata, input.envelope_id);
        const value = await ports.runArtifactMutation({ session, envelope, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
          const artifact = await ports.createArtifactDraft({ operation, title: input.title, content: input.content, kind: "graph", locale: outputLocale, sourceLocales: [inputLocale], createdBy: "backend" });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref], {}, { artifact_id: artifact.id });
          return { resource: artifact, ref: artifact.file_ref, rollbackPoint, summary: `Created artifact ${artifact.title}.`, extra: {} };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default graphCreate;
