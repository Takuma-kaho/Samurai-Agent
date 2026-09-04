import { describe, expect, it } from "vitest";
import { createDesktopConfig } from "./config";

describe("Desktop configuration", () => {
  it("reads web port from the Node runtime environment", () => {
    const key = "SAMURAI_WEB_PORT";
    const previous = process.env[key];
    process.env[key] = "5913";

    try {
      expect(createDesktopConfig({ isPackaged: false }).webDevUrl).toBe("http://127.0.0.1:5913");
    } finally {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
  });

  it("uses an explicitly supplied environment for desktop URLs", () => {
    const config = createDesktopConfig({
      isPackaged: false,
      env: {
        SAMURAI_API_PORT: "4319",
        SAMURAI_DESKTOP_WEB_URL: "http://127.0.0.1:5914/workspace?ignored=1#ignored"
      }
    });

    expect(config.apiBaseUrl).toBe("http://127.0.0.1:4319");
    expect(config.webDevUrl).toBe("http://127.0.0.1:5914/workspace");
  });
});
