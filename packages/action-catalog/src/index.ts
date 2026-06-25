import type { ActionCatalogEntry } from "@samurai-agent/core-schemas";

export const actionCatalogEntries: ActionCatalogEntry[] = [
  {
    id: "artifact.create",
    title: "Create artifact",
    description: "Create a local workspace artifact from backend output.",
    input_schema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        preview: { type: "string" }
      }
    },
    output_schema: { type: "object" },
    resource_kinds: ["artifact"],
    handler_id: "runtime.artifact.create"
  },
  {
    id: "memory.suggest",
    title: "Suggest memory",
    description: "Create a visible memory suggestion from backend output.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        content: { type: "string" }
      }
    },
    output_schema: { type: "object" },
    resource_kinds: ["memory"],
    handler_id: "runtime.memory.suggest"
  },
  {
    id: "skill.candidate.suggest",
    title: "Suggest skill candidate",
    description: "Create a reusable skill candidate from backend output.",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    resource_kinds: ["skill"],
    handler_id: "runtime.skill.candidate.suggest"
  },
  {
    id: "workspace.change.record",
    title: "Record workspace change",
    description: "Record a normalized workspace change.",
    input_schema: { type: "object" },
    output_schema: { type: "object" },
    resource_kinds: ["workspace_change"],
    handler_id: "runtime.workspace.change.record"
  }
];

export function getActionCatalogEntry(id: string): ActionCatalogEntry | undefined {
  return actionCatalogEntries.find((entry) => entry.id === id);
}
