import { describe, expect, it } from "vitest";
import {
  workspaceAgentBackendBindRequest,
  workspaceAgentCreateRequest,
  workspaceAgentDmRequest,
  workspaceAgentPatchRequest,
  workspaceAgentViewRequest,
  workspaceRoomAgentMemberListRequest,
  workspaceRoomAgentPermissionRequest,
  workspaceRoomAgentRemoveRequest,
  workspaceRoomMemberListRequest,
  workspaceRoomCreateRequest,
  workspaceRoomDefaultAgentRequest,
  workspaceRoomMemberRequest,
  workspaceRoomMoveRequest
} from "./workspace-room-requests";

describe("Desktop Room operation boundary", () => {
  it("keeps Agent operations on the public contract and target boundary", () => {
    expect(workspaceAgentCreateRequest({
      name: "Research Agent",
      role: "調査担当",
      instructions: "根拠を添えて調査する。",
      backendId: "samurai-native",
      enabled: true,
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      operationId: "agent_create_1",
      privateKey: "must-not-cross-the-boundary"
    })).toEqual({
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      operationId: "agent_create_1",
      body: { name: "Research Agent", role: "調査担当", instructions: "根拠を添えて調査する。", backend_id: "samurai-native", enabled: true }
    });
    expect(workspaceAgentViewRequest({ agentId: "agent_research", target: { connectionId: "server_a", workspaceId: "workspace_a" } })).toEqual({
      agentId: "agent_research",
      target: { connectionId: "server_a", workspaceId: "workspace_a" }
    });
    expect(workspaceAgentPatchRequest({ agentId: "agent_research", role: "編集後", expectedVersion: 3, operationId: "agent_patch_1" })).toEqual({
      operationId: "agent_patch_1",
      body: { id: "agent_research", role: "編集後", expected_version: 3 }
    });
    expect(workspaceAgentBackendBindRequest({ agentId: "agent_research", backendId: "samurai-native", operationId: "agent_bind_1" })).toEqual({
      operationId: "agent_bind_1",
      body: { id: "agent_research", backend_id: "samurai-native" }
    });
  });

  it("keeps Room Agent membership changes in typed public operations", () => {
    expect(workspaceRoomAgentMemberListRequest({ roomId: "room_a", target: { connectionId: "server_a", workspaceId: "workspace_a" } })).toEqual({
      roomId: "room_a",
      target: { connectionId: "server_a", workspaceId: "workspace_a" }
    });
    expect(workspaceRoomAgentPermissionRequest({ roomId: "room_a", agentId: "agent_research", canView: true, canEdit: true, canExecute: false, operationId: "permission_1" })).toEqual({
      roomId: "room_a",
      agentId: "agent_research",
      operationId: "permission_1",
      body: { agent_id: "agent_research", can_view: true, can_edit: true, can_execute: false }
    });
    expect(workspaceRoomAgentRemoveRequest({ roomId: "room_a", agentId: "agent_research", operationId: "remove_1" })).toEqual({
      roomId: "room_a",
      agentId: "agent_research",
      operationId: "remove_1",
      body: { agent_id: "agent_research" }
    });
    expect(() => workspaceRoomAgentPermissionRequest({ roomId: "room_a", agentId: "agent_research", canView: false, canEdit: true, canExecute: false, operationId: "permission_invalid" })).toThrow("room_agent_view_required");
  });

  it("binds default-Agent and DM mutations to the renderer target", () => {
    const target = { connectionId: "server_a", workspaceId: "workspace_a" };
    expect(workspaceRoomDefaultAgentRequest({
      roomId: "room_a",
      agentId: "agent_research",
      expectedVersion: 4,
      operationId: "default_agent_1",
      target,
      privateKey: "must-not-cross-the-boundary"
    })).toEqual({
      roomId: "room_a",
      agentId: "agent_research",
      operationId: "default_agent_1",
      target,
      body: { agent_id: "agent_research", expected_version: 4 }
    });
    expect(workspaceAgentDmRequest({
      agentId: "agent_research",
      operationId: "agent_dm_1",
      target,
      sessionId: "must-not-cross-the-boundary"
    })).toEqual({
      agentId: "agent_research",
      operationId: "agent_dm_1",
      target,
      body: { agent_id: "agent_research" }
    });
  });

  it("makes a fixed create request without accepting a renderer supplied key or URL", () => {
    expect(workspaceRoomCreateRequest({
      name: " Child Room ",
      parentRoomId: "room_parent",
      expectedWorkspaceVersion: 3,
      operationId: "room_create_1",
      privateKey: "renderer-must-not-control-this",
      serverUrl: "https://attacker.example"
    })).toEqual({
      operationId: "room_create_1",
      body: { name: "Child Room", parent_room_id: "room_parent", expected_workspace_version: 3 }
    });
  });

  it("keeps an existing default Agent, version, permission, operation, and workspace version", () => {
    expect(workspaceRoomCreateRequest({
      name: "既存AgentのRoom",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      defaultAgentId: "agent_research",
      defaultAgentVersion: 4,
      agentPermission: { can_view: true, can_edit: false, can_execute: true },
      expectedWorkspaceVersion: 9,
      operationId: "room_create_existing"
    })).toEqual({
      operationId: "room_create_existing",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      body: {
        name: "既存AgentのRoom",
        expected_workspace_version: 9,
        default_agent_id: "agent_research",
        default_agent_version: 4,
        agent_permission: { can_view: true, can_edit: false, can_execute: true }
      }
    });
  });

  it("keeps a new Agent profile and Room permission without accepting secrets", () => {
    expect(workspaceRoomCreateRequest({
      name: "新規AgentのRoom",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      expectedWorkspaceVersion: 2,
      operationId: "room_create_new",
      newAgent: {
        name: "Research Agent",
        role: "調査担当",
        instructions: "根拠を添えて調査する。",
        backend_id: "samurai-native",
        enabled: true
      },
      agentPermission: { can_view: true, can_edit: true, can_execute: true },
      apiKey: "must-not-cross-the-boundary",
      privateKey: "must-not-cross-the-boundary"
    })).toEqual({
      operationId: "room_create_new",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      body: {
        name: "新規AgentのRoom",
        expected_workspace_version: 2,
        new_agent: {
          name: "Research Agent",
          role: "調査担当",
          instructions: "根拠を添えて調査する。",
          backend_id: "samurai-native",
          enabled: true
        },
        agent_permission: { can_view: true, can_edit: true, can_execute: true }
      }
    });
  });

  it("rejects conflicting Agent selection and unsafe default permissions", () => {
    expect(() => workspaceRoomCreateRequest({
      name: "競合",
      defaultAgentId: "agent_a",
      newAgent: { name: "New", role: "role", instructions: "instructions", backend_id: "samurai-native" },
      expectedWorkspaceVersion: 1,
      operationId: "room_create_conflict"
    })).toThrow("room_default_agent_selection_conflict");
    expect(() => workspaceRoomCreateRequest({
      name: "実行不可",
      defaultAgentId: "agent_a",
      agentPermission: { can_view: true, can_edit: false, can_execute: false },
      expectedWorkspaceVersion: 1,
      operationId: "room_create_invalid_permission"
    })).toThrow("room_default_agent_permission_required");
    expect(() => workspaceRoomCreateRequest({
      name: "Backendなし",
      expectedWorkspaceVersion: 1,
      operationId: "room_create_backend_missing",
      newAgent: { name: "New", role: "role", instructions: "instructions", backend_id: "" }
    })).toThrow("new_agent_backend_id_invalid");
    expect(() => workspaceRoomCreateRequest({
      name: "無効Agent",
      expectedWorkspaceVersion: 1,
      operationId: "room_create_disabled",
      newAgent: { name: "New", role: "role", instructions: "instructions", backend_id: "samurai-native", enabled: false }
    })).toThrow("room_default_agent_enabled_required");
  });

  it("keeps the complete renderer target without placing it in the public Domain input", () => {
    const request = workspaceRoomCreateRequest({
      name: "Target bound",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      expectedWorkspaceVersion: 3,
      operationId: "room_create_target"
    });
    expect(request.target).toEqual({ connectionId: "server_a", workspaceId: "workspace_a" });
    expect(request.body).not.toHaveProperty("target");
  });

  it("requires an explicit root destination and current versions for a move", () => {
    expect(workspaceRoomMoveRequest({
      roomId: "room_child",
      parentRoomId: null,
      expectedRoomVersion: 4,
      expectedWorkspaceVersion: 8,
      operationId: "room_move_1"
    })).toEqual({
      roomId: "room_child",
      operationId: "room_move_1",
      body: { parent_room_id: null, expected_room_version: 4, expected_workspace_version: 8 }
    });
    expect(() => workspaceRoomMoveRequest({ roomId: "room_child", expectedRoomVersion: 4, expectedWorkspaceVersion: 8, operationId: "room_move_1" }))
      .toThrow("parentRoomId_required");
  });

  it("keeps member changes limited to the typed Room operation", () => {
    expect(workspaceRoomMemberRequest({
      roomId: "room_child",
      accountId: "account_member",
      role: "member",
      state: "revoked",
      expectedVersion: 2,
      operationId: "room_member_1",
      arbitraryPath: "/api/workspaces/other"
    })).toEqual({
      roomId: "room_child",
      accountId: "account_member",
      operationId: "room_member_1",
      body: { role: "member", state: "revoked", expected_version: 2 }
    });
  });

  it("carries the complete target through Room move and membership requests", () => {
    const target = { connectionId: "server_a", workspaceId: "workspace_a", roomId: "room_child", selectionGeneration: 7 };

    expect(workspaceRoomMemberListRequest({ roomId: "room_child", target })).toEqual({ roomId: "room_child", target });
    expect(workspaceRoomMoveRequest({
      roomId: "room_child",
      parentRoomId: null,
      expectedRoomVersion: 4,
      expectedWorkspaceVersion: 8,
      operationId: "room_move_target",
      target
    })).toMatchObject({ roomId: "room_child", operationId: "room_move_target", target });
    expect(workspaceRoomMemberRequest({
      roomId: "room_child",
      accountId: "account_member",
      role: "member",
      state: "active",
      expectedVersion: 2,
      operationId: "room_member_target",
      target
    })).toMatchObject({ roomId: "room_child", accountId: "account_member", operationId: "room_member_target", target });
    expect(() => workspaceRoomMoveRequest({
      roomId: "room_child",
      parentRoomId: null,
      expectedRoomVersion: 4,
      expectedWorkspaceVersion: 8,
      operationId: "room_move_invalid_target",
      target: { connectionId: "", workspaceId: "workspace_a" }
    })).toThrow("workspace_target_invalid");
  });

  it("rejects malformed optional Room target fields instead of dropping their scope", () => {
    expect(() => workspaceRoomMemberListRequest({
      roomId: "room_child",
      target: { connectionId: "server_a", workspaceId: "workspace_a", roomId: "" }
    })).toThrow("workspace_target_invalid");
    expect(() => workspaceRoomMemberListRequest({
      roomId: "room_child",
      target: { connectionId: "server_a", workspaceId: "workspace_a", selectionGeneration: -1 }
    })).toThrow("workspace_target_invalid");
  });
});
