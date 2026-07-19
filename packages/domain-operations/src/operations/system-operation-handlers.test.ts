import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../definition/index.js";
import pluginStatusSet from "./plugin/status/set.operation.js";
import presentationPlan from "./presentation/plan.operation.js";
import settingsPatch from "./settings/patch.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

describe("System operation handlers", () => {
  it("passes only schema-validated settings fields to persistence", async () => {
    const applySettingsPatch = vi.fn(async () => ({
      ui_locale: "ja" as const,
      output_locale: "ja" as const,
      memory_capture_mode: "manual" as const,
      knowledge_wiki_capture_mode: "manual" as const,
      skill_capture_mode: "manual" as const,
      external_provider_role: "assistive" as const,
      updated_at: "2026-07-16T00:00:00.000Z"
    }));
    const handler = settingsPatch.createHandler({ applySettingsPatch });
    const input = settingsPatch.input.parse({ ui_locale: "ja", memory_capture_mode: "manual" });

    await handler.execute(context, input);

    expect(applySettingsPatch).toHaveBeenCalledWith({ uiLocale: "ja", memoryCaptureMode: "manual" });
  });

  it("owns plugin enablement, lookup, and state persistence order", async () => {
    const setPluginEnabled = vi.fn(() => true);
    const findPluginStatus = vi.fn(() => ({ manifest_id: "plugin-1", version: "1.0.0" }));
    const savePluginState = vi.fn(async () => ({
      manifest_id: "plugin-1",
      enabled: true,
      version: "1.0.0",
      updated_at: "2026-07-16T00:00:00.000Z"
    }));
    const handler = pluginStatusSet.createHandler({
      setPluginEnabled,
      findPluginStatus,
      savePluginState,
      pluginNotFoundError: () => new Error("plugin_not_found")
    });

    await handler.execute(context, { plugin_id: "plugin-1", status: "enabled" });

    expect(setPluginEnabled).toHaveBeenCalledWith("plugin-1", true);
    expect(findPluginStatus).toHaveBeenCalledWith("plugin-1");
    expect(savePluginState).toHaveBeenCalledWith({ manifestId: "plugin-1", enabled: true, version: "1.0.0" });
  });

  it("plans presentation without a runtime service", async () => {
    const handler = presentationPlan.createHandler({});

    await expect(handler.execute(context, { requested_kind: "generated_surface" })).resolves.toMatchObject({
      ok: true,
      value: { selected_kind: "generated_surface" }
    });
  });
});
