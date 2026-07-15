import { OperationRecordSchema, ResourceRefSchema, ToolRunRecordSchema } from "@samurai-agent/core-schemas";
import { z } from "zod";
import { domainJsonValueSchema } from "../definition/index.js";

const base = {
  operation: OperationRecordSchema,
  toolRun: ToolRunRecordSchema,
  resourceRefs: z.array(ResourceRefSchema),
  artifacts: z.array(z.record(domainJsonValueSchema)).optional(),
  memories: z.array(z.record(domainJsonValueSchema)).optional(),
  collectionSchemas: z.array(z.record(domainJsonValueSchema)).optional(),
  workspaceChanges: z.array(z.record(domainJsonValueSchema)).optional(),
  events: z.array(z.record(domainJsonValueSchema)).optional()
};

export const mcpCallValueSchema = z.object({
  ...base,
  outputPayload: z.object({
    status: z.enum(["completed", "blocked", "failed"]), action_id: z.literal("mcp.call"),
    server_name: z.string().min(1), tool_name: z.string().min(1), reason: z.string().nullable(),
    error: z.string().nullable(), output: domainJsonValueSchema,
    secret_resolution: domainJsonValueSchema, sandbox: domainJsonValueSchema,
    gateway_boundary: z.record(domainJsonValueSchema)
  }).strict()
}).strict();

export const sandboxExecValueSchema = z.object({
  ...base,
  outputPayload: z.object({
    status: z.enum(["completed", "blocked", "failed", "timed_out"]), action_id: z.literal("sandbox.exec"),
    command: z.string().min(1), exit_code: z.number().int().nullable(), signal: z.string().nullable(),
    stdout: z.string(), stderr: z.string(), reason: z.string().nullable(), error: z.string().nullable(),
    secret_resolution: domainJsonValueSchema, sandbox: domainJsonValueSchema,
    sandbox_instance: z.object({ id: z.string(), instance_key: z.string(), scope: z.string(), backend: z.string(), status: z.string() }).strict().nullable(),
    gateway_boundary: z.record(domainJsonValueSchema)
  }).strict()
}).strict();
