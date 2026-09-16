import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeThemePreferenceKey, normalizeNativeTheme, readNativeThemePreference, writeNativeThemePreference } from "./native-app-theme-preferences";

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("Native App theme preference", () => {
  it("normalizes only the three supported themes and defaults to C dark", () => {
    expect(normalizeNativeTheme("dark")).toBe("dark");
    expect(normalizeNativeTheme("light")).toBe("light");
    expect(normalizeNativeTheme("special")).toBe("special");
    expect(normalizeNativeTheme("a-green")).toBe("dark");
    expect(normalizeNativeTheme(undefined)).toBe("dark");
    expect(normalizeNativeTheme({ id: "light" })).toBe("dark");
  });

  it("reads and writes the allowlisted value without storing unrelated data", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
      key: (_index: number) => null,
      get length() { return values.size; }
    } satisfies Storage;
    vi.stubGlobal("window", { localStorage: storage });

    expect(readNativeThemePreference()).toBe("dark");
    expect(writeNativeThemePreference("light")).toBe("light");
    expect(values.get(nativeThemePreferenceKey)).toBe("light");
    values.set(nativeThemePreferenceKey, "invalid");
    expect(readNativeThemePreference()).toBe("dark");
  });

  it("does not throw when localStorage is unavailable", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };
    vi.stubGlobal("window", { localStorage: storage });
    expect(readNativeThemePreference()).toBe("dark");
    expect(writeNativeThemePreference("special")).toBe("special");
  });
});
