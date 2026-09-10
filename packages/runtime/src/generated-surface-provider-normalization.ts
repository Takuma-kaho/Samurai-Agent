import { getDomainCommandForProviderToolName } from "@samurai-agent/action-catalog";
import type { JsonValue } from "@samurai-agent/core-schemas";

/**
 * Provider tools use ergonomic names such as `create_artifact`, while a
 * persisted Generated Surface must refer to the canonical Domain Command ID
 * such as `artifact.create`.  Canonicalizing at the provider boundary keeps
 * Surface capability manifests transport-independent and lets later action
 * dispatch rely on the Domain catalog alone.
 *
 * Unknown values deliberately pass through unchanged.  The strict Generated
 * Surface contract remains responsible for rejecting an unknown command or a
 * command that does not accept the `generated_surface` input source.
 */
export function canonicalGeneratedSurfaceProviderCommandId(commandId: string): string {
  return getDomainCommandForProviderToolName(commandId)?.id ?? commandId;
}

/** Preserve malformed action values for the Domain schema to reject; only
 * canonicalize a recognized provider alias in a structurally valid object. */
export function normalizeGeneratedSurfaceProviderAction(value: JsonValue): JsonValue {
  if (!isJsonRecord(value) || typeof value.command_id !== "string") return value;
  return {
    ...value,
    command_id: canonicalGeneratedSurfaceProviderCommandId(value.command_id)
  };
}

/** Normalize the capability list with the exact same mapping as its actions. */
export function normalizeGeneratedSurfaceProviderAllowedCommands(value: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(value)) return value;
  return value.map((commandId) => typeof commandId === "string"
    ? canonicalGeneratedSurfaceProviderCommandId(commandId)
    : commandId);
}

/**
 * Normalize all command references carried by a provider-facing Generated
 * Surface tool call. This is shared by the in-memory Runtime and PostgreSQL
 * Runtime ingress so the persisted Surface contract does not depend on which
 * execution path received the provider event.
 */
export function normalizeGeneratedSurfaceProviderToolArguments(
  argumentsValue: Record<string, JsonValue>
): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = { ...argumentsValue };
  const request = jsonRecord(argumentsValue.request);
  if (request && Object.hasOwn(request, "allowed_domain_commands")) {
    const allowedCommands = normalizeGeneratedSurfaceProviderAllowedCommands(request.allowed_domain_commands);
    if (allowedCommands !== undefined) {
      normalized.request = {
        ...request,
        allowed_domain_commands: allowedCommands
      };
    }
  }

  const bundle = jsonRecord(argumentsValue.bundle);
  if (bundle && Array.isArray(bundle.actions)) {
    normalized.bundle = {
      ...bundle,
      actions: bundle.actions.map(normalizeGeneratedSurfaceProviderAction)
    };
  } else if (Array.isArray(argumentsValue.actions)) {
    normalized.actions = argumentsValue.actions.map(normalizeGeneratedSurfaceProviderAction);
  }
  return normalized;
}

function isJsonRecord(value: JsonValue): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== undefined && isJsonRecord(value) ? value : undefined;
}
