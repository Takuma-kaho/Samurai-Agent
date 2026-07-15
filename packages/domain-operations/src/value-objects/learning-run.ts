import {
  CuratorLifecycleReportSchema,
  CuratorReviewReportSchema,
  EvaluationTraceReportSchema,
  LearningEvaluationRecordSchema,
  ReflectionRunRecordSchema,
  ReflectionSuggestionRecordSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";

export const curatorRunValueSchema = z.object({
  reflectionRun: ReflectionRunRecordSchema,
  suggestions: z.array(ReflectionSuggestionRecordSchema),
  curatorReport: CuratorLifecycleReportSchema,
  curatorReviewReport: CuratorReviewReportSchema
}).strict();

export const evaluationRunValueSchema = z.object({
  reflectionRun: ReflectionRunRecordSchema,
  suggestions: z.array(ReflectionSuggestionRecordSchema),
  evaluationReport: EvaluationTraceReportSchema,
  learningEvaluations: z.array(LearningEvaluationRecordSchema)
}).strict();
