import type { JsonValue } from "@samurai-agent/core-schemas";
import { domainJsonValueSchema } from "@samurai-agent/domain-operations";

export function jsonValue(value: unknown): JsonValue {
  return domainJsonValueSchema.parse(value);
}
