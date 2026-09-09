import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { resolveRoomWorkResourceRefs, roomWorkInstructionForPublicInput } from "./domain-api-v1";

describe("Domain API v1 Room Work resource refs", () => {
  it("passes only the public selector to Completion and returns its canonical ref", async () => {
    const resolver = {
      getResourceRefForRoom: vi.fn(async () => ({
        kind: "knowledge" as const,
        id: "knowledge_1",
        uri: ".versions/knowledge_1/2.md",
        version: "2",
        label: "Server title"
      }))
    };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "knowledge", id: "knowledge_1", version: 2 }] }
    )).resolves.toEqual([{
      kind: "knowledge",
      id: "knowledge_1",
      uri: ".versions/knowledge_1/2.md",
      version: "2",
      label: "Server title"
    }]);

    expect(resolver.getResourceRefForRoom).toHaveBeenCalledWith(
      { workspaceId: "workspace_1", accountId: "account_1" },
      { targetRoomId: "room_1", resourceId: "knowledge_1", kind: "knowledge", version: 2 }
    );
    expect(JSON.stringify(resolver.getResourceRefForRoom.mock.calls[0])).not.toContain("uri");
  });

  it("rejects client-owned uri/label and unsupported resource kinds before lookup", async () => {
    const resolver = { getResourceRefForRoom: vi.fn() };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "knowledge", id: "knowledge_1", version: 2, uri: "client://wrong" }] }
    )).rejects.toMatchObject({ code: "domain_api_resource_refs_invalid", status: 400 });
    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "policy", id: "policy_1", version: 1 }] }
    )).rejects.toMatchObject({ code: "domain_api_resource_refs_invalid", status: 400 });
    expect(resolver.getResourceRefForRoom).not.toHaveBeenCalled();
  });

  it("propagates Completion authorization failures instead of falling back to the client ref", async () => {
    const resolver = {
      getResourceRefForRoom: vi.fn(async () => {
        throw new WorkspaceServerError("workspace_completion_resource_not_found", 404);
      })
    };

    await expect(resolveRoomWorkResourceRefs(
      resolver,
      { workspaceId: "workspace_1", accountId: "account_1" },
      "room_1",
      { resource_refs: [{ kind: "skill", id: "skill_1", version: "4" }] }
    )).rejects.toMatchObject({ code: "workspace_completion_resource_not_found", status: 404 });
  });

  it("gives a resource-only Work an explicit instruction body", () => {
    expect(roomWorkInstructionForPublicInput({}, [{
      kind: "knowledge",
      id: "knowledge_1",
      uri: ".versions/knowledge_1/2.md",
      version: "2"
    }])).toBe("Review the referenced resources.");
    expect(roomWorkInstructionForPublicInput({}, [])).toBeUndefined();
    expect(roomWorkInstructionForPublicInput({ instruction: "  Follow up.  " }, [])).toBe("Follow up.");
  });
});
