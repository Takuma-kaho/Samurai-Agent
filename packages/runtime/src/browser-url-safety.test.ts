import { describe, expect, it } from "vitest";
import { BrowserUrlSafetyError, parseBrowserUrl } from "./browser-url-safety.js";

describe("browser URL safety", () => {
  it("allows only HTTP(S) URLs without embedded credentials", () => {
    expect(parseBrowserUrl("https://example.com/path").protocol).toBe("https:");
    expect(() => parseBrowserUrl("ftp://example.com/file")).toThrow(BrowserUrlSafetyError);
    expect(() => parseBrowserUrl("https://user:password@example.com/")).toThrow(BrowserUrlSafetyError);
  });

  it("rejects loopback, private, link-local, and metadata targets before DNS", () => {
    for (const value of [
      "http://127.0.0.1/",
      "http://10.0.0.8/",
      "http://192.168.1.10/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://localhost/",
      "http://metadata.google.internal/"
    ]) {
      expect(() => parseBrowserUrl(value)).toThrow(BrowserUrlSafetyError);
    }
  });
});
