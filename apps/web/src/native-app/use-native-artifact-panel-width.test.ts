import { describe, expect, it } from "vitest";
import {
  clampNativeArtifactPanelWidth,
  nativeArtifactPanelWidthDefault,
  nativeArtifactPanelWidthMin,
  nativeArtifactPanelSplitMaxWidth,
  nativeArtifactPanelWidthTransition,
  normalizeNativeArtifactPanelWidth
} from "./use-native-artifact-panel-width";

describe("native artifact panel width", () => {
  it("keeps the stored preference inside the panel range", () => {
    expect(clampNativeArtifactPanelWidth(180)).toBe(nativeArtifactPanelWidthMin);
    expect(clampNativeArtifactPanelWidth(900)).toBe(900);
    expect(clampNativeArtifactPanelWidth(410.6)).toBe(411);
    expect(clampNativeArtifactPanelWidth(Number.NaN)).toBe(nativeArtifactPanelWidthDefault);
  });

  it("keeps a minimum chat width in a split layout", () => {
    expect(clampNativeArtifactPanelWidth(720, 1_100)).toBe(720);
    expect(clampNativeArtifactPanelWidth(900, 1_100)).toBe(820);
    expect(clampNativeArtifactPanelWidth(720, 900)).toBe(620);
    expect(clampNativeArtifactPanelWidth(410, 650)).toBe(370);
    expect(clampNativeArtifactPanelWidth(410, 539)).toBe(259);
    expect(clampNativeArtifactPanelWidth(1_300, 1_500)).toBe(1_220);
    expect(nativeArtifactPanelSplitMaxWidth(900)).toBe(620);
    expect(nativeArtifactPanelSplitMaxWidth(1_500)).toBe(1_220);
  });

  it("keeps the split layout at the maximum and expands only after crossing it", () => {
    expect(nativeArtifactPanelWidthTransition(410, 259, 900)).toEqual({ kind: "close" });
    expect(nativeArtifactPanelWidthTransition(410, 260, 900)).toEqual({ kind: "split", width: 260 });
    expect(nativeArtifactPanelWidthTransition(410, 261, 900)).toEqual({ kind: "split", width: 261 });
    expect(nativeArtifactPanelWidthTransition(620, 619, 900)).toEqual({ kind: "split", width: 619 });
    expect(nativeArtifactPanelWidthTransition(620, 620, 900)).toEqual({ kind: "split", width: 620 });
    expect(nativeArtifactPanelWidthTransition(620, 621, 900)).toEqual({ kind: "expand", restoreWidth: 620 });
    expect(nativeArtifactPanelWidthTransition(410, 1_220, 1_500)).toEqual({ kind: "split", width: 1_220 });
    expect(nativeArtifactPanelWidthTransition(1_220, 1_221, 1_500)).toEqual({ kind: "expand", restoreWidth: 1_220 });
  });

  it("normalizes browser storage values without accepting malformed input", () => {
    expect(normalizeNativeArtifactPanelWidth("520")).toBe(520);
    expect(normalizeNativeArtifactPanelWidth("720")).toBe(720);
    expect(normalizeNativeArtifactPanelWidth("not-a-width")).toBe(nativeArtifactPanelWidthDefault);
    expect(normalizeNativeArtifactPanelWidth(null)).toBe(nativeArtifactPanelWidthDefault);
  });
});
