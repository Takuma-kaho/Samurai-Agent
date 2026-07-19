// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { messagePresentationUpdateValueSchema } from "../../../value-objects/presentation.js";

const Input = z.object({
  "presentation_id": z.string().trim().min(1),
  "view_state": z.record(domainJsonValueSchema).default({})
}).strict();
const Output = messagePresentationUpdateValueSchema;
type OutputValue = z.infer<typeof Output>;

export interface MessagePresentationUpdatePorts {
  getMessagePresentation(id: string): Promise<OutputValue["presentation"] | undefined>;
  presentCollectionView(input: { collectionId: string; viewId?: string }): Promise<{ render_spec: OutputValue["render_spec"] }>;
  applyPresentationViewState(spec: OutputValue["render_spec"], viewState: z.infer<typeof Input>["view_state"]): OutputValue["render_spec"];
  presentationViewStateFromSpec(spec: OutputValue["render_spec"]): z.infer<typeof Input>["view_state"];
  updateMessagePresentationViewState(input: { id: string; viewState: z.infer<typeof Input>["view_state"] }): Promise<OutputValue["presentation"] | undefined>;
  messagePresentationNotFoundError(id: string): Error;
}

const messagePresentationUpdate = defineCommand<MessagePresentationUpdatePorts>()({
  ...{
  "kind": "command",
  "id": "message.presentation.update",
  "version": "3.0",
  "availability": "active",
  "title": "Update message presentation state",
  "description": "Persist card-local UI state for a chat message presentation.",
  "sources": [
    "surface_operation",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "chat",
    "custom_view"
  ],
  "resourceKinds": [
    "message_presentation",
    "collection_schema"
  ],
  "proposedEffects": [
    "Persist the current view state for a chat card."
  ],
  "outputResourceKind": "message_presentation",
  "uiDisplayCategory": "chat",
  "surfaceOperationKinds": [
    "message.presentation.update"
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
      execute: async function handleMessagePresentationUpdate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const existing = await ports.getMessagePresentation(input.presentation_id);
        if (!existing) throw ports.messagePresentationNotFoundError(input.presentation_id);
        const requestedViewId = typeof input.view_state.view_id === "string" && input.view_state.view_id.trim() ? input.view_state.view_id.trim() : undefined;
        const result = await ports.presentCollectionView({ collectionId: existing.collection_id, viewId: requestedViewId ?? existing.view_id });
        const renderSpec = ports.applyPresentationViewState(result.render_spec, input.view_state);
        const updated = await ports.updateMessagePresentationViewState({ id: input.presentation_id, viewState: ports.presentationViewStateFromSpec(renderSpec) });
        if (!updated) throw ports.messagePresentationNotFoundError(input.presentation_id);
        return { ok: true, value: { presentation: updated, render_spec: renderSpec, render_specs: [renderSpec] } };
      }
    };
  }
});

export default messagePresentationUpdate;
