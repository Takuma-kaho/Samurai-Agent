export function sanitizeWorkspaceChatSessionInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["roomId", "operationId", "title", "uiLocale", "outputLocale"]) {
    if (typeof value[key] === "string") output[key] = value[key].slice(0, key === "title" ? 240 : key === "roomId" || key === "operationId" ? 128 : 32);
  }
  return output;
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
