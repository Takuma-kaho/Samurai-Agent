import {
  PublicAgentDmRecordSchema,
  PublicRoomWorkAssigneeSchema,
  PublicRoomWorkCommentSchema,
  PublicRoomWorkControlSchema,
  PublicRoomWorkInstructionSchema,
  PublicRoomWorkReactionSchema,
  PublicRoomWorkRecordSchema,
  PublicRoomWorkViewSchema,
  WorkspaceFileResourceRefSchema,
  RoomWorkAssignmentStatusSchema,
  RoomWorkInstructionStateSchema,
  RoomWorkStatusSchema
} from "@samurai-agent/core-schemas";
import { z } from "zod";

/** Identifiers crossing the Room work boundary are server-owned strings. */
export const roomWorkIdSchema = z.string().trim().min(1).max(512);
export const roomWorkVersionSchema = z.number().int().positive();
export const roomWorkGenerationSchema = z.number().int().nonnegative();

/**
 * Attachments are references issued by the Server.  The operation contract
 * never accepts a local filesystem path or inline file contents.
 */
export const roomWorkAttachmentSchema = WorkspaceFileResourceRefSchema;
export const roomWorkAttachmentsSchema = z.array(roomWorkAttachmentSchema).max(100).default([]);

export const roomWorkStatusSchema = RoomWorkStatusSchema;
export const roomWorkAssigneeStatusSchema = RoomWorkAssignmentStatusSchema;
export const roomWorkInstructionKindSchema = z.enum(["initial", "reply", "comment_apply", "delegated"]);
export const roomWorkInstructionStatusSchema = RoomWorkInstructionStateSchema;
export const roomWorkControlActionSchema = z.enum(["stop", "assignee.stop", "assignee.reassign"]);
export const roomWorkControlStatusSchema = z.enum(["requested", "accepted", "running", "completed", "failed", "unconfirmed", "rejected"]);

/** Minimal public projection of one assigned Agent's work. */
export const roomWorkAssigneeValueSchema = PublicRoomWorkAssigneeSchema;

/** Publicly visible instruction receipt; the Backend Session is intentionally absent. */
export const roomWorkInstructionValueSchema = PublicRoomWorkInstructionSchema;

/** Human discussion is a separate record from an Agent instruction. */
export const roomWorkCommentValueSchema = PublicRoomWorkCommentSchema;

/** Reactions are explicit human state and never imply approval or execution. */
export const roomWorkReactionValueSchema = PublicRoomWorkReactionSchema;

/**
 * A control result distinguishes receipt of a stop/reassign request from its
 * terminal state.  It deliberately exposes no Backend diagnostics.
 */
export const roomWorkControlValueSchema = PublicRoomWorkControlSchema;

/** Work is the Room-facing aggregate; its Objective/Session internals stay private. */
export const roomWorkValueSchema = PublicRoomWorkRecordSchema;

export const roomWorkViewValueSchema = PublicRoomWorkViewSchema;

/** Room-scoped default Agent setting. */
export const roomDefaultAgentValueSchema = z.object({
  room_id: roomWorkIdSchema,
  agent_id: roomWorkIdSchema,
  agent_version: roomWorkVersionSchema,
  enabled: z.boolean(),
  can_execute: z.boolean(),
  version: roomWorkVersionSchema,
  updated_at: z.string().datetime()
}).strict();

/** A DM is a private Room projection, not a separate conversation store. */
export const agentDmValueSchema = PublicAgentDmRecordSchema;

export type RoomWorkAttachment = z.infer<typeof roomWorkAttachmentSchema>;
export type RoomWorkAssignee = z.infer<typeof roomWorkAssigneeValueSchema>;
export type RoomWorkInstruction = z.infer<typeof roomWorkInstructionValueSchema>;
export type RoomWorkComment = z.infer<typeof roomWorkCommentValueSchema>;
export type RoomWorkReaction = z.infer<typeof roomWorkReactionValueSchema>;
export type RoomWorkControl = z.infer<typeof roomWorkControlValueSchema>;
export type RoomWork = z.infer<typeof roomWorkValueSchema>;
export type RoomWorkView = z.infer<typeof roomWorkViewValueSchema>;
export type RoomDefaultAgent = z.infer<typeof roomDefaultAgentValueSchema>;
export type AgentDm = z.infer<typeof agentDmValueSchema>;
