import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCuratorResourceGraph,
  curatorEdgeId,
  curatorLifecycleDecision,
  type CuratorResourceCandidate
} from "../../packages/learning/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-curator-graph-"));
const now = "2026-01-31T00:00:00.000Z";
const store = await WorkspaceStore.create({ rootDir: root });

try {
  const resources: CuratorResourceCandidate[] = [
    candidate("memory", "duplicate-a", "must allow invoice approval finance send"),
    candidate("wiki", "duplicate-b", "must allow invoice approval finance send"),
    candidate("skill", "overlap", "must allow invoice approval finance review"),
    candidate("skill", "conflict", "never allow invoice approval finance send"),
    { ...candidate("surface_pattern", "new-pattern", "new invoice layout"), supersedes: ["old-pattern"], derived_from: ["overlap"] },
    candidate("surface_pattern", "old-pattern", "old invoice layout")
  ];
  const edges = buildCuratorResourceGraph(resources);
  const relations = new Set(edges.map((edge) => edge.relation));
  for (const expected of ["duplicate", "overlaps", "conflicts", "supersedes", "derived_from"]) {
    assert.ok(relations.has(expected as never), `missing ${expected}`);
  }
  for (const edge of edges) {
    await store.saveLearningResourceEdge({ id: curatorEdgeId(edge), ...edge, curator_run_id: "curator-1", created_at: now });
  }
  const persisted = await store.listLearningResourceEdges();
  assert.equal(persisted.length, edges.length);

  const pinned = { ...candidate("skill", "pinned", "pinned"), pinned: true, last_used_at: "2020-01-01T00:00:00.000Z" };
  const stale = { ...candidate("wiki", "stale", "stale"), usage_count: 5, last_used_at: "2025-01-01T00:00:00.000Z" };
  const archive = { ...candidate("memory", "archive", "archive"), source_trust: 0.2, last_used_at: "2020-01-01T00:00:00.000Z" };
  const review = { ...candidate("surface_pattern", "review", "review"), correction_rate: 0.6, last_used_at: "2026-01-30T00:00:00.000Z" };
  assert.equal(curatorLifecycleDecision(pinned, { now, stale_days: 30, archive_days: 90 }).reason, "owner_pinned");
  assert.equal(curatorLifecycleDecision(stale, { now, stale_days: 30, archive_days: 90 }).decision, "stale");
  assert.equal(curatorLifecycleDecision(archive, { now, stale_days: 30, archive_days: 90 }).decision, "archive");
  assert.equal(curatorLifecycleDecision(review, { now, stale_days: 30, archive_days: 90 }).decision, "review");

  const snapshot = await store.createLearningSnapshot("curator-rollback");
  const extra = {
    from_ref: resources[0]!.ref,
    to_ref: resources[4]!.ref,
    relation: "derived_from" as const,
    confidence: 0.5,
    evidence: ["temporary"]
  };
  await store.saveLearningResourceEdge({ id: "temporary-edge", ...extra, curator_run_id: "curator-2", created_at: now });
  assert.equal((await store.listLearningResourceEdges()).length, persisted.length + 1);
  await store.restoreLearningSnapshot(snapshot.id);
  assert.equal((await store.listLearningResourceEdges()).length, persisted.length);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    relations: [...relations].sort(),
    edge_count: persisted.length,
    pinned_protected: true,
    stale_detected: true,
    archive_detected: true,
    correction_review: true,
    snapshot_rollback_exact: true,
    resource_kinds: [...new Set(resources.map((resource) => resource.ref.kind))]
  })}\n`);
} finally {
  await store.close();
  await rm(root, { recursive: true, force: true });
}

function candidate(kind: string, id: string, content: string): CuratorResourceCandidate {
  return {
    ref: { kind: kind as never, id, uri: `${kind}/${id}` },
    content,
    pinned: false,
    usage_count: 0,
    success_rate: 0.8,
    correction_rate: 0,
    last_used_at: "2026-01-30T00:00:00.000Z",
    source_trust: 0.9
  };
}
