import { type ToolRunRecord } from "@samurai-agent/core-schemas";
import type { ToolRunsTable } from "../kernel/workspace-db-schema";
import { parse, stringify } from "./serialization";

export function toolRunToRow(run: ToolRunRecord): ToolRunsTable {
return {
  id: run.id,
  run_id: run.run_id,
  session_id: run.session_id ?? null,
  tool_call_id: run.tool_call_id ?? null,
  provider_tool_name: run.provider_tool_name,
  action_id: run.action_id ?? null,
  status: run.status,
  input_summary: run.input_summary,
  output_summary: run.output_summary,
  error_code: run.error_code ?? null,
  resource_refs_json: stringify(run.resource_refs),
  created_at: run.created_at
};
}
export function toolRunFromRow(row: ToolRunsTable): ToolRunRecord {
return {
  id: row.id,
  run_id: row.run_id,
  ...(row.session_id ? { session_id: row.session_id } : {}),
  tool_call_id: row.tool_call_id ?? undefined,
  provider_tool_name: row.provider_tool_name,
  action_id: row.action_id ?? undefined,
  status: row.status as ToolRunRecord["status"],
  input_summary: row.input_summary,
  output_summary: row.output_summary,
  error_code: row.error_code ?? undefined,
  resource_refs: parse(row.resource_refs_json),
  created_at: row.created_at
};
}
