import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const httpSource = await readFile(path.join(here, "http-server.ts"), "utf8");
const commandSource = await readFile(path.join(here, "../../../../packages/workspace-server/src/workspace-server-commands.ts"), "utf8");
const completionSource = await readFile(path.join(here, "../../../../packages/workspace-server/src/workspace-completion-service.ts"), "utf8");

/** Locks the Native App boundary without pretending that a source grep is an
 * RLS test. The live verifier separately exercises these routes' services on
 * PostgreSQL for Hosted and Self-host modes. */
describe("Workspace completion API contract", () => {
  it("exposes Completion only through command/service APIs with stable pagination", () => {
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/resources"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/skills"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/jobs"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/knowledge/search"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/skills/search"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/skills/:resourceId"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/activities/:activityId/evidence"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/episodes/:episodeId/evidence"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/curator/archives"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/policies/requests"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/policies/:policyId"');
    expect(httpSource).toContain('"/api/workspaces/:workspaceId/completion/policies/:policyId/audit"');
    expect(httpSource).toContain("listResourcesPage");
    expect(httpSource).toContain("listSkillsPage");
    expect(httpSource).toContain("listJobsPage");
    expect(httpSource).toContain("searchKnowledgePage");
    expect(httpSource).toContain("searchSkillsPage");
    expect(httpSource).toContain("getSkillDocument");
    expect(httpSource).toContain("listActivityEvidence");
    expect(httpSource).toContain("listEpisodeEvidence");
    expect(httpSource).toContain("listArchivedAiResourcesPage");
    expect(httpSource).toContain("listPolicyChangeRequests");
    expect(httpSource).toContain("getPolicy");
    expect(httpSource).toContain("next_cursor");
    expect(commandSource).toContain("createCompletionResource");
    expect(commandSource).toContain("applyCompletionPolicy");
    expect(commandSource).toContain("redactCompletionResource");
  });

  it("keeps retired Learning writes explicit and prevents maintenance identity HTTP use", () => {
    expect(httpSource).toContain("workspace_learning_legacy_write_retired");
    expect(httpSource).toContain("workspace_completion_maintenance_http_forbidden");
    expect(completionSource).toContain("workspace_completion_secret_content_forbidden");
  });
});
