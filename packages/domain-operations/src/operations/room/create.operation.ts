import { z } from "zod";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { roomValueSchema } from "../../value-objects/room-agent.js";

const AgentPermissionInput = z.object({
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_execute: z.boolean()
}).strict().refine((value) => (!value.can_edit && !value.can_execute) || value.can_view, "room_agent_view_required");

const NewAgentInput = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
  backend_id: z.string().trim().min(1).max(512),
  enabled: z.boolean().default(true),
  /** Optional when the new Agent is not the Room default. */
  permission: AgentPermissionInput.optional()
}).strict();

/**
 * Room creation can configure an existing Agent or create a new Agent and
 * grant its Room permission in the same persistence transaction. Omitting
 * both keeps the migration state in which a Room has no default Agent; it is
 * not an implicit Agent selection.
 */
const Input = z.object({
  name: z.string().trim().min(1).max(200),
  parent_room_id: z.string().trim().min(1).max(512).optional(),
  default_agent_id: z.string().trim().min(1).max(512).optional(),
  default_agent_version: z.number().int().positive().optional(),
  new_agent: NewAgentInput.optional(),
  agent_permission: AgentPermissionInput.optional()
}).strict().superRefine((value, issue) => {
  if (value.default_agent_id !== undefined && value.new_agent !== undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["default_agent_id"], message: "room_default_agent_selection_conflict" });
  }
  if (value.agent_permission !== undefined && value.default_agent_id === undefined && value.new_agent === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_agent_permission_target_required" });
  }
  if (value.default_agent_version !== undefined && value.default_agent_id === undefined) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["default_agent_version"], message: "room_default_agent_required" });
  }
  const defaultPermission = value.agent_permission ?? value.new_agent?.permission;
  if ((value.default_agent_id !== undefined || value.new_agent !== undefined)
    && defaultPermission !== undefined
    && (!defaultPermission.can_view || !defaultPermission.can_execute)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_default_agent_permission_required" });
  }
  if (value.agent_permission !== undefined && value.new_agent?.permission !== undefined
    && (value.agent_permission.can_view !== value.new_agent.permission.can_view
      || value.agent_permission.can_edit !== value.new_agent.permission.can_edit
      || value.agent_permission.can_execute !== value.new_agent.permission.can_execute)) {
    issue.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_permission"], message: "room_agent_permission_conflict" });
  }
});
const Output = roomValueSchema;
export type RoomCreateInput = z.input<typeof Input>;
export type RoomAgentPermissionInput = z.infer<typeof AgentPermissionInput>;
export type RoomCreateNewAgentInput = z.input<typeof NewAgentInput>;
export interface RoomAgentPermission {
  canView: boolean;
  canEdit: boolean;
  canExecute: boolean;
}
export interface RoomCreatePorts {
  createRoom(context: TrustedDomainContext, input: {
    name: string;
    parentRoomId?: string;
    defaultAgentId?: string;
    defaultAgentVersion?: number;
    newAgent?: {
      name: string;
      role: string;
      instructions: string;
      backendId: string;
      enabled?: boolean;
      permission?: RoomAgentPermission;
    };
    agentPermission?: RoomAgentPermission;
  }): Promise<z.infer<typeof Output>>;
}

const roomCreate = defineCommand<RoomCreatePorts>()({
  id: "room.create", version: "1.1", availability: "active", title: "Create Room", description: "Create a persistent Room in the current Workspace.",
  sources: ["runtime_api", "surface_operation", "provider_tool_call"], effect: "workspace_mutation", idempotency: "required", concurrency: "append_or_unique",
  render: ["status_timeline"], resourceKinds: ["room"], proposedEffects: ["Create a Room."], outputResourceKind: "room", uiDisplayCategory: "workspace", providerToolNames: ["samurai.room.create"],
  provenance: [{ source: "samurai", commit_sha: "workspace-design-v1", reference_file: "ARCHITECTURE.md", decision: "adapted", reason: "Keep Room identity in Workspace PostgreSQL, separate from Backend execution." }],
  input: Input, output: Output,
  createHandler(ports) {
    return {
      execute: async function handleRoomCreate(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const value = await ports.createRoom(context, {
          name: input.name,
          ...(input.parent_room_id === undefined ? {} : { parentRoomId: input.parent_room_id }),
          ...(input.default_agent_id === undefined ? {} : { defaultAgentId: input.default_agent_id }),
          ...(input.default_agent_version === undefined ? {} : { defaultAgentVersion: input.default_agent_version }),
          ...(input.new_agent === undefined ? {} : {
            newAgent: {
              name: input.new_agent.name,
              role: input.new_agent.role,
              instructions: input.new_agent.instructions,
              backendId: input.new_agent.backend_id,
              enabled: input.new_agent.enabled,
              ...(input.new_agent.permission === undefined ? {} : {
                permission: {
                  canView: input.new_agent.permission.can_view,
                  canEdit: input.new_agent.permission.can_edit,
                  canExecute: input.new_agent.permission.can_execute
                }
              })
            }
          }),
          ...(input.agent_permission === undefined ? {} : {
            agentPermission: {
              canView: input.agent_permission.can_view,
              canEdit: input.agent_permission.can_edit,
              canExecute: input.agent_permission.can_execute
            }
          })
        });
        return { ok: true, value: Output.parse(value) };
      }
    };
  }
});
export default roomCreate;
