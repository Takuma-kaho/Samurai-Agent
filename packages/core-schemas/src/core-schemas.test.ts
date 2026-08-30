import { describe, expect, it } from "vitest";
import {
  BackendEventRecordSchema,
  BackendReleaseReadinessHealthSchema,
  ChangeHistoryEntrySchema,
  ClientEventRecordSchema,
  ContextFreezeResponseSchema,
  ContextPreviewSchema,
  CuratorLifecycleReportSchema,
  CuratorReviewReportSchema,
  CuratorStateRecordSchema,
  DomainCommandCatalogDiagnosticsReportSchema,
  EvaluationDiagnosticsReportSchema,
  EvaluationTraceReportSchema,
  ExternalAssistDiagnosticsReportSchema,
  ExternalAssistProviderConfigDiagnosticsSchema,
  ExternalSendDiagnosticsReportSchema,
  FileBrowserActionDiagnosticsReportSchema,
  GatewayBoundaryPolicySchema,
  GatewayInboundMessageRecordSchema,
  GatewayDiagnosticsReportSchema,
  GatewayMcpConfigRecordSchema,
  GatewayMcpConfigSummarySchema,
  GatewayBoundaryRuntimeSnapshotSchema,
  GatewayPairingPolicyRecordSchema,
  GatewayPairingRecordSchema,
  GatewayRoutingPolicyRecordSchema,
  KnowledgeWikiDiagnosticsReportSchema,
  MessageEnvelopeSchema,
  OperationRecordSchema,
  PluginDiagnosticsReportSchema,
  ReflectionDiagnosticsReportSchema,
  ResourceTranslationRecordSchema,
  RunHistoryEntrySchema,
  SecretRefSchema,
  SettingsResponseSchema,
  SkillDiagnosticsReportSchema,
  SkillIndexEntryReadModelSchema,
  SkillUsageRecordSchema,
  ToolRunDiagnosticsReportSchema,
  createId,
  nowIso,
  stableDigest,
  stableHash
} from "./index";

describe("core schemas", () => {
  it("provides a wider digest for durable identity checks", () => {
    expect(stableDigest({ value: 1 })).toMatch(/^[a-f0-9]{32}$/);
    expect(stableDigest({ value: 1 })).not.toBe(stableDigest({ value: 2 }));
  });
  it("parses locale-aware message envelopes", () => {
    const envelope = MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      user_intent: "提案書を作って",
      attachments: [],
      input_locale: "ja",
      output_locale: "en",
      metadata: {},
      received_at: nowIso()
    });

    expect(envelope.input_locale).toBe("ja");
    expect(envelope.output_locale).toBe("en");

    const mobileEnvelope = MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: "mobile",
      actor_identity: "paired_contact",
      session_key: "mobile:mobile-user~3Auser-1:conversation~3Aconv-1",
      user_intent: "外出先から依頼する",
      attachments: [],
      input_locale: "ja",
      output_locale: "ja",
      metadata: {},
      received_at: nowIso()
    });

    expect(mobileEnvelope.source).toBe("mobile");
  });

  it("parses backend stream lifecycle events", () => {
    const event = BackendEventRecordSchema.parse({
      id: createId("event"),
      run_id: createId("run"),
      session_id: createId("session"),
      event_type: "backend_stream_synced",
      sequence: 1,
      payload: {
        reason: "stream_sync_completed",
        observed_event_count: 3,
        persisted_event_count: 3
      },
      resource_refs: [],
      created_at: nowIso()
    });

    expect(event.event_type).toBe("backend_stream_synced");
  });

  it("requires the execution fields for each typed backend event kind", () => {
    const base = {
      id: createId("event"),
      run_id: createId("run"),
      session_id: createId("session"),
      sequence: 1,
      resource_refs: [],
      created_at: nowIso()
    };

    expect(BackendEventRecordSchema.safeParse({ ...base, event_type: "text_delta", payload: { reason: "missing text" } }).success).toBe(false);
    expect(BackendEventRecordSchema.safeParse({ ...base, event_type: "tool_call_started", payload: { provider_tool_name: "Read" } }).success).toBe(false);
    expect(BackendEventRecordSchema.safeParse({ ...base, event_type: "backend_native_input_submitted", payload: { submitted_at: nowIso(), has_input: true, input: "secret" } }).success).toBe(false);
    expect(BackendEventRecordSchema.safeParse({ ...base, event_type: "run_completed", payload: { terminal_evidence: { kind: "completed", source: "canonical_event" } } }).success).toBe(true);
  });

  it("parses client event queue records", () => {
    const event = ClientEventRecordSchema.parse({
      id: createId("client_event"),
      target_client_kind: "desktop",
      event_type: "client.notification.requested",
      status: "pending",
      payload: {
        title: "Runが完了しました",
        deep_link: "samurai://run/run_test"
      },
      resource_refs: [{
        kind: "backend_run",
        id: "run_test",
        uri: "backend-runs/run_test"
      }],
      created_at: nowIso(),
      expires_at: nowIso()
    });

    expect(event.status).toBe("pending");
    expect(event.resource_refs[0]?.kind).toBe("backend_run");
  });

  it("keeps resource translations as derived records", () => {
    const now = nowIso();
    const translation = ResourceTranslationRecordSchema.parse({
      id: createId("translation"),
      source_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/artifact_1.md" },
      source_locale: "ja",
      target_locale: "en",
      status: "draft",
      original_hash: "hash_original",
      translated_text: "Translated text",
      created_at: now,
      updated_at: now
    });

    expect(translation.source_locale).toBe("ja");
    expect(translation.target_locale).toBe("en");
    expect(translation.status).toBe("draft");
  });

  it("keeps operation records parseable for approval replay", () => {
    const now = nowIso();
    const operation = OperationRecordSchema.parse({
      id: createId("operation"),
      session_id: createId("session"),
      capability_id: "proposal_workspace",
      operation: "artifact.create",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      input_hash: stableHash({ ok: true }),
      target_resource_refs: [],
      proposed_effects: ["Create draft"],
      status: "created",
      created_at: now,
      updated_at: now
    });

    expect(operation.operation).toBe("artifact.create");
  });

  it("keeps gateway boundary policies explicit about sandbox, tools, and locks", () => {
    const now = nowIso();
    const boundary = GatewayBoundaryPolicySchema.parse({
      id: createId("gateway_boundary"),
      source_channel: "webhook",
      source_identity: "calendar-hook",
      session_key: "webhook:calendar-hook:main",
      allowed_tools: ["collection.record.create"],
      mcp_config_refs: [],
      secret_refs: [
        {
          id: createId("secret_ref"),
          source: "env",
          provider: "default",
          key: "CALENDAR_TOKEN",
          label: "Calendar token"
        }
      ],
      sandbox: {
        mode: "non_main",
        scope: "session",
        backend: "none",
        workspace_access: "none",
        network_access: "none",
        allowed_paths: [],
        denied_paths: ["system"],
        metadata: {}
      },
      path_normalization: {
        canonical_root: "workspace",
        reject_absolute_paths: true,
        reject_parent_segments: true,
        allowed_roots: ["workspace"],
        denied_roots: ["system"]
      },
      allowlist: ["webhook:calendar-hook"],
      concurrency_lock: {
        scope: "session",
        key: "webhook:calendar-hook:main",
        ttl_ms: 60_000
      },
      metadata: {},
      created_at: now,
      updated_at: now
    });

    expect(boundary.sandbox.mode).toBe("non_main");
    expect(boundary.secret_refs[0]?.key).toBe("CALENDAR_TOKEN");
    expect(boundary.concurrency_lock?.scope).toBe("session");
  });

  it("rejects raw secret values in SecretRef records", () => {
    expect(() =>
      SecretRefSchema.parse({
        id: createId("secret_ref"),
        source: "env",
        provider: "default",
        key: "API_TOKEN",
        value: "raw-token"
      })
    ).toThrow();
  });

  it("parses MCP config records while exposing only secret ids in summaries", () => {
    const now = nowIso();
    const config = GatewayMcpConfigRecordSchema.parse({
      id: createId("gateway_mcp"),
      server_name: "calendar",
      transport: "stdio",
      enabled: true,
      allowed_tools: ["calendar.read"],
      secret_refs: [
        {
          id: "secret_calendar",
          source: "env",
          provider: "calendar",
          key: "CALENDAR_TOKEN"
        }
      ],
      stdio: {
        command: "node",
        args: ["calendar-mcp.js"],
        env: {},
        secret_env: { CALENDAR_TOKEN: "secret_calendar" },
        secret_files: [],
        framing: "json_lines",
        initialize: true
      },
      metadata: {},
      created_at: now,
      updated_at: now
    });
    const summary = GatewayMcpConfigSummarySchema.parse({
      id: config.id,
      server_name: config.server_name,
      transport: config.transport,
      enabled: config.enabled,
      allowed_tools: config.allowed_tools,
      secret_ref_ids: config.secret_refs.map((ref) => ref.id),
      has_stdio: true,
      has_http: false,
      metadata: {},
      created_at: now,
      updated_at: now
    });

    expect(config.secret_refs[0]?.key).toBe("CALENDAR_TOKEN");
    expect(JSON.stringify(summary)).toContain("secret_calendar");
    expect(JSON.stringify(summary)).not.toContain("CALENDAR_TOKEN");
    expect(() =>
      GatewayMcpConfigRecordSchema.parse({
        ...config,
        value: "raw-secret"
      })
    ).toThrow();
  });

  it("keeps gateway runtime snapshots free of secret lookup keys", () => {
    const now = nowIso();
    const snapshot = GatewayBoundaryRuntimeSnapshotSchema.parse({
      policy_id: createId("gateway_boundary"),
      source_channel: "webhook",
      source_identity: "calendar-hook",
      session_key: "webhook:calendar-hook:main",
      allowed_tools: ["collection.record.create"],
      mcp_config_refs: [
        {
          id: "mcp_calendar",
          server_name: "calendar",
          allowed_tools: ["calendar.read"],
          secret_ref_ids: ["secret_calendar"]
        }
      ],
      secret_ref_ids: ["secret_calendar"],
      sandbox: {
        mode: "non_main",
        scope: "session",
        backend: "none",
        workspace_access: "none",
        network_access: "none",
        allowed_paths: [],
        denied_paths: [],
        metadata: {}
      },
      path_normalization: {
        canonical_root: "workspace",
        reject_absolute_paths: true,
        reject_parent_segments: true,
        allowed_roots: ["workspace"],
        denied_roots: []
      },
      allowlist: ["webhook:calendar-hook"],
      created_at: now
    });

    expect(snapshot.secret_ref_ids).toEqual(["secret_calendar"]);
    expect(JSON.stringify(snapshot)).not.toContain("RAW_ENV_KEY");
    expect(() =>
      GatewayBoundaryRuntimeSnapshotSchema.parse({
        ...snapshot,
        key: "RAW_ENV_KEY"
      })
    ).toThrow();
  });

  it("parses external gateway channels for pairing, routing, and inbound records", () => {
    const now = nowIso();
    const pairing = GatewayPairingRecordSchema.parse({
      id: createId("gateway_pairing"),
      channel: "slack",
      source_identity: "workspace:T123/user:U456",
      source_label: "Slack user",
      status: "pending",
      pairing_code: "123456",
      session_key: "slack:T123:U456",
      metadata: {},
      requested_at: now,
      expires_at: now,
      updated_at: now
    });
    const pairingPolicy = GatewayPairingPolicyRecordSchema.parse({
      id: createId("gateway_pairing_policy"),
      channel: "line",
      status: "enabled",
      trust_mode: "pairing_required",
      allowlist: ["line:*"],
      allowed_tools: [],
      metadata: {},
      created_at: now,
      updated_at: now
    });
    const routingPolicy = GatewayRoutingPolicyRecordSchema.parse({
      id: createId("gateway_routing_policy"),
      channel: "email",
      status: "enabled",
      session_key_strategy: "account_thread",
      default_route: "main",
      metadata: {},
      created_at: now,
      updated_at: now
    });
    const inbound = GatewayInboundMessageRecordSchema.parse({
      id: createId("gateway_inbound"),
      channel: "telegram",
      source_identity: "chat:123/user:456",
      body: "hello",
      status: "blocked",
      trusted: false,
      metadata: {},
      created_at: now,
      updated_at: now
    });

    expect(pairing.channel).toBe("slack");
    expect(pairingPolicy.channel).toBe("line");
    expect(routingPolicy.channel).toBe("email");
    expect(inbound.channel).toBe("telegram");
  });

  it("parses Gateway diagnostics reports", () => {
    const now = nowIso();
    const report = GatewayDiagnosticsReportSchema.parse({
      generated_at: now,
      total_pairings: 1,
      pending_pairings: 1,
      approved_pairings: 0,
      pairing_policies: 1,
      routing_policies: 0,
      inbound_messages: 1,
      blocked_inbound_messages: 1,
      failed_inbound_messages: 0,
      boundary_policies: 0,
      mcp_configs: 0,
      concurrency_locks: 0,
      active_concurrency_locks: 0,
      expired_active_concurrency_locks: 0,
      sandbox_instances: 0,
      failed_sandbox_instances: 0,
      sandbox_workspace_syncs: 0,
      failed_sandbox_workspace_syncs: 0,
      status_counts: {
        pairings: { pending: 1 },
        pairing_policies: { enabled: 1 },
        routing_policies: {},
        inbound_messages: { blocked: 1 },
        concurrency_locks: {},
        sandbox_instances: {},
        sandbox_workspace_syncs: {}
      },
      issues: [{
        code: "gateway_pending_pairing",
        severity: "warning",
        resource_kind: "pairing",
        resource_id: "pairing_1",
        message: "Gateway pairing is pending approval."
      }],
      recommendation: "Review Gateway pairing, routing, inbound, lock, and sandbox warnings before expanding external channels."
    });

    expect(report.pending_pairings).toBe(1);
    expect(report.issues[0]?.code).toBe("gateway_pending_pairing");
  });

  it("parses self-improvement usage and curator state records", () => {
    const now = nowIso();
    const usage = SkillUsageRecordSchema.parse({
      skill_id: "skill_monthly_report",
      use_count: 3,
      last_used_at: now,
      last_run_id: "run_latest",
      created_at: now,
      updated_at: now
    });
    const state = CuratorStateRecordSchema.parse({
      id: "default",
      paused: false,
      interval_hours: 168,
      min_idle_hours: 2,
      stale_after_days: 30,
      archive_after_days: 90,
      last_run_at: now,
      last_run_summary: "Created 2 suggestion(s).",
      run_count: 1,
      updated_at: now
    });
    const report = CuratorLifecycleReportSchema.parse({
      id: "curator_report_default",
      checked_at: now,
      dry_run: true,
      paused: false,
      thresholds: {
        stale_after_days: 30,
        archive_after_days: 90,
        min_idle_hours: 2
      },
      counts: {
        memory_items: 1,
        wiki_pages: 1,
        skill_items: 1,
        skill_usage_rows: 1,
        suggestions: 1
      },
      skill_actions: [{
        skill_id: "skill_monthly_report",
        title: "Monthly report",
        current_state: "project",
        proposed_state: "stale",
        action: "mark_stale",
        reason: "Inactive past stale threshold.",
        usage_count: 3,
        last_activity_at: now,
        owner_pinned: false,
        suggestion_id: "suggestion_1"
      }],
      protected_skills: [{
        skill_id: "skill_pinned",
        title: "Pinned skill",
        state: "pinned",
        reason: "owner_pinned"
      }]
    });
    const reviewReport = CuratorReviewReportSchema.parse({
      id: "curator_review_default",
      checked_at: now,
      dry_run: true,
      counts: {
        keep_candidates: 1,
        patch_candidates: 1,
        consolidate_candidates: 1,
        archive_candidates: 1
      },
      keep_candidates: [{
        kind: "skill",
        id: "skill_recent",
        title: "Recent Skill",
        reason: "Recent usage keeps this Skill active."
      }],
      memory_merge_groups: [{
        topic: "monthly report",
        memory_ids: ["memory_1", "memory_2"],
        reason: "Same normalized topic.",
        suggestion_id: "suggestion_merge"
      }],
      skill_consolidation_groups: [{
        group_key: "report",
        skill_ids: ["skill_1", "skill_2"],
        suggested_umbrella_title: "Report workflow",
        reason: "Similar tags and required capabilities.",
        suggestion_id: "suggestion_skill"
      }],
      wiki_patch_proposals: [{
        wiki_id: "wiki_1",
        title: "Draft Wiki",
        reason: "Unverified active page.",
        suggestion_id: "suggestion_wiki"
      }],
      archive_candidates: [{
        kind: "skill",
        id: "skill_old",
        title: "Old Skill",
        reason: "Archive lifecycle action proposed.",
        suggestion_id: "suggestion_archive"
      }]
    });
    const evaluationReport = EvaluationTraceReportSchema.parse({
      id: "evaluation_report_1",
      checked_at: now,
      judge: {
        deterministic_status: "completed",
        external_status: "not_configured",
        summary: "Deterministic trace review completed."
      },
      counts: {
        backend_runs: 1,
        backend_events: 2,
        workspace_changes: 1,
        tool_runs: 1,
        audit_records: 1,
        findings: 1,
        comparisons: 1
      },
      run_scores: [{
        run_id: "run_1",
        backend_id: "native",
        status: "completed",
        score: 72,
        verdict: "warn",
        findings: [{
          kind: "tool_not_completed",
          severity: "warning",
          reason: "One tool was ignored.",
          resource_refs: [{ kind: "backend_run", id: "run_1", uri: "backend-runs/run_1" }]
        }],
        suggested_improvements: ["Add a recovery checklist."]
      }],
      comparisons: [{
        current_run_id: "run_1",
        result: "no_baseline",
        reason: "No comparable earlier run."
      }]
    });

    expect(usage.use_count).toBe(3);
    expect(state.archive_after_days).toBe(90);
    expect(report.skill_actions[0]?.action).toBe("mark_stale");
    expect(reviewReport.skill_consolidation_groups[0]?.skill_ids).toHaveLength(2);
    expect(evaluationReport.run_scores[0]?.verdict).toBe("warn");
  });

  it("parses Reflection and Curator diagnostics reports", () => {
    const now = nowIso();
    const report = ReflectionDiagnosticsReportSchema.parse({
      generated_at: now,
      stale_after_hours: 72,
      total_reflection_runs: 1,
      completed_reflection_runs: 1,
      failed_reflection_runs: 0,
      total_curator_runs: 1,
      completed_curator_runs: 1,
      failed_curator_runs: 0,
      pending_reflection_suggestions: 1,
      pending_curator_suggestions: 1,
      latest_reflection_run: {
        id: "reflection_1",
        kind: "manual",
        session_id: "session_1",
        status: "completed",
        input_summary: "Review session traces.",
        output_summary: "Created 1 suggestion.",
        started_at: now,
        completed_at: now
      },
      latest_curator_run: {
        id: "reflection_curator",
        kind: "curator",
        session_id: "session_1",
        status: "completed",
        input_summary: "Curate skills.",
        output_summary: "Curator is paused.",
        started_at: now,
        completed_at: now
      },
      curator_state: {
        id: "default",
        paused: true,
        interval_hours: 168,
        min_idle_hours: 2,
        stale_after_days: 30,
        archive_after_days: 90,
        last_run_at: now,
        last_run_summary: "Curator is paused.",
        run_count: 1,
        updated_at: now
      },
      status_counts: {
        reflection_runs: { completed: 1 },
        curator_runs: { completed: 1 },
        suggestions: { proposed: 2 },
        suggestion_types: { skill_patch: 1, memory_patch: 1 }
      },
      issues: [{
        code: "curator_paused",
        severity: "warning",
        message: "Curator is paused.",
        status: "paused",
        created_at: now
      }],
      recommendation: "Review pending Reflection / Curator suggestions before relying on the self-improvement loop."
    });

    expect(report.curator_state.paused).toBe(true);
    expect(report.issues[0]?.code).toBe("curator_paused");
  });

  it("parses Evaluation diagnostics reports", () => {
    const now = nowIso();
    const report = EvaluationDiagnosticsReportSchema.parse({
      generated_at: now,
      stale_after_hours: 24,
      total_evaluation_runs: 1,
      completed_evaluation_runs: 1,
      failed_evaluation_runs: 0,
      pending_evaluation_suggestions: 1,
      backend_runs: 2,
      failed_backend_runs: 1,
      outcome_unknown_backend_runs: 0,
      waiting_backend_runs: 0,
      tool_runs: 1,
      ignored_or_failed_tool_runs: 1,
      workspace_changes: 1,
      latest_evaluation_run: {
        id: "reflection_1",
        kind: "evaluation",
        session_id: "session_1",
        status: "completed",
        input_summary: "Evaluate traces.",
        output_summary: "Evaluation created 1 suggestion.",
        started_at: now,
        completed_at: now
      },
      status_counts: {
        evaluation_runs: { completed: 1 },
        evaluation_suggestions: { proposed: 1 },
        backend_runs: { completed: 1, failed: 1 },
        tool_runs: { failed: 1 }
      },
      issues: [{
        code: "evaluation_suggestion_pending",
        severity: "info",
        message: "Evaluation suggestion is still pending review.",
        reflection_run_id: "reflection_1",
        suggestion_id: "suggestion_1",
        status: "proposed",
        created_at: now
      }],
      recommendation: "Review pending evaluation suggestions before treating trace quality as closed."
    });

    expect(report.latest_evaluation_run?.kind).toBe("evaluation");
    expect(report.issues[0]?.code).toBe("evaluation_suggestion_pending");
  });

  it("parses skill progressive disclosure in context previews", () => {
    const now = "2026-06-26T00:00:00.000Z";
    const context = ContextPreviewSchema.parse({
      session_id: "session_1",
      query: "monthly report references",
      context_assembly: {
        version: 1,
        assembled_at: now,
        session_id: "session_1",
        query: "monthly report references",
        sources: [
          {
            kind: "session",
            status: "included",
            candidate_count: 1,
            included_count: 1,
            reason: "Session record was loaded from Workspace Store."
          },
          {
            kind: "selected_skills",
            status: "included",
            candidate_count: 1,
            included_count: 1,
            reason: "Skill index search selected reusable procedures."
          },
          {
            kind: "gateway_boundary",
            status: "missing",
            candidate_count: 0,
            included_count: 0,
            reason: "No Gateway boundary policy was attached to this preview."
          }
        ],
        omissions: [],
        limits: {
          recent_messages: 10,
          knowledge_wiki: 5,
          collection_notes: 5,
          selected_skills: 5,
          session_search: 8
        },
        gateway_boundary: {
          present: false,
          allowed_tools_count: 0,
          available_tools_before_boundary: 1,
          available_tools_after_boundary: 1,
          filtered_tool_count: 0,
          reason: "No Gateway boundary policy was attached to this preview."
        },
        quality_checks: [{
          id: "external_assist_isolated",
          status: "pass",
          detail: "External assist is not included in accepted active Memory."
        }]
      },
      session_summary: {
        session_key: "web:owner:main",
        title: "Monthly report",
        ui_locale: "ja",
        output_locale: "ja",
        message_count: 2,
        operation_count: 1,
        backend_run_count: 1,
        tool_run_count: 0,
        workspace_change_count: 1
      },
      external_assist: {
        role: "assistive",
        isolated_from_memory: true,
        included_in_active_memory: false,
        note: "External provider output is assistive and not a memory source of truth.",
        hints: [{
          id: "hint_1",
          title: "External note",
          summary: "Unverified external hint.",
          source_uri: "external://hint/1",
          confidence: 0.7
        }],
        recent_failures: []
      },
      active_memory: [],
      active_memory_report: {
        query: "monthly report references",
        retrieved_at: now,
        candidate_count: 0,
        included_count: 0,
        included_memory_ids: [],
        excluded: [],
        sensitive_redactions: [],
        conflict_groups: [],
        resolution_suggestions: []
      },
      knowledge_wiki: [{
        id: "wiki_provider_storage",
        slug: "provider-storage",
        title: "Provider storage",
        content: "External provider hints stay proposals until accepted.",
        source_refs: [{
          kind: "memory",
          id: "memory_provider_policy",
          uri: "memory/topic/memory_provider_policy.md",
          label: "Provider policy"
        }],
        provenance: {
          kind: "user_authored",
          summary: "Accepted from an explicit owner-authored proposal.",
          verified: true
        }
      }],
      knowledge_wiki_report: {
        query: "monthly report references",
        retrieved_at: now,
        candidate_count: 1,
        included_count: 1,
        included_wiki_ids: ["wiki_provider_storage"],
        excluded: [],
        source_refs: [{
          kind: "memory",
          id: "memory_provider_policy",
          uri: "memory/topic/memory_provider_policy.md",
          label: "Provider policy"
        }]
      },
      collection_notes: [{
        collection_id: "contacts",
        file_path: "collections/contacts/notes/README.md",
        content: "Notes are context only.",
        role: "context_only"
      }],
      skill_selection_report: {
        query: "monthly report references",
        candidate_count: 1,
        selected_count: 1,
        selected_skill_ids: ["skill_monthly_report"],
        available_capabilities: ["artifact.create", "artifact.write"],
        environment: {
          runtime: "local_workspace",
          platform: "test"
        },
        excluded: []
      },
      selected_skills: [{
        id: "skill_monthly_report",
        title: "Monthly report",
        description: "Draft monthly reports",
        tags: ["report"],
        allowed_scopes: ["workspace"],
        required_capabilities: ["artifact.write"],
        disclosure_level: "support",
        selection_reason: "Matched support files: references/style.md",
        selection: {
          score: 12,
          matched_terms: ["monthly", "report"],
          matched_capabilities: ["artifact.write"],
          missing_capabilities: [],
          unsupported_scopes: [],
          reasons: ["Matched query terms: monthly, report."]
        },
        usage: {
          use_count: 3,
          last_used_at: "2026-01-01T00:00:00.000Z"
        },
        content: "# Steps\n- Draft the report.",
        support_file_refs: [{
          path: "references/style.md",
          file_path: "skills/support/skill_monthly_report/references/style.md"
        }],
        support_files: [{
          path: "references/style.md",
          file_path: "skills/support/skill_monthly_report/references/style.md",
          content: "Use concise bullets."
        }]
      }],
      session_search: [],
      recent_messages: [],
      available_tools: ["artifact.create"]
    });

    expect(context.knowledge_wiki[0]?.provenance).toMatchObject({ kind: "user_authored", verified: true });
    expect(context.selected_skills[0]?.disclosure_level).toBe("support");
    expect(context.selected_skills[0]?.support_files?.[0]?.path).toBe("references/style.md");
    expect(context.selected_skills[0]?.support_files?.[0]?.file_path).toBe("skills/support/skill_monthly_report/references/style.md");
    expect(context.collection_notes[0]?.role).toBe("context_only");
  });

  it("parses context freeze responses", () => {
    const now = "2026-06-26T00:00:00.000Z";
    const response = ContextFreezeResponseSchema.parse({
      session_id: "session_1",
      query: "monthly report",
      freeze_snapshot: {
        id: "freeze_1",
        soul: {
          id: "soul",
          kind: "soul",
          file_ref: { kind: "profile", id: "soul", uri: "profile/SOUL.md", label: "SOUL.md" },
          content: "# SOUL.md\n\nKeep Workspace responsibilities separate.",
          loaded_at: now
        },
        profile: {
          id: "profile",
          kind: "profile",
          file_ref: { kind: "profile", id: "profile", uri: "profile/PROFILE.md", label: "PROFILE.md" },
          content: "# PROFILE.md\n\nOwner preferences.",
          loaded_at: now
        },
        memory_refs: [{ kind: "memory", id: "memory_1", uri: "memory/topic/memory_1.md", label: "Memory" }],
        skill_refs: [{ kind: "skill", id: "skill_1", uri: "skills/skill_1/SKILL.md", label: "Skill" }],
        wiki_refs: [{ kind: "wiki", id: "wiki_1", uri: "wiki/pages/wiki_1.md", label: "Wiki" }],
        content: "# Frozen identity\n\n## SOUL.md\nKeep Workspace responsibilities separate.",
        stable_hash: "freeze_hash",
        created_at: now
      },
      context_assembly: {
        version: 1,
        assembled_at: now,
        session_id: "session_1",
        query: "monthly report",
        sources: [{
          kind: "freeze_snapshot",
          status: "included",
          candidate_count: 1,
          included_count: 1,
          reason: "SOUL/Profile freeze snapshot was loaded for this turn."
        }],
        omissions: [],
        limits: {
          recent_messages: 10,
          knowledge_wiki: 5,
          collection_notes: 5,
          selected_skills: 5,
          session_search: 8
        },
        gateway_boundary: {
          present: false,
          allowed_tools_count: 0,
          available_tools_before_boundary: 1,
          available_tools_after_boundary: 1,
          filtered_tool_count: 0,
          reason: "No Gateway boundary policy was attached to this preview."
        },
        quality_checks: [{
          id: "freeze_snapshot_loaded",
          status: "pass",
          detail: "Freeze snapshot is pinned for this turn."
        }]
      },
      session_summary: {
        session_key: "web:owner:main",
        title: "Monthly report",
        ui_locale: "ja",
        output_locale: "ja",
        message_count: 1,
        operation_count: 0,
        backend_run_count: 0,
        tool_run_count: 0,
        workspace_change_count: 0
      },
      source_refs: [
        { kind: "profile", id: "soul", uri: "profile/SOUL.md", label: "SOUL.md" },
        { kind: "profile", id: "profile", uri: "profile/PROFILE.md", label: "PROFILE.md" },
        { kind: "memory", id: "memory_1", uri: "memory/topic/memory_1.md", label: "Memory" },
        { kind: "wiki", id: "wiki_1", uri: "wiki/pages/wiki_1.md", label: "Wiki" },
        { kind: "skill", id: "skill_1", uri: "skills/skill_1/SKILL.md", label: "Skill" }
      ],
      stable_hash: "freeze_hash",
      created_at: now
    });

    expect(response.freeze_snapshot.stable_hash).toBe("freeze_hash");
    expect(response.source_refs.map((ref) => ref.kind)).toEqual(["profile", "profile", "memory", "wiki", "skill"]);
  });

  it("parses external send diagnostics reports", () => {
    const now = nowIso();
    const report = ExternalSendDiagnosticsReportSchema.parse({
      generated_at: now,
      dispatch_enabled: false,
      dry_run_default: true,
      stale_after_hours: 24,
      total_sends: 3,
      pending_approval_sends: 1,
      failed_sends: 1,
      dry_run_approved_sends: 1,
      stale_draft_sends: 1,
      status_counts: {
        pending_approval: 1,
        approved: 1,
        failed: 1
      },
      channel_counts: {
        webhook: 2,
        email: 1
      },
      transport_status_counts: {
        dry_run_only: 2,
        not_configured: 1
      },
      transport_readiness: [{
        channel: "webhook",
        status: "dry_run_only",
        configured: true,
        dispatch_enabled: false,
        requires_target_url: true,
        message: "Webhook dispatch is dry-run by default."
      }, {
        channel: "email",
        status: "not_configured",
        configured: false,
        dispatch_enabled: false,
        requires_target_url: false,
        message: "Email transport is not configured."
      }],
      issues: [{
        code: "external_send_pending_approval",
        severity: "warning",
        send_id: "send_pending",
        channel: "webhook",
        status: "pending_approval",
        title: "Pending send",
        message: "External send is waiting for explicit owner approval before dispatch.",
        resource_ref: {
          kind: "external_send",
          id: "send_pending",
          uri: "external-sends/send_pending",
          label: "Pending send"
        }
      }],
      recommendation: "Review pending external sends and approve or deny them through the approval flow."
    });

    expect(report.dry_run_default).toBe(true);
    expect(report.issues[0]?.code).toBe("external_send_pending_approval");
  });

  it("parses Knowledge Wiki diagnostics reports", () => {
    const now = nowIso();
    const report = KnowledgeWikiDiagnosticsReportSchema.parse({
      generated_at: now,
      total_pages: 2,
      active_pages: 1,
      state_counts: {
        active: 1,
        proposed: 1
      },
      active_with_provenance: 1,
      active_with_verified_provenance: 0,
      active_with_source_refs: 0,
      active_empty_pages: 0,
      issues: [{
        code: "active_wiki_missing_source_refs",
        severity: "warning",
        wiki_id: "wiki_provider_policy",
        slug: "provider-policy",
        title: "Provider policy",
        state: "active",
        message: "Active Knowledge Wiki page has no source refs."
      }],
      recommendation: "Review Knowledge Wiki provenance and source refs before relying on active pages as evidence."
    });

    expect(report.issues[0]?.code).toBe("active_wiki_missing_source_refs");
    expect(report.active_with_verified_provenance).toBe(0);
  });

  it("parses external assist diagnostics reports", () => {
    const now = nowIso();
    const latestRecord = {
      id: "external_assist_1",
      phase: "prefetch",
      status: "completed",
      provider_id: "test-provider",
      session_id: "session_1",
      query: "memory boundary",
      role: "assistive",
      hints: [{
        id: "hint_1",
        summary: "Unverified external hint.",
        source_uri: "external://hint/1"
      }],
      isolated_from_memory: true,
      included_in_active_memory: false,
      created_at: now,
      updated_at: now
    };
    const report = ExternalAssistDiagnosticsReportSchema.parse({
      generated_at: now,
      scope: {
        session_id: "session_1",
        phase: "prefetch",
        status: "completed",
        provider_id: "test-provider",
        limit: 100
      },
      total_records: 1,
      failed_records: 0,
      hint_count: 1,
      unisolated_records: 0,
      included_in_active_memory_records: 1,
      groups: [{
        provider_id: "test-provider",
        phase: "prefetch",
        status: "completed",
        count: 1,
        hint_count: 1,
        latest_record: latestRecord
      }],
      violations: [{
        code: "external_assist_included_in_active_memory",
        record_id: "external_assist_1",
        provider_id: "test-provider",
        phase: "prefetch",
        status: "completed",
        message: "External Assist record must not be included in active Memory retrieval."
      }],
      recent_failures: [],
      recommendation: "External Assist crossed the Memory isolation boundary."
    });

    expect(report.groups[0]?.latest_record.hints[0]?.source_uri).toBe("external://hint/1");
    expect(report.violations[0]?.code).toBe("external_assist_included_in_active_memory");
  });

  it("parses settings responses with safe external assist config diagnostics", () => {
    const now = nowIso();
    const diagnostics = ExternalAssistProviderConfigDiagnosticsSchema.parse({
      configured: false,
      source: "invalid",
      provider_id: "broken-assist",
      provider_ids: ["broken-assist"],
      provider_count: 0,
      provider_kind: "http",
      max_hints: 5,
      timeout_ms: 5000,
      token_configured: true,
      auth_header: "Authorization",
      endpoint_origin: "https://assist.example.test",
      endpoint_path_configured: true,
      raw_context_shared: false,
      errors: ["invalid_external_assist_url"],
      warnings: []
    });
    const response = SettingsResponseSchema.parse({
      ui_locale: "ja",
      output_locale: "ja",
        memory_capture_mode: "auto",
        knowledge_wiki_capture_mode: "auto",
        skill_capture_mode: "auto",
      external_provider_role: "assistive",
      updated_at: now,
      external_assist_config: diagnostics
    });

    expect(response.external_assist_config.source).toBe("invalid");
    expect(JSON.stringify(response.external_assist_config)).not.toContain("raw-token");
  });

  it("parses multiple external assist provider diagnostics", () => {
    const diagnostics = ExternalAssistProviderConfigDiagnosticsSchema.parse({
      configured: true,
      source: "multiple",
      provider_id: "release-assist, gateway-assist",
      provider_ids: ["release-assist", "gateway-assist"],
      provider_count: 2,
      provider_kind: "multiple",
      max_hints: 5,
      timeout_ms: null,
      token_configured: false,
      auth_header: null,
      raw_context_shared: false,
      file_name: "release.json, gateway.json",
      errors: [],
      warnings: []
    });

    expect(diagnostics.provider_ids).toEqual(["release-assist", "gateway-assist"]);
    expect(diagnostics.provider_count).toBe(2);
  });

  it("parses backend release readiness manual gates", () => {
    const health = BackendReleaseReadinessHealthSchema.parse({
      non_destructive: {
        status: "available",
        command: "CI=true pnpm run backend:release:verify -- --json"
      },
      external_effects_confirmed: false,
      manual_gate_count: 3,
      manual_gates: [
        {
          id: "external-backend-run-resume",
          label: "External backend run/resume",
          status: "manual_opt_in_required",
          effect: "authenticated_external_service",
          reason: "Requires explicit confirmation because it may use authenticated external services, network, and provider quota.",
          command: "pnpm run backend:external:verify -- --run --confirm-external-effects --resume --require-configured --backend <id>",
          confirmation_flag: "--confirm-external-effects",
          runbook: "docs/runbooks/backend-external-e2e.md"
        },
        {
          id: "external-sandbox-run",
          label: "External sandbox run",
          status: "manual_opt_in_required",
          effect: "external_sandbox",
          reason: "Docker, SSH, and remote sandbox runs can create remote or container side effects.",
          command: "pnpm run sandbox:verify -- --run --confirm-external-effects --backend docker|ssh|remote",
          confirmation_flag: "--confirm-external-effects",
          runbook: "docs/runbooks/backend-external-e2e.md"
        },
        {
          id: "external-channel-service-e2e",
          label: "External channel service E2E",
          status: "manual_opt_in_required",
          effect: "external_channel_service",
          reason: "Requires real Slack, Telegram, LINE, or Email provider credentials and may send or receive live messages.",
          command: "manual: run the channel service E2E checklist in docs/runbooks/backend-external-e2e.md",
          confirmation_flag: "--confirm-external-effects",
          runbook: "docs/runbooks/backend-external-e2e.md"
        }
      ],
      profiles: [
        {
          id: "local_oss",
          label: "Local OSS Release",
          status: "available",
          non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
          required_gate_ids: ["typecheck", "full-tests", "i18n-check", "web-build", "doctor", "public-naming-scan", "external-channel-probe"],
          manual_gate_ids: [],
          runbook: "docs/runbooks/backend-external-e2e.md",
          notes: ["No authenticated external service calls are started by this profile."]
        },
        {
          id: "production_ops",
          label: "Production Operations",
          status: "manual_opt_in_required",
          non_destructive_command: "CI=true pnpm run backend:release:verify -- --json",
          required_gate_ids: ["typecheck", "full-tests", "i18n-check", "web-build", "doctor", "public-naming-scan", "external-channel-probe"],
          manual_gate_ids: ["external-backend-run-resume", "external-sandbox-run", "external-channel-service-e2e"],
          runbook: "docs/runbooks/backend-external-e2e.md",
          notes: ["Run the manual gates only after credentials, quotas, and side effects are approved."]
        }
      ]
    });

    expect(health.manual_gate_count).toBe(3);
    expect(health.manual_gates.map((gate) => gate.status)).toEqual([
      "manual_opt_in_required",
      "manual_opt_in_required",
      "manual_opt_in_required"
    ]);
    expect(health.profiles.map((profile) => profile.id)).toEqual(["local_oss", "production_ops"]);
    expect(health.profiles.find((profile) => profile.id === "production_ops")?.manual_gate_ids).toEqual([
      "external-backend-run-resume",
      "external-sandbox-run",
      "external-channel-service-e2e"
    ]);
  });

  it("parses workspace read models", () => {
    const now = nowIso();
    const skill = SkillIndexEntryReadModelSchema.parse({
      id: "skill_1",
      state: "active",
      title: "Skill",
      description: "Reusable workflow",
      tags: ["workflow"],
      required_capabilities: ["artifact.create"],
      file_path: "skills/active/skill_1.md",
      updated_at: now
    });
    const change = ChangeHistoryEntrySchema.parse({
      id: "change_1",
      session_id: "session_1",
      run_id: "run_1",
      change_type: "artifact_created",
      resource_ref: { kind: "artifact", id: "artifact_1", uri: "artifacts/a.md" },
      summary: "Created artifact.",
      created_at: now
    });
    const run = RunHistoryEntrySchema.parse({
      id: "run_1",
      session_id: "session_1",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      input_summary: "hello",
      output_summary: "done",
      started_at: now,
      completed_at: now,
      event_count: 2,
      workspace_change_count: 1
    });

    expect(skill.file_path).toContain("skills");
    expect(change.resource_ref.kind).toBe("artifact");
    expect(run.event_count).toBe(2);
  });

  it("parses Skill diagnostics reports", () => {
    const now = nowIso();
    const report = SkillDiagnosticsReportSchema.parse({
      generated_at: now,
      total_skills: 2,
      selectable_skills: 1,
      state_counts: {
        project: 1,
        candidate: 1
      },
      selectable_with_verified_provenance: 0,
      selectable_with_source_refs: 0,
      selectable_with_support_files: 1,
      selectable_with_usage: 0,
      empty_support_files: 0,
      issues: [{
        code: "selectable_skill_unverified_provenance",
        severity: "warning",
        skill_id: "skill_1",
        title: "Draft report",
        state: "project",
        message: "Selectable Skill has unverified provenance detail."
      }],
      recommendation: "Review Skill provenance, source refs, support files, and usage before expanding backend automation."
    });

    expect(report.selectable_skills).toBe(1);
    expect(report.issues[0]?.code).toBe("selectable_skill_unverified_provenance");
  });

  it("parses tool run diagnostics reports", () => {
    const now = nowIso();
    const report = ToolRunDiagnosticsReportSchema.parse({
      generated_at: now,
      scope: {
        session_id: "session_1",
        status: "ignored",
        limit: 50
      },
      total_tool_runs: 2,
      ignored_or_failed_tool_runs: 2,
      groups: [{
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        status: "ignored",
        count: 2,
        latest_tool_run: {
          id: "toolrun_1",
          run_id: "run_1",
          session_id: "session_1",
          tool_call_id: "tool_1",
          provider_tool_name: "create_artifact",
          action_id: "artifact.create",
          status: "ignored",
          input_summary: "create_artifact",
          output_summary: "provider_tool_requires_domain_command",
          resource_refs: [],
          created_at: now
        },
        reasons: [{ reason: "provider_tool_requires_domain_command", count: 2 }]
      }],
      repeated_ignored_provider_tools: [{
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        status: "ignored",
        count: 2,
        latest_tool_run: {
          id: "toolrun_1",
          run_id: "run_1",
          session_id: "session_1",
          tool_call_id: "tool_1",
          provider_tool_name: "create_artifact",
          action_id: "artifact.create",
          status: "ignored",
          input_summary: "create_artifact",
          output_summary: "provider_tool_requires_domain_command",
          resource_refs: [],
          created_at: now
        },
        reasons: [{ reason: "provider_tool_requires_domain_command", count: 2 }]
      }],
      adapter_recommendations: [{
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        status: "ignored",
        count: 2,
        mapping_status: "mapped_provider_tool",
        domain_command_id: "artifact.create",
        suggested_next_step: "route_through_domain_command",
        reason: "Provider tool is already mapped to a Domain Command; inspect why the runtime ignored it."
      }],
      recommendation: "Review repeated ignored or failed provider tool calls."
    });

    expect(report.repeated_ignored_provider_tools[0]?.count).toBe(2);
    expect(report.adapter_recommendations?.[0]?.domain_command_id).toBe("artifact.create");
  });

  it("parses File / Browser action diagnostics reports", () => {
    const now = nowIso();
    const report = FileBrowserActionDiagnosticsReportSchema.parse({
      generated_at: now,
      scope: {
        session_id: "session_1",
        limit: 50
      },
      total_operations: 3,
      total_tool_runs: 1,
      file_operations: 2,
      browser_operations: 1,
      completed_file_operations: 1,
      completed_browser_operations: 1,
      failed_or_blocked_operations: 1,
      ignored_or_failed_tool_runs: 1,
      browser_workspace_fallbacks: 1,
      operation_status_counts: {
        completed: 2,
        failed: 1
      },
      tool_run_status_counts: {
        ignored: 1
      },
      issues: [{
        code: "browser_workspace_fallback",
        severity: "info",
        action_kind: "browser",
        operation: "browser.download_to_workspace",
        status: "completed",
        message: "Browser action saved page content into the workspace fallback.",
        operation_id: "operation_1",
        session_id: "session_1",
        resource_ref: {
          kind: "file",
          id: "file_1",
          uri: "browser/test.txt",
          label: "browser/test.txt"
        },
        created_at: now
      }],
      recommendation: "Review failed or blocked File / Browser actions before expanding the generic tool suite."
    });

    expect(report.browser_workspace_fallbacks).toBe(1);
    expect(report.issues[0]?.code).toBe("browser_workspace_fallback");
  });

  it("parses Plugin diagnostics reports", () => {
    const now = nowIso();
    const report = PluginDiagnosticsReportSchema.parse({
      ok: false,
      generated_at: now,
      total_plugins: 2,
      built_in_plugins: 1,
      filesystem_plugins: 1,
      marketplace_plugins: 0,
      total_actions: 3,
      filesystem_actions: 1,
      total_renderers: 1,
      filesystem_renderers: 0,
      entrypoint_ready_plugins: 0,
      entrypoint_not_ready_plugins: 1,
      unsigned_entrypoint_plugins: 1,
      untrusted_signature_plugins: 0,
      plugins_with_missing_handlers: 1,
      registered_handlers: 0,
      missing_handlers: 1,
      load_issue_count: 1,
      status_counts: {
        sources: { built_in: 1, filesystem: 1 },
        kinds: { tool: 2 },
        entrypoints: { not_declared: 1, missing: 1 },
        signatures: { not_declared: 2 }
      },
      issues: [{
        code: "plugin_missing_handlers",
        severity: "critical",
        manifest_id: "example-plugin",
        missing_handler_ids: ["example.handler"],
        action_ids: ["example.action"],
        message: "Plugin action handlers are missing."
      }],
      recommendation: "Fix plugin manifest, entrypoint, signature, or handler issues before exposing filesystem plugin actions."
    });

    expect(report.ok).toBe(false);
    expect(report.issues[0]?.code).toBe("plugin_missing_handlers");
  });

  it("parses Domain Command catalog diagnostics reports", () => {
    const now = nowIso();
    const report = DomainCommandCatalogDiagnosticsReportSchema.parse({
      ok: true,
      generated_at: now,
      coverage: {
        commands: 3,
        action_catalog_entries: 3,
        provider_tool_mappings: 2,
        surface_operation_mappings: 1,
        render_kinds: ["chat", "artifact"],
        input_sources: ["surface_operation", "provider_tool_call"]
      },
      issues: [],
      recommendation: "Domain Command catalog is internally consistent."
    });

    expect(report.ok).toBe(true);
    expect(report.coverage.provider_tool_mappings).toBe(2);
  });
});
