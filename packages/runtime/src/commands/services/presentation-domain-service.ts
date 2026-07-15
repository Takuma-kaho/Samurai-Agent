import type { JsonValue, MessagePresentationRecord } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";

export interface PresentationCommandPort {
  getPresentation(id: string): Promise<MessagePresentationRecord | undefined>;
  presentView(input: { collectionId: string; viewId?: string }): Promise<{ render_spec: SurfaceRenderSpec }>;
  applyViewState(spec: SurfaceRenderSpec, viewState: Record<string, JsonValue>): SurfaceRenderSpec;
  viewStateFromSpec(spec: SurfaceRenderSpec): Record<string, JsonValue>;
  updateViewState(input: { id: string; viewState: Record<string, JsonValue> }): Promise<MessagePresentationRecord | undefined>;
  savePresentation(record: MessagePresentationRecord): Promise<MessagePresentationRecord>;
}

export class PresentationDomainService {
  constructor(private readonly commands?: PresentationCommandPort, private readonly notFoundError?: (id: string) => Error) {}

  plan(payload: Record<string, JsonValue>) {
    const requested = typeof payload.requested_kind === "string" && payload.requested_kind.trim()
      ? payload.requested_kind.trim()
      : "built_in_surface";
    return {
      requested_kind: requested,
      selected_kind: requested === "generated_surface" ? "generated_surface" as const : "built_in_surface" as const,
      reason: requested === "generated_surface"
        ? "User explicitly requested an independent UI."
        : "A built-in Workspace renderer is preferred when it can represent the result.",
      fallback_chain: ["built_in_surface", "artifact", "text"] as ["built_in_surface", "artifact", "text"]
    };
  }

  async update(payload: Record<string, JsonValue>) {
    if (!this.commands) throw new Error("presentation_command_port_missing");
    const presentationId = requiredString(payload, "presentation_id");
    const existing = await this.commands.getPresentation(presentationId);
    if (!existing) throw this.notFound(presentationId);
    const requestedViewState = recordValue(payload.view_state);
    const requestedViewId = typeof requestedViewState.view_id === "string" && requestedViewState.view_id.trim()
      ? requestedViewState.view_id.trim() : undefined;
    const result = await this.commands.presentView({
      collectionId: existing.collection_id,
      viewId: requestedViewId ?? existing.view_id
    });
    const renderSpec = this.commands.applyViewState(result.render_spec, requestedViewState);
    const updated = await this.commands.updateViewState({ id: presentationId, viewState: this.commands.viewStateFromSpec(renderSpec) });
    if (!updated) throw this.notFound(presentationId);
    return { presentation: updated, render_spec: renderSpec, render_specs: [renderSpec] };
  }

  async saveUnique(records: MessagePresentationRecord[]): Promise<MessagePresentationRecord[]> {
    if (!this.commands) throw new Error("presentation_command_port_missing");
    const saved: MessagePresentationRecord[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      const recordId = typeof record.view_state?.record_id === "string" ? record.view_state.record_id : "";
      const key = `${record.collection_id}:${record.view_id}:${record.renderer}:${recordId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      saved.push(await this.commands.savePresentation(record));
    }
    return saved;
  }

  private notFound(id: string): Error {
    return this.notFoundError?.(id) ?? new Error(`Message presentation not found: ${id}`);
  }
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = typeof payload[key] === "string" ? payload[key].trim() : "";
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
