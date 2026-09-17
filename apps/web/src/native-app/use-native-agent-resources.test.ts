import { describe, expect, it } from "vitest";
import { nativeAgentResourceDetailFromUnknown, nativeAgentResourcesFromUnknown } from "./use-native-agent-resources";
const target = { workspaceId: "workspace_a", agentId: "agent_a" };

describe("native Agent resource projection", () => {
  it("keeps only confirmed manual Agent-scoped Knowledge and Skill", () => {
    const resources = nativeAgentResourcesFromUnknown({
      resources: [
        {
          workspaceId: "workspace_a",
          id: "knowledge_ok",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "knowledge",
          knowledgeKind: "fact",
          title: "確認済み",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 2
        },
        {
          workspaceId: "workspace_a",
          id: "skill_archived",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "skill",
          title: "保管済みSkill",
          evidenceState: "confirmed",
          lifecycleState: "archived",
          aiManaged: false,
          version: 4
        },
        {
          workspaceId: "workspace_a",
          id: "workspace_knowledge",
          scope: { kind: "workspace" },
          kind: "knowledge",
          title: "Workspace Knowledge",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        },
        {
          workspaceId: "workspace_a",
          id: "room_knowledge",
          scope: { kind: "room", roomId: "room_a" },
          kind: "knowledge",
          title: "Room Knowledge",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        },
        {
          workspaceId: "workspace_a",
          id: "ai_managed",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "skill",
          title: "AI managed",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: true,
          version: 1
        },
        {
          workspaceId: "workspace_a",
          id: "pending",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "knowledge",
          title: "確認待ち",
          evidenceState: "provisional",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        },
        {
          workspaceId: "workspace_other",
          id: "other_workspace",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "knowledge",
          title: "別Workspace",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        },
        {
          workspaceId: "workspace_a",
          id: "policy",
          scope: { kind: "agent", agentId: "agent_a" },
          kind: "policy",
          title: "Policy",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        },
        {
          workspaceId: "workspace_a",
          id: "other_agent",
          scope: { kind: "agent", agentId: "agent_other" },
          kind: "knowledge",
          title: "別Agent",
          evidenceState: "confirmed",
          lifecycleState: "active",
          aiManaged: false,
          version: 1
        }
      ]
    }, target.agentId, target.workspaceId);

    expect(resources.map((resource) => resource.id)).toEqual(["knowledge_ok", "skill_archived"]);
  });

  it("rejects detail responses that change the fixed Agent or version", () => {
    expect(() => nativeAgentResourceDetailFromUnknown({
      resource: {
        workspaceId: "workspace_a",
        id: "knowledge_ok",
        scope: { kind: "agent", agentId: "agent_other" },
        kind: "knowledge",
        title: "別Agent",
        evidenceState: "confirmed",
        lifecycleState: "active",
        aiManaged: false,
        version: 2
      },
      current_version: { version: 2, metadata: {}, contentHash: "hash", reason: "test", createdAt: "now" }
    }, target.agentId, target.workspaceId)).toThrow("agent_resource_response_scope_invalid");

    expect(() => nativeAgentResourceDetailFromUnknown({
      resource: {
        workspaceId: "workspace_a",
        id: "knowledge_ok",
        scope: { kind: "agent", agentId: "agent_a" },
        kind: "knowledge",
        title: "確認済み",
        evidenceState: "confirmed",
        lifecycleState: "active",
        aiManaged: false,
        version: 2
      },
      current_version: { version: 3, metadata: {}, contentHash: "hash", reason: "test", createdAt: "now" }
    }, target.agentId, target.workspaceId)).toThrow("agent_resource_version_invalid");
  });
});
