const opaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type LearningScope = { scopeKind: "workspace"; roomId?: never } | { scopeKind: "room"; roomId: string };
type LearningResourceKind = "knowledge" | "memory" | "skill" | "workspace_rule";

/**
 * Fixed request bodies for the Native App learning UI. The renderer never
 * supplies a URL, signing capability, secret value, or arbitrary payload.
 */
export function workspaceLearningScopeRequest(input: unknown): LearningScope {
  const value = object(input);
  if (value.scopeKind === "workspace") return { scopeKind: "workspace" };
  if (value.scopeKind === "room") return { scopeKind: "room", roomId: requiredOpaque(value, "roomId") };
  throw new Error("scopeKind_invalid");
}

export function workspaceLearningResourceListRequest(input: unknown): LearningScope & { includeArchived?: boolean } {
  const value = object(input);
  const scope = workspaceLearningScopeRequest(value);
  return {
    ...scope,
    ...(value.includeArchived === true ? { includeArchived: true } : {})
  };
}

export function workspaceLearningResourceIdRequest(input: unknown): string {
  return requiredOpaque(object(input), "resourceId");
}

export function workspaceLearningResourceCreateRequest(input: unknown): {
  operationId: string;
  body: { scope_kind: "workspace" | "room"; room_id?: string; kind: LearningResourceKind; is_absolute_rule?: boolean; title: string; content: string; reason: string };
} {
  const value = object(input);
  const scope = workspaceLearningScopeRequest(value);
  const kind = resourceKind(value);
  const isAbsoluteRule = optionalBoolean(value, "isAbsoluteRule");
  validateResourceIdentity(scope, kind, isAbsoluteRule);
  return {
    operationId: requiredOpaque(value, "operationId"),
    body: {
      scope_kind: scope.scopeKind,
      ...(scope.scopeKind === "room" ? { room_id: scope.roomId } : {}),
      kind,
      ...(isAbsoluteRule === undefined ? {} : { is_absolute_rule: isAbsoluteRule }),
      title: requiredText(value, "title", 20_000),
      content: requiredText(value, "content", 200_000),
      reason: requiredText(value, "reason", 4_000)
    }
  };
}

export function workspaceLearningResourceUpdateRequest(input: unknown): {
  resourceId: string;
  operationId: string;
  body: { scope_kind: "workspace" | "room"; room_id?: string; kind: LearningResourceKind; is_absolute_rule?: boolean; title: string; content: string; reason: string; expected_version: number };
} {
  const value = object(input);
  const created = workspaceLearningResourceCreateRequest(value);
  return {
    resourceId: requiredOpaque(value, "resourceId"),
    operationId: created.operationId,
    body: { ...created.body, expected_version: requiredVersion(value, "expectedVersion", 1) }
  };
}

export function workspaceLearningResourceStateRequest(input: unknown, action: "fixed" | "archive"): {
  resourceId: string;
  operationId: string;
  body: { [key: string]: boolean | number | string };
} {
  const value = object(input);
  const field = action === "fixed" ? "fixed" : "archived";
  return {
    resourceId: requiredOpaque(value, "resourceId"),
    operationId: requiredOpaque(value, "operationId"),
    body: {
      [field]: requiredBoolean(value, field),
      expected_version: requiredVersion(value, "expectedVersion", 1),
      reason: requiredText(value, "reason", 4_000)
    }
  };
}

export function workspaceLearningSettingsRequest(input: unknown): {
  operationId: string;
  body: {
    scope_kind: "workspace" | "room";
    room_id?: string;
    enabled?: boolean;
    engine_id?: string;
    model?: string;
    secret_ref?: string;
    currency_limit?: number;
    token_limit?: number;
    clear_engine_id?: boolean;
    clear_model?: boolean;
    clear_secret_ref?: boolean;
    clear_currency_limit?: boolean;
    clear_token_limit?: boolean;
    remove_override?: boolean;
    expected_version?: number;
  };
} {
  const value = object(input);
  const scope = workspaceLearningScopeRequest(value);
  const engineId = optionalOpaque(value, "engineId");
  const secretRef = optionalSecretRef(value);
  const model = optionalText(value, "model", 512);
  const clearEngineId = optionalBoolean(value, "clearEngineId");
  const clearModel = optionalBoolean(value, "clearModel");
  const clearSecretRef = optionalBoolean(value, "clearSecretRef");
  const clearCurrencyLimit = optionalBoolean(value, "clearCurrencyLimit");
  const clearTokenLimit = optionalBoolean(value, "clearTokenLimit");
  const removeOverride = optionalBoolean(value, "removeOverride");
  if ((clearEngineId && engineId) || (clearModel && model) || (clearSecretRef && secretRef)
    || (clearCurrencyLimit && value.currencyLimit !== undefined) || (clearTokenLimit && value.tokenLimit !== undefined)) {
    throw new Error("workspace_learning_settings_clear_conflict");
  }
  if (removeOverride === true) {
    if (scope.scopeKind !== "room" || value.enabled !== undefined || engineId || model || secretRef
      || clearEngineId || clearModel || clearSecretRef || clearCurrencyLimit || clearTokenLimit
      || value.currencyLimit !== undefined || value.tokenLimit !== undefined) {
      throw new Error("workspace_learning_settings_override_remove_invalid");
    }
  }
  return {
    operationId: requiredOpaque(value, "operationId"),
    body: {
      scope_kind: scope.scopeKind,
      ...(scope.scopeKind === "room" ? { room_id: scope.roomId } : {}),
      ...(value.enabled === undefined ? {} : { enabled: requiredBoolean(value, "enabled") }),
      ...(engineId ? { engine_id: engineId } : {}),
      ...(model ? { model } : {}),
      ...(secretRef ? { secret_ref: secretRef } : {}),
      ...(value.currencyLimit === undefined ? {} : { currency_limit: nonnegative(value, "currencyLimit", false) }),
      ...(value.tokenLimit === undefined ? {} : { token_limit: nonnegative(value, "tokenLimit", true) }),
      ...(clearEngineId === undefined ? {} : { clear_engine_id: clearEngineId }),
      ...(clearModel === undefined ? {} : { clear_model: clearModel }),
      ...(clearSecretRef === undefined ? {} : { clear_secret_ref: clearSecretRef }),
      ...(clearCurrencyLimit === undefined ? {} : { clear_currency_limit: clearCurrencyLimit }),
      ...(clearTokenLimit === undefined ? {} : { clear_token_limit: clearTokenLimit }),
      ...(removeOverride === undefined ? {} : { remove_override: removeOverride }),
      ...(value.expectedVersion === undefined ? {} : { expected_version: requiredVersion(value, "expectedVersion", 0) })
    }
  };
}

export function workspaceLearningSearchRequest(input: unknown): { roomId: string; query: string; limit?: number } {
  const value = object(input);
  return {
    roomId: requiredOpaque(value, "roomId"),
    query: requiredText(value, "query", 2_000),
    ...(value.limit === undefined ? {} : { limit: requiredVersion(value, "limit", 1) })
  };
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_learning_request_invalid");
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

function optionalSecretRef(value: Record<string, unknown>): string | undefined {
  const secretRef = optionalOpaque(value, "secretRef");
  if (secretRef && /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})(?:$|[^A-Za-z0-9])/.test(secretRef)) {
    throw new Error("secretRef_invalid");
  }
  return secretRef;
}

function requiredText(value: Record<string, unknown>, key: string, maximum: number): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim() || candidate.trim().length > maximum) throw new Error(`${key}_invalid`);
  return candidate.trim();
}

function optionalText(value: Record<string, unknown>, key: string, maximum: number): string | undefined {
  if (value[key] === undefined || value[key] === null || value[key] === "") return undefined;
  return requiredText(value, key, maximum);
}

function requiredBoolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`${key}_invalid`);
  return value[key] as boolean;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  if (value[key] === undefined) return undefined;
  return requiredBoolean(value, key);
}

function requiredVersion(value: Record<string, unknown>, key: string, minimum: number): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < minimum) throw new Error(`${key}_invalid`);
  return candidate;
}

function nonnegative(value: Record<string, unknown>, key: string, integer: boolean): number {
  const candidate = value[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || (integer && !Number.isSafeInteger(candidate))) throw new Error(`${key}_invalid`);
  return candidate;
}

function resourceKind(value: Record<string, unknown>): LearningResourceKind {
  if (value.kind === "knowledge" || value.kind === "memory" || value.kind === "skill" || value.kind === "workspace_rule") return value.kind;
  throw new Error("kind_invalid");
}

function validateResourceIdentity(scope: LearningScope, kind: LearningResourceKind, isAbsoluteRule: boolean | undefined): void {
  if ((kind === "workspace_rule") !== (isAbsoluteRule === true) || (kind === "workspace_rule" && scope.scopeKind !== "workspace")) {
    throw new Error("workspace_learning_resource_scope_invalid");
  }
}
