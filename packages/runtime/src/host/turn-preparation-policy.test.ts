import { describe, expect, it } from "vitest";
import type { ContextPreview, GatewayBoundaryPolicy } from "@samurai-agent/core-schemas";
import { buildHostContextAssembly } from "../context/context-assembly.js";
import {
  applyGatewayBoundaryAllowedTools,
  applyGatewayBoundaryToContextAssembly,
  buildContextHandoffForBackend,
  contextHandoffRuntimeMetadata,
  expectedBackendOutputs,
  gatewayBoundaryRuntimeMetadata,
  gatewayBoundaryRuntimeSnapshot
} from "./turn-preparation-policy.js";

const timestamp = "2026-01-01T00:00:00.000Z";

const policy: GatewayBoundaryPolicy = {
  id: "policy-1",
  source_channel: "web",
  source_identity: "user-1",
  session_key: "session-key",
  allowed_tools: ["workspace.read"],
  mcp_config_refs: [{
    id: "mcp-1",
    server_name: "calendar",
    config_ref: { kind: "file", id: "mcp-config", uri: "mcp/calendar.json" },
    allowed_tools: ["calendar.list"],
    secret_refs: [{ id: "secret-mcp", source: "env", provider: "calendar", key: "CALENDAR_TOKEN" }]
  }],
  secret_refs: [{ id: "secret-direct", source: "keychain", provider: "workspace", key: "WORKSPACE_TOKEN" }],
  sandbox: {
    mode: "non_main",
    scope: "session",
    backend: "docker",
    workspace_access: "read_write",
    network_access: "localhost",
    allowed_paths: [{ root: "workspace", access: "read_write" }],
    denied_paths: [".env"],
    timeout_ms: 30_000,
    metadata: { profile: "safe" }
  },
  path_normalization: {
    canonical_root: "workspace",
    reject_absolute_paths: true,
    reject_parent_segments: true,
    allowed_roots: ["workspace"],
    denied_roots: ["secrets"]
  },
  allowlist: ["workspace"],
  timeout_ms: 60_000,
  concurrency_lock: { scope: "session", key: "session-key", ttl_ms: 10_000 },
  metadata: { origin: "fixture" },
  created_at: timestamp,
  updated_at: timestamp
};

function preview(query = "短い質問") {
  return {
    session_id: "session-1",
    query,
    context_assembly: buildHostContextAssembly({
      sessionId: "session-1",
      query,
      sessionFound: true,
      messageCount: 1,
      recentMessageCount: 1,
      freezeSnapshotPresent: false,
      activeMemoryCandidateCount: 0,
      activeMemoryCount: 0,
      knowledgeWikiCandidateCount: 0,
      knowledgeWikiIncludedCount: 0,
      collectionNoteCandidateCount: 1,
      collectionNoteIncludedCount: 1,
      selectedSkillCount: 0,
      sessionSearchCandidateCount: 0,
      sessionSearchIncludedCount: 0,
      externalAssistRole: "disabled",
      externalAssistHintCount: 0,
      externalAssistFailureCount: 0,
      availableToolCount: 3
    }),
    session_summary: {
      session_key: "main",
      title: "作業セッション",
      ui_locale: "ja",
      output_locale: "ja",
      message_count: 1,
      operation_count: 0,
      backend_run_count: 0,
      tool_run_count: 0,
      workspace_change_count: 0
    },
    external_assist: { role: "disabled", isolated_from_memory: true, included_in_active_memory: false, note: "disabled", hints: [], recent_failures: [] },
    active_memory: [],
    active_memory_report: {} as ContextPreview["active_memory_report"],
    knowledge_wiki: [],
    knowledge_wiki_report: {} as ContextPreview["knowledge_wiki_report"],
    collection_notes: [{ collection_id: "collection-1", file_path: "collections/notes.md", content: "note", role: "context_only" }],
    skill_selection_report: {} as ContextPreview["skill_selection_report"],
    selected_skills: [],
    session_search: [],
    recent_messages: [],
    available_tools: ["workspace.read", "workspace.write", "artifact.create"]
  } as ContextPreview;
}

describe("turn preparation policy", () => {
  it("keeps output intent parity and excludes file/path requests from artifacts", () => {
    expect(expectedBackendOutputs("議事録を作って")).toContain("artifact");
    expect(expectedBackendOutputs("議事録をファイルに保存して")).not.toContain("artifact");
    expect(expectedBackendOutputs("plans/notes.md を作って")).not.toContain("artifact");
  });

  it("preserves wildcard tools and the complete Gateway runtime snapshot", () => {
    expect(applyGatewayBoundaryAllowedTools(["a", "b"], { ...policy, allowed_tools: ["*"] })).toEqual(["a", "b"]);
    const snapshot = gatewayBoundaryRuntimeSnapshot(policy, "2026-02-01T00:00:00.000Z");
    expect(snapshot).toMatchObject({
      policy_id: "policy-1",
      source_channel: "web",
      source_identity: "user-1",
      session_key: "session-key",
      allowed_tools: ["workspace.read"],
      secret_ref_ids: ["secret-direct", "secret-mcp"],
      sandbox: policy.sandbox,
      path_normalization: policy.path_normalization,
      allowlist: ["workspace"],
      timeout_ms: 60_000,
      concurrency_lock: policy.concurrency_lock,
      created_at: "2026-02-01T00:00:00.000Z"
    });
    expect(snapshot.mcp_config_refs[0]).toMatchObject({ id: "mcp-1", secret_ref_ids: ["secret-mcp"] });
    expect(gatewayBoundaryRuntimeMetadata(snapshot)).toMatchObject({
      gateway_boundary_sandbox_mode: "non_main",
      gateway_boundary_sandbox_backend: "docker",
      gateway_boundary_workspace_access: "read_write",
      gateway_boundary_network_access: "localhost",
      gateway_boundary_secret_ref_ids: ["secret-direct", "secret-mcp"],
      gateway_boundary_mcp_config_ref_ids: ["mcp-1"],
      gateway_boundary_concurrency_lock_key: "session-key"
    });
  });

  it("keeps exact assembly status, reason, omission, and quality evidence", () => {
    const base = preview().context_assembly;
    const assembled = applyGatewayBoundaryToContextAssembly(base, gatewayBoundaryRuntimeSnapshot(policy, timestamp), ["a", "b", "c"], ["a"]);
    expect(assembled.sources.find((source) => source.kind === "available_tools")).toMatchObject({ status: "filtered", candidate_count: 3, included_count: 1, reason: "Gateway boundary policy filtered the workspace tool catalog." });
    expect(assembled.sources.find((source) => source.kind === "gateway_boundary")).toMatchObject({ status: "included", reason: "Gateway boundary runtime snapshot is attached to this backend run." });
    expect(assembled.omissions).toContainEqual({ kind: "available_tools", count: 2, reason: "Gateway boundary policy removed tools not allowed for this source." });
    expect(assembled.quality_checks).toContainEqual({ id: "gateway_boundary_applied", status: "pass", detail: "Gateway boundary filtered 2 tool(s)." });
  });

  it("keeps handoff refs, session title, warning threshold, and metadata", () => {
    const contextPreview = preview();
    const handoff = buildContextHandoffForBackend({
      backendKind: "codex",
      contextIntent: "contextual_chat",
      contextPreview,
      contextAssembly: contextPreview.context_assembly,
      gatewayBoundaryPresent: false
    });
    const collectionSource = handoff.sources.find((source) => source.kind === "collection_notes");
    const sessionSource = handoff.sources.find((source) => source.kind === "session");
    expect(collectionSource?.refs[0]).toMatchObject({ kind: "file", uri: "collections/notes.md", label: "collections/notes.md" });
    expect(sessionSource?.refs[0]).toMatchObject({ kind: "session", label: "作業セッション" });
    expect(handoff.prompt_size_warning).toBeUndefined();
    expect(contextHandoffRuntimeMetadata(handoff)).toMatchObject({ context_handoff_version: 1, context_handoff_strategy: "pointer_first" });

    const largeHandoff = buildContextHandoffForBackend({
      backendKind: "codex",
      contextIntent: "contextual_chat",
      contextPreview: preview("x".repeat(16_100)),
      contextAssembly: contextPreview.context_assembly,
      gatewayBoundaryPresent: false
    });
    expect(largeHandoff.prompt_size_warning).toMatch(/Context handoff is/);
  });
});
