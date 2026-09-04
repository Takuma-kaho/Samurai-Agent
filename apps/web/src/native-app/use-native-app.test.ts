import { describe, expect, it } from "vitest";
import {
  backendRunForChatRequest,
  shouldDiscardWorkspaceTargetAfterReauthorizationFailure,
  streamingAgentMessageFromBackendEvents,
  textDeltaContentForRun,
  workspaceDirectoryRequestIsCurrent,
  workspaceDirectoryStateFingerprint,
  workspaceTransferStatusFromUnknown,
  workspaceTransferStatusMessage,
  workspacesAfterReauthorizationFailure
} from "./use-native-app";
import type { DesktopWorkspaceConnectionState } from "../lib/api";
import type { BackendEventRecord, BackendRunRecord } from "@samurai-agent/core-schemas";
import type { NativeWorkspaceTransferStatus } from "./types";

const source = { connectionId: "server_a", workspaceId: "workspace_a" };
const destination = { connectionId: "server_b", workspaceId: "workspace_b" };
const fallback = {
  transferId: "transfer_1",
  source,
  destination,
  workspace: {
    id: "workspace_a",
    name: "移転対象",
    state: "active" as const,
    access: "granted" as const,
    target: source
  }
};

const runStartedAt = "2026-09-04T00:00:00.000Z";

function backendRun(id: string, sessionId: string, requestId: string, startedAt = runStartedAt): BackendRunRecord {
  return {
    id,
    session_id: sessionId,
    room_id: "room_a",
    backend_id: "samurai-native",
    backend_kind: "samurai_native",
    status: "running",
    started_at: startedAt,
    request_idempotency_key: requestId,
    input_summary: "入力",
    metadata: {}
  };
}

function textEvent(id: string, runId: string, sequence: number, text: string, sessionId = "session_a"): BackendEventRecord {
  return {
    id,
    run_id: runId,
    session_id: sessionId,
    event_type: "text_delta",
    sequence,
    payload: { text },
    resource_refs: [],
    created_at: runStartedAt
  };
}

describe("Persisted chat stream projection", () => {
  it("selects only the run matching the Session and request idempotency key", () => {
    const expected = backendRun("run-current", "session_a", "request_a", "2026-09-04T00:00:01.000Z");
    expect(backendRunForChatRequest([
      backendRun("run-other-session", "session_b", "request_a"),
      backendRun("run-other-request", "session_a", "request_b"),
      expected
    ], "session_a", "request_a")).toBe(expected);
  });

  it("orders persisted deltas, removes duplicate event IDs, and excludes another run", () => {
    const events = [
      textEvent("event-2", "run-a", 3, "世界"),
      textEvent("event-other-run", "run-b", 1, "別の実行"),
      textEvent("event-1", "run-a", 2, "こんにちは"),
      textEvent("event-2", "run-a", 3, "重複")
    ];

    expect(textDeltaContentForRun(events, "run-a")).toBe("こんにちは世界");
    expect(streamingAgentMessageFromBackendEvents(backendRun("run-a", "session_a", "request_a"), events)).toMatchObject({
      id: "streaming-agent:run-a",
      role: "agent",
      content: "こんにちは世界",
      pending: true
    });
  });

  it("does not render malformed or empty text payloads", () => {
    const malformed = { ...textEvent("event-empty", "run-a", 1, ""), payload: { text: 42 } } as BackendEventRecord;
    expect(textDeltaContentForRun([malformed], "run-a")).toBe("");
  });
});

describe("Workspace transfer status projection", () => {
  it.each([
    ["preparing", "移転の準備中です。移転元は保持されています。"],
    ["exported", "Export済みです。移転元は保持されています。"],
    ["imported", "移転先へ復元済みです。移転元は保持されています。"],
    ["committed", "移転完了を確認中です。移転元は保持されています。"],
    ["rolled_back", "移転を安全に取り消しました。移転元は保持されています。"],
    ["failed", "移転に失敗しました。移転元は保持されています。"]
  ] as const)("projects the Server %s state without claiming success", (serverState, message) => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: serverState,
      target_workspace_id: "workspace_b",
      source_workspace_state: "read_only",
      source_archived: false
    }, fallback);

    expect(status.serverState).toBe(serverState);
    expect(status.state).toBe(serverState);
    expect(status.message).toBe(message);
  });

  it("keeps the Server imported state and only exposes receipt presence", () => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "imported",
      source_integrity_hash: "a".repeat(64),
      target_integrity_hash: "a".repeat(64),
      target_workspace_id: "workspace_b",
      receipt_present: true,
      source_workspace_state: "read_only",
      target_receipt: { imported_at: "private" }
    }, fallback);

    expect(status).toMatchObject({
      state: "imported",
      serverState: "imported",
      targetWorkspaceId: "workspace_b",
      receiptPresent: true,
      sourceWorkspaceState: "read_only",
      sourceIntegrityHash: "a".repeat(64),
      targetIntegrityHash: "a".repeat(64)
    });
    expect(status.message).toBe("移転先へ復元済みです。受領確認を待っています。");
    expect(status).not.toHaveProperty("targetReceipt");
  });

  it("says archive is confirmed only when the Server confirms it", () => {
    const status = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "committed",
      target_workspace_id: "workspace_b",
      receipt_present: true,
      source_workspace_state: "archived",
      source_archived: true
    }, fallback);

    expect(status.state).toBe("committed");
    expect(status.sourceArchived).toBe(true);
    expect(status.message).toBe("移転完了。移転元はArchive済みです。");
  });

  it("keeps rollback and partial restore visibly safe", () => {
    const rolledBack = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "rolled_back",
      target_workspace_id: "workspace_b",
      receipt_present: false,
      source_workspace_state: "active",
      source_archived: false
    }, fallback);
    const failed = workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "failed",
      target_workspace_id: "workspace_b",
      target_restored: true,
      target_cleanup_required: true,
      source_workspace_state: "read_only",
      source_archived: false
    }, fallback);

    expect(rolledBack.message).toBe("移転を安全に取り消しました。移転元は保持されています。");
    expect(failed.message).toBe("移転が途中で停止しました。移転元は保持されています。移転先の確認が必要です。");
  });

  it("rejects a mismatched target or an unknown state instead of showing a false preflight", () => {
    expect(() => workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "imported",
      target_workspace_id: "workspace_other"
    }, fallback)).toThrow("workspace_transfer_status_target_mismatch");
    expect(() => workspaceTransferStatusFromUnknown({
      transfer_id: "transfer_1",
      state: "not-a-transfer-state"
    }, fallback)).toThrow("workspace_transfer_status_invalid");
  });

  it("keeps the local source-archived checkpoint understandable", () => {
    const status: NativeWorkspaceTransferStatus = {
      transferId: "transfer_1",
      source,
      destination,
      state: "source_archived",
      workspaceId: "workspace_a"
    };

    expect(workspaceTransferStatusMessage(status)).toBe("移転完了。移転元はArchive済みです。");
  });
});

describe("Workspace reauthorization failure state", () => {
  it.each([
    ["workspace_selection_denied", true],
    ["workspace_reauthorization_denied", true],
    ["workspace_target_not_found", true],
    ["workspace_identity_required", false],
    ["workspace_selection_unavailable", false]
  ] as const)("classifies %s as %s", (code, shouldDiscard) => {
    expect(shouldDiscardWorkspaceTargetAfterReauthorizationFailure(new Error(code))).toBe(shouldDiscard);
  });

  it("recognizes an HTTP denial even when the error message is generic", () => {
    const error = Object.assign(new Error("Workspace request failed"), { status: 403 });
    expect(shouldDiscardWorkspaceTargetAfterReauthorizationFailure(error)).toBe(true);
  });

  it("locks only the denied connection + Workspace target", () => {
    const denied = {
      id: "workspace_shared",
      name: "Server AのWorkspace",
      state: "active" as const,
      access: "granted" as const,
      target: { connectionId: "server_a", workspaceId: "workspace_shared" }
    };
    const sameIdOnOtherServer = {
      id: "workspace_shared",
      name: "Server BのWorkspace",
      state: "active" as const,
      access: "granted" as const,
      target: { connectionId: "server_b", workspaceId: "workspace_shared" }
    };

    const next = workspacesAfterReauthorizationFailure([denied, sameIdOnOtherServer], denied.target);

    expect(next[0]).toMatchObject({ access: "none", connectionError: "workspace_reauthorization_denied" });
    expect(next[1]).toBe(sameIdOnOtherServer);
    expect(next[1]).toMatchObject({ access: "granted" });
  });
});

describe("Workspace directory request generation", () => {
  const stateA: DesktopWorkspaceConnectionState = {
    activeConnectionId: "server_a",
    activeTarget: { connectionId: "server_a", workspaceId: "workspace_shared" },
    connections: [
      {
        id: "server_a",
        label: "Server A",
        serverUrl: "http://server-a.test",
        accountId: "account_a",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      },
      {
        id: "server_b",
        label: "Server B",
        serverUrl: "http://server-b.test",
        accountId: "account_b",
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z"
      }
    ]
  };
  const stateB: DesktopWorkspaceConnectionState = {
    ...stateA,
    activeConnectionId: "server_b",
    activeTarget: { connectionId: "server_b", workspaceId: "workspace_shared" }
  };

  it("accepts only the current generation and state snapshot", () => {
    const request = {
      generation: 4,
      stateFingerprint: workspaceDirectoryStateFingerprint(stateA)
    };

    expect(workspaceDirectoryRequestIsCurrent(request, 4, stateA)).toBe(true);
    expect(workspaceDirectoryRequestIsCurrent(request, 5, stateA)).toBe(false);
  });

  it("rejects a same-ID Workspace result after switching Servers", () => {
    const request = {
      generation: 8,
      stateFingerprint: workspaceDirectoryStateFingerprint(stateA)
    };

    expect(stateA.activeTarget?.workspaceId).toBe(stateB.activeTarget?.workspaceId);
    expect(workspaceDirectoryRequestIsCurrent(request, 8, stateB)).toBe(false);
  });
});
