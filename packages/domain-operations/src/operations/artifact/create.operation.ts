// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { SupportedLocaleSchema, type ActivityInboxItem, ArtifactRecord, type JsonValue, type OperationRecord, type ResourceRef, type RollbackPoint } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, trustedCreatorId, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { artifactCreateValueSchema } from "../../value-objects/artifact.js";

const Input = z.object({
  "content": z.string().min(1),
  "input_locale": SupportedLocaleSchema.optional(),
  "kind": z.enum(["markdown", "document", "table", "chart", "graph", "image", "pdf", "structured_draft", "generated_report", "note"]).optional(),
  "metadata": z.record(domainJsonValueSchema).default({}),
  "output_locale": SupportedLocaleSchema.optional(),
  "title": z.string().trim().min(1).max(512)
}).strict();
const Output = artifactCreateValueSchema;
type OutputValue = z.infer<typeof Output>;

export interface ArtifactCreatePorts {
  artifactContract(id: "artifact.create"): { id: string; proposed_effects: string[] };
  artifactDefaultLocales(): Promise<{ inputLocale: z.infer<typeof SupportedLocaleSchema>; outputLocale: z.infer<typeof SupportedLocaleSchema> }>;
  validateGraphArtifactContent(content: string): void;
  createArtifactDraft(input: { operation: OperationRecord; title: string; content: string; kind?: z.infer<typeof Input>["kind"]; locale: z.infer<typeof SupportedLocaleSchema>; sourceLocales: z.infer<typeof SupportedLocaleSchema>[]; createdBy: string; metadata?: Record<string, JsonValue> }): Promise<ArtifactRecord>;
  createArtifactRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runArtifactMutation(input: { trustedContext: TrustedDomainContext; inputSummary: string; operationName: string; proposedEffects: string[]; execute(operation: OperationRecord): Promise<{ resource: ArtifactRecord; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string; extra: Record<string, never> }> }): Promise<{ resource: ArtifactRecord; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
}

const artifactCreate = defineCommand<ArtifactCreatePorts>()({
  ...{
  "kind": "command",
  "id": "artifact.create",
  "version": "6.0",
  "availability": "active",
  "title": "Create artifact",
  "description": "Create a local workspace artifact from backend, UI, or generated surface output.",
  "sources": [
    "surface_operation",
    "provider_tool_call",
    "generated_surface",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "append_or_unique",
  "render": [
    "artifact",
    "form",
    "table",
    "chart",
    "custom_view"
  ],
  "resourceKinds": [
    "artifact"
  ],
  "proposedEffects": [
    "Create a local workspace artifact draft."
  ],
  "outputResourceKind": "artifact",
  "uiDisplayCategory": "artifact",
  "providerToolNames": [
    "create_artifact",
    "samurai.artifact.create",
    "mcp__samurai__artifact_create"
  ],
  "surfaceOperationKinds": [
    "form.submit",
    "table.patch",
    "chart.request",
    "artifact.request",
    "custom_view.action"
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
      execute: async function handleArtifactCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (input.kind === "graph") ports.validateGraphArtifactContent(input.content);
        const defaults = await ports.artifactDefaultLocales();
        const inputLocale = input.input_locale ?? defaults.inputLocale;
        const outputLocale = input.output_locale ?? defaults.outputLocale;
        const metadata = {
          ...input.metadata,
          ...(context.surfaceOperation
            ? {
                surface_operation_id: context.surfaceOperation.id,
                surface_operation_kind: context.surfaceOperation.kind
              }
            : {})
        };
        const contract = ports.artifactContract("artifact.create");
        const value = await ports.runArtifactMutation({ trustedContext: context, inputSummary: `Create artifact: ${input.title}`, operationName: contract.id, proposedEffects: contract.proposed_effects, execute: async (operation) => {
          const artifact = await ports.createArtifactDraft({
            operation,
            title: input.title,
            content: input.content,
            kind: input.kind,
            locale: outputLocale,
            sourceLocales: [inputLocale],
            createdBy: trustedCreatorId(context),
            metadata
          });
          const rollbackPoint = await ports.createArtifactRollback(operation, [artifact.file_ref], {}, { artifact_id: artifact.id });
          return { resource: artifact, ref: artifact.file_ref, rollbackPoint, summary: `Created artifact ${artifact.title}.`, extra: {} };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default artifactCreate;
