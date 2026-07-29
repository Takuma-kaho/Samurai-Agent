import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import type { Core02SettlementInput } from "../workspace-store-contracts";
import { ManagedResourceSynchronizer } from "../repositories/managed-resource-synchronizer";

export interface HostDiagnosticPort {
  appendHostDiagnostic(input: {
    runId: string;
    sessionId: string;
    attemptNo: number;
    operationId: string;
    eventType: "host_post_turn_failed" | "host_cleanup_failed" | "host_emit_failed";
    message: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<void>;
}

/**
 * Runs only after terminal settlement.  It deliberately sits outside the
 * settlement transaction: a filesystem indexing problem must not undo an
 * already durable answer or reservation release.
 */
export class ManagedResourcePostTurnService {
  constructor(
    private readonly managedResources: ManagedResourceSynchronizer,
    private readonly diagnostics: HostDiagnosticPort
  ) {}

  async synchronizeAfterSettlement(run: BackendRunRecord, input: Core02SettlementInput): Promise<void> {
    try {
      const synchronized = await this.managedResources.synchronizeAll();
      const issues = [
        ...synchronized.memory.errors,
        ...synchronized.wiki.errors,
        ...synchronized.skills.errors,
        ...synchronized.collections.schemas.errors,
        ...synchronized.collections.records.errors
      ];
      if (issues.length === 0) return;
      await this.diagnostics.appendHostDiagnostic({
        runId: run.id,
        sessionId: run.session_id,
        attemptNo: input.attemptNo,
        operationId: "workspace.managed_resource.sync",
        eventType: "host_post_turn_failed",
        message: "Managed Workspace resource synchronization reported issues.",
        metadata: { issue_count: issues.length }
      });
    } catch (error) {
      await this.diagnostics.appendHostDiagnostic({
        runId: run.id,
        sessionId: run.session_id,
        attemptNo: input.attemptNo,
        operationId: "workspace.managed_resource.sync",
        eventType: "host_post_turn_failed",
        message: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  }
}
