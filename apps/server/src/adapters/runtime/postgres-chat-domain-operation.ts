import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { RunChatTurnResult } from "@samurai-agent/runtime";
import { PostgresRuntimeCommandService } from "./postgres-runtime-chat";

/**
 * PostgreSQL's Runtime adapter for the shared `chat.turn.run` contract.
 *
 * The HTTP route supplies only the authenticated Account, Session, and
 * idempotency identity. Room authorization and evidence persistence remain in
 * PostgresRuntimeCommandService; this adapter does not create a second write
 * path around either boundary.
 */
export async function runPostgresChatTurnThroughDomainOperation(
  runtime: PostgresRuntimeCommandService,
  request: {
    workspaceId: string;
    accountId: string;
    sessionId: string;
    idempotencyKey: string;
    input: unknown;
  }
): Promise<RunChatTurnResult> {
  const context: TrustedDomainContext = {
    inputSource: "runtime_api",
    workspaceId: request.workspaceId,
    actorId: request.accountId,
    sessionId: request.sessionId,
    correlationId: request.idempotencyKey,
    idempotencyKey: request.idempotencyKey
  };
  const result = await runtime.runDomainCommand({
    operationId: "chat.turn.run",
    context,
    input: request.input
  });
  return result as RunChatTurnResult;
}
