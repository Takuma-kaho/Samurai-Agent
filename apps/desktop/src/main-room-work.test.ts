import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PublicRoomWorkAttachmentSchema } from "@samurai-agent/domain-api";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const preloadSource = readFileSync(new URL("./preload.cts", import.meta.url), "utf8");

describe("Desktop Room work and Agent bridge", () => {
  it("uses Room/Work IPC scope without exposing legacy Session references", () => {
    const start = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room-work:list"');
    const end = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:events:list"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const roomWorkSource = mainSource.slice(start, end);

    expect(roomWorkSource).toContain('context: { room_id: roomId }');
    expect(roomWorkSource).toContain("captureWorkspaceTargetSnapshot");
    expect(roomWorkSource).toContain("assertActiveWorkspaceSnapshot");
    expect(roomWorkSource).not.toMatch(/session(?:_id|Id)/i);
    expect(roomWorkSource).not.toMatch(/credential|password|privateKey/i);
  });

  it("connects the authorized agent.list query through a minimal allowlist", () => {
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:agents:list"');
    expect(mainSource).toContain('"agent.list"');
    expect(mainSource).toContain("workspaceAgentPublicPayloadKeys");
    expect(mainSource).toContain("sanitizeWorkspaceAgentListPayload");
    const start = mainSource.indexOf("function sanitizeWorkspaceAgentPayload");
    const end = mainSource.indexOf("function assertRoomWorkListResponseScope", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const sanitizerSource = mainSource.slice(start, end);
    expect(sanitizerSource).not.toMatch(/instructions|description|credential|password|session/i);
    expect(preloadSource).toContain('listWorkspaceAgents: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:agents:list-target", sanitizeWorkspaceAgentTargetInput(input))');
  });

  it("connects backend availability through the target-bound public query only", () => {
    expect(mainSource).toContain('ipcMain.handle("samurai:workspace-server:agent-backends:list-target"');
    expect(mainSource).toContain('workspaceAgentListRequest(input)');
    expect(mainSource).toContain('"agent.backend.list"');
    expect(mainSource).toContain("sanitizeWorkspaceAgentBackendListPayload");
    expect(mainSource).not.toContain('"/agent-backends"');
    expect(preloadSource).toContain('listWorkspaceAgentBackends: async (input: unknown) => sanitizeWorkspaceAgentBackendList(await ipcRenderer.invoke("samurai:workspace-server:agent-backends:list-target", sanitizeWorkspaceAgentTargetInput(input)))');
    const start = mainSource.indexOf("function sanitizeWorkspaceAgentBackendListPayload");
    const end = mainSource.indexOf("/** Explicit agent.view/editor projection", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const sanitizerSource = mainSource.slice(start, end);
    expect(sanitizerSource).not.toMatch(/metadata|capabilit|session|credential|diagnostic/i);
  });

  it("keeps Room kind and default Agent state in the public Room projection", () => {
    expect(mainSource).toContain("kind: room.kind ?? \"normal\"");
    expect(mainSource).toContain("defaultAgentId: room.default_agent_id");
    expect(mainSource).toContain("defaultAgentEnabled");
    expect(mainSource).toContain("defaultAgentCanExecute");
  });

  it("pins default-Agent and DM operations to the active target snapshot", () => {
    const defaultStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room:default-agent:set"');
    const dmStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:agent:dm:open"');
    const eventsStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:events:list"');
    expect(defaultStart).toBeGreaterThanOrEqual(0);
    expect(dmStart).toBeGreaterThan(defaultStart);
    expect(eventsStart).toBeGreaterThan(dmStart);
    const source = mainSource.slice(defaultStart, eventsStart);
    expect(source).toContain("workspaceRoomDefaultAgentRequest");
    expect(source).toContain("workspaceAgentDmRequest");
    expect(source).toContain("captureWorkspaceTargetSnapshot");
    expect(source).toContain("snapshotWorkspaceDomainApiClient");
    expect(source).toContain("assertAgentDmResponseScope");
    expect(mainSource).toContain('record.kind !== "agent_dm"');
    expect(mainSource).toContain("record.agent_id !== agentId");
  });

  it("pins explicit delegation to the active target and strips trusted runtime fields", () => {
    const delegateStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room-work:assignee:delegate"');
    const defaultStart = mainSource.indexOf('ipcMain.handle("samurai:workspace-server:room:default-agent:set"', delegateStart);
    expect(delegateStart).toBeGreaterThanOrEqual(0);
    expect(defaultStart).toBeGreaterThan(delegateStart);
    const source = mainSource.slice(delegateStart, defaultStart);
    expect(source).toContain("captureWorkspaceTargetSnapshot");
    expect(source).toContain("snapshotWorkspaceDomainApiClient");
    expect(source).toContain("assertActiveWorkspaceSnapshot");
    expect(source).toContain('context: { room_id: roomId }');
    expect(source).toContain('"room.work.assignee.delegate"');
    expect(source).toContain("assertRoomWorkDelegateResponseScope(response.result, workId, assigneeId, agentId)");
    expect(source).not.toMatch(/session(?:_id|Id)|credential|password|privateKey/i);
    expect(preloadSource).toContain('delegateWorkspaceRoomWorkAssignee: (input: unknown) => ipcRenderer.invoke("samurai:workspace-server:room-work:assignee:delegate", sanitizeWorkspaceRoomWorkDelegateInput(input))');
    expect(preloadSource).toContain("function sanitizeWorkspaceRoomWorkDelegateInput");
  });

  it("accepts an optional parent scope while retaining child, Work, and Agent checks", () => {
    const start = mainSource.indexOf("function assertRoomWorkDelegateResponseScope");
    const end = mainSource.indexOf("function assertRoomDefaultAgentResponseScope", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const source = mainSource.slice(start, end);

    expect(source).toContain("record.id === parentAssigneeId");
    expect(source).toContain("record.work_id !== workId");
    expect(source).toContain("record.agent_id !== agentId");
    expect(source).toContain("record.parent_assignee_id !== undefined");
    expect(source).toContain("record.parent_assignee_id !== null");
    expect(source).toContain("record.parent_assignee_id !== parentAssigneeId");
  });

  it("preserves Core-sized ResourceRef paths in the Desktop response sanitizer", () => {
    const start = mainSource.indexOf("function sanitizeRoomWorkResources");
    // Extract precisely this function. Adjacent Room Work helpers are allowed
    // to evolve independently and may contain TypeScript-only syntax.
    const end = mainSource.indexOf("\nfunction ", start + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const sanitizerSource = mainSource.slice(start, end);
    expect(sanitizerSource).toContain("uri.slice(0, 4_096)");
    expect(sanitizerSource).toContain("label.slice(0, 4_096)");
    expect(sanitizerSource).not.toContain("uri.slice(0, 2_000)");
    expect(sanitizerSource).not.toContain("label.slice(0, 2_000)");

    const runnableSource = sanitizerSource
      .replace("(value: unknown): unknown", "(value)")
      .replace("item as Record<string, unknown>", "item");
    const sanitize = new Function("PublicRoomWorkAttachmentSchema", `${runnableSource}; return sanitizeRoomWorkResources;`)(PublicRoomWorkAttachmentSchema) as (value: unknown) => unknown;
    const longUri = `notes/${"a".repeat(4_084)}.md`;
    const longLabel = "label-" + "b".repeat(4_090);
    const result = sanitize([{
      kind: "file",
      id: "a".repeat(64),
      uri: longUri,
      version: "1",
      label: longLabel
    }]) as Array<Record<string, unknown>>;
    expect(result).toEqual([{ kind: "file", id: "a".repeat(64), uri: longUri, version: "1", label: longLabel }]);
    expect(sanitize([{ kind: "file", id: "a".repeat(64), uri: 42 }])).toEqual([]);
    expect(sanitize([{ kind: "file", id: "a".repeat(64), uri: "../secret", version: "1" }])).toEqual([]);
    expect(sanitize([{ kind: "file", id: "not-a-sha", uri: "notes/brief.md", version: "1" }])).toEqual([]);
    expect(sanitize([{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "0" }])).toEqual([]);
    expect(sanitize([{ kind: "file", id: "a".repeat(64), uri: "notes/brief.md", version: "1", label: "" }])).toEqual([]);
    expect(sanitize([{ kind: "artifact", id: "artifact-1", uri: "runtime://artifact-1", version: "1" }])).toEqual([{
      kind: "artifact", id: "artifact-1", uri: "runtime://artifact-1", version: "1"
    }]);
  });
});
