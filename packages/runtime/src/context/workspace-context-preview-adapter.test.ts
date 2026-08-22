import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { nowIso } from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { RoomAuthorizationService } from "../commands/services/room-authorization-service.js";
import { buildContextPreview } from "./context-preview.js";
import { WorkspaceContextPreviewAdapter } from "./workspace-context-preview-adapter.js";

describe("workspace context preview adapter", () => {
  it("connects a temporary Workspace Store to the context ports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-context-preview-"));
      const store = await WorkspaceStore.create({ rootDir: root });
    try {
      const settings = await store.getSettings();
      const timestamp = nowIso();
      await store.createSession({ id: "session-adapter", session_key: "test:adapter", title: "Adapter", room_id: settings.default_room_id, ui_locale: settings.ui_locale, output_locale: settings.output_locale, created_at: timestamp, updated_at: timestamp });
      const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) }, new RoomAuthorizationService(store));
      const preview = await buildContextPreview({ sessionId: "session-adapter", query: "こんにちは", ports: adapter.portsForAccess({ roomId: settings.default_room_id!, principal: { kind: "human", participantId: localOwnerParticipantId } }) });
      expect(preview.session_id).toBe("session-adapter");
      expect(preview.context_assembly.sources.find((source) => source.kind === "available_tools")?.included_count).toBeGreaterThan(0);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes only support-file paths before an explicit Skill view", async () => {
    let bodyReads = 0;
    const store = {
      readSkillMarkdown: async () => { bodyReads += 1; return "ignored"; },
      listSkillSupportFileRefs: async () => [{ skill_id: "skill-1", path: "references/a.md", file_path: "skills/support/skill-1/references/a.md" }]
    } as unknown as WorkspaceStore;
    const authorization = { assertResource: async () => undefined } as unknown as RoomAuthorizationService;
    const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) }, authorization);

    await expect(adapter.portsForAccess({ roomId: "room-1", principal: { kind: "human", participantId: localOwnerParticipantId } }).skills.listSupportFileRefs("skill-1")).resolves.toEqual([
      { skill_id: "skill-1", path: "references/a.md", file_path: "skills/support/skill-1/references/a.md" }
    ]);
    expect(bodyReads).toBe(0);
  });

  it("trims collection note content before selection", async () => {
    const store = {
      listCollectionNotes: async () => [{ collection_id: "collection-1", file_path: "notes/a.md", content: "  deploy note  ", role: "context_only" as const }]
    } as unknown as WorkspaceStore;
    const authorization = { assertResource: async () => undefined } as unknown as RoomAuthorizationService;
    const adapter = new WorkspaceContextPreviewAdapter(store, { sessionNotFound: (id) => new Error(`missing:${id}`) }, authorization);
    await expect(adapter.portsForAccess({ roomId: "room-1", principal: { kind: "human", participantId: localOwnerParticipantId } }).collections.listNotes("collection-1")).resolves.toEqual([{ collection_id: "collection-1", file_path: "notes/a.md", content: "deploy note", role: "context_only" }]);
  });
});
