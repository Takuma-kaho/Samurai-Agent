// Domain operation module. Keep its contract and handler together.
import { z } from "zod";
import type { JsonValue, MessageEnvelope, OperationRecord, ReflectionSuggestionRecord, ResourceRef, RollbackPoint, SessionRecord } from "@samurai-agent/core-schemas";
import { defineCommand, type DomainResult, type TrustedDomainContext } from "../../../definition/index.js";
import { reflectionSuggestionApplyValueSchema } from "../../../value-objects/reflection.js";

const Input = z.object({
  "suggestion_id": z.string().trim().min(1)
}).strict();
const Output = reflectionSuggestionApplyValueSchema;
type ReflectionTarget = z.infer<typeof Output>["resource"];

export interface ReflectionSuggestionApplyPorts {
  listReflectionSuggestions(): Promise<ReflectionSuggestionRecord[]>;
  reflectionSuggestionError(code: "not_found" | "conflict", message: string): Error;
  ensureReflectionMutationSession(): Promise<SessionRecord>;
  createReflectionMutationEnvelope(content: string): MessageEnvelope;
  runReflectionSuggestionMutation(input: { session: SessionRecord; envelope: MessageEnvelope; operationName: string; proposedEffects: string[]; targetResourceRefs: ResourceRef[]; execute(operation: OperationRecord): Promise<{ resource: ReflectionTarget; ref: ResourceRef; rollbackPoint?: RollbackPoint; summary: string }> }): Promise<z.infer<typeof Output>>;
  createReflectionMemoryTarget(input: { title: string; content: string; envelope: MessageEnvelope }): Promise<{ resource: ReflectionTarget; ref: ResourceRef; rollbackPoint?: RollbackPoint }>;
  createReflectionWikiTarget(input: { title: string; content: string; sourceRefs: ResourceRef[] }): Promise<{ resource: ReflectionTarget; ref: ResourceRef; rollbackPoint?: RollbackPoint }>;
  createReflectionSkillTarget(input: { title: string; content: string; sourceRefs: ResourceRef[] }): Promise<{ resource: ReflectionTarget; ref: ResourceRef; rollbackPoint?: RollbackPoint }>;
  createReflectionTargetRollback(operation: OperationRecord, refs: ResourceRef[], after: Record<string, JsonValue>): Promise<RollbackPoint>;
  updateReflectionSuggestion(suggestion: ReflectionSuggestionRecord): Promise<ReflectionSuggestionRecord>;
  reflectionNow(): string;
}

const reflectionSuggestionApply = defineCommand<ReflectionSuggestionApplyPorts>()({
  ...{
  "kind": "command",
  "id": "reflection.suggestion.apply",
  "version": "3.0",
  "availability": "active",
  "title": "Apply reflection suggestion",
  "description": "Apply a visible reflection suggestion to Memory, Knowledge Wiki, or Skill.",
  "sources": [
    "provider_tool_call",
    "runtime_api"
  ],
  "effect": "workspace_mutation",
  "idempotency": "required",
  "concurrency": "none",
  "render": [
    "memory",
    "knowledge_wiki",
    "skill"
  ],
  "resourceKinds": [
    "reflection_suggestion",
    "memory",
    "wiki",
    "skill"
  ],
  "proposedEffects": [
    "Apply a visible reflection suggestion to a reusable workspace resource."
  ],
  "outputResourceKind": "reflection_suggestion",
  "uiDisplayCategory": "memory",
  "providerToolNames": [
    "reflection.suggestion.apply"
  ],
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
      execute: async function handleReflectionSuggestionApply(context: TrustedDomainContext, input: z.infer<typeof Input>): Promise<DomainResult<z.infer<typeof Output>>> {
        const suggestion = (await ports.listReflectionSuggestions()).find((item) => item.id === input.suggestion_id);
        if (!suggestion) throw ports.reflectionSuggestionError("not_found", `Reflection suggestion not found: ${input.suggestion_id}`);
        if (suggestion.status !== "proposed") throw ports.reflectionSuggestionError("conflict", "reflection_suggestion_already_settled");
        const session = await ports.ensureReflectionMutationSession();
        const envelope = ports.createReflectionMutationEnvelope(`Apply reflection suggestion: ${suggestion.title}`);
        const value = Output.parse(await ports.runReflectionSuggestionMutation({ session, envelope, operationName: "reflection.suggestion.apply",
          proposedEffects: [`Apply ${suggestion.suggestion_type} reflection suggestion.`], targetResourceRefs: suggestion.source_refs,
          execute: async (operation) => {
            const now = ports.reflectionNow();
            if (suggestion.suggestion_type === "memory") {
              const target = await ports.createReflectionMemoryTarget({ title: suggestion.title || "reflection", content: suggestion.content, envelope });
              const rollbackPoint = await ports.createReflectionTargetRollback(operation, [target.ref], { memory: target.resource as JsonValue });
              await ports.updateReflectionSuggestion({ ...suggestion, status: "applied", updated_at: now });
              return { ...target, rollbackPoint, summary: `Applied reflection suggestion as Memory ${suggestion.title}.` };
            }
            if (suggestion.suggestion_type === "knowledge_wiki" || suggestion.suggestion_type === "skill") {
              const target = suggestion.suggestion_type === "knowledge_wiki"
                ? await ports.createReflectionWikiTarget({ title: suggestion.title, content: suggestion.content, sourceRefs: suggestion.source_refs })
                : await ports.createReflectionSkillTarget({ title: suggestion.title, content: suggestion.content, sourceRefs: suggestion.source_refs });
              await ports.updateReflectionSuggestion({ ...suggestion, status: "applied", target_ref: target.ref, updated_at: now });
              return { ...target, summary: `Applied reflection suggestion as ${suggestion.suggestion_type === "skill" ? "Skill candidate" : "Knowledge Wiki proposal"} ${suggestion.title}.` };
            }
            throw ports.reflectionSuggestionError("conflict", "reflection_suggestion_type_not_applyable");
          }}));
        return { ok: true, value };
      }
    };
  }
});

export default reflectionSuggestionApply;
