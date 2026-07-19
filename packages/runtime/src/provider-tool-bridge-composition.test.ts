import { describe, expect, it } from "vitest";
import { getDomainOperationForProviderToolName } from "@samurai-agent/action-catalog";
import {
  buildProviderToolBridgeMaps,
  isSamuraiToolBridgeObservedProviderTool,
  normalizeSamuraiToolBridgeName,
  samuraiToolBridgeActionId,
  samuraiToolBridgeDescriptors,
  samuraiToolBridgeTools,
  samuraiToolBridgeWriteTools
} from "./provider-tool-bridge-composition.js";

describe("provider tool bridge projection", () => {
  it("keeps every declared canonical and provider alias on one catalog definition", () => {
    for (const descriptor of samuraiToolBridgeDescriptors) {
      expect(samuraiToolBridgeTools.has(descriptor.name)).toBe(true);
      expect(normalizeSamuraiToolBridgeName(descriptor.provider_tool_name)).toBe(descriptor.name);
      expect(samuraiToolBridgeActionId(descriptor.provider_tool_name)).toBe(samuraiToolBridgeActionId(descriptor.name));
      if (descriptor.name === "samurai.collection.manage") continue;
      const entry = getDomainOperationForProviderToolName(descriptor.name);
      expect(entry).toBeDefined();
      for (const alias of entry?.provider_tool_names ?? []) {
        expect(normalizeSamuraiToolBridgeName(alias)).toBe(descriptor.name);
        expect(samuraiToolBridgeActionId(alias)).toBe(entry?.id);
      }
      if (entry?.kind === "query") expect(samuraiToolBridgeWriteTools.has(descriptor.name)).toBe(false);
      if (entry?.kind === "command") expect(samuraiToolBridgeWriteTools.has(descriptor.name)).toBe(true);
    }
  });

  it("rejects unknown names and observed aliases outside the bridge", () => {
    expect(() => samuraiToolBridgeActionId("samurai.unknown")).toThrow("unknown_samurai_tool_bridge");
    expect(samuraiToolBridgeTools.has(normalizeSamuraiToolBridgeName("mcp__samurai__unknown"))).toBe(false);
    expect(isSamuraiToolBridgeObservedProviderTool("mcp__samurai__unknown", {
      already_executed: true,
      tool_origin: "samurai_tool_bridge"
    })).toBe(false);
  });

  it("keeps explicit bridge presentation aliases on the same definition", () => {
    expect(normalizeSamuraiToolBridgeName("artifact_create")).toBe("samurai.artifact.create");
    expect(samuraiToolBridgeActionId("artifact_create")).toBe("artifact.create");
  });

  it("fails fast on duplicate bridge declarations", () => {
    const duplicate = {
      name: "samurai.memory.search",
      provider_tool_name: "mcp__samurai__memory_search",
      title: "Memory",
      description: "Memory"
    } as Parameters<typeof buildProviderToolBridgeMaps>[0][number];
    expect(() => buildProviderToolBridgeMaps([duplicate, duplicate])).toThrow("duplicate_provider_tool_bridge_name");
  });
});
