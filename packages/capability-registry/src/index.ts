import type { CapabilityManifest } from "@samurai-agent/core-schemas";

export const proposalCapabilityManifest: CapabilityManifest = {
  id: "proposal_workspace",
  version: "1.0.0",
  title: "Workspace proposal capability",
  description: "Creates local drafts, provisional memory, and approval-gated outbound actions.",
  operations: [
    {
      operation: "artifact.create",
      description: "Create a local markdown artifact draft.",
      input_schema_ref: "artifact.create.input",
      output_schema_ref: "artifact.create.output",
      risk: "low",
      scope: "artifact",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "owner_approved_policy", "agent_reasoning", "scheduled_context"],
      default_decision: "allow_auto"
    },
    {
      operation: "memory.session.create",
      description: "Keep a session-scoped memory note.",
      input_schema_ref: "memory.session.create.input",
      output_schema_ref: "memory.session.create.output",
      risk: "low",
      scope: "memory",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "agent_reasoning", "scheduled_context"],
      default_decision: "allow_auto"
    },
    {
      operation: "memory.topic.create",
      description: "Create a non-sensitive topic memory candidate.",
      input_schema_ref: "memory.topic.create.input",
      output_schema_ref: "memory.topic.create.output",
      risk: "medium",
      scope: "memory",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "owner_approved_policy", "agent_reasoning"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "memory.archive",
      description: "Archive a memory item so it leaves normal memory views without deleting the record.",
      input_schema_ref: "memory.archive.input",
      output_schema_ref: "memory.archive.output",
      risk: "medium",
      scope: "memory",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "owner_approved_policy"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "skill.candidate.create",
      description: "Create a local skill candidate markdown file.",
      input_schema_ref: "skill.candidate.create.input",
      output_schema_ref: "skill.candidate.create.output",
      risk: "low",
      scope: "skill",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "agent_reasoning"],
      default_decision: "allow_auto"
    },
    {
      operation: "skill.project.save",
      description: "Save a promoted project skill markdown file.",
      input_schema_ref: "skill.project.save.input",
      output_schema_ref: "skill.project.save.output",
      risk: "medium",
      scope: "skill",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "collection.schema.save",
      description: "Save a collection schema to the local workspace.",
      input_schema_ref: "collection.schema.save.input",
      output_schema_ref: "collection.schema.save.output",
      risk: "medium",
      scope: "collection",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "collection.record.create",
      description: "Create a local collection record.",
      input_schema_ref: "collection.record.create.input",
      output_schema_ref: "collection.record.create.output",
      risk: "medium",
      scope: "collection",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "collection.patch.apply",
      description: "Apply a local collection record patch.",
      input_schema_ref: "collection.patch.apply.input",
      output_schema_ref: "collection.patch.apply.output",
      risk: "medium",
      scope: "collection",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "allow_with_audit"
    },
    {
      operation: "automation.memory_review.run",
      description: "Run the minimal scheduled memory review automation.",
      input_schema_ref: "automation.memory_review.run.input",
      output_schema_ref: "automation.memory_review.run.output",
      risk: "low",
      scope: "memory",
      reversibility: true,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["scheduled_context"],
      default_decision: "allow_auto"
    },
    {
      operation: "external.send",
      description: "Prepare an outbound send operation.",
      input_schema_ref: "external.send.input",
      output_schema_ref: "external.send.output",
      risk: "high",
      scope: "external_channel",
      reversibility: false,
      external_impact: true,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction", "owner_approved_policy"],
      default_decision: "requires_approval"
    },
    {
      operation: "workspace.delete",
      description: "Delete a workspace resource.",
      input_schema_ref: "workspace.delete.input",
      output_schema_ref: "workspace.delete.output",
      risk: "irreversible",
      scope: "workspace",
      reversibility: false,
      external_impact: false,
      secret_requirement: "none",
      allowed_instruction_sources: ["owner_instruction"],
      default_decision: "requires_strong_approval"
    }
  ],
  input_schema: {},
  output_schema: {},
  ui_surfaces: ["chat", "artifact", "context_drawer", "audit"],
  agent_tools: [
    "artifact.create",
    "memory.session.create",
    "memory.topic.create",
    "memory.archive",
    "skill.candidate.create",
    "skill.project.save",
    "collection.schema.save",
    "collection.record.create",
    "collection.patch.apply",
    "automation.memory_review.run",
    "external.send"
  ],
  permission_policy: {
    grant_key: "capability_id+operation+actor_identity+channel+resource_scope"
  },
  secret_policy: {
    direct_secret_values: false
  },
  audit_policy: {
    state_changes: "always"
  },
  rollback_policy: {
    workspace_changes: "snapshot"
  }
};

export const capabilityManifests = [proposalCapabilityManifest] as const;

export function getCapabilityManifest(capabilityId: string): CapabilityManifest | undefined {
  return capabilityManifests.find((manifest) => manifest.id === capabilityId);
}
