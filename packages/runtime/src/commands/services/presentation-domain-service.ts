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

  getPresentation(id: string) { return this.requireCommands().getPresentation(id); }
  presentView(input: { collectionId: string; viewId?: string }) { return this.requireCommands().presentView(input); }
  applyViewState(spec: SurfaceRenderSpec, state: Record<string, JsonValue>) { return this.requireCommands().applyViewState(spec, state); }
  viewStateFromSpec(spec: SurfaceRenderSpec) { return this.requireCommands().viewStateFromSpec(spec); }
  updateViewState(input: { id: string; viewState: Record<string, JsonValue> }) { return this.requireCommands().updateViewState(input); }
  presentationNotFound(id: string) { return this.notFound(id); }

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

  private requireCommands(): PresentationCommandPort {
    if (!this.commands) throw new Error("presentation_command_port_missing");
    return this.commands;
  }
}
