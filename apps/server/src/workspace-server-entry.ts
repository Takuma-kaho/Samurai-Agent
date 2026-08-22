/**
 * Compatibility exports for callers that imported the former PostgreSQL
 * Workspace Server entry module. The standard process entry is `src/index.ts`.
 */
export {
  createWorkspaceServerHttp,
  startWorkspaceServer,
  type WorkspaceServerHttp,
  type WorkspaceServerHttpOptions
} from "./workspace-server/http-server";
