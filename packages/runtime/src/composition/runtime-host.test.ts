import { describe, expect, it } from "vitest";
import {
  runtimeBindingFromRunMetadata,
  runtimeExecutionContextForBackend,
  runtimeMetadataForBackend
} from "./runtime-host";

const nativeMetadata = {
  runtime_binding: {
    workspace_id: "workspace_1",
    room_id: "room_1",
    session_id: "session_1",
    work_id: "work_1",
    assignee_id: "assignment_1",
    agent_id: "agent_1",
    agent_configuration_version: 7,
    backend_id: "samurai-native",
    generation: 3,
    agent: {
      name: "Writer",
      role: "drafting",
      instructions: "Write concise drafts.",
      enabled: true,
      backend_id: "samurai-native",
      config_version: "7"
    }
  },
  request_label: "kept"
} as const;

describe("RuntimeHost execution context", () => {
  it("rebuilds Native context from the persisted Agent snapshot and association", () => {
    const binding = runtimeBindingFromRunMetadata(nativeMetadata, {
      workspaceId: "workspace_1",
      roomId: "room_1",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "samurai-native"
    });

    expect(binding).toMatchObject({
      workspaceId: "workspace_1",
      roomId: "room_1",
      workId: "work_1",
      assigneeId: "assignment_1",
      generation: 3,
      agentConfigurationVersion: 7,
      agent: { name: "Writer", role: "drafting", enabled: true }
    });
    expect(runtimeExecutionContextForBackend(binding!, { id: "samurai-native", kind: "samurai_native" })).toEqual({
      agent: {
        id: "agent_1",
        name: "Writer",
        role: "drafting",
        instructions: "Write concise drafts.",
        enabled: true,
        backend_id: "samurai-native",
        config_version: "7"
      },
      association: {
        workspace_id: "workspace_1",
        room_id: "room_1",
        work_id: "work_1",
        assignee_id: "assignment_1",
        backend_id: "samurai-native",
        generation: 3
      },
      credential_boundary: "provider_api",
      continuity: "samurai_context"
    });
  });

  it("uses the external CLI/session boundary only for external backends", () => {
    const binding = runtimeBindingFromRunMetadata({
      ...nativeMetadata,
      runtime_binding: {
        ...nativeMetadata.runtime_binding,
        backend_id: "codex-cli",
        agent: { ...nativeMetadata.runtime_binding.agent, backend_id: "codex-cli" }
      }
    }, {
      workspaceId: "workspace_1",
      roomId: "room_1",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "codex-cli"
    });

    expect(runtimeExecutionContextForBackend(binding!, { id: "codex-cli", kind: "external_cli" })).toMatchObject({
      credential_boundary: "external_cli",
      continuity: "external_session"
    });
  });

  it("accepts generation zero only for an explicit Human Work association", () => {
    const binding = runtimeBindingFromRunMetadata({
      ...nativeMetadata,
      runtime_binding: { ...nativeMetadata.runtime_binding, generation: 0 }
    }, {
      workspaceId: "workspace_1",
      roomId: "room_1",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "samurai-native"
    });

    expect(binding?.generation).toBe(0);
    expect(runtimeExecutionContextForBackend(binding!, { id: "samurai-native", kind: "samurai_native" })?.association.generation).toBe(0);
  });

  it("keeps the legacy no-binding generation default at one", () => {
    const binding = runtimeBindingFromRunMetadata({}, {
      workspaceId: "workspace_1",
      roomId: "room_1",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "samurai-native",
      generation: 0,
      agent: {
        id: "agent_1",
        name: "Writer",
        role: "drafting",
        instructions: "Write concise drafts.",
        backend_id: "samurai-native",
        enabled: true,
        configuration_version: 7,
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z"
      }
    });

    expect(binding?.generation).toBe(1);
    expect(runtimeExecutionContextForBackend(binding!, { id: "samurai-native", kind: "samurai_native" })).toBeUndefined();
  });

  it("does not leak the persisted association through generic metadata", () => {
    const safe = runtimeMetadataForBackend(nativeMetadata);
    expect(safe).toEqual({ request_label: "kept" });
    expect(safe).not.toHaveProperty("runtime_binding");
  });

  it("rejects a continuation whose persisted Room does not match the current handoff", () => {
    expect(() => runtimeBindingFromRunMetadata(nativeMetadata, {
      workspaceId: "workspace_1",
      roomId: "different_room",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "samurai-native"
    })).toThrow("runtime_execution_binding_mismatch");
  });

  it("rejects a partial work association instead of silently falling back", () => {
    expect(() => runtimeBindingFromRunMetadata({
      runtime_binding: {
        ...nativeMetadata.runtime_binding,
        assignee_id: null
      }
    }, {
      workspaceId: "workspace_1",
      roomId: "room_1",
      sessionId: "session_1",
      agentId: "agent_1",
      backendId: "samurai-native"
    })).toThrow("runtime_execution_binding_invalid");
  });
});
