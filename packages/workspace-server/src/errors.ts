export class WorkspaceServerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, status = 400, details?: Record<string, unknown>) {
    super(code);
    this.name = "WorkspaceServerError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asWorkspaceServerError(error: unknown): WorkspaceServerError {
  if (error instanceof WorkspaceServerError) return error;
  return new WorkspaceServerError("workspace_server_internal_error", 500);
}
