export class ManagedResourceVersionConflictError extends Error {
  constructor(
    readonly resourceKind: "wiki" | "skill",
    readonly resourceId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(`${resourceKind}_resource_version_conflict:${resourceId}:${expectedVersion}:${actualVersion}`);
    this.name = "ManagedResourceVersionConflictError";
  }
}

/** A Room-scoped managed resource can move only while its persisted Room
 * boundary still agrees with the source scope and has no share history that
 * would become ambiguous after relocation. */
export class ManagedResourceScopeTransferError extends Error {
  constructor(
    readonly resourceKind: "wiki" | "skill",
    readonly resourceId: string,
    readonly reason: "source_scope_invalid" | "boundary_missing" | "boundary_source_mismatch" | "boundary_has_shares"
  ) {
    super(`${resourceKind}_scope_transfer_conflict:${resourceId}:${reason}`);
    this.name = "ManagedResourceScopeTransferError";
  }
}
