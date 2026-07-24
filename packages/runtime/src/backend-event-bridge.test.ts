import { describe, expect, it } from "vitest";
import { BackendEventBridge } from "./backend-event-bridge";

describe("BackendEventBridge", () => {
  it("normalizes backend events, assigns sequence, and drops invalid resource refs", () => {
    const bridge = new BackendEventBridge({ runId: "run_1", sessionId: "session_1", attemptNo: 1, startSequence: 5 });

    const first = bridge.project({
      event_type: "tool_call_output",
      payload: {
        ok: true,
        nested: { unsupported: undefined }
      },
      resource_refs: [
        { kind: "artifact", id: "artifact_1", uri: "artifacts/artifact_1.md" },
        { kind: "artifact", uri: "missing-id" } as never
      ]
    });
    const second = bridge.project({
      event_type: "run_completed",
      payload: { output_summary: "done" }
    });

    expect(first.record).toMatchObject({
      run_id: "run_1",
      session_id: "session_1",
      sequence: 5,
      payload: { ok: true, nested: { unsupported: null } },
      resource_refs: [{ kind: "artifact", id: "artifact_1", uri: "artifacts/artifact_1.md" }]
    });
    expect(first.visible).toBe(true);
    expect(first.uiRecord).toMatchObject({
      payload: { ok: true },
      resource_refs: []
    });
    expect(first.terminal).toBeUndefined();
    expect(second.record.sequence).toBe(6);
    expect(second.terminal).toBe("completed");
  });

  it("separates persisted event payloads from compact UI projections", () => {
    const bridge = new BackendEventBridge({ runId: "run_1", sessionId: "session_1", attemptNo: 1 });
    const started = bridge.project({
      event_type: "tool_call_started",
      payload: {
        tool_call_id: "tool_1",
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        execution_boundary: "host_runtime",
        requires_host_execution: true,
        arguments: {
          title: "Draft",
          api_key: "secret-key"
        }
      }
    });
    const output = bridge.project({
      event_type: "tool_call_output",
      payload: {
        tool_call_id: "tool_1",
        provider_tool_name: "shell.exec",
        action_id: "sandbox.exec",
        stdout: "x".repeat(4100),
        token: "secret-token",
        gateway_boundary: {
          decision: "allowed",
          action_id: "sandbox.exec",
          provider_tool_name: "shell.exec",
          policy_id: "policy_1",
          allowed_tools: ["sandbox.exec"],
          authorization: "Bearer secret"
        },
        secret_resolution: {
          secret_ref_ids: ["secret_1"],
          resolved_secret_ref_ids: ["secret_1"],
          raw_value: "secret"
        }
      },
      resource_refs: [{ kind: "artifact", id: "artifact_1", uri: "artifacts/artifact_1.md" }]
    });
    const submitted = bridge.project({
      event_type: "backend_native_input_submitted",
      payload: {
        submitted_at: "2026-06-26T00:00:00.000Z",
        input: { answer: "yes", api_key: "secret-key" }
      }
    });
    const hidden = bridge.project({
      event_type: "text_delta",
      payload: { text: "", ui_visible: false }
    });

    expect(started.record.payload).toMatchObject({
      arguments: { title: "Draft", api_key: "secret-key" }
    });
    expect(started.uiRecord?.payload).toEqual({
      tool_call_id: "tool_1",
      provider_tool_name: "create_artifact",
      action_id: "artifact.create",
      execution_boundary: "host_runtime",
      requires_host_execution: true
    });
    expect(output.record.payload).toMatchObject({
      stdout: "x".repeat(4100),
      token: "secret-token"
    });
    expect(output.uiRecord?.payload).toMatchObject({
      tool_call_id: "tool_1",
      provider_tool_name: "shell.exec",
      action_id: "sandbox.exec",
      gateway_boundary: {
        decision: "allowed",
        action_id: "sandbox.exec",
        provider_tool_name: "shell.exec",
        policy_id: "policy_1",
        allowed_tools: ["sandbox.exec"]
      },
      secret_resolution: {
        secret_ref_ids: ["secret_1"],
        resolved_secret_ref_ids: ["secret_1"]
      },
      summary: `${"x".repeat(4000)}...[truncated]`
    });
    expect(output.uiRecord?.payload).not.toHaveProperty("token");
    expect(JSON.stringify(output.uiRecord?.payload)).not.toContain("Bearer secret");
    expect(JSON.stringify(output.uiRecord?.payload)).not.toContain("raw_value");
    expect(output.uiRecord?.resource_refs).toEqual([]);
    expect(submitted.record.payload).toMatchObject({ input: { answer: "yes", api_key: "secret-key" } });
    expect(submitted.uiRecord?.payload).toEqual({
      submitted_at: "2026-06-26T00:00:00.000Z",
      has_input: true
    });
    expect(hidden.visible).toBe(false);
    expect(hidden.uiRecord).toBeUndefined();
  });
});
