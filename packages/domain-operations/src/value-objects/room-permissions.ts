import { z } from "zod";

export const humanParticipantIdSchema = z.string().trim().regex(/^human:[^\s:][^\s]*$/, "human_participant_id_required");
export const roomHumanRoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export const workspaceRoleSchema = roomHumanRoleSchema;

export const workspaceMemberValueSchema = z.object({
  id: z.string(),
  participant_id: humanParticipantIdSchema,
  role: workspaceRoleSchema,
  joined_at: z.string(),
  removed_at: z.string().optional(),
  created_by_participant_id: humanParticipantIdSchema,
  removed_by_participant_id: humanParticipantIdSchema.optional(),
  updated_at: z.string()
}).strict();

export const roomMemberValueSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  participant_id: humanParticipantIdSchema,
  role: roomHumanRoleSchema,
  joined_at: z.string(),
  removed_at: z.string().optional(),
  created_by_participant_id: humanParticipantIdSchema,
  removed_by_participant_id: humanParticipantIdSchema.optional(),
  updated_at: z.string()
}).strict();

export const roomAgentPermissionValueSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  agent_id: z.string(),
  can_view: z.boolean(),
  can_edit: z.boolean(),
  can_execute: z.boolean(),
  joined_at: z.string(),
  removed_at: z.string().optional(),
  created_by_participant_id: humanParticipantIdSchema,
  removed_by_participant_id: humanParticipantIdSchema.optional(),
  updated_at: z.string()
}).strict();

export const agentWorkspacePermissionValueSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  permission: z.literal("room.create"),
  granted_at: z.string(),
  revoked_at: z.string().optional(),
  granted_by_participant_id: humanParticipantIdSchema,
  revoked_by_participant_id: humanParticipantIdSchema.optional(),
  updated_at: z.string()
}).strict();

/** A share target is typed before it reaches any Room authorization code. */
export const roomShareableResourceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("artifact"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("memory"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("wiki"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("skill"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("collection_schema"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("collection_record"), collection_id: z.string().trim().min(1), record_id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("generated_surface"), id: z.string().trim().min(1) }).strict()
]);
export type RoomShareableResourceReferenceValue = z.infer<typeof roomShareableResourceReferenceSchema>;

/** New shares intentionally exclude app-owned Session records. */
export const newRoomShareableResourceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("artifact"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("memory"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("wiki"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("skill"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("collection_schema"), id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("collection_record"), collection_id: z.string().trim().min(1), record_id: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("generated_surface"), id: z.string().trim().min(1) }).strict()
]);
export type NewRoomShareableResourceReferenceValue = z.infer<typeof newRoomShareableResourceReferenceSchema>;

export const roomResourceShareValueSchema = z.object({
  id: z.string(),
  resource_access_boundary_id: z.string(),
  source_room_id: z.string(),
  target_room_id: z.string(),
  shared_by_participant_id: humanParticipantIdSchema,
  created_at: z.string(),
  revoked_at: z.string().optional(),
  revoked_by_participant_id: humanParticipantIdSchema.optional(),
  updated_at: z.string()
}).strict();
