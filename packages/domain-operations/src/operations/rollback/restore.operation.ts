// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { ActivityInboxItem, JsonValue, MessageEnvelope, OperationRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { rollbackRestoreValueSchema } from "../../value-objects/rollback.js";

const Input = z.object({
  "rollback_point_id": z.string().trim().min(1)
}).strict();
const Output = rollbackRestoreValueSchema;

export interface RollbackRestorePorts {
  getRollbackPoint(id: string): Promise<{ id: string; reversible: boolean; expires_at: string; before_snapshot: Record<string, JsonValue> } | undefined>;
  rollbackRestoreError(code: "not_found" | "conflict" | "forbidden", message: string): Error;
  resolveRollbackPath(path: string): { absolutePath: string; relativePath: string };
  ensureRollbackSession(): Promise<SessionRecord>;
  createRollbackEnvelope(content: string): MessageEnvelope;
  rollbackFileRef(path: string): ResourceRef;
  readRollbackFile(path: string): Promise<string | undefined>;
  removeRollbackFile(path: string): Promise<void>;
  ensureRollbackParent(path: string): Promise<void>;
  writeRollbackFile(path: string, content: string): Promise<void>;
  createRestoreRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  runRollbackMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: { rollback_point_id: string; path: string; action: "written" | "deleted" }; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<{ resource: { rollback_point_id: string; path: string; action: "written" | "deleted" }; operation: OperationRecord; rollbackPoint?: RollbackPoint; activity: ActivityInboxItem[] }>;
  currentTimeMillis(): number;
}

const rollbackRestore = defineCommand<RollbackRestorePorts>()({
  ...{
  "kind": "command",
  "id": "rollback.restore",
  "version": "3.0",
  "availability": "active",
  "title": "Restore rollback point",
  "description": "Restore a reversible local workspace snapshot.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "optimistic_version",
  "render": [
    "status_timeline"
  ],
  "resourceKinds": [
    "rollback_point",
    "file"
  ],
  "proposedEffects": [
    "Restore a reversible local workspace snapshot from a rollback point."
  ],
  "outputResourceKind": "rollback_point",
  "uiDisplayCategory": "run_history",
  "provenance": [
    {
      "source": "samurai",
      "commit_sha": "workspace-design-v1",
      "reference_file": "ARCHITECTURE.md",
      "decision": "adapted",
      "reason": "Use a server-owned contract and a shared Runtime boundary for Workspace state."
    }
  ]
},
  input: Input,
  output: Output,
  createHandler(ports) {
    return {
      execute: async function handleRollbackRestore(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const point = await ports.getRollbackPoint(input.rollback_point_id);
        if (!point) throw ports.rollbackRestoreError("not_found", `Rollback point not found: ${input.rollback_point_id}`);
        if (!point.reversible) throw ports.rollbackRestoreError("conflict", "rollback_not_reversible");
        if (Date.parse(point.expires_at) < ports.currentTimeMillis()) throw ports.rollbackRestoreError("conflict", "rollback_expired");
        const path = typeof point.before_snapshot.path === "string" ? point.before_snapshot.path : undefined;
        const content = point.before_snapshot.content;
        if (!path || (typeof content !== "string" && content !== null)) throw ports.rollbackRestoreError("conflict", "rollback_restore_unsupported_snapshot");
        const workspacePath = ports.resolveRollbackPath(path);
        if (workspacePath.relativePath === ".") throw ports.rollbackRestoreError("forbidden", "rollback_restore_requires_file_path");
        const session = await ports.ensureRollbackSession();
        const envelope = ports.createRollbackEnvelope(`rollback.restore: ${point.id}`);
        const ref = ports.rollbackFileRef(workspacePath.relativePath);
        const value = await ports.runRollbackMutation({ session, envelope, operationName: "rollback.restore", proposedEffects: [`Restore rollback point ${point.id} for ${workspacePath.relativePath}.`], targetResourceRefs: [ref], execute: async (operation) => {
          const current = await ports.readRollbackFile(workspacePath.absolutePath);
          if (content === null) await ports.removeRollbackFile(workspacePath.absolutePath);
          else { await ports.ensureRollbackParent(workspacePath.absolutePath); await ports.writeRollbackFile(workspacePath.absolutePath, content); }
          const rollbackPoint = await ports.createRestoreRollback(operation, [ref], { path: workspacePath.relativePath, content: current ?? null }, { path: workspacePath.relativePath, content });
          return { resource: { rollback_point_id: point.id, path: workspacePath.relativePath, action: content === null ? "deleted" : "written" }, ref, rollbackPoint, summary: `Restored rollback point ${point.id} for ${workspacePath.relativePath}.` };
        }});
        return { ok: true, value };
      }
    };
  }
});

export default rollbackRestore;
