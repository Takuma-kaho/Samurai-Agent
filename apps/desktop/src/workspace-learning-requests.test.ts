import { describe, expect, it } from "vitest";
import {
  workspaceLearningResourceIdRequest,
  workspaceLearningResourceCreateRequest,
  workspaceLearningResourceListRequest,
  workspaceLearningSettingsRequest
} from "./workspace-learning-requests";

describe("Desktop learning operation boundary", () => {
  it("accepts only a resource identifier for history lookup", () => {
    expect(workspaceLearningResourceIdRequest({ resourceId: "resource_one", url: "https://attacker.example" })).toBe("resource_one");
    expect(() => workspaceLearningResourceIdRequest({ resourceId: "" })).toThrow("resourceId_invalid");
  });

  it("allows the renderer to ask for archived items without opening another query surface", () => {
    expect(workspaceLearningResourceListRequest({
      scopeKind: "room", roomId: "room_product", includeArchived: true, serverUrl: "https://attacker.example"
    })).toEqual({ scopeKind: "room", roomId: "room_product", includeArchived: true });
  });

  it("creates a fixed Room Knowledge request without a renderer URL, key, or arbitrary payload", () => {
    expect(workspaceLearningResourceCreateRequest({
      scopeKind: "room", roomId: "room_product", kind: "knowledge", title: " Deploy ",
      content: " Verified steps ", reason: " Human confirmed ", operationId: "learning_create_1",
      privateKey: "must-not-leave-renderer", serverUrl: "https://attacker.example", payload: { secret: "no" }
    })).toEqual({
      operationId: "learning_create_1",
      body: {
        scope_kind: "room", room_id: "room_product", kind: "knowledge",
        title: "Deploy", content: "Verified steps", reason: "Human confirmed"
      }
    });
  });

  it("allows an opaque SecretRef but never accepts a secret value or a cross-scope rule", () => {
    expect(workspaceLearningSettingsRequest({
      scopeKind: "workspace", enabled: true, engineId: "local_engine", secretRef: "keychain_learning",
      expectedVersion: 1, operationId: "learning_settings_1", apiKey: "actual-secret"
    })).toEqual({
      operationId: "learning_settings_1",
      body: {
        scope_kind: "workspace", enabled: true, engine_id: "local_engine",
        secret_ref: "keychain_learning", expected_version: 1
      }
    });
    expect(() => workspaceLearningResourceCreateRequest({
      scopeKind: "room", roomId: "room_product", kind: "workspace_rule", isAbsoluteRule: true,
      title: "Bad", content: "Bad", reason: "Bad", operationId: "learning_bad_rule"
    })).toThrow("workspace_learning_resource_scope_invalid");
    expect(() => workspaceLearningSettingsRequest({
      scopeKind: "workspace", enabled: true, secretRef: `sk-${"a".repeat(24)}`,
      operationId: "learning_bad_secret_ref"
    })).toThrow("secretRef_invalid");
  });

  it("uses explicit clear and Room-override removal commands instead of sending blank secrets", () => {
    expect(workspaceLearningSettingsRequest({
      scopeKind: "workspace", enabled: true, clearEngineId: true, clearModel: true,
      clearCurrencyLimit: true, clearTokenLimit: true, expectedVersion: 2, operationId: "learning_clear_1"
    })).toEqual({
      operationId: "learning_clear_1",
      body: {
        scope_kind: "workspace", enabled: true, clear_engine_id: true, clear_model: true,
        clear_currency_limit: true, clear_token_limit: true, expected_version: 2
      }
    });
    expect(workspaceLearningSettingsRequest({
      scopeKind: "room", roomId: "room_product", removeOverride: true,
      expectedVersion: 3, operationId: "learning_remove_override_1"
    })).toEqual({
      operationId: "learning_remove_override_1",
      body: { scope_kind: "room", room_id: "room_product", remove_override: true, expected_version: 3 }
    });
  });
});
