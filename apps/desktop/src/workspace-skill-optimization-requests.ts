type JsonValue = null | string | boolean | number | JsonValue[] | { [key: string]: JsonValue };

const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workspaceSkillOptimizationListRequest(input: unknown): { skillId?: string; roomId?: string; limit?: number } {
  const value = object(input);
  const skillId = optionalOpaque(value, "skillId");
  const roomId = optionalOpaque(value, "roomId");
  const limit = value.limit === undefined ? undefined : integer(value.limit, 1, 500, "limit");
  return { ...(skillId ? { skillId } : {}), ...(roomId ? { roomId } : {}), ...(limit === undefined ? {} : { limit }) };
}

export function workspaceSkillOptimizationIdRequest(input: unknown): { runId: string } {
  const value = object(input);
  return { runId: requiredOpaque(value, "runId") };
}

export function workspaceSkillOptimizationStartRequest(input: unknown): {
  skillId: string;
  roomId?: string;
  objective?: string;
  goldenExamples?: JsonValue[];
  syntheticExamples?: JsonValue[];
  operationId: string;
} {
  const value = object(input);
  return {
    skillId: requiredOpaque(value, "skillId"),
    ...(optionalOpaque(value, "roomId") ? { roomId: optionalOpaque(value, "roomId") } : {}),
    ...(optionalText(value, "objective", 10_000) ? { objective: optionalText(value, "objective", 10_000) } : {}),
    ...(value.goldenExamples === undefined ? {} : { goldenExamples: jsonArray(value.goldenExamples, "goldenExamples") }),
    ...(value.syntheticExamples === undefined ? {} : { syntheticExamples: jsonArray(value.syntheticExamples, "syntheticExamples") }),
    operationId: requiredOpaque(value, "operationId")
  };
}

export function workspaceSkillOptimizationActionRequest(input: unknown): {
  runId: string;
  action: "cancel" | "promote" | "reject" | "rollback";
  candidateId?: string;
  promotionId?: string;
  snapshotId?: string;
  operationId: string;
} {
  const value = object(input);
  const action = value.action;
  if (action !== "cancel" && action !== "promote" && action !== "reject" && action !== "rollback") throw new Error("skill_optimization_action_invalid");
  return {
    runId: requiredOpaque(value, "runId"),
    action,
    ...(optionalOpaque(value, "candidateId") ? { candidateId: optionalOpaque(value, "candidateId") } : {}),
    ...(optionalOpaque(value, "promotionId") ? { promotionId: optionalOpaque(value, "promotionId") } : {}),
    ...(optionalOpaque(value, "snapshotId") ? { snapshotId: optionalOpaque(value, "snapshotId") } : {}),
    operationId: requiredOpaque(value, "operationId")
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill_optimization_request_invalid");
  return input as Record<string, unknown>;
}

function requiredOpaque(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !opaqueIdPattern.test(candidate)) throw new Error(`${key}_invalid`);
  return candidate;
}

function optionalOpaque(value: Record<string, unknown>, key: string): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredOpaque(value, key);
}

function optionalText(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  if (typeof value[key] !== "string" || !value[key].trim() || value[key].length > maxLength) throw new Error(`${key}_invalid`);
  return value[key].trim();
}

function integer(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key}_invalid`);
  return value;
}

function jsonArray(value: unknown, key: string): JsonValue[] {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((item) => !isJsonValue(item))) throw new Error(`${key}_invalid`);
  if (JSON.stringify(value).length > 1_000_000) throw new Error(`${key}_too_large`);
  return value as JsonValue[];
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return Array.isArray(value) ? value.every(isJsonValue) : Boolean(value) && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJsonValue);
}
