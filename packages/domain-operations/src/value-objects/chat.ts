import {
  ActivityInboxItemSchema,
  ApprovalRequestSchema,
  ArtifactRecordSchema,
  AuditRecordSchema,
  BackendEventRecordSchema,
  BackendRunRecordSchema,
  MemoryFrontmatterSchema,
  MessageEnvelopeSchema,
  OperationRecordSchema,
  PolicyDecisionRecordSchema,
  ReflectionRunRecordSchema,
  ReflectionSuggestionRecordSchema,
  RollbackPointSchema,
  ToolRunRecordSchema,
  WorkspaceChangeRecordSchema,
  supportedLocales
} from "@samurai-agent/core-schemas";
import { z } from "zod";
import { messagePresentationRecordSchema } from "./presentation.js";

const localeSchema = z.enum(supportedLocales);
export const sessionRecordSchema = z.object({
  id: z.string().min(1), session_key: z.string().min(1), room_id: z.string().min(1).optional(), title: z.string(),
  ui_locale: localeSchema, output_locale: localeSchema,
  created_at: z.string().datetime(), updated_at: z.string().datetime()
}).strict();
const messageRecordSchema = z.object({
  id: z.string().min(1), session_id: z.string().min(1), role: z.enum(["user", "agent", "system"]),
  content: z.string(), input_locale: localeSchema, output_locale: localeSchema,
  envelope: MessageEnvelopeSchema.optional(), created_at: z.string().datetime()
}).strict();

export const chatTurnValueSchema = z.object({
  session: sessionRecordSchema,
  messages: z.array(messageRecordSchema),
  messagePresentations: z.array(messagePresentationRecordSchema),
  backendRun: BackendRunRecordSchema,
  backendEvents: z.array(BackendEventRecordSchema),
  workspaceChanges: z.array(WorkspaceChangeRecordSchema),
  operations: z.array(OperationRecordSchema),
  policyDecisions: z.array(PolicyDecisionRecordSchema),
  artifacts: z.array(ArtifactRecordSchema),
  memories: z.array(MemoryFrontmatterSchema),
  approvalRequests: z.array(ApprovalRequestSchema),
  auditRecords: z.array(AuditRecordSchema),
  rollbackPoints: z.array(RollbackPointSchema),
  activity: z.array(ActivityInboxItemSchema),
  reflectionRuns: z.array(ReflectionRunRecordSchema),
  reflectionSuggestions: z.array(ReflectionSuggestionRecordSchema),
  toolRuns: z.array(ToolRunRecordSchema)
}).strict();
