import { describe, expect, it } from "vitest";
import {
  clampNativeSidebarWidth,
  nativeSidebarWidthDefault,
  nativeSidebarWidthMax,
  nativeSidebarWidthMin,
  normalizeNativeSidebarWidth
} from "./use-native-sidebar-width";

describe("native sidebar width", () => {
  it("keeps the saved width inside the supported range", () => {
    expect(clampNativeSidebarWidth(180)).toBe(nativeSidebarWidthMin);
    expect(clampNativeSidebarWidth(512)).toBe(nativeSidebarWidthMax);
    expect(clampNativeSidebarWidth(301.6)).toBe(302);
    expect(clampNativeSidebarWidth(Number.NaN)).toBe(nativeSidebarWidthDefault);
  });

  it("normalizes browser storage values without accepting malformed input", () => {
    expect(normalizeNativeSidebarWidth("340")).toBe(340);
    expect(normalizeNativeSidebarWidth("not-a-width")).toBe(nativeSidebarWidthDefault);
    expect(normalizeNativeSidebarWidth(null)).toBe(nativeSidebarWidthDefault);
  });
});

