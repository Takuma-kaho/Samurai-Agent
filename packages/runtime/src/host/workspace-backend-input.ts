import type { BackendRunInput } from "@samurai-agent/agent-backends";
import type { BackendRunRecord, JsonValue } from "@samurai-agent/core-schemas";

/**
 * Stable Backend cassette input for a Room-first Workspace Run.
 *
 * This deliberately carries no App Session or Message dependency.  A
 * SessionRef may influence the Backend's private continuation key, but it is
 * never copied into authorization or used as a Workspace identity.
 */
export function workspaceBackendInput(
  run: BackendRunRecord,
  now: () => string,
  userInput: string,
  metadata: Record<string, JsonValue> = {}
): BackendRunInput {
  if (!run.room_id) throw new Error(`workspace_run_room_required:${run.id}`);
  const appSession = run.session_ref
    ? `${run.session_ref.app_id}:${run.session_ref.session_id}`
    : `run:${run.id}`;
  const backendSessionKey = `room:${run.room_id}:app:${appSession}:agent:${run.agent_id ?? "none"}:backend:${run.backend_id}`;
  const mergedMetadata = { ...run.metadata, ...metadata };
  const normalizedInput = userInput.trim() || run.input_summary || "Workspace execution";
  return {
    run_id: run.id,
    ...(run.session_id ? { session_id: run.session_id } : {}),
    room_id: run.room_id,
    ...(run.backend_session_id ? { backend_session_id: run.backend_session_id } : {}),
    ...(run.input_message_id ? { input_message_id: run.input_message_id } : {}),
    backend_session_key: backendSessionKey,
    envelope: {
      id: `workspace-envelope:${run.id}`,
      source: "local_cli",
      actor_identity: run.source?.kind === "system" ? "owner_scheduled" : "owner",
      session_key: backendSessionKey,
      user_intent: normalizedInput,
      attachments: [],
      input_locale: "ja",
      output_locale: "ja",
      metadata: mergedMetadata,
      received_at: now()
    },
    user_input: normalizedInput,
    input_locale: "ja",
    output_locale: "ja",
    active_memory: [],
    recent_messages: [],
    metadata: mergedMetadata,
    context_intent: "workspace_task"
  };
}
