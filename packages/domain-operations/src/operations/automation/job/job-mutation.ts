import type { AutomationJobRecord, JsonValue } from "@samurai-agent/core-schemas";

export function automationJobJson(job: AutomationJobRecord): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(job)) as Record<string, JsonValue>;
}
