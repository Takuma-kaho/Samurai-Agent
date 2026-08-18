import type { ActivityInboxItem, JsonValue, OperationRecord, ResourceRef, RollbackPoint } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "../../definition/index.js";
import { z } from "zod";
import { storedSkillSchema } from "../../value-objects/skill.js";

export type StoredSkill = z.infer<typeof storedSkillSchema>;

interface SkillMutationWorkflowPorts {
  skillMutationContract(id: "skill.patch" | "skill.candidate.create" | "skill.project.save" | "skill.support_file.save"): { id: string; proposed_effects: string[] };
  skillResourceRef(skill: StoredSkill): ResourceRef;
  createSkillRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runSkillMutation<T>(input: { trustedContext: TrustedDomainContext; operationName: string; proposedEffects: string[]; inputSummary: string; targetResourceRefs?: ResourceRef[]; boundaryResourceRefs?: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: T; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: T; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  skillMutationNotFound(message: string): Error;
  skillMutationConflict(message: string): Error;
}

export interface SkillProjectMutationPorts extends SkillMutationWorkflowPorts {
  readSkillMarkdown(id: string): Promise<string | undefined>;
  saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<StoredSkill>;
}

export interface SkillSupportFileMutationPorts extends SkillMutationWorkflowPorts {
  getSkillForMutation(id: string): Promise<StoredSkill | undefined>;
  listSkillSupportFiles(id: string): Promise<Array<{ path: string; file_path: string; content: string }>>;
  writeSkillSupportFile(input: { skillId: string; path: string; content: string }): Promise<{ path: string; file_path: string; content: string }>;
}

export interface SkillCandidateMutationPorts extends SkillMutationWorkflowPorts {
  saveSkillMarkdown(input: { state: "candidate" | "project"; skillId: string; markdown: string }): Promise<StoredSkill>;
}

export interface SkillPatchMutationPorts extends SkillMutationWorkflowPorts {
  getSkillForMutation(id: string): Promise<StoredSkill | undefined>;
  readSkillMarkdown(id: string): Promise<string | undefined>;
  patchSkillRecord(input: { id: string; title?: string; description?: string; tags?: string[]; content?: string; pinned?: boolean; expected_resource_version?: number }): Promise<StoredSkill | undefined>;
  mapSkillWriteError(error: unknown): Error;
}
