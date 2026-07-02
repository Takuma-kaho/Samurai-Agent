import { describe, expect, it } from "vitest";
import { assertLocaleKeyParity, t } from "./index";

describe("localization", () => {
  it("keeps every locale key in sync", () => {
    expect(() => assertLocaleKeyParity()).not.toThrow();
  });

  it("returns canonical labels", () => {
    expect(t("ja", "settings.title")).toBe("Settings");
    expect(t("en", "chat.send")).toBe("Send");
  });
});
