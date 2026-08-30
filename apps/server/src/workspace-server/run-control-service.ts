import {
  runControlCatalog,
  type RunControlAction
} from "@samurai-agent/domain-api";
import {
  type BackendRunRecord,
  type JsonValue
} from "@samurai-agent/core-schemas";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";

export type RunControlRuntimeResult = BackendRunRecord | { backendRun: BackendRunRecord };

/** Narrow Runtime port used by the public Run Control application boundary. */
export interface RunControlRuntimePort {
  getBackendRun(runId: string): Promise<BackendRunRecord | undefined>;
  executeRunControlAction(input: {
    action: RunControlAction;
    runId: string;
    resumeInput: Record<string, JsonValue>;
    idempotencyKey: string;
    confirmUnknown?: boolean;
  }): Promise<RunControlRuntimeResult>;
}

export interface RunControlExecution {
  result: RunControlRuntimeResult;
  run: BackendRunRecord;
  replayed: boolean;
}

/**
 * Keeps the public Run Control lifecycle in one application service.  HTTP
 * only supplies authenticated selections; it never chooses a mutable Runtime
 * method or decides whether a repeated action emits another Event.
 */
export class RunControlService {
  async execute(input: {
    runtime: RunControlRuntimePort;
    action: RunControlAction;
    runId: string;
    roomId?: string;
    sessionId?: string;
    resumeInput: Record<string, JsonValue>;
    idempotencyKey: string;
    confirmUnknown?: boolean;
    onChanged?: (change: { action: RunControlAction; run: BackendRunRecord }) => Promise<void>;
  }): Promise<RunControlExecution> {
    const before = await input.runtime.getBackendRun(input.runId);
    if (!before) throw new WorkspaceServerError("runtime_backend_run_not_found", 404);
    assertRunContext(input.roomId, input.sessionId, before);

    // Lifecycle actions are safe replays once settled. Retry deliberately
    // creates a new attempt and is therefore validated below.
    if (input.action !== "retry" && isSettledRun(before)) {
      return { result: before, run: before, replayed: true };
    }
    assertActionAllowed(input.action, before.status);

    const result = await input.runtime.executeRunControlAction({
      action: input.action,
      runId: input.runId,
      resumeInput: input.resumeInput,
      idempotencyKey: input.idempotencyKey,
      ...(input.confirmUnknown === true ? { confirmUnknown: true } : {})
    });
    const run = runFromControlResult(result);
    await input.onChanged?.({ action: input.action, run });
    return { result, run, replayed: false };
  }
}

function assertRunContext(roomId: string | undefined, sessionId: string | undefined, run: BackendRunRecord): void {
  if (roomId !== undefined && roomId !== run.room_id) throw new WorkspaceServerError("domain_context_mismatch", 400);
  if (sessionId !== undefined && sessionId !== run.session_id) throw new WorkspaceServerError("domain_context_mismatch", 400);
}

function assertActionAllowed(action: RunControlAction, status: BackendRunRecord["status"]): void {
  const contract = runControlCatalog.find((candidate) => candidate.action === action);
  if (!contract || !contract.allowed_states.includes(status)) {
    throw new WorkspaceServerError("run_control_state_invalid", 409, { action, status });
  }
}

function isSettledRun(run: BackendRunRecord): boolean {
  return ["completed", "failed", "cancelled", "outcome_unknown"].includes(run.status);
}

function runFromControlResult(value: RunControlRuntimeResult): BackendRunRecord {
  return "backendRun" in value ? value.backendRun : value;
}
