import { describe, expect, it } from "vitest";
import { workspaceLearningSettingsRequest } from "./workspace-learning-requests";
import { workspaceCompletionResourceCreateRequest } from "./workspace-completion-requests";

describe("Desktop learning and completion operation boundaries", () => {
  it("sends Knowledge resources through the Completion contract", () => {
    expect(workspaceCompletionResourceCreateRequest({
      scopeKind: "room", roomId: "room_product", kind: "knowledge", knowledgeKind: "experience_rule", title: " Deploy ",
      content: " Verified steps ", reason: " Human confirmed ", operationId: "knowledge_create_1",
      privateKey: "must-not-leave-renderer", serverUrl: "https://attacker.example"
    })).toEqual({
      operationId: "knowledge_create_1",
      body: {
        scope_kind: "room", room_id: "room_product", kind: "knowledge", knowledge_kind: "experience_rule", metadata: {},
        title: "Deploy", content: "Verified steps", reason: "Human confirmed"
      }
    });
  });

  it("allows an opaque SecretRef but never accepts a secret value", () => {
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
