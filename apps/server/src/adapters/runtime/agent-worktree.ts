import { mkdir } from "node:fs/promises";
import path from "node:path";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";

/**
 * External Agent processes receive an explicitly separate worktree.  The
 * Workspace Core root and the worktree must never overlap, because a child
 * process can otherwise bypass Room authorization through ordinary files.
 */
export function assertAgentWorktreeSeparated(agentWorktreeRoot: string, coreWorkspaceRoot?: string): string {
  const resolvedAgentRoot = path.resolve(agentWorktreeRoot.trim());
  if (!resolvedAgentRoot || resolvedAgentRoot === path.parse(resolvedAgentRoot).root) {
    throw new WorkspaceServerError("runtime_agent_worktree_root_invalid", 500);
  }
  if (coreWorkspaceRoot?.trim()) {
    const resolvedCoreRoot = path.resolve(coreWorkspaceRoot.trim());
    if (isWithin(resolvedAgentRoot, resolvedCoreRoot) || isWithin(resolvedCoreRoot, resolvedAgentRoot)) {
      throw new WorkspaceServerError("runtime_agent_worktree_core_overlap", 500);
    }
  }
  return resolvedAgentRoot;
}

export async function ensureAgentWorktree(agentWorktreeRoot: string, coreWorkspaceRoot?: string): Promise<string> {
  const resolved = assertAgentWorktreeSeparated(agentWorktreeRoot, coreWorkspaceRoot);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
