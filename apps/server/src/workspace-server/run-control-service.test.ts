import { describe, expect, it, vi } from "vitest";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { RunControlService, type RunControlRuntimePort } from "./run-control-service";

describe("RunControlService", () => {
  it("does not dispatch a settled lifecycle action or emit a duplicate Event", async () => {
    const runtime = runtimeFor(run("completed"));
    const onChanged = vi.fn();

    const result = await new RunControlService().execute({
      runtime,
      action: "cancel",
      runId: "run-1",
      roomId: "room-1",
      sessionId: "session-1",
      resumeInput: {},
      idempotencyKey: "operation-1",
      onChanged
    });

    expect(result).toMatchObject({ replayed: true, run: { id: "run-1", status: "completed" } });
    expect(runtime.executeRunControlAction).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("dispatches an allowed action through the single Runtime port and emits once", async () => {
    const updated = run("running");
    const runtime = runtimeFor(run("running"), updated);
    const onChanged = vi.fn();

    const result = await new RunControlService().execute({
      runtime,
      action: "sync",
      runId: "run-1",
      roomId: "room-1",
      sessionId: "session-1",
      resumeInput: {},
      idempotencyKey: "operation-2",
      onChanged
    });

    expect(result).toMatchObject({ replayed: false, run: updated });
    expect(runtime.executeRunControlAction).toHaveBeenCalledWith({
      action: "sync",
      runId: "run-1",
      resumeInput: {},
      idempotencyKey: "operation-2"
    });
    expect(onChanged).toHaveBeenCalledWith({ action: "sync", run: updated });
  });

  it("keeps retry separate and forwards its explicit confirmation", async () => {
    const retried = run("queued");
    const runtime = runtimeFor(run("outcome_unknown"), { backendRun: retried });

    const result = await new RunControlService().execute({
      runtime,
      action: "retry",
      runId: "run-1",
      resumeInput: { confirm_unknown: true },
      idempotencyKey: "operation-3",
      confirmUnknown: true
    });

    expect(result).toMatchObject({ replayed: false, run: retried });
    expect(runtime.executeRunControlAction).toHaveBeenCalledWith({
      action: "retry",
      runId: "run-1",
      resumeInput: { confirm_unknown: true },
      idempotencyKey: "operation-3",
      confirmUnknown: true
    });
  });

  it("rejects an action that is not allowed from the current Run state", async () => {
    const runtime = runtimeFor(run("running"));

    await expect(new RunControlService().execute({
      runtime,
      action: "retry",
      runId: "run-1",
      resumeInput: {},
      idempotencyKey: "operation-invalid-state"
    })).rejects.toMatchObject<Partial<WorkspaceServerError>>({
      code: "run_control_state_invalid",
      status: 409
    });
    expect(runtime.executeRunControlAction).not.toHaveBeenCalled();
  });

  it("rejects a selected Room that does not belong to the Run", async () => {
    const runtime = runtimeFor(run("running"));

    await expect(new RunControlService().execute({
      runtime,
      action: "sync",
      runId: "run-1",
      roomId: "room-other",
      resumeInput: {},
      idempotencyKey: "operation-4"
    })).rejects.toMatchObject<Partial<WorkspaceServerError>>({
      code: "domain_context_mismatch",
      status: 400
    });
    expect(runtime.executeRunControlAction).not.toHaveBeenCalled();
  });
});

function runtimeFor(before: BackendRunRecord, result: BackendRunRecord | { backendRun: BackendRunRecord } = before): RunControlRuntimePort & {
  executeRunControlAction: ReturnType<typeof vi.fn>;
} {
  return {
    getBackendRun: vi.fn(async () => before),
    executeRunControlAction: vi.fn(async () => result)
  };
}

function run(status: BackendRunRecord["status"]): BackendRunRecord {
  return {
    id: "run-1",
    session_id: "session-1",
    room_id: "room-1",
    backend_id: "backend-1",
    backend_kind: "mock",
    status,
    started_at: "2026-08-30T00:00:00.000Z",
    input_summary: "test",
    metadata: {}
  };
}
