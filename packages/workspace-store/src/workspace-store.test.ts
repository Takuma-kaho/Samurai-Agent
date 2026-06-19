import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso, type PolicyDecisionRecord, type SessionRecord } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "./index";

const roots: string[] = [];

async function createTempStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-store-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace store", () => {
  it("creates settings and persists sessions", async () => {
    const store = await createTempStore();
    const settings = await store.getSettings();
    const now = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      session_key: "web:owner:main",
      title: "Store test",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: now,
      updated_at: now
    };

    await store.createSession(session);
    const sessions = await store.listSessions();
    await store.close();

    expect(sessions[0]?.title).toBe("Store test");
  });

  it("writes artifact content to filesystem", async () => {
    const store = await createTempStore();
    const artifactId = createId("artifact");
    await store.writeArtifactContent(artifactId, "# Hello");
    await store.close();

    expect(artifactId.startsWith("artifact_")).toBe(true);
  });

  it("returns saved policy decisions by id", async () => {
    const store = await createTempStore();
    const now = nowIso();
    const decision: PolicyDecisionRecord = {
      id: createId("policy"),
      operation_id: createId("operation"),
      capability_id: "proposal_workspace",
      operation: "external.send",
      decision: "requires_approval",
      reason: "Needs approval.",
      policy_inputs: {
        capability_id: "proposal_workspace",
        operation: "external.send",
        actor_identity: "owner",
        instruction_source: "owner_instruction",
        instruction_authority: "owner",
        channel: "web",
        target_resource_refs: [],
        proposed_effects: ["Prepare an outbound action."],
        prior_grants: [],
        recent_history: [],
        input_hash: "abc123"
      },
      matched_rules: ["manifest_default:requires_approval"],
      required_approval_level: "approval",
      created_at: now
    };

    await store.savePolicyDecision(decision);
    const saved = await store.getPolicyDecision(decision.id);
    const missing = await store.getPolicyDecision("policy_missing");
    await store.close();

    expect(saved?.id).toBe(decision.id);
    expect(missing).toBeUndefined();
  });
});
