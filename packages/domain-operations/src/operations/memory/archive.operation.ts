// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import { createId, nowIso, stableHash, type ActivityInboxItem, type JsonValue, type MemoryFrontmatter, type OperationRecord, type ResourceRef, type RollbackPoint, type SessionRecord } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema, defineCommand, type DomainResult, type TrustedDomainContext } from "../../definition/index.js";
import { memoryArchiveValueSchema } from "../../value-objects/memory.js";

const Input = z.object({
  "memory_id": z.string().trim().min(1)
}).strict();
const Output = memoryArchiveValueSchema;

export interface MemoryArchivePorts {
  getMemorySession(id: string): Promise<SessionRecord | undefined>;
  getMemoryForArchive(id: string): Promise<(MemoryFrontmatter & { file_path: string }) | undefined>;
  listMemoryForSession(sessionId: string): Promise<Array<MemoryFrontmatter & { file_path: string }>>;
  archiveMemoryRecord(id: string): Promise<{ before: { frontmatter: MemoryFrontmatter; file_path: string }; after: { frontmatter: MemoryFrontmatter; file_path: string }; content: string; changed: boolean; warning?: string } | undefined>;
  memoryArchiveError(code: "conflict" | "not_found", message: string): Error;
  memoryResourceRef(memory: MemoryFrontmatter): ResourceRef;
  memoryArchiveCapabilityId(): string;
  saveMemoryArchiveOperation(operation: OperationRecord): Promise<OperationRecord>;
  updateMemoryArchiveOperation(operation: OperationRecord): Promise<OperationRecord>;
  emitMemoryArchiveOperation(operation: OperationRecord): Promise<void>;
  createMemoryArchiveRollback(operation: OperationRecord, refs: ResourceRef[], before: Record<string, JsonValue>, after: Record<string, JsonValue>): Promise<RollbackPoint>;
  rebuildMemoryActivity(): Promise<ActivityInboxItem[]>;
}

const memoryArchive = defineCommand<MemoryArchivePorts>()({
  ...{
  "kind": "command",
  "id": "memory.archive",
  "version": "4.0",
  "availability": "active",
  "title": "Archive memory",
  "description": "Archive a memory item without physically deleting it.",
  "sources": [
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "state_transition",
  "render": [
    "memory"
  ],
  "resourceKinds": [
    "memory"
  ],
  "proposedEffects": [
    "Archive a memory item so it leaves normal memory views."
  ],
  "outputResourceKind": "memory",
  "uiDisplayCategory": "memory",
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
      execute: async function handleMemoryArchive(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        if (!context.sessionId) throw ports.memoryArchiveError("conflict", "trusted_context_session_required");
        const session = await ports.getMemorySession(context.sessionId);
        if (!session) throw ports.memoryArchiveError("not_found", `Session not found: ${context.sessionId}`);
        const memory = await ports.getMemoryForArchive(input.memory_id);
        if (!memory) throw ports.memoryArchiveError("not_found", `Memory not found: ${input.memory_id}`);
        const sessionMemory = await ports.listMemoryForSession(session.id);
        if (!sessionMemory.some((item) => item.id === input.memory_id)) throw ports.memoryArchiveError("conflict", "memory_not_in_session");
        const now = nowIso();
        const initialRef = ports.memoryResourceRef(memory);
        const operation: OperationRecord = {
          id: createId("operation"), session_id: session.id, capability_id: ports.memoryArchiveCapabilityId(), operation: "memory.archive",
          actor_identity: "owner", instruction_source: "owner_instruction", instruction_authority: "owner", channel: "web",
          input_hash: stableHash({ memory_id: memory.id, session_id: session.id, operationName: "memory.archive" }), input_ref: initialRef,
          target_resource_refs: [initialRef], proposed_effects: ["Archive a session-linked memory so it no longer appears in normal memory views."],
          status: "created", created_at: now, updated_at: now
        };
        await ports.saveMemoryArchiveOperation(operation);
        await ports.emitMemoryArchiveOperation(operation);
        const archive = await ports.archiveMemoryRecord(input.memory_id);
        if (!archive) throw ports.memoryArchiveError("not_found", `Memory not found: ${input.memory_id}`);
        const archivedMemory = { ...archive.after.frontmatter, file_path: archive.after.file_path };
        const ref = ports.memoryResourceRef(archivedMemory);
        const rollbackPoint = archive.changed
          ? await ports.createMemoryArchiveRollback(operation, [ref], { memory: domainJsonValueSchema.parse(archive.before) }, { memory: domainJsonValueSchema.parse(archive.after) })
          : undefined;
        operation.status = "completed"; operation.result_ref = ref; operation.updated_at = nowIso();
        await ports.updateMemoryArchiveOperation(operation);
        const value = Output.parse({ memory: archivedMemory, content: archive.content, operation, rollbackPoint, activity: await ports.rebuildMemoryActivity(), changed: archive.changed, warning: archive.warning });
        return { ok: true, value };
      }
    };
  }
});

export default memoryArchive;
