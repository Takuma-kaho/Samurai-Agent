import type { JsonValue } from "@samurai-agent/core-schemas";

export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function decodeJsonValue(value: string): JsonValue {
  return decodeJson<JsonValue>(value);
}

export const stringify = encodeJson;
export const parse = decodeJson;
