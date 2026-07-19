import { LearningResourceUseRecordSchema, type LearningResourceUseRecord } from "@samurai-agent/core-schemas";

export interface LearningUsageTracePort {
  recordLearningResourceUse(record: LearningResourceUseRecord): Promise<LearningResourceUseRecord>;
  listLearningResourceUses(input?: { runId?: string; sessionId?: string; resourceId?: string }): Promise<LearningResourceUseRecord[]>;
}

export function isActualLearningResourceUse(record: LearningResourceUseRecord): boolean {
  return record.stage === "body_loaded" || record.stage === "support_loaded";
}

export function actualLearningResourceUses(records: LearningResourceUseRecord[]): LearningResourceUseRecord[] {
  return records.filter(isActualLearningResourceUse);
}

export function parseLearningResourceUse(input: unknown): LearningResourceUseRecord {
  return LearningResourceUseRecordSchema.parse(input);
}
