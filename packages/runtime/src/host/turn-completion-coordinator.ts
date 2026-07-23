import type { BackendRunRecord, MessageRecord } from "@samurai-agent/core-schemas";
import { nowIso } from "@samurai-agent/core-schemas";
import type { AdmittedTurn, HostCompletionPort, PostTurnPort, TurnOutput, TurnSettlementInput } from "./host-types";

export interface CompletionStore {
  commitTurnSettlement(input: TurnSettlementInput): Promise<BackendRunRecord>;
}

/** Required persistence and optional side effects are intentionally separate. */
export class TurnCompletionCoordinator implements HostCompletionPort {
  constructor(
    private readonly store: CompletionStore,
    private readonly postTurns: readonly PostTurnPort[] = [],
    private readonly clock: () => string = nowIso,
    private readonly recordPostTurnFailure?: (input: { runId: string; operation: string; error: unknown }) => void | Promise<void>
  ) {}

  async commitTurnSettlement(input: TurnSettlementInput & { admitted: AdmittedTurn; turnOutput: TurnOutput }): Promise<BackendRunRecord> {
    const message: MessageRecord | undefined = input.turnOutput.content ? {
      id: input.outputSourceId, session_id: input.admitted.session.id, role: "agent", content: input.turnOutput.content,
      input_locale: input.admitted.userMessage.input_locale, output_locale: input.admitted.session.output_locale, created_at: this.clock()
    } : undefined;
    const settled = await this.store.commitTurnSettlement({ ...input, output: message });
    if (settled.status === "completed") {
      for (const postTurn of this.postTurns) {
        try {
          await postTurn.run({ admitted: input.admitted, run: settled, output: input.turnOutput });
        } catch (error) {
          try {
            await this.recordPostTurnFailure?.({ runId: settled.id, operation: postTurn.id ?? "post_turn", error });
          } catch {
            // Failure reporting is optional and must not alter a committed Run.
          }
        }
      }
    }
    return settled;
  }
}
