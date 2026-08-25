import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const protocols = new Set(["http:", "https:"]);

export class GatewayHttpEndpointError extends Error {
  constructor(readonly reason: "invalid" | "private_address" | "dns_resolution_failed" | "redirect_blocked") {
    super(`gateway_http_endpoint_${reason}`);
    this.name = "GatewayHttpEndpointError";
  }
}

/**
 * Gateway MCP is a server-side HTTP client.  Resolve the configured host
 * before connecting and reject private, loopback, link-local, metadata, and
 * documentation ranges.  Redirects are blocked separately at the fetch call.
 */
export async function assertSafeGatewayHttpEndpoint(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new GatewayHttpEndpointError("invalid");
  }
  if (!protocols.has(url.protocol) || url.username || url.password || !url.hostname) {
    throw new GatewayHttpEndpointError("invalid");
  }
  const hostname = normalizeHostname(url.hostname);
  if (blockedHostname(hostname) || isPrivateAddress(hostname)) {
    throw new GatewayHttpEndpointError("private_address");
  }
  if (isIP(hostname) !== 0) return url;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new GatewayHttpEndpointError("dns_resolution_failed");
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new GatewayHttpEndpointError("private_address");
  }
  return url;
}

function normalizeHostname(value: string): string {
  return value.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function blockedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
    || hostname === "metadata.google";
}

function isPrivateAddress(value: string): boolean {
  const address = normalizeHostname(value);
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [first, second, third] = octets;
    if (first === undefined || second === undefined || third === undefined) return true;
    return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0) || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 168) || (first === 198 && second >= 18 && second <= 19)
      || (first === 198 && second === 51 && third === 100) || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  }
  if (version !== 6) return false;
  const words = parseIpv6(address);
  if (!words) return true;
  const first = words[0] ?? 0;
  if (words.every((word) => word === 0)) return true;
  if (words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return isPrivateAddress(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`);
  }
  return first === 0 || (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00
    || (first & 0xff00) === 0xff00 || (first === 0x2001 && words[1] === 0x0db8);
}

function parseIpv6(value: string): number[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2) return undefined;
  const parsePart = (part: string): number[] | undefined => {
    if (!part) return [];
    const words: number[] = [];
    for (const token of part.split(":")) {
      if (/^[0-9a-f]{1,4}$/i.test(token)) words.push(Number.parseInt(token, 16));
      else if (token.includes(".")) {
        const octets = token.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else return undefined;
    }
    return words;
  };
  const left = parsePart(parts[0] ?? "");
  const right = parsePart(parts[1] ?? "");
  if (!left || !right) return undefined;
  if (parts.length === 1) return left.length === 8 ? left : undefined;
  if (left.length + right.length >= 8) return undefined;
  return [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}
