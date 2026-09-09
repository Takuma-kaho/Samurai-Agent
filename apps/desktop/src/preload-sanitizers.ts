export function sanitizeWorkspaceChatSessionInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "operationId", "title", "uiLocale", "outputLocale"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "title" ? 240 : key === "roomId" || key === "operationId" ? 128 : 32);
  }
  return output;
}

/**
 * Room Work resource selectors are intentionally narrower than attachments.
 * The renderer may provide a display label, but only the server-resolved
 * selector fields cross the IPC boundary.
 */
export function sanitizeWorkspaceRoomWorkResourceRefs(input: unknown): Array<{ kind: "knowledge" | "skill"; id: string; version: number }> {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("workspace_room_resource_ref_invalid");
  if (input.length > 32) throw new Error("workspace_room_resource_ref_count_invalid");
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("workspace_room_resource_ref_invalid");
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    if ((value.kind !== "knowledge" && value.kind !== "skill")
      || !id
      || id.length > 512
      || typeof value.version !== "number"
      || !Number.isSafeInteger(value.version)
      || value.version <= 0) {
      throw new Error("workspace_room_resource_ref_invalid");
    }
    return { kind: value.kind, id, version: value.version };
  });
}

/** Keep standalone Workspace creation account-scoped and renderer-safe. */
export function sanitizeWorkspaceCreateInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId.slice(0, 128) } : {}),
    ...(typeof value.name === "string" ? { name: value.name.slice(0, 240) } : {}),
    ...(typeof value.operationId === "string" ? { operationId: value.operationId.slice(0, 128) } : {})
  };
}

/** Artifact revision bridge input. Content may be UTF-8 text or an actual
 * byte array; no renderer-provided URL, path, credential, or arbitrary IPC
 * callback crosses the preload boundary. */
export function sanitizeWorkspaceArtifactRevisionInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "artifactId", "revisionId", "baseRevisionId", "operationId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  if (typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0) {
    output.expectedRevision = value.expectedRevision;
  }
  if (typeof value.changeSummary === "string") output.changeSummary = value.changeSummary.slice(0, 20_000);
  if (typeof value.content === "string") {
    output.content = value.content.slice(0, 50_000_000);
  } else if (value.content instanceof Uint8Array) {
    output.content = Array.from(value.content.slice(0, 50_000_000));
  } else if (Array.isArray(value.content) && value.content.length <= 50_000_000 && value.content.every((item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
    output.content = value.content;
  }
  return output;
}

/** Keep the Generated Surface write DTO explicit while allowing its validated
 * bundle/request objects to pass through the main process. */
export function sanitizeWorkspaceGeneratedSurfaceMutationInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "surfaceId", "operationId"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, 160);
  }
  const bundle = value.bundle;
  if (bundle && typeof bundle === "object" && !Array.isArray(bundle)) {
    const source = bundle as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const key of ["title", "html", "css", "script"]) {
      if (typeof source[key] === "string") sanitized[key] = source[key].slice(0, key === "html" ? 200_000 : key === "script" ? 50_000 : key === "css" ? 100_000 : 512);
    }
    if (source.input_data_schema && typeof source.input_data_schema === "object" && !Array.isArray(source.input_data_schema)) sanitized.input_data_schema = source.input_data_schema;
    if (Array.isArray(source.actions)) sanitized.actions = source.actions.slice(0, 20).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return {};
      const action = item as Record<string, unknown>;
      return {
        ...(typeof action.id === "string" ? { id: action.id.slice(0, 256) } : {}),
        ...(typeof action.label === "string" ? { label: action.label.slice(0, 512) } : {}),
        ...(typeof action.command_id === "string" ? { command_id: action.command_id.slice(0, 256) } : {}),
        ...(action.input_schema && typeof action.input_schema === "object" && !Array.isArray(action.input_schema) ? { input_schema: action.input_schema } : {}),
        ...(action.payload_template && typeof action.payload_template === "object" && !Array.isArray(action.payload_template) ? { payload_template: action.payload_template } : {}),
        ...(typeof action.requires_confirmation === "boolean" ? { requires_confirmation: action.requires_confirmation } : {})
      };
    });
    if (Array.isArray(source.assets)) sanitized.assets = source.assets.slice(0, 50).map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return {};
      const asset = item as Record<string, unknown>;
      return {
        ...(typeof asset.path === "string" ? { path: asset.path.slice(0, 1_024) } : {}),
        ...(typeof asset.content === "string" ? { content: asset.content.slice(0, 2_000_000) } : {}),
        ...(asset.encoding === "utf8" || asset.encoding === "base64" ? { encoding: asset.encoding } : {}),
        ...(typeof asset.mime_type === "string" ? { mime_type: asset.mime_type.slice(0, 255) } : {})
      };
    });
    output.bundle = sanitized;
  }
  const request = value.request;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    const source = request as Record<string, unknown>;
    output.request = {
      ...(typeof source.user_intent === "string" ? { user_intent: source.user_intent.slice(0, 100_000) } : {}),
      ...(Array.isArray(source.source_resource_refs) ? { source_resource_refs: source.source_resource_refs.slice(0, 128) } : {}),
      ...(Array.isArray(source.allowed_domain_commands) ? { allowed_domain_commands: source.allowed_domain_commands.filter((item): item is string => typeof item === "string").slice(0, 128) } : {}),
      ...(Array.isArray(source.selected_knowledge_refs) ? { selected_knowledge_refs: source.selected_knowledge_refs.slice(0, 128) } : {}),
      ...(Array.isArray(source.selected_skill_refs) ? { selected_skill_refs: source.selected_skill_refs.slice(0, 128) } : {}),
      ...(source.client_capabilities && typeof source.client_capabilities === "object" && !Array.isArray(source.client_capabilities) ? { client_capabilities: source.client_capabilities } : {}),
      ...(source.expected_lifetime === "message" || source.expected_lifetime === "session" || source.expected_lifetime === "pinned" ? { expected_lifetime: source.expected_lifetime } : {}),
      ...(Array.isArray(source.fallback_chain) ? { fallback_chain: source.fallback_chain.filter((item): item is string => item === "built_in_surface" || item === "artifact" || item === "text").slice(0, 3) } : {})
    };
  }
  return output;
}

/** Keep standalone Bundle export account-scoped and renderer-safe. */
export function sanitizeWorkspaceBundleExportInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId.slice(0, 128) } : {}),
    ...(typeof value.expectedWorkspaceVersion === "number" && Number.isSafeInteger(value.expectedWorkspaceVersion)
      ? { expectedWorkspaceVersion: value.expectedWorkspaceVersion }
      : {}),
    ...(typeof value.operationId === "string" ? { operationId: value.operationId.slice(0, 128) } : {})
  };
}

/** Restore references a Server-managed Bundle ID; Bundle bytes never cross the bridge. */
export function sanitizeWorkspaceBundleRestoreInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  return {
    ...(typeof value.bundleId === "string" ? { bundleId: value.bundleId.slice(0, 160) } : {}),
    ...(typeof value.targetWorkspaceId === "string" ? { targetWorkspaceId: value.targetWorkspaceId.slice(0, 128) } : {}),
    ...(typeof value.operationId === "string" ? { operationId: value.operationId.slice(0, 128) } : {})
  };
}

const interactionRequestOpaqueIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const interactionRequestJsonMaxLength = 256 * 1024;

/** Fixed, renderer-safe input for the durable interaction-request list route. */
export function sanitizeWorkspaceInteractionRequestListInput(input: unknown): Record<string, unknown> {
  const value = strictInteractionRequestInputRecord(input);
  return {
    roomId: strictInteractionRequestId(value.roomId, "roomId"),
    includeResolved: value.includeResolved === undefined
      ? false
      : strictInteractionRequestBoolean(value.includeResolved, "includeResolved")
  };
}

/** Fixed, renderer-safe input for the durable interaction-request respond route. */
export function sanitizeWorkspaceInteractionRequestRespondInput(input: unknown): Record<string, unknown> {
  const value = strictInteractionRequestInputRecord(input);
  const output: Record<string, unknown> = {
    roomId: strictInteractionRequestId(value.roomId, "roomId"),
    requestId: strictInteractionRequestId(value.requestId, "requestId"),
    expectedVersion: strictInteractionRequestVersion(value.expectedVersion),
    optionId: strictInteractionRequestId(value.optionId, "optionId"),
    operationId: strictInteractionRequestId(value.operationId, "operationId")
  };
  if (value.values !== undefined) output.values = strictInteractionRequestJsonObject(value.values, "values");
  return output;
}

/** Fixed, renderer-safe input for the durable interaction-request cancel route. */
export function sanitizeWorkspaceInteractionRequestCancelInput(input: unknown): Record<string, unknown> {
  const value = strictInteractionRequestInputRecord(input);
  return {
    roomId: strictInteractionRequestId(value.roomId, "roomId"),
    requestId: strictInteractionRequestId(value.requestId, "requestId"),
    expectedVersion: strictInteractionRequestVersion(value.expectedVersion),
    operationId: strictInteractionRequestId(value.operationId, "operationId")
  };
}

function strictInteractionRequestInputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("workspace_interaction_request_input_invalid");
  return input as Record<string, unknown>;
}

function strictInteractionRequestId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`workspace_interaction_request_${field}_invalid`);
  const normalized = value.trim();
  if (!interactionRequestOpaqueIdPattern.test(normalized)) throw new Error(`workspace_interaction_request_${field}_invalid`);
  return normalized;
}

function strictInteractionRequestVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("workspace_interaction_request_expected_version_invalid");
  return value;
}

function strictInteractionRequestBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`workspace_interaction_request_${field}_invalid`);
  return value;
}

function strictInteractionRequestJsonObject(value: unknown, field: string): Record<string, unknown> {
  if (!isStrictInteractionRequestJsonObject(value, 0)) throw new Error(`workspace_interaction_request_${field}_invalid`);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
  if (encoded.length > interactionRequestJsonMaxLength) throw new Error(`workspace_interaction_request_${field}_invalid`);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`workspace_interaction_request_${field}_invalid`);
  }
}

function isStrictInteractionRequestJsonObject(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 2_000) return false;
  return entries.every(([key, item]) => key.length <= 512 && isStrictInteractionRequestJsonValue(item, depth + 1));
}

function isStrictInteractionRequestJsonValue(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2_000 && value.every((item) => isStrictInteractionRequestJsonValue(item, depth + 1));
  return isStrictInteractionRequestJsonObject(value, depth);
}
