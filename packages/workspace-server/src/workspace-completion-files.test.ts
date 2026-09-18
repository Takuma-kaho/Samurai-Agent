import { mkdtemp, mkdir, readFile, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceServerError } from "./errors";
import {
  assertSkillSupportRelativePath,
  completionResourcePath,
  completionSkillSupportPath,
  isWorkspaceCompletionOwnedPath,
  parseWorkspaceCompletionDocument,
  renderWorkspaceCompletionDocument,
  WorkspaceCompletionFileService
} from "./workspace-completion-files";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace completion files", () => {
  it("round-trips a human-readable Knowledge document through a recoverable batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const content = renderWorkspaceCompletionDocument({ id: "knowledge_a", title: "Decision", resourceKind: "knowledge", metadata: { decision: "Use file bodies" }, body: "The file is authoritative." });
    const batch = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [{ path: "knowledge/knowledge_a.md", content }]);
    await files.finalize(batch);
    const restored = await files.read("workspace_a", "knowledge/knowledge_a.md", batch.entries[0]!.sha256);
    expect(parseWorkspaceCompletionDocument(restored)).toEqual({
      id: "knowledge_a", title: "Decision", resourceKind: "knowledge", metadata: { decision: "Use file bodies" }, body: "The file is authoritative."
    });
  });

  it("rejects a path outside the Workspace", () => {
    expect(() => completionResourcePath({ id: "policy_a", kind: "policy", scope: { kind: "room", roomId: "../room" } })).toThrow(WorkspaceServerError);
    try {
      completionResourcePath({ id: "knowledge_a", kind: "knowledge", scope: { kind: "workspace" } });
      throw new Error("expected Workspace Knowledge to be rejected");
    } catch (error) {
      expect(error).toMatchObject({ code: "workspace_memory_removed", status: 409 });
    }
  });

  it("keeps generic Workspace files out of Completion-owned roots", () => {
    expect(isWorkspaceCompletionOwnedPath("knowledge/topic.md")).toBe(true);
    expect(isWorkspaceCompletionOwnedPath("collections/topic/record.md")).toBe(false);
    expect(() => isWorkspaceCompletionOwnedPath("../outside.md")).toThrow(WorkspaceServerError);
  });

  it("accepts only the four Skill support roots enforced by PostgreSQL", () => {
    for (const relativePath of ["references/portable-fixture.md", "scripts/check.sh", "templates/prompt.md", "examples/example.json"]) {
      expect(assertSkillSupportRelativePath(relativePath)).toBe(relativePath);
    }
  });

  it("returns the API validation error before an invalid Skill support path reaches PostgreSQL", () => {
    for (const relativePath of ["assets/icons/skill.bin", "SKILL.md", "references", "../outside.bin"]) {
      expect(() => assertSkillSupportRelativePath(relativePath)).toThrow(WorkspaceServerError);
      try {
        assertSkillSupportRelativePath(relativePath);
      } catch (error) {
        expect(error).toMatchObject({ code: "workspace_completion_skill_support_path_invalid", status: 422 });
      }
    }
  });

  it("keeps a Workspace-common batch independent of any Room", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const batch = await files.stage("workspace_a", { kind: "workspace" }, [{
      path: "profile/PROFILE.md", content: Buffer.from("workspace profile", "utf8")
    }]);
    expect(batch.scope).toEqual({ kind: "workspace" });
    await files.finalize(batch);
    await expect(files.read("workspace_a", "profile/PROFILE.md", batch.entries[0]!.sha256)).resolves.toEqual(Buffer.from("workspace profile", "utf8"));
  });

  it("generates Agent-owned resource and Skill support paths", () => {
    const scope = { kind: "agent" as const, agentId: "agent_a" };
    expect(completionResourcePath({ id: "knowledge_a", kind: "knowledge", scope })).toBe("agents/agent_a/knowledge/knowledge_a.md");
    expect(completionResourcePath({ id: "skill_a", kind: "skill", scope })).toBe("agents/agent_a/skills/skill_a/SKILL.md");
    expect(completionSkillSupportPath({ id: "skill_a", scope, relativePath: "references/guide.md" })).toBe("agents/agent_a/skills/skill_a/references/guide.md");
    expect(isWorkspaceCompletionOwnedPath("agents/agent_a/knowledge/knowledge_a.md")).toBe(true);
  });

  it("stages Agent files only with an exclusive Agent scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const batch = await files.stage("workspace_a", { kind: "agent", agentId: "agent_a" }, [{
      path: "agents/agent_a/knowledge/knowledge_a.md", content: Buffer.from("agent knowledge", "utf8")
    }]);
    expect(batch.scope).toEqual({ kind: "agent", agentId: "agent_a" });
    await expect(files.stage("workspace_a", { kind: "agent", agentId: "agent_a", roomId: "room_a" }, [{
      path: "agents/agent_a/knowledge/other.md", content: Buffer.from("body", "utf8")
    }])).rejects.toMatchObject({ code: "workspace_completion_file_batch_scope_invalid", status: 422 });
  });

  it("rejects an ambiguous Room scope before staging files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    await expect(files.stage("workspace_a", { kind: "room", roomId: "" }, [{
      path: "knowledge/knowledge_a.md", content: Buffer.from("body", "utf8")
    }])).rejects.toMatchObject({ code: "workspace_completion_file_batch_scope_invalid" });
  });

  it("stops on a symlink instead of reading outside the Workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const workspace = path.join(root, "workspaces", "workspace_a", "files");
    await mkdir(workspace, { recursive: true });
    await symlink(os.tmpdir(), path.join(workspace, "knowledge"));
    const files = new WorkspaceCompletionFileService(root);
    await expect(files.inspectPhysicalFile("workspace_a", "knowledge/anything.md")).rejects.toMatchObject({ code: "workspace_completion_file_symlink_forbidden" });
  });

  it("only removes an orphaned migration file when its hash is unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const first = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [{ path: "knowledge/knowledge_a.md", content: Buffer.from("first", "utf8") }]);
    await files.finalize(first);
    const replacement = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [{ path: "knowledge/knowledge_a.md", content: Buffer.from("later human edit", "utf8") }]);
    await files.finalize(replacement);
    await expect(files.removeIfUnchanged("workspace_a", "knowledge/knowledge_a.md", first.entries[0]!.sha256)).resolves.toBe(false);
    await expect(files.removeIfUnchanged("workspace_a", "knowledge/knowledge_a.md", replacement.entries[0]!.sha256)).resolves.toBe(true);
  });

  it("finishes a batch after a restart when a rename stopped halfway", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const batch = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [
      { path: "knowledge/first.md", content: Buffer.from("first", "utf8") },
      { path: "knowledge/second.md", content: Buffer.from("second", "utf8") }
    ]);
    const workspaceFiles = path.join(root, "workspaces", "workspace_a");
    await mkdir(path.join(workspaceFiles, "files", "knowledge"), { recursive: true });
    await rename(
      path.join(workspaceFiles, ".completion-staging", batch.id, "knowledge", "first.md"),
      path.join(workspaceFiles, "files", "knowledge", "first.md")
    );

    const restarted = new WorkspaceCompletionFileService(root);
    await restarted.recover(batch);

    await expect(restarted.read("workspace_a", "knowledge/first.md", batch.entries[0]!.sha256)).resolves.toEqual(Buffer.from("first", "utf8"));
    await expect(restarted.read("workspace_a", "knowledge/second.md", batch.entries[1]!.sha256)).resolves.toEqual(Buffer.from("second", "utf8"));
  });

  it("publishes an import batch exclusively without replacing another body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-completion-"));
    roots.push(root);
    const files = new WorkspaceCompletionFileService(root);
    const first = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [{
      path: "knowledge/knowledge_a.md", content: Buffer.from("first", "utf8")
    }]);
    await files.finalizeExclusive(first);

    const second = await files.stage("workspace_a", { kind: "room", roomId: "room_a" }, [{
      path: "knowledge/knowledge_a.md", content: Buffer.from("second", "utf8")
    }]);
    await expect(files.finalizeExclusive(second)).rejects.toMatchObject({
      code: "workspace_completion_file_path_conflict",
      status: 409
    });
    await expect(files.read("workspace_a", "knowledge/knowledge_a.md", first.entries[0]!.sha256)).resolves.toEqual(Buffer.from("first", "utf8"));
  });
});
