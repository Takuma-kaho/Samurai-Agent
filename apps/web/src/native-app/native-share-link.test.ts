import { describe, expect, it } from "vitest";
import parseNativeShareLink, {
  NativeShareLinkError,
  type NativeShareLinkErrorCode
} from "./native-share-link";

const locator = "a".repeat(43);
const sourceUrl = `https://source.example/s/${locator}`;
const route = `#/share?source=${encodeURIComponent(sourceUrl)}`;

function expectParseError(input: unknown, code: NativeShareLinkErrorCode): NativeShareLinkError {
  try {
    parseNativeShareLink(input);
  } catch (error) {
    expect(error).toBeInstanceOf(NativeShareLinkError);
    const parsedError = error as NativeShareLinkError;
    expect(parsedError.code).toBe(code);
    return parsedError;
  }
  throw new Error("expected share-link parsing to fail");
}

describe("parseNativeShareLink", () => {
  it("normalizes an encoded share source without exposing extra fields", () => {
    const result = parseNativeShareLink(route);

    expect(result).toEqual({
      sourceOrigin: "https://source.example/",
      locator,
      sourceUrl
    });
    expect(Object.keys(result).sort()).toEqual(["locator", "sourceOrigin", "sourceUrl"]);
  });

  it("requires the exact hash route and a single source parameter", () => {
    expectParseError("/share?source=https%3A%2F%2Fsource.example", "share_link_route_invalid");
    expectParseError("#/share", "share_link_route_invalid");
    expectParseError("#/share?source=", "share_link_source_missing");
    expectParseError(`#/share?source=${encodeURIComponent(sourceUrl)}&extra=1`, "share_link_route_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(sourceUrl)}&source=${encodeURIComponent(sourceUrl)}`, "share_link_route_invalid");
    expectParseError(null, "share_link_input_invalid");
  });

  it("accepts only HTTPS source URLs without credentials or query/hash", () => {
    expectParseError(`#/share?source=${encodeURIComponent(sourceUrl.replace("https:", "http:"))}`, "share_link_source_protocol_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://user:pass@source.example/s/${locator}`)}`, "share_link_source_credentials_forbidden");
    expectParseError(`#/share?source=${encodeURIComponent(`${sourceUrl}?`)}`, "share_link_source_scope_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`${sourceUrl}#`)}`, "share_link_source_scope_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`${sourceUrl}?mode=preview`)}`, "share_link_source_scope_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`${sourceUrl}#section`)}`, "share_link_source_scope_invalid");
  });

  it("requires exactly a 43-character share locator at /s", () => {
    expectParseError(`#/share?source=${encodeURIComponent("https://source.example/s/short")}`, "share_link_locator_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://source.example/s/${"a".repeat(42)}`)}`, "share_link_locator_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://source.example/s/${"a".repeat(44)}`)}`, "share_link_locator_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://source.example/s/${"!".repeat(43)}`)}`, "share_link_locator_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://source.example/other/${locator}`)}`, "share_link_locator_invalid");
    expectParseError(`#/share?source=${encodeURIComponent(`https://source.example/s/${locator}/`)}`, "share_link_locator_invalid");
  });

  it("does not place untrusted source data in errors", () => {
    const suspicious = `https://user:secret@source.example/s/${locator}?token=do-not-display#fragment`;
    const error = expectParseError(`#/share?source=${encodeURIComponent(suspicious)}`, "share_link_source_credentials_forbidden");

    expect(error.message).not.toContain(suspicious);
    expect(error.message).not.toContain(locator);
    expect(error.message).not.toContain("secret");
  });
});
