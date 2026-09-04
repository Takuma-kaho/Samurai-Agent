import { describe, expect, it } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import type { PostgresRuntimeChatCompletionEvent } from "../adapters/runtime/postgres-runtime-chat.js";
import { recordPostgresChatCompletionActivity } from "./http-server.js";

describe("PostgreSQL Runtime Completion projection", () => {
  it("always submits the stable Activity ID so Completion can atomically replay it", async () => {
    const ingestedOperationIds: string[] = [];
    const ingestedActivityIds: Array<string | undefined> = [];
    const ingestedEpisodeKeys: string[] = [];
    const changedResourceIds: string[][] = [];
    const commands = {
      ingestCompletionActivity: async (context: { operationId: string }, input: { id?: string; externalEpisodeKey?: string; changedResources?: readonly string[] }) => {
        ingestedOperationIds.push(context.operationId);
        ingestedActivityIds.push(input.id);
        if (input.externalEpisodeKey) ingestedEpisodeKeys.push(input.externalEpisodeKey);
        changedResourceIds.push([...(input.changedResources ?? [])]);
        return { replayed: ingestedOperationIds.length > 1 };
      }
    };

    await recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent());
    await recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent());

    expect(ingestedOperationIds).toHaveLength(2);
    expect(ingestedOperationIds[0]).toMatch(/^runtime_chat_completion_/);
    expect(ingestedOperationIds[0]).not.toBe(ingestedOperationIds[1]);
    expect(ingestedActivityIds[0]).toBe(ingestedActivityIds[1]);
    expect(ingestedEpisodeKeys).toEqual(["run-a", "run-a"]);
    expect(changedResourceIds).toEqual([["message-output-a"], ["message-output-a"]]);
  });

  it("does not treat a conflicting Activity with the same ID as a successful projection", async () => {
    const commands = {
      ingestCompletionActivity: async () => {
        throw new WorkspaceServerError("workspace_completion_activity_id_conflict", 409);
      }
    };

    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).rejects.toMatchObject({
      code: "workspace_completion_activity_id_conflict",
      status: 409
    });
  });

  it("uses a new operation ledger entry after a failed projection", async () => {
    const ingestedOperationIds: string[] = [];
    const commands = {
      ingestCompletionActivity: async (context: { operationId: string }) => {
        ingestedOperationIds.push(context.operationId);
        if (ingestedOperationIds.length === 1) throw new Error("projection_write_failed");
        return {};
      }
    };

    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).rejects.toThrow("projection_write_failed");
    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).resolves.toEqual(undefined);

    expect(ingestedOperationIds).toHaveLength(2);
    expect(ingestedOperationIds[0]).not.toBe(ingestedOperationIds[1]);
  });
});

function projectionContext() {
  return {
    workspaceId: "workspace-a",
    accountId: "account-a",
    operationId: "request-a"
  };
}

function completionEvent(): PostgresRuntimeChatCompletionEvent {
  return {
    session: {
      id: "session-a",
      session_key: "workspace:workspace-a:thread-a",
      room_id: "room-a",
      title: "A session",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z"
    },
    run: {
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      phase: "settled",
      current_attempt: 1,
      input_message_id: "message-a",
      output_message_id: "message-output-a",
      requested_by_participant_id: "account-a",
      request_idempotency_key: "request-a",
      request_hash: "request-hash-a",
      started_at: "2026-09-03T00:00:00.000Z",
      completed_at: "2026-09-03T00:01:00.000Z",
      input_summary: "A request",
      output_summary: "A response",
      metadata: {}
    },
    resourceRefs: [
      { kind: "message", id: "message-output-a", uri: "runtime://messages/message-output-a" },
      { kind: "message", id: "message-output-a", uri: "runtime://messages/message-output-a" }
    ],
    instructionSummary: "A request"
  };
}
