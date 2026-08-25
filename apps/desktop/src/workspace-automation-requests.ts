const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const automationKinds = new Set([
  "memory_review",
  "learning_evaluation",
  "skill_curator",
  "wiki_reindex",
  "daily_digest",
  "custom_instruction",
  "resource_translation"
]);

export type WorkspaceAutomationKind =
  | "memory_review"
  | "learning_evaluation"
  | "skill_curator"
  | "wiki_reindex"
  | "daily_digest"
  | "custom_instruction"
  | "resource_translation";

export function workspaceAutomationListRequest(input: unknown): { roomId?: string } {
  const value = object(input);
  const roomId = optionalOpaque(value, "roomId");
  return roomId ? { roomId } : {};
}

export function workspaceAutomationJobCreateRequest(input: unknown): {
  operationId: string;
  body: Record<string, unknown>;
} {
  const value = object(input);
  const kind = requiredKind(value.kind);
  return {
    operationId: requiredOpaque(value, "operationId"),
    body: {
      room_id: requiredOpaque(value, "roomId"),
      title: requiredText(value, "title", 200),
      kind,
      schedule: requiredText(value, "schedule", 4_000),
      target_instruction: requiredText(value, "targetInstruction", 20_000),
      ...(value.deliveryTarget === undefined ? {} : { delivery_target: requiredJsonObject(value, "deliveryTarget") }),
      ...(value.enabled === undefined ? {} : { enabled: requiredBoolean(value, "enabled") }),
      ...(value.nextRunAt === undefined ? {} : { next_run_at: requiredText(value, "nextRunAt", 80) }),
      ...(value.maxAttempts === undefined ? {} : { max_attempts: requiredInteger(value, "maxAttempts", 1, 10) }),
      ...(value.connectionId === undefined ? {} : { connection_id: requiredOpaque(value, "connectionId") }),
      ...(value.sessionRef === undefined ? {} : { session_ref: requiredJsonObject(value, "sessionRef") })
    }
  };
}

export function workspaceAutomationManagementRequest(input: unknown): {
  jobId: string;
  operationId: string;
  state: "allowed" | "manager_stopped";
} {
  const value = object(input);
  const state = value.state === "allowed" || value.state === "manager_stopped" ? value.state : undefined;
  if (!state) throw new Error("automation_management_state_invalid");
  return {
    jobId: requiredOpaque(value, "jobId"),
    operationId: requiredOpaque(value, "operationId"),
    state
  };
}

export function workspaceAutomationRunNowRequest(input: unknown): {
  roomId: string;
  operationId: string;
  kind: WorkspaceAutomationKind;
} {
  const value = object(input);
  return {
    roomId: requiredOpaque(value, "roomId"),
    operationId: requiredOpaque(value, "operationId"),
    kind: requiredKind(value.kind ?? "memory_review")
  };
}

export function workspaceAutomationJobIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "jobId");
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_automation_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || !opaqueIdPattern.test(value[key] as string)) throw new Error(`${key}_invalid`);
  return value[key] as string;
}

function optionalOpaque(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredOpaque(value, key);
}

function requiredText(value: Record<string, unknown>, key: string, max: number): string {
  if (typeof value[key] !== "string" || !(value[key] as string).trim() || (value[key] as string).length > max) throw new Error(`${key}_invalid`);
  return (value[key] as string).trim();
}

function requiredKind(value: unknown): WorkspaceAutomationKind {
  if (typeof value !== "string" || !automationKinds.has(value)) throw new Error("kind_invalid");
  return value as WorkspaceAutomationKind;
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`${key}_invalid`);
  return value[key] as boolean;
}

function requiredInteger(value: Record<string, unknown>, key: string, min: number, max: number): number {
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) throw new Error(`${key}_invalid`);
  return value[key] as number;
}

function requiredJsonObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const candidate = value[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !isJsonObject(candidate) || JSON.stringify(candidate).length > 200_000) throw new Error(`${key}_invalid`);
  return candidate as Record<string, unknown>;
}

function isJsonObject(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
