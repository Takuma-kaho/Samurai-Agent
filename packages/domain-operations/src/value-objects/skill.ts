import {
  ExecutionScopeSchema,
  LearningResourceUseRecordSchema,
  ObjectiveRecordSchema,
  OptimizationCandidateSchema,
  OptimizationPromotionSchema,
  ResourceRefSchema,
  SkillFrontmatterSchema,
  SkillOptimizationRunSchema,
  SkillOptimizationSnapshotSchema,
  SkillStateSchema,
  WorkItemRecordSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { runtimeWriteValueSchema } from "./runtime-write.js";
import { domainJsonValueSchema } from "../definition/index.js";

const skillOptimizationExampleBaseShape = {
  id: z.string().min(1),
  skill_id: z.string().min(1),
  prompt: z.string().min(1),
  expected_behavior: z.string().min(1),
  feedback: z.string().min(1),
  split: z.enum(["train", "validation", "holdout"]),
  trace_refs: z.array(ResourceRefSchema),
  metadata: z.record(domainJsonValueSchema),
  created_at: z.string().datetime()
};

const skillOptimizationExampleValueSchema = z.discriminatedUnion("source", [
  z.object({ ...skillOptimizationExampleBaseShape, source: z.literal("synthetic"), skill_body_read_run_id: z.string().min(1).optional() }).strict(),
  z.object({ ...skillOptimizationExampleBaseShape, source: z.enum(["real", "golden"]), skill_body_read_run_id: z.string().min(1) }).strict()
]);

const skillOptimizationDatasetValueSchema = z.object({
  id: z.string().min(1),
  skill_id: z.string().min(1),
  examples: z.array(skillOptimizationExampleValueSchema).min(20),
  split_counts: z.object({
    train: z.number().int().min(12),
    validation: z.number().int().min(4),
    holdout: z.number().int().min(4)
  }).strict(),
  holdout_non_synthetic_count: z.number().int().min(1),
  created_at: z.string().datetime()
}).strict();

export const storedSkillSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  state: SkillStateSchema,
  allowed_scopes: z.array(ExecutionScopeSchema),
  required_capabilities: z.array(z.string()),
  owner_pinned: z.boolean(),
  frontmatter: SkillFrontmatterSchema,
  file_path: z.string().min(1)
}).strict();

export const skillSupportFileSchema = z.object({
  skill_id: z.string().min(1),
  path: z.string().min(1),
  file_path: z.string().min(1),
  content: z.string()
}).strict();

export const skillWriteValueSchema = runtimeWriteValueSchema(storedSkillSchema);
export const skillSupportFileWriteValueSchema = runtimeWriteValueSchema(skillSupportFileSchema);
export const skillUsageRecordValueSchema = z.object({ use_record: LearningResourceUseRecordSchema }).strict();

export const skillOptimizationStartValueSchema = z.object({
  run: SkillOptimizationRunSchema,
  dataset: skillOptimizationDatasetValueSchema,
  objective: ObjectiveRecordSchema,
  work_item: WorkItemRecordSchema
}).strict();

export const skillOptimizationPromoteValueSchema = z.object({
  run: SkillOptimizationRunSchema,
  skill: storedSkillSchema,
  candidate: OptimizationCandidateSchema,
  snapshot: SkillOptimizationSnapshotSchema,
  promotion: OptimizationPromotionSchema
}).strict();

export const skillOptimizationRejectValueSchema = z.object({
  run: SkillOptimizationRunSchema,
  candidate: OptimizationCandidateSchema
}).strict();

export const skillOptimizationRollbackValueSchema = z.object({
  skill: storedSkillSchema,
  snapshot: SkillOptimizationSnapshotSchema,
  promotion: OptimizationPromotionSchema.optional()
}).strict();
