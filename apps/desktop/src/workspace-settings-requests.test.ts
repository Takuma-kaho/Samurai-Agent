import { describe, expect, it } from "vitest";
import { workspaceSettingsPatchRequest } from "./workspace-settings-requests";

describe("workspace settings IPC request", () => {
  it("keeps settings updates operation-scoped and rejects unknown fields", () => {
    expect(workspaceSettingsPatchRequest({
      operationId: "settings-op-1",
      patch: { memory_capture_mode: "manual", learning_enabled: false }
    })).toEqual({
      operationId: "settings-op-1",
      body: { memory_capture_mode: "manual", learning_enabled: false }
    });
    expect(() => workspaceSettingsPatchRequest({ operationId: "settings-op-1", patch: { bypass: true } })).toThrow("settings_field_invalid");
  });
});
