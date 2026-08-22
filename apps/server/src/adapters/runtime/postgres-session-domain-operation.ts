import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import type { SessionRecord } from "@samurai-agent/core-schemas";
import { PostgresRuntimeCommandService } from "./postgres-runtime-chat";

/** PostgreSQL adapter for the shared Session creation operation. */
export async function createPostgresChatSessionThroughDomainOperation(
  runtime: PostgresRuntimeCommandService,
  request: { workspaceId: string; accountId: string; operationId: string; input: unknown }
): Promise<SessionRecord> {
  const context: TrustedDomainContext = {
    inputSource: "runtime_api",
    workspaceId: request.workspaceId,
    actorId: request.accountId,
    correlationId: request.operationId,
    idempotencyKey: request.operationId
  };
  const result = await runtime.runDomainCommand({
    operationId: "session.create",
    context,
    input: request.input
  });
  return result as SessionRecord;
}
