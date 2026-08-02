import type { BackendRunRecord, MessageRecord } from "@samurai-agent/core-schemas";
import { nowIso } from "@samurai-agent/core-schemas";
import type { AdmittedTurn, CommitTurnSettlementPort, HostCompletionPort, HostDiagnosticsPort, PostTurnOperations, TurnOutput, TurnSettlementInput } from "./host-types";

export interface CompletionStore extends CommitTurnSettlementPort {}

/** Settlement is durable first; named post-turn operations run only afterwards. */
export class TurnCompletionCoordinator implements HostCompletionPort {
  constructor(
    private readonly store: CompletionStore,
    private readonly postTurn: PostTurnOperations,
    private readonly diagnostics: HostDiagnosticsPort,
    private readonly clock: () => string = nowIso
  ) {}

  async commitTurnSettlement(input: TurnSettlementInput & { admitted: AdmittedTurn; turnOutput: TurnOutput }): Promise<BackendRunRecord> {
    const message: MessageRecord | undefined = input.turnOutput.content ? {
      id: input.outputSourceId,
      session_id: input.admitted.session.id,
      role: "agent",
      content: input.turnOutput.content,
      input_locale: input.admitted.userMessage.input_locale,
      output_locale: input.admitted.session.output_locale,
      created_at: this.clock()
    } : undefined;
    const settled = await this.store.commitTurnSettlement({ ...input, output: message });
    if (settled.status !== "completed") return settled;

    const operations = [
      this.postTurn.presentation,
      this.postTurn.externalAssistSync,
      this.postTurn.notification,
      this.postTurn.telemetry
    ];
    for (const operation of operations) {
      if (!operation) continue;
      try {
        await operation.run({ admitted: input.admitted, run: settled, output: input.turnOutput });
      } catch (error) {
        const diagnostic = {
          runId: settled.id,
          sessionId: settled.session_id,
          attemptNo: settled.current_attempt ?? 1,
          operationId: operation.operationId,
          eventType: "host_post_turn_failed" as const,
          message: error instanceof Error ? error.message : String(error)
        };
        try {
          await this.diagnostics.record(diagnostic);
        } catch (diagnosticError) {
          this.diagnostics.logPersistenceFailure({ ...diagnostic, error: diagnosticError });
        }
      }
    }
    return settled;
  }
}
