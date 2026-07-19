import type { GeneratedSurfaceActionDeclaration, GeneratedSurfaceDefinition, JsonValue } from "@samurai-agent/core-schemas";

export interface ResolvedGeneratedSurfaceAction {
  surface: GeneratedSurfaceDefinition;
  revisionId: string;
  action: GeneratedSurfaceActionDeclaration;
  payloadTemplate: Record<string, JsonValue>;
}

export async function executeGeneratedSurfaceAction<TCommand, TInteraction>(input: {
  resolved: ResolvedGeneratedSurfaceAction;
  interactionId: string;
  actionPayload: Record<string, JsonValue>;
  dispatch: (request: { commandId: string; idempotencyKey: string; payload: Record<string, JsonValue> }) => Promise<TCommand>;
  recordInteraction: (request: { commandId: string; result?: TCommand; error?: unknown }) => Promise<TInteraction>;
}): Promise<{ command: TCommand; interaction: TInteraction }> {
  const { resolved } = input;
  let command: TCommand | undefined;
  let targetError: unknown;
  try {
    command = await input.dispatch({
      commandId: resolved.action.command_id,
      idempotencyKey: `${resolved.surface.id}:${resolved.revisionId}:${input.interactionId}:${resolved.action.id}`,
      payload: { ...resolved.payloadTemplate, ...input.actionPayload }
    });
  } catch (error) {
    targetError = error;
  }
  const interaction = await input.recordInteraction({
    commandId: resolved.action.command_id,
    ...(targetError ? { error: targetError } : { result: command })
  });
  if (targetError) throw targetError;
  return { command: command as TCommand, interaction };
}
