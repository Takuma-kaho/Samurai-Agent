import { describe, expect, it } from "vitest";
import {
  clampNativeArtifactPanelWidth,
  nativeArtifactPanelWidthDefault,
  nativeArtifactPanelWidthMax,
  nativeArtifactPanelWidthMin,
  normalizeNativeArtifactPanelWidth
} from "./use-native-artifact-panel-width";

describe("native artifact panel width", () => {
  it("keeps the stored preference inside the panel range", () => {
    expect(clampNativeArtifactPanelWidth(180)).toBe(nativeArtifactPanelWidthMin);
    expect(clampNativeArtifactPanelWidth(900)).toBe(nativeArtifactPanelWidthMax);
    expect(clampNativeArtifactPanelWidth(410.6)).toBe(411);
    expect(clampNativeArtifactPanelWidth(Number.NaN)).toBe(nativeArtifactPanelWidthDefault);
  });

  it("keeps a minimum chat width in a split layout", () => {
    expect(clampNativeArtifactPanelWidth(720, 1_100)).toBe(720);
    expect(clampNativeArtifactPanelWidth(720, 900)).toBe(620);
    expect(clampNativeArtifactPanelWidth(410, 650)).toBe(370);
    expect(clampNativeArtifactPanelWidth(410, 539)).toBe(259);
  });

  it("normalizes browser storage values without accepting malformed input", () => {
    expect(normalizeNativeArtifactPanelWidth("520")).toBe(520);
    expect(normalizeNativeArtifactPanelWidth("not-a-width")).toBe(nativeArtifactPanelWidthDefault);
    expect(normalizeNativeArtifactPanelWidth(null)).toBe(nativeArtifactPanelWidthDefault);
  });
});
