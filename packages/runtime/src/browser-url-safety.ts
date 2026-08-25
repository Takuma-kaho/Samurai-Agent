import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * A browser target is an outbound server-side request.  Keep this guard
 * independent from the browser adapter so fetch, Playwright, and injected
 * adapters share the same fail-closed URL policy.
 */
export class BrowserUrlSafetyError extends Error {
  constructor(readonly reason: "invalid" | "private_address" | "dns_resolution_failed" | "redirect_blocked" | "network_guard_unavailable") {
    super(`browser_url_${reason}`);
    this.name = "BrowserUrlSafetyError";
  }
}

/** Parse and validate the parts that do not require DNS. */
export function parseBrowserUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BrowserUrlSafetyError("invalid");
  }
  if (!HTTP_PROTOCOLS.has(url.protocol) || url.username || url.password || !url.hostname) {
    throw new BrowserUrlSafetyError("invalid");
  }
  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname) || isPrivateAddress(hostname)) {
    throw new BrowserUrlSafetyError("private_address");
  }
  return url;
}

/**
 * Resolve a hostname before it reaches a server-side HTTP client.  This also
 * catches public-looking names that resolve to loopback, link-local, private,
 * or other non-routable addresses.
 */
export async function assertSafeBrowserUrl(value: string): Promise<URL> {
  const url = parseBrowserUrl(value);
  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname) !== 0) return url;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new BrowserUrlSafetyError("dns_resolution_failed");
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new BrowserUrlSafetyError("private_address");
  }
  return url;
}

/** Schemes that do not cause a network request inside an already-open page. */
export function isNonNetworkBrowserRequest(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("about:") || normalized.startsWith("data:") || normalized.startsWith("blob:");
}

export function normalizeHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
    || hostname === "metadata.google";
}

function isPrivateAddress(value: string): boolean {
  const hostname = normalizeHostname(value);
  const version = isIP(hostname);
  if (version === 4) return isPrivateIpv4(hostname);
  if (version !== 6) return false;
  const words = parseIpv6(hostname);
  if (!words) return true;
  const first = words[0] ?? 0;
  if (words.every((word) => word === 0)) return true;
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
    const mappedHigh = words[6] ?? 0;
    const mappedLow = words[7] ?? 0;
    return isPrivateIpv4(`${mappedHigh >>> 8}.${mappedHigh & 0xff}.${mappedLow >>> 8}.${mappedLow & 0xff}`);
  }
  return first === 0 || (first & 0xffc0) === 0xfe80
    || (first & 0xfe00) === 0xfc00
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && words[1] === 0x0db8);
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second, third] = octets;
  if (first === undefined || second === undefined || third === undefined) return true;
  return first === 0
    || first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 198 && second === 18)
    || (first === 198 && second === 19)
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function parseIpv6(value: string): number[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) return undefined;
  const parsePart = (part: string): number[] | undefined => {
    if (!part) return [];
    const words: number[] = [];
    for (const token of part.split(":")) {
      if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
        const [first, second, third, fourth] = octets;
        if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined;
        words.push((first << 8) | second, (third << 8) | fourth);
      } else if (/^[0-9a-f]{1,4}$/i.test(token)) {
        words.push(Number.parseInt(token, 16));
      } else {
        return undefined;
      }
    }
    return words;
  };
  const left = parsePart(parts[0] ?? "");
  const right = parsePart(parts[1] ?? "");
  if (!left || !right) return undefined;
  if (parts.length === 1 && left.length !== 8) return undefined;
  if (parts.length === 2 && left.length + right.length >= 8) return undefined;
  return parts.length === 1
    ? left
    : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}
