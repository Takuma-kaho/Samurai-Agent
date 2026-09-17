import {
  WorkspaceCompletionService,
  type WorkspaceCompletionImportEntry
} from "@samurai-agent/workspace-server";
import type {
  WorkspaceShareImportWriter,
  WorkspaceShareImportWriterContext,
  WorkspaceShareImportedEntry
} from "./share-postgres";

/** Bridges Share Core's manifest representation to the Completion transaction
 * writer. The supplied SQL remains the transaction opened by Share Core. */
export class PostgresWorkspaceShareCompletionImportWriter implements WorkspaceShareImportWriter {
  constructor(private readonly completion: WorkspaceCompletionService) {}

  async commitRoomKnowledge(input: WorkspaceShareImportWriterContext & {
    targetRoomId: string;
    entries: readonly WorkspaceShareImportedEntry[];
  }): Promise<{ createdAgentId: null; createdResourceIds: readonly string[] }> {
    const result = await this.completion.commitImportedShare({
      sql: input.sql,
      context: {
        workspaceId: input.context.workspaceId,
        accountId: input.context.accountId,
        operationId: input.operationId
      },
      operationId: input.operationId,
      scope: { kind: "room", roomId: input.targetRoomId },
      entries: mapImportedEntries(input.entries),
      reservedResourceIds: input.reservedResourceIds
    });
    return { createdAgentId: null, createdResourceIds: result.createdResourceIds };
  }

  async commitAgent(input: WorkspaceShareImportWriterContext & {
    agentId: string;
    agent: { name: string; role: string; instructions: string };
    entries: readonly WorkspaceShareImportedEntry[];
  }): Promise<{ createdAgentId: string; createdResourceIds: readonly string[] }> {
    const result = await this.completion.commitImportedShare({
      sql: input.sql,
      context: {
        workspaceId: input.context.workspaceId,
        accountId: input.context.accountId,
        operationId: input.operationId
      },
      operationId: input.operationId,
      scope: { kind: "agent", agentId: input.agentId },
      agent: input.agent,
      entries: mapImportedEntries(input.entries),
      reservedResourceIds: input.reservedResourceIds
    });
    return { createdAgentId: input.agentId, createdResourceIds: result.createdResourceIds };
  }
}

export function createPostgresWorkspaceShareCompletionImportWriter(
  completion: WorkspaceCompletionService
): WorkspaceShareImportWriter {
  return new PostgresWorkspaceShareCompletionImportWriter(completion);
}

function mapImportedEntries(entries: readonly WorkspaceShareImportedEntry[]): WorkspaceCompletionImportEntry[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    kind: entry.kind,
    title: entry.title,
    content: entry.content,
    ...(entry.knowledgeKind ? { knowledgeKind: entry.knowledgeKind } : {}),
    files: entry.files.map((file) => ({
      path: file.path,
      content: file.content,
      byteSize: file.byteSize,
      sha256: file.sha256
    }))
  }));
}
