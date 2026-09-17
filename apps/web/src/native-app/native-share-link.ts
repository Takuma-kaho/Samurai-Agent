/**
 * The renderer-side share handoff parser.
 *
 * This function only validates and normalizes the route.  It never fetches a
 * share, claims one, or starts an import.  In particular, the source URL and
 * locator are not included in parse errors so callers cannot accidentally put
 * them into UI or log output while reporting an invalid handoff.
 */

const MAX_SHARE_LINK_LENGTH = 4_096;
const SHARE_LOCATOR_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface NativeShareLink {
  sourceOrigin: string;
  locator: string;
  sourceUrl: string;
}

export type NativeShareLinkErrorCode =
  | "share_link_input_invalid"
  | "share_link_route_invalid"
  | "share_link_source_missing"
  | "share_link_source_invalid"
  | "share_link_source_protocol_invalid"
  | "share_link_source_credentials_forbidden"
  | "share_link_source_scope_invalid"
  | "share_link_locator_invalid";

const nativeShareLinkErrorMessages: Record<NativeShareLinkErrorCode, string> = {
  share_link_input_invalid: "共有リンクの入力が不正です。",
  share_link_route_invalid: "共有リンクの形式が不正です。",
  share_link_source_missing: "共有リンクに共有元URLがありません。",
  share_link_source_invalid: "共有元URLが不正です。",
  share_link_source_protocol_invalid: "共有元URLはHTTPSのみ利用できます。",
  share_link_source_credentials_forbidden: "共有元URLに資格情報は指定できません。",
  share_link_source_scope_invalid: "共有元URLにqueryやfragmentは指定できません。",
  share_link_locator_invalid: "共有元URLのlocatorが不正です。"
};

export class NativeShareLinkError extends Error {
  readonly code: NativeShareLinkErrorCode;

  constructor(code: NativeShareLinkErrorCode) {
    super(nativeShareLinkErrorMessages[code]);
    this.name = "NativeShareLinkError";
    this.code = code;
  }
}

/**
 * Parse `#/share?source=<encoded HTTPS share URL>`.
 *
 * The accepted source URL intentionally mirrors Desktop's share handoff
 * checks: HTTPS, no credentials, no query or fragment, and exactly
 * `/s/<43-character locator>`.
 */
export function parseNativeShareLink(value: unknown): NativeShareLink {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SHARE_LINK_LENGTH) {
    throw new NativeShareLinkError("share_link_input_invalid");
  }

  const queryStart = value.indexOf("?");
  if (queryStart < 0 || value.slice(0, queryStart) !== "#/share") {
    throw new NativeShareLinkError("share_link_route_invalid");
  }

  const query = value.slice(queryStart + 1);
  if (query.length === 0) {
    throw new NativeShareLinkError("share_link_source_missing");
  }

  const params = new URLSearchParams(query);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "source" || params.getAll("source").length !== 1) {
    throw new NativeShareLinkError("share_link_route_invalid");
  }

  const sourceUrlValue = params.get("source");
  if (!sourceUrlValue) {
    throw new NativeShareLinkError("share_link_source_missing");
  }
  if (sourceUrlValue.length > MAX_SHARE_LINK_LENGTH) {
    throw new NativeShareLinkError("share_link_source_invalid");
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(sourceUrlValue);
  } catch {
    throw new NativeShareLinkError("share_link_source_invalid");
  }

  if (sourceUrl.protocol !== "https:") {
    throw new NativeShareLinkError("share_link_source_protocol_invalid");
  }
  if (sourceUrl.username || sourceUrl.password) {
    throw new NativeShareLinkError("share_link_source_credentials_forbidden");
  }

  // URL normalizes an empty trailing `?` or `#` to an empty search/hash.
  // Reject the delimiters in the original value as well so “no query/hash”
  // remains literal and cannot be bypassed with an empty component.
  if (sourceUrlValue.includes("?") || sourceUrlValue.includes("#") || sourceUrl.search || sourceUrl.hash) {
    throw new NativeShareLinkError("share_link_source_scope_invalid");
  }

  const locatorMatch = /^\/s\/([A-Za-z0-9_-]{43})$/.exec(sourceUrl.pathname);
  const locator = locatorMatch?.[1];
  if (!locator || !SHARE_LOCATOR_PATTERN.test(locator)) {
    throw new NativeShareLinkError("share_link_locator_invalid");
  }

  return {
    sourceOrigin: new URL("/", sourceUrl.origin).toString(),
    locator,
    sourceUrl: sourceUrl.toString()
  };
}

/** Alias for callers that use the Desktop terminology for the same handoff. */
export const parseNativeShareDeepLink = parseNativeShareLink;

export default parseNativeShareLink;
