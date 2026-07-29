/** Process-local guard for operations that rearrange or reconcile Workspace state. */
export class WorkspaceMaintenanceGuard {
  private busy = false;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("workspace_maintenance_busy");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
}
