import {
  ObjectiveRecordSchema,
  createId,
  nowIso,
  type JsonValue,
  type ObjectiveRecord,
  type WorkItemRecord
} from "@samurai-agent/core-schemas";

export interface ObjectiveWritePort {
  save(record: ObjectiveRecord): Promise<ObjectiveRecord>;
  transition(objectiveId: string, action: "pause" | "resume" | "cancel"): Promise<{
    objective: ObjectiveRecord; workItems: WorkItemRecord[]; cancelBackendRunIds: string[];
  }>;
}

export interface ObjectiveDomainServiceDependencies {
  objectives: ObjectiveWritePort;
  requestError: (code: "conflict", message: string) => Error;
}

export class ObjectiveDomainService {
  constructor(private readonly dependencies: ObjectiveDomainServiceDependencies) {}

  create(payload: Record<string, JsonValue>) {
    const objective = optionalString(payload.objective);
    const completionCriteria = stringArray(payload.completion_criteria);
    if (!objective || completionCriteria.length === 0) {
      throw this.dependencies.requestError("conflict", "objective_and_completion_criteria_required");
    }
    const now = nowIso();
    return this.dependencies.objectives.save(ObjectiveRecordSchema.parse({
      id: optionalString(payload.objective_id) || optionalString(payload.id) || createId("objective"),
      session_id: optionalString(payload.session_id) || undefined,
      title: optionalString(payload.title) || summarize(objective, 80),
      objective,
      completion_criteria: completionCriteria,
      status: "active",
      token_budget: positiveInteger(payload.token_budget),
      time_budget_ms: positiveInteger(payload.time_budget_ms),
      max_attempts: positiveInteger(payload.max_attempts),
      created_at: now,
      updated_at: now
    }));
  }

  transition(payload: Record<string, JsonValue>) {
    const action = optionalString(payload.action);
    if (action !== "pause" && action !== "resume" && action !== "cancel") {
      throw this.dependencies.requestError("conflict", "objective_transition_action_required");
    }
    return this.dependencies.objectives.transition(requiredString(payload, "objective_id"), action);
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function positiveInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function summarize(value: string, maxLength: number): string {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}
