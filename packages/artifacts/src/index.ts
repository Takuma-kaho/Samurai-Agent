import {
  type ArtifactRecord,
  type OperationRecord,
  type SupportedLocale,
  createId,
  nowIso
} from "@samurai-agent/core-schemas";
import type { WorkspaceStore } from "@samurai-agent/workspace-store";

export interface CreateArtifactDraftInput {
  store: WorkspaceStore;
  operation: OperationRecord;
  title: string;
  content: string;
  locale: SupportedLocale;
  sourceLocales: SupportedLocale[];
  createdBy: string;
}

export async function createArtifactDraft(input: CreateArtifactDraftInput): Promise<ArtifactRecord> {
  const now = nowIso();
  const id = createId("artifact");
  const relativePath = await input.store.writeArtifactContent(id, input.content);
  const record: ArtifactRecord = {
    id,
    title: input.title,
    kind: "markdown",
    locale: input.locale,
    source_locales: input.sourceLocales,
    file_ref: {
      kind: "artifact",
      id,
      uri: relativePath,
      version: now,
      label: input.title
    },
    metadata: {
      word_count: input.content.trim().split(/\s+/).filter(Boolean).length,
      status: "draft"
    },
    source_operation_id: input.operation.id,
    created_by: input.createdBy,
    created_at: now,
    updated_at: now
  };

  return input.store.saveArtifactMetadata(record);
}
