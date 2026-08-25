import { describe, expect, it } from "vitest";
import type {
  AgentBackend,
  BackendOutputEvent,
  BackendRunInput
} from "@samurai-agent/agent-backends";
import {
  WorkspaceServerError,
  type WorkspaceCompletionReviewSnapshot
} from "@samurai-agent/workspace-server";
import { WorkspaceCompletionBackendReviewPort } from "./workspace-completion-review-port";

describe("WorkspaceCompletionBackendReviewPort", () => {
  it("returns a validated review and does not grant backend file or tool capabilities", async () => {
    let received: BackendRunInput | undefined;
    const backend = reviewBackend(async function* (input) {
      received = input;
      yield { event_type: "text_delta", payload: { text: JSON.stringify({
        reviewer: "backend:samurai-native",
        summary: "No reusable resource was justified.",
        candidates: [{ kind: "skip", reason: "The snapshot contains no explicit reusable decision.", evidenceActivityIds: ["activity-1"] }]
      }) } } satisfies BackendOutputEvent;
      yield {
        event_type: "run_completed",
        terminal_evidence: { kind: "completed", source: "owned_loop_return" },
        payload: { output_summary: "review completed" }
      } satisfies BackendOutputEvent;
    });

    const result = await new WorkspaceCompletionBackendReviewPort(backend).review(snapshot());

    expect(result.candidates[0]).toMatchObject({ kind: "skip", evidenceActivityIds: ["activity-1"] });
    expect(received).toMatchObject({
      room_id: "room-1",
      available_tools: [],
      active_memory: [],
      recent_messages: []
    });
    expect(received?.workspace_root).toBeUndefined();
    expect(received?.working_directory).toBeUndefined();
  });

  it("rejects a non-host backend instead of silently giving it a review snapshot", () => {
    expect(() => new WorkspaceCompletionBackendReviewPort({
      ...reviewBackend(async function* () {}),
      id: "codex",
      kind: "codex",
      execution_owner: "backend"
    } as AgentBackend)).toThrowError(new WorkspaceServerError("workspace_completion_review_backend_boundary_invalid", 500));
  });
});

function reviewBackend(
  runTurn: (input: BackendRunInput) => AsyncIterable<BackendOutputEvent>
): AgentBackend {
  return {
    id: "samurai-native",
    kind: "samurai_native",
    label: "Samurai Native fixture",
    sessionPolicy: { acquisition: "none", resume: "unsupported" },
    execution_owner: "host",
    runTurn
  };
}

function snapshot(): WorkspaceCompletionReviewSnapshot {
  return {
    workspaceId: "workspace-1",
    roomId: "room-1",
    episodeId: "episode-1",
    highWatermarkActivityId: "activity-1",
    activityCount: 1,
    resourceCount: 0,
    digest: "a".repeat(64),
    configurationVersion: 1,
    activities: [{
      workspaceId: "workspace-1",
      roomId: "room-1",
      id: "activity-1",
      principalAccountId: "account-1",
      sourceApp: "test-client",
      instructionSummary: "A completed operation.",
      changedResources: [],
      verificationOutcome: "confirmed",
      failureState: "none",
      outcome: "completed",
      explicitRemember: false,
      payload: {},
      createdAt: "2026-08-22T00:00:00.000Z",
      finalizedAt: "2026-08-22T00:00:01.000Z"
    }],
    resources: []
  };
}
