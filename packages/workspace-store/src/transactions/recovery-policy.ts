export type WorkspaceFileRecoveryAction = "finalize_staged" | "accept_target" | "rollback_database" | "discard_staged";

export function workspaceFileRecoveryAction(input: { status: string; stagedExists: boolean; targetVersion?: number; afterVersion?: number }): WorkspaceFileRecoveryAction {
  if (input.status !== "db_committed") return "discard_staged";
  if (input.stagedExists) return "finalize_staged";
  if (input.targetVersion !== undefined && input.targetVersion === input.afterVersion) return "accept_target";
  return "rollback_database";
}
