import {
  CuratorLifecycleReportSchema,
  CuratorReviewReportSchema,
  EvaluationTraceReportSchema,
  LearningEvaluationRecordSchema,
  MemoryFrontmatterSchema,
  ReflectionRunRecordSchema,
  ReflectionSuggestionRecordSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { storedSkillSchema } from "./skill.js";
import { storedWikiSchema } from "./wiki.js";

export const reflectionRunValueSchema = z.object({
  reflectionRun: ReflectionRunRecordSchema,
  suggestions: z.array(ReflectionSuggestionRecordSchema),
  learningEvaluations: z.array(LearningEvaluationRecordSchema).optional(),
  curatorReport: CuratorLifecycleReportSchema.optional(),
  curatorReviewReport: CuratorReviewReportSchema.optional(),
  evaluationReport: EvaluationTraceReportSchema.optional()
}).strict();

export const reflectionSuggestionApplyValueSchema = runtimeWriteValueSchema(
  z.union([MemoryFrontmatterSchema, storedWikiSchema, storedSkillSchema])
);
