import type { AgentBackendKind, ContextHandoff, ContextPreview, GatewayBoundaryPolicy, GatewayBoundaryRuntimeSnapshot, HostContextAssembly, JsonValue, ResourceRef } from "@samurai-agent/core-schemas";
import { stableHash } from "@samurai-agent/core-schemas";
import { contextAssemblySource, contextAssemblyStatus } from "../context/context-assembly.js";
import { fileRef } from "../context/resource-refs.js";

export type BackendContextIntent = "light_chat" | "contextual_chat" | "workspace_task";
export type BackendExpectedOutput = "artifact" | "collection_schema" | "collection_view" | "generated_surface";

export function classifyBackendContextIntent(query: string): BackendContextIntent {
  const trimmed = query.trim();
  const normalized = trimmed.replace(/[！!。.,、\s]/g, "").toLowerCase();
  if (!normalized) return "light_chat";
  if (/続き|前回|さっき|以前|この前|覚えて|思い出|探して|検索|履歴|history|session|remember|previous|last time/i.test(trimmed)) return "contextual_chat";
  if (/作って|作成|編集|修正|実装|調査|確認|レビュー|テスト|ビルド|実行|保存|更新|追加|削除|まとめて|書いて|生成|deploy|build|test|fix|implement|review|create|update|delete|search/i.test(trimmed)) return "workspace_task";
  if (new Set(["こんにちは", "こんばんは", "おはよう", "おはようございます", "ありがとう", "ありがとうございます", "了解", "ok", "okay", "hi", "hello", "hey", "thanks", "thankyou"]).has(normalized) || trimmed.length <= 8) return "light_chat";
  return trimmed.length >= 24 ? "workspace_task" : "contextual_chat";
}

export function expectedBackendOutputs(query: string): BackendExpectedOutput[] {
  const outputs: BackendExpectedOutput[] = [];
  if (shouldCreateGeneratedSurfaceOutput(query)) outputs.push("generated_surface");
  if (shouldCreateArtifactOutput(query)) outputs.push("artifact");
  if (shouldCreateCollectionSchemaOutput(query)) outputs.push("collection_schema");
  return outputs;
}

function shouldCreateGeneratedSurfaceOutput(query: string): boolean {
  const trimmed = query.trim();
  return Boolean(trimmed) && /独自\s*UI|独自画面|カスタム\s*UI|HTML(?:\s*表示|(?:を|で)?\s*生成)|generated\s*UI|custom\s*UI|custom\s*html|renders?\s+(?:this|it)\s+as\s+(?:custom|html)/i.test(trimmed);
}
function shouldCreateArtifactOutput(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || /実装|修正|編集|コード|テスト|ビルド|デプロイ|commit|branch|pr|pull request|fix|implement|test|build|deploy|code/i.test(trimmed)) return false;
  if (/ファイル|保存|書き込|追加先|保存先|path|plans\/|\.md\b|markdown\s+file|save\s+as|write\s+(a\s+)?file/i.test(trimmed)) return false;
  return /作って|作成|書いて|まとめて|生成|下書き|ドラフト|create|write|draft|generate/i.test(trimmed) && /作業メモ|メモ|議事録|下書き|ドラフト|提案書|企画書|レポート|報告書|資料|ドキュメント|文章|メール文|表|一覧|memo|note|minutes|draft|proposal|report|document|table|email/i.test(trimmed);
}
function shouldCreateCollectionSchemaOutput(query: string): boolean {
  const trimmed = query.trim();
  return Boolean(trimmed) && /作って|作成|作る|create|make|build|crear|criar|créer|creer|erstellen|machen|만들|생성|创建|建立|創建/i.test(trimmed) && /アプリ|コレクション|ログ|collection|app|application|log|tracker|aplicación|aplicacion|aplicação|aplicacao|appli|anwendung|앱|컬렉션|로그|기록|应用|應用|集合|日志|日誌|记录|紀錄/i.test(trimmed);
}

export function shouldThinExternalBackendContext(kind: AgentBackendKind, intent: BackendContextIntent): boolean {
  return intent === "light_chat" && (kind === "claude_code" || kind === "codex" || kind === "external");
}

export function applyGatewayBoundaryAllowedTools(availableTools: string[], policy: GatewayBoundaryPolicy | undefined): string[] {
  if (!policy) {
    return availableTools;
  }
  if (policy.allowed_tools.includes("*")) {
    return availableTools;
  }
  if (policy.allowed_tools.length === 0) {
    return [];
  }
  const allowed = new Set(policy.allowed_tools);
  return availableTools.filter((tool) => allowed.has(tool));
}

export function gatewayBoundaryRuntimeSnapshot(policy: GatewayBoundaryPolicy, createdAt: string): GatewayBoundaryRuntimeSnapshot {
  const secretRefIds = new Set<string>();
  for (const ref of policy.secret_refs) secretRefIds.add(ref.id);
  for (const mcp of policy.mcp_config_refs) {
    for (const ref of mcp.secret_refs) {
      secretRefIds.add(ref.id);
    }
  }
  return {
    policy_id: policy.id,
    source_channel: policy.source_channel,
    source_identity: policy.source_identity,
    session_key: policy.session_key,
    allowed_tools: policy.allowed_tools,
    mcp_config_refs: policy.mcp_config_refs.map((ref) => ({
      id: ref.id,
      server_name: ref.server_name,
      config_ref: ref.config_ref,
      allowed_tools: ref.allowed_tools,
      secret_ref_ids: ref.secret_refs.map((secretRef) => secretRef.id)
    })),
    secret_ref_ids: [...secretRefIds],
    sandbox: policy.sandbox,
    path_normalization: policy.path_normalization,
    allowlist: policy.allowlist,
    timeout_ms: policy.timeout_ms,
    concurrency_lock: policy.concurrency_lock,
    created_at: createdAt
  };
}
export function gatewayBoundaryRuntimeMetadata(snapshot: GatewayBoundaryRuntimeSnapshot): Record<string, JsonValue> {
  return {
    gateway_boundary_policy_id: snapshot.policy_id,
    gateway_boundary_source_channel: snapshot.source_channel,
    gateway_boundary_source_identity: snapshot.source_identity ?? null,
    gateway_boundary_allowed_tools: snapshot.allowed_tools,
    gateway_boundary_sandbox_mode: snapshot.sandbox.mode,
    gateway_boundary_sandbox_backend: snapshot.sandbox.backend,
    gateway_boundary_workspace_access: snapshot.sandbox.workspace_access,
    gateway_boundary_network_access: snapshot.sandbox.network_access,
    gateway_boundary_secret_ref_ids: snapshot.secret_ref_ids,
    gateway_boundary_mcp_config_ref_ids: snapshot.mcp_config_refs.map((ref) => ref.id),
    gateway_boundary_concurrency_lock_key: snapshot.concurrency_lock?.key ?? null
  };
}

export function applyGatewayBoundaryToContextAssembly(assembly: HostContextAssembly, boundary: GatewayBoundaryRuntimeSnapshot | undefined, before: string[], after: string[]): HostContextAssembly {
  if (!boundary) {
    return assembly;
  }
  const beforeCount = before.length;
  const afterCount = after.length;
  const filteredCount = Math.max(0, beforeCount - afterCount);
  const sources = assembly.sources.map((source) => {
    if (source.kind === "available_tools") {
      return contextAssemblySource(
        "available_tools",
        filteredCount > 0 ? "filtered" : contextAssemblyStatus(beforeCount, afterCount),
        beforeCount,
        afterCount,
        filteredCount > 0
          ? "Gateway boundary policy filtered the workspace tool catalog."
          : "Gateway boundary policy allowed the available workspace tools."
      );
    }
    if (source.kind === "gateway_boundary") {
      return contextAssemblySource(
        "gateway_boundary",
        "included",
        1,
        1,
        "Gateway boundary runtime snapshot is attached to this backend run."
      );
    }
    return source;
  });
  const omissions = filteredCount > 0
    ? [
        ...assembly.omissions,
        {
          kind: "available_tools" as const,
          count: filteredCount,
          reason: "Gateway boundary policy removed tools not allowed for this source."
        }
      ]
    : assembly.omissions;
  const gatewayBoundary: HostContextAssembly["gateway_boundary"] = {
    present: true,
    policy_id: boundary.policy_id,
    source_channel: boundary.source_channel,
    ...(boundary.source_identity ? { source_identity: boundary.source_identity } : {}),
    allowed_tools_count: boundary.allowed_tools.length,
    available_tools_before_boundary: beforeCount,
    available_tools_after_boundary: afterCount,
    filtered_tool_count: filteredCount,
    reason: filteredCount > 0
      ? "Gateway boundary restricted available tools for this run."
      : "Gateway boundary did not remove any available tool for this run."
  };
  return {
    ...assembly,
    sources,
    omissions,
    gateway_boundary: gatewayBoundary,
    quality_checks: [
      ...assembly.quality_checks,
      {
        id: "gateway_boundary_applied",
        status: "pass",
        detail: filteredCount > 0
          ? `Gateway boundary filtered ${filteredCount} tool(s).`
          : "Gateway boundary was attached and required no tool filtering."
      }
    ]
  };
}

export function contextAssemblyRuntimeMetadata(assembly: HostContextAssembly): Record<string, JsonValue> {
  return {
    context_assembly_version: assembly.version,
    context_assembly_sources: assembly.sources.map((source) => ({
      kind: source.kind,
      status: source.status,
      candidate_count: source.candidate_count,
      included_count: source.included_count
    })),
    context_assembly_gateway_boundary_present: assembly.gateway_boundary.present,
    context_assembly_filtered_tool_count: assembly.gateway_boundary.filtered_tool_count,
    context_assembly_quality_warnings: assembly.quality_checks
      .filter((check) => check.status !== "pass")
      .map((check) => ({ id: check.id, status: check.status, detail: check.detail }))
  };
}

export function buildContextHandoffForBackend(input: {
  backendKind: AgentBackendKind;
  contextIntent: BackendContextIntent;
  contextPreview: ContextPreview;
  contextAssembly: HostContextAssembly;
  gatewayBoundaryPresent: boolean;
}): ContextHandoff {
  const pointerFirst = input.backendKind === "claude_code" || input.backendKind === "codex" || input.backendKind === "external";
  const sourceByKind = new Map(input.contextAssembly.sources.map((source) => [source.kind, source]));
  const modeFor = (kind: HostContextAssembly["sources"][number]["kind"], includedCount: number): ContextHandoff["sources"][number]["mode"] => {
    const source = sourceByKind.get(kind);
    if (!source || source.status === "skipped" || includedCount === 0) {
      return "skipped";
    }
    if (!pointerFirst) {
      return "inline";
    }
    return kind === "session" || kind === "recent_messages" ? "inline" : "pointer";
  };
  const refsFor = (kind: HostContextAssembly["sources"][number]["kind"]): ResourceRef[] => {
    switch (kind) {
      case "freeze_snapshot":
        return [
          input.contextPreview.freeze_snapshot?.soul.file_ref,
          input.contextPreview.freeze_snapshot?.profile?.file_ref,
          ...(input.contextPreview.freeze_snapshot?.memory_refs ?? []),
          ...(input.contextPreview.freeze_snapshot?.skill_refs ?? []),
          ...(input.contextPreview.freeze_snapshot?.wiki_refs ?? [])
        ].filter((ref): ref is ResourceRef => Boolean(ref));
      case "active_memory":
        return input.contextPreview.active_memory.map((memory) => ({
          kind: "memory",
          id: memory.id,
          uri: `memory/${memory.state}/${memory.id}.md`,
          label: memory.topic
        }));
      case "knowledge_wiki":
        return input.contextPreview.knowledge_wiki.map((wiki) => ({
          kind: "wiki",
          id: wiki.id,
          uri: `wiki/${wiki.slug}.md`,
          label: wiki.title
        }));
      case "collection_notes":
        return input.contextPreview.collection_notes.map((note) => fileRef(note.file_path));
      case "selected_skills":
        return input.contextPreview.selected_skills.flatMap((skill) => [
          {
            kind: "skill",
            id: skill.id,
            uri: `skills/${skill.id}/SKILL.md`,
            label: skill.title
          },
          ...(skill.support_file_refs ?? []).map((file) => ({
            kind: "skill_support_file",
            id: `${skill.id}:${file.path}`,
            uri: file.file_path,
            label: file.path
          }))
        ]);
      case "session_search":
        return input.contextPreview.session_search.map((result) => ({
          kind: result.kind,
          id: result.id,
          uri: `session-search/${result.kind}/${result.id}`,
          label: result.title
        }));
      case "external_assist":
        return input.contextPreview.external_assist.hints.map((hint) => ({
          kind: "external_assist",
          id: hint.id,
          uri: hint.source_uri ?? `external-assist/${hint.id}`,
          label: hint.title ?? hint.summary
        }));
      case "recent_messages":
        return input.contextPreview.recent_messages.map((message) => ({
          kind: "message",
          id: message.id,
          uri: `session/${input.contextPreview.session_id}/messages/${message.id}`,
          label: message.role
        }));
      case "available_tools":
        return input.contextPreview.available_tools.map((tool) => ({
          kind: "tool",
          id: stableHash(tool),
          uri: `tool/${tool}`,
          label: tool
        }));
      case "gateway_boundary":
        return input.gatewayBoundaryPresent
          ? [{
              kind: "gateway_boundary",
              id: input.contextPreview.session_id,
              uri: `session/${input.contextPreview.session_id}/gateway-boundary`,
              label: "Gateway Boundary"
            }]
          : [];
      case "session":
        return [{
          kind: "session",
          id: input.contextPreview.session_id,
          uri: `session/${input.contextPreview.session_id}`,
          label: input.contextPreview.session_summary.title
        }];
      default:
        return [];
    }
  };
  const sources = input.contextAssembly.sources.map((source) => {
    const refs = refsFor(source.kind);
    return {
      kind: source.kind,
      mode: modeFor(source.kind, source.included_count),
      candidate_count: source.candidate_count,
      included_count: source.included_count,
      reason: source.reason,
      refs
    };
  });
  const estimatedSize = JSON.stringify({
    query: input.contextPreview.query,
    sources: sources.map((source) => ({
      kind: source.kind,
      mode: source.mode,
      refs: source.refs.map((ref) => ref.uri)
    }))
  }).length;
  return {
    version: 1,
    strategy: pointerFirst ? "pointer_first" : "inline_context",
    sources,
    ...(estimatedSize > 16_000 ? { prompt_size_warning: `Context handoff is ${estimatedSize} characters before backend prompt formatting.` } : {})
  };
}

export function contextHandoffRuntimeMetadata(handoff: ContextHandoff): Record<string, JsonValue> {
  return {
    context_handoff_version: handoff.version,
    context_handoff_strategy: handoff.strategy,
    context_handoff_sources: handoff.sources.map((source) => ({
      kind: source.kind,
      mode: source.mode,
      candidate_count: source.candidate_count,
      included_count: source.included_count,
      ref_count: source.refs.length,
      reason: source.reason
    })),
    ...(handoff.prompt_size_warning ? { context_handoff_prompt_size_warning: handoff.prompt_size_warning } : {})
  };
}
