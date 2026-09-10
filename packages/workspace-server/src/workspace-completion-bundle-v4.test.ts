import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import type { WorkspaceServerStore } from "./workspace-server-store";
import {
  readWorkspaceBundleV4Transport,
  verifyWorkspaceBundleV4,
  writeWorkspaceBundleV4Transport,
  WorkspaceBundleV4Service
} from "./workspace-completion-bundle-v4";

const workspaceId = "workspace_bundle_v4_test";
const transferId = "transfer_bundle_v4_test";
const timestamp = "2026-08-22T00:00:00.000Z";
const completionFiles = [
  "configurations.jsonl", "activities.jsonl", "episodes.jsonl", "episode-activities.jsonl",
  "resources.jsonl", "resource-versions.jsonl", "skill-files.jsonl", "policy-approvals.jsonl",
  "attestations.jsonl", "evidence.jsonl", "resource-links.jsonl", "policy-rules.jsonl",
  "policy-change-requests.jsonl", "uses.jsonl", "evaluations.jsonl", "jobs.jsonl",
  "job-attempts.jsonl", "curator-state.jsonl", "curator-snapshots.jsonl", "file-batches.jsonl",
  "file-batch-entries.jsonl", "search-projection.jsonl", "migration-receipts.jsonl",
  "workspace-documents.jsonl", "runtime-activities.jsonl", "automation-jobs.jsonl",
  "runtime-runs.jsonl", "runtime-events.jsonl", "runtime-changes.jsonl", "runtime-resource-usage.jsonl",
  "automation-runs.jsonl", "runtime-sessions.jsonl", "runtime-messages.jsonl", "redactions.jsonl", "agents.jsonl", "agent-room-permissions.jsonl",
  "connection-descriptors.jsonl"
] as const;
const recordCountKeys = [
  "configurations", "activities", "episodes", "episode_activities", "resources", "resource_versions", "skill_files",
  "policy_approvals", "attestations", "evidence", "resource_links", "policy_rules", "policy_change_requests", "uses",
  "evaluations", "jobs", "job_attempts", "curator_state", "curator_snapshots", "file_batches", "file_batch_entries",
  "search_projection", "migration_receipts", "workspace_documents", "runtime_activities", "runtime_automation_jobs",
  "runtime_automation_runs", "runtime_sessions", "runtime_messages", "runtime_runs", "runtime_events", "runtime_changes",
  "runtime_resource_usage", "redactions", "agents", "agent_room_permissions", "connection_descriptors"
] as const;
const humanWorkFiles = [
  ["workspace_human_works", "human-works.jsonl"],
  ["workspace_human_work_assignments", "human-work-assignments.jsonl"],
  ["workspace_human_work_instructions", "human-work-instructions.jsonl"],
  ["workspace_human_work_comments", "human-work-comments.jsonl"],
  ["workspace_human_work_comment_reactions", "human-work-comment-reactions.jsonl"],
  ["workspace_human_work_controls", "human-work-controls.jsonl"],
  ["workspace_human_work_launch_reservations", "human-work-launch-reservations.jsonl"],
  ["workspace_human_work_legacy_sessions", "human-work-legacy-sessions.jsonl"]
] as const;

describe("Workspace Bundle v4 HTTP transport", () => {
  it("round-trips a verified transfer bundle without changing its transfer identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const verified = await verifyWorkspaceBundleV4(source);
      const transport = await readWorkspaceBundleV4Transport(source);
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });

      expect(transport.format).toBe("samurai-workspace-bundle-v4");
      expect(restored.manifest.integrity_hash).toBe(verified.manifest.integrity_hash);
      expect(restored.manifest.transfer_id).toBe(transferId);
      expect(restored.manifest).not.toHaveProperty("source_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a V4 Bundle exported before portable Runtime history was added", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-legacy-runtime-history-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const legacyFiles = [
        ["runtime-runs.jsonl", "runtime_runs"],
        ["runtime-events.jsonl", "runtime_events"],
        ["runtime-changes.jsonl", "runtime_changes"],
        ["runtime-resource-usage.jsonl", "runtime_resource_usage"]
      ] as const;
      const manifestPath = path.join(source, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        files: Record<string, string>;
        record_counts: Record<string, number>;
        transfer_id?: string;
        base_v3_integrity_hash: string;
        excluded_maintenance_account_ids: string[];
        integrity_hash: string;
      };
      for (const [filename, countKey] of legacyFiles) {
        await rm(path.join(source, "completion", filename));
        delete manifest.files[`completion/${filename}`];
        delete manifest.record_counts[countKey];
      }
      manifest.integrity_hash = hash(canonicalJson({
        files: manifest.files,
        record_counts: manifest.record_counts,
        ...(manifest.transfer_id ? { transfer_id: manifest.transfer_id } : {}),
        base_v3_integrity_hash: manifest.base_v3_integrity_hash,
        excluded_maintenance_account_ids: [...manifest.excluded_maintenance_account_ids].sort()
      }));
      await writeFile(manifestPath, canonicalJson(manifest), { flag: "w", mode: 0o600 });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest.record_counts).not.toHaveProperty("runtime_runs");
      expect(verified.manifest.record_counts).not.toHaveProperty("runtime_events");
      expect(verified.manifest.record_counts).not.toHaveProperty("runtime_changes");
      expect(verified.manifest.record_counts).not.toHaveProperty("runtime_resource_usage");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a transport entry whose content does not match the signed manifest hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const transport = await readWorkspaceBundleV4Transport(source);
      transport.entries[0] = { ...transport.entries[0]!, content_base64: Buffer.from("tampered").toString("base64") };

      await expect(writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "rejected")
      })).rejects.toThrow("workspace_bundle_v4_hash_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects migration receipts that expose excluded secret-shaped resource identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        migrationReceipts: [{
          workspace_id: workspaceId,
          id: "completion_migration_receipt_test",
          counts: { blocked_secret_resources: ["sk-live-must-not-be-portable"] }
        }]
      });

      await expect(verifyWorkspaceBundleV4(source)).rejects.toThrow("workspace_bundle_v4_secret_forbidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts portable migration receipts that retain only the filtered count", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        migrationReceipts: [{
          workspace_id: workspaceId,
          id: "completion_migration_receipt_test",
          counts: { filtered_resource_count: 1 }
        }]
      });

      await expect(verifyWorkspaceBundleV4(source)).resolves.toMatchObject({
        manifest: { format_version: 4 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts historical source Organization provenance from an old v3 Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-provenance-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        provenance: { sourceOrganizationId: "organization_source", schemaRevision: 78 }
      });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest).toMatchObject({
        source_organization_id: "organization_source",
        schema_revision: 78,
        schema_version: 78
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Agent role, instructions, and enabled fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-agent-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_test",
          display_name: "Bundle Agent",
          description: "Legacy description",
          role: "researcher",
          instructions: "Use evidence before answering",
          backend_id: "samurai-native",
          enabled: false,
          status: "disabled",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }]
      });
      const transport = await readWorkspaceBundleV4Transport(source);
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      const restoredAgent = JSON.parse((await readFile(
        path.join(restored.directory, "completion", "agents.jsonl"),
        "utf8"
      )).trim()) as Record<string, unknown>;

      expect(restoredAgent).toMatchObject({
        role: "researcher",
        instructions: "Use evidence before answering",
        enabled: false
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Workspace Chat sessions and messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-chat-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        chatSessions: [{
          workspace_id: workspaceId,
          id: "session_bundle_test",
          session_key: "workspace:portable:thread_bundle_test",
          room_id: "room_bundle_test",
          title: "Portable Chat",
          ui_locale: "ja",
          output_locale: "ja",
          created_at: timestamp,
          updated_at: timestamp
        }],
        chatMessages: [{
          workspace_id: workspaceId,
          id: "message_bundle_test",
          session_id: "session_bundle_test",
          role: "user",
          content: "Keep this Workspace conversation available after restore.",
          input_locale: "ja",
          output_locale: "ja",
          envelope: { input_locale: "ja", output_locale: "ja" },
          created_at: timestamp
        }]
      });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest.record_counts).toMatchObject({ runtime_sessions: 1, runtime_messages: 1 });
      const transport = await readWorkspaceBundleV4Transport(source);
      expect(transport.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        "completion/runtime-sessions.jsonl",
        "completion/runtime-messages.jsonl"
      ]));
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      const restoredSession = JSON.parse(await readFile(
        path.join(restored.directory, "completion", "runtime-sessions.jsonl"),
        "utf8"
      )) as Record<string, unknown>;
      const restoredMessage = JSON.parse(await readFile(
        path.join(restored.directory, "completion", "runtime-messages.jsonl"),
        "utf8"
      )) as Record<string, unknown>;

      expect(restoredSession).toMatchObject({ id: "session_bundle_test", room_id: "room_bundle_test" });
      expect(restoredMessage).toMatchObject({ id: "message_bundle_test", session_id: "session_bundle_test", role: "user" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips settled Runtime history for an artifact conversation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-runtime-history-"));
    try {
      const source = path.join(root, "source");
      const runId = "run_bundle_artifact";
      const activityId = "activity_bundle_artifact";
      const changeId = "change_bundle_artifact";
      await writeMinimalV4Bundle(source, {
        chatSessions: [{
          workspace_id: workspaceId,
          id: "session_bundle_artifact",
          session_key: "workspace:portable:thread_bundle_artifact",
          room_id: "room_bundle_test",
          title: "Artifact Chat",
          ui_locale: "ja",
          output_locale: "ja",
          created_at: timestamp,
          updated_at: timestamp
        }],
        chatMessages: [{
          workspace_id: workspaceId,
          id: "message_bundle_artifact_input",
          session_id: "session_bundle_artifact",
          role: "user",
          content: "Create the artifact and keep the execution history.",
          input_locale: "ja",
          output_locale: "ja",
          envelope: null,
          created_at: timestamp
        }, {
          workspace_id: workspaceId,
          id: "message_bundle_artifact_output",
          session_id: "session_bundle_artifact",
          role: "agent",
          content: "Artifact created.",
          input_locale: "ja",
          output_locale: "ja",
          envelope: null,
          created_at: "2026-08-22T00:00:01.000Z"
        }],
        runtimeRuns: [{
          workspace_id: workspaceId,
          id: runId,
          session_id: "session_bundle_artifact",
          room_id: "room_bundle_test",
          principal: null,
          source: null,
          session_ref: { app_id: "samurai-native", session_id: "session_bundle_artifact" },
          agent_id: null,
          requested_by_participant_id: "account_owner",
          input_message_id: "message_bundle_artifact_input",
          output_message_id: "message_bundle_artifact_output",
          backend_id: "gemini",
          backend_kind: "remote",
          backend_session_id: null,
          status: "completed",
          phase: "settled",
          current_attempt: 1,
          request_idempotency_key: "artifact-conversation",
          request_hash: "request-hash",
          started_at: timestamp,
          completed_at: "2026-08-22T00:00:01.000Z",
          input_summary: "Create the artifact",
          output_summary: "Artifact created.",
          error_code: null,
          metadata: {}
        }],
        runtimeEvents: [{
          workspace_id: workspaceId,
          id: "event_bundle_artifact",
          run_id: runId,
          session_id: "session_bundle_artifact",
          backend_session_id: null,
          event_type: "artifact_created",
          sequence: 1,
          attempt_no: 1,
          source_event_id: "artifact-created:bundle",
          source_sequence: null,
          payload: { artifact_id: "artifact_bundle_test", title: "Artifact" },
          resource_refs: [{ kind: "artifact", id: "artifact_bundle_test", uri: "runtime://artifacts/artifact_bundle_test" }],
          created_at: "2026-08-22T00:00:01.000Z"
        }],
        runtimeChanges: [{
          workspace_id: workspaceId,
          id: changeId,
          run_id: runId,
          session_id: "session_bundle_artifact",
          room_id: "room_bundle_test",
          activity_id: activityId,
          domain_operation_id: null,
          session_ref: { app_id: "samurai-native", session_id: "session_bundle_artifact" },
          resource_ref: { kind: "artifact", id: "artifact_bundle_test", uri: "runtime://artifacts/artifact_bundle_test" },
          change_type: "artifact_created",
          summary: "Artifact created.",
          legacy_operation_id: null,
          correlation_id: "artifact-conversation",
          created_at: "2026-08-22T00:00:01.000Z"
        }],
        runtimeActivities: [{
          workspace_id: workspaceId,
          id: activityId,
          room_id: "room_bundle_test",
          status: "completed",
          idempotency_key: "activity-conversation",
          backend_run_id: runId,
          record: { id: activityId, status: "completed" },
          created_at: timestamp,
          updated_at: "2026-08-22T00:00:01.000Z"
        }],
        runtimeResourceUsage: [{
          workspace_id: workspaceId,
          id: "usage_bundle_artifact",
          activity_id: activityId,
          workspace_job_attempt_id: null,
          resource_ref: { kind: "artifact", id: "artifact_bundle_test", uri: "runtime://artifacts/artifact_bundle_test" },
          resource_version: "1",
          content_hash: "artifact-content-hash",
          usage_scope: { kind: "room", room_id: "room_bundle_test" },
          stage: "modified",
          domain_operation_id: null,
          workspace_change_id: changeId,
          created_at: "2026-08-22T00:00:01.000Z"
        }]
      });

      const verified = await verifyWorkspaceBundleV4(source);
      expect(verified.manifest.record_counts).toMatchObject({
        runtime_sessions: 1,
        runtime_messages: 2,
        runtime_runs: 1,
        runtime_events: 1,
        runtime_changes: 1,
        runtime_activities: 1,
        runtime_resource_usage: 1
      });
      const transport = await readWorkspaceBundleV4Transport(source);
      expect(transport.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining([
        "completion/runtime-runs.jsonl",
        "completion/runtime-events.jsonl",
        "completion/runtime-changes.jsonl",
        "completion/runtime-activities.jsonl",
        "completion/runtime-resource-usage.jsonl"
      ]));
      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      const restoredRun = JSON.parse(await readFile(path.join(restored.directory, "completion", "runtime-runs.jsonl"), "utf8")) as Record<string, unknown>;
      const restoredEvent = JSON.parse(await readFile(path.join(restored.directory, "completion", "runtime-events.jsonl"), "utf8")) as Record<string, unknown>;
      const restoredChange = JSON.parse(await readFile(path.join(restored.directory, "completion", "runtime-changes.jsonl"), "utf8")) as Record<string, unknown>;
      const restoredActivity = JSON.parse(await readFile(path.join(restored.directory, "completion", "runtime-activities.jsonl"), "utf8")) as Record<string, unknown>;
      const restoredUsage = JSON.parse(await readFile(path.join(restored.directory, "completion", "runtime-resource-usage.jsonl"), "utf8")) as Record<string, unknown>;

      expect(restoredRun).toMatchObject({ id: runId, status: "completed", phase: "settled", backend_session_id: null });
      expect(restoredEvent).toMatchObject({ run_id: runId, event_type: "artifact_created", backend_session_id: null });
      expect(restoredChange).toMatchObject({ id: changeId, run_id: runId, change_type: "artifact_created" });
      expect(restoredActivity).toMatchObject({ id: activityId, backend_run_id: runId, status: "completed" });
      expect(restoredUsage).toMatchObject({ activity_id: activityId, workspace_change_id: changeId });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates a settled Human Work runtime binding against its source graph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-runtime-binding-"));
    try {
      const agentId = "agent_bundle_runtime_binding";
      const workId = "work_bundle_runtime_binding";
      const assignmentId = "assignment_bundle_runtime_binding";
      const runId = "run_bundle_runtime_binding";
      const roomId = "room_bundle_attachment";
      const agent = {
        workspace_id: workspaceId,
        id: agentId,
        display_name: "Runtime binding agent",
        description: "",
        role: "assistant",
        instructions: "Keep the source binding intact",
        backend_id: "samurai-native",
        enabled: true,
        status: "active",
        version: 1,
        created_by: "account_owner",
        created_at: timestamp,
        updated_at: timestamp
      };
      const work = {
        workspace_id: workspaceId,
        id: workId,
        room_id: roomId,
        requester_account_id: "account_owner",
        default_agent_id: agentId,
        default_agent_version: 1,
        title: "Runtime binding history",
        objective: "Keep settled evidence portable",
        completion_criteria: [],
        status: "completed",
        stop_state: "none",
        instruction_version: 1,
        control_generation: 0,
        operation_id: "operation_bundle_runtime_binding",
        created_at: timestamp,
        updated_at: timestamp
      };
      const assignment = {
        workspace_id: workspaceId,
        id: assignmentId,
        work_id: workId,
        room_id: roomId,
        parent_assignment_id: null,
        dependency_assignment_ids: [],
        origin_kind: "normal",
        agent_id: agentId,
        agent_version: 1,
        instruction_version: 1,
        attempt: 1,
        priority: 0,
        status: "completed",
        current_run_id: runId,
        result: { status: "completed", run_id: runId },
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: timestamp,
        completed_at: timestamp
      };
      const instruction = {
        workspace_id: workspaceId,
        id: "instruction_bundle_runtime_binding",
        work_id: workId,
        assignment_id: assignmentId,
        room_id: roomId,
        version: 1,
        body: "Keep settled evidence portable",
        attachment_refs: [],
        source_kind: "request",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      };
      const binding = {
        workspace_id: workspaceId,
        room_id: roomId,
        work_id: workId,
        assignee_id: assignmentId,
        agent_id: agentId,
        backend_id: "samurai-native",
        generation: 0,
        agent_configuration_version: 1
      };
      const runtimeRun = {
        workspace_id: workspaceId,
        id: runId,
        session_id: "session_bundle_runtime_binding",
        room_id: roomId,
        agent_id: agentId,
        backend_id: "samurai-native",
        backend_session_id: null,
        status: "completed",
        phase: "settled",
        metadata: { runtime_binding: binding }
      };
      const valid = path.join(root, "valid");
      await writeMinimalV4Bundle(valid, {
        agents: [agent],
        runtimeRuns: [runtimeRun],
        humanWork: { work, instruction, assignments: [assignment], fileHash: hash("portable attachment\n"), fileContent: "portable attachment\n" }
      });
      await expect(verifyWorkspaceBundleV4(valid)).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });

      const invalid = path.join(root, "invalid");
      await writeMinimalV4Bundle(invalid, {
        agents: [agent],
        runtimeRuns: [{ ...runtimeRun, metadata: { runtime_binding: { ...binding, workspace_id: "workspace_other" } } }],
        humanWork: { work, instruction, assignments: [assignment], fileHash: hash("portable attachment\n"), fileContent: "portable attachment\n" }
      });
      await expect(verifyWorkspaceBundleV4(invalid)).rejects.toThrow("workspace_bundle_v4_runtime_history_reference_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sanitizes provider-native Runtime identifiers through the source exporter", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-runtime-sanitization-"));
    try {
      const template = path.join(root, "template");
      await writeMinimalV4Bundle(template, {
        provenance: { sourceOrganizationId: "organization_source", schemaRevision: 26 }
      });
      const sourceRows: Record<string, readonly Record<string, unknown>[]> = {
        workspace_runtime_runs: [{
          workspace_id: workspaceId,
          id: "run_bundle_sanitization",
          session_id: "session_bundle_sanitization",
          room_id: "room_bundle_test",
          session_ref: { app_id: "samurai-native", session_id: "session_bundle_sanitization" },
          backend_id: "gemini",
          backend_kind: "remote",
          backend_session_id: "provider-session-to-remove",
          status: "completed",
          phase: "settled",
          metadata: {
            artifact_id: "artifact_bundle_sanitization",
            providerThreadId: "provider-thread-to-remove",
            nested: {
              backend_conversation_id: "backend-conversation-to-remove",
              nativeSessionId: "native-session-to-remove",
              codex_thread_id: "codex-thread-to-remove",
              geminiConversationId: "gemini-conversation-to-remove",
              evidence: "retain-this-evidence"
            }
          }
        }],
        workspace_runtime_events: [{
          workspace_id: workspaceId,
          id: "event_bundle_sanitization",
          run_id: "run_bundle_sanitization",
          session_id: "session_bundle_sanitization",
          backend_session_id: "provider-session-to-remove",
          event_type: "artifact_created",
          sequence: 1,
          payload: {
            artifact_id: "artifact_bundle_sanitization",
            title: "Portable artifact evidence",
            provider_thread_id: "provider-thread-to-remove",
            nested: {
              threadId: "thread-to-remove",
              backendConversationId: "backend-conversation-to-remove",
              provider_native_session_id: "provider-session-to-remove",
              claude_session_ref: "claude-session-to-remove",
              openai_thread_ref: "openai-thread-to-remove",
              evidence: "retain-this-evidence"
            }
          }
        }]
      };
      const tableRows = (query: string): Record<string, unknown>[] => {
        const table = /\bFROM\s+([a-z0-9_]+)/i.exec(query)?.[1];
        return table ? [...(sourceRows[table] ?? [])] : [];
      };
      const store = {
        storageRoot: root,
        database: {
          withContext: async (_context: unknown, callback: (sql: { query: (query: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<unknown>) =>
            callback({ query: async (query: string) => ({ rows: /samurai_can_workspace/.test(query) ? [{ allowed: true }] : tableRows(query) }) }),
          withReadSnapshot: async (_context: unknown, callback: (sql: { query: (query: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<unknown>) =>
            callback({ query: async (query: string) => ({ rows: tableRows(query) }) })
        },
        insertAudit: async () => undefined
      } as unknown as WorkspaceServerStore;
      const service = new WorkspaceBundleV4Service(store);
      const internals = service as unknown as {
        v3: { writePortableSnapshot: (context: unknown, input: { destination: string }) => Promise<{ directory: string; manifest: Record<string, unknown> }> };
        recordV4Ledger: (...args: unknown[]) => Promise<string>;
      };
      internals.v3.writePortableSnapshot = async (_context, input) => {
        await cp(path.join(template, "base-v3"), input.destination, { recursive: true });
        return {
          directory: input.destination,
          manifest: JSON.parse(await readFile(path.join(input.destination, "manifest.json"), "utf8")) as Record<string, unknown>
        };
      };
      internals.recordV4Ledger = async () => "bundle_bundle_sanitization";

      const exported = await service.export({
        workspaceId,
        accountId: "account_owner",
        operationId: "operation_bundle_v4_sanitization"
      } as never, { destination: path.join(root, "exported"), transferId });
      const run = JSON.parse(await readFile(path.join(exported.directory, "completion", "runtime-runs.jsonl"), "utf8")) as Record<string, unknown>;
      const event = JSON.parse(await readFile(path.join(exported.directory, "completion", "runtime-events.jsonl"), "utf8")) as Record<string, unknown>;

      expect(run).toMatchObject({
        session_id: "session_bundle_sanitization",
        session_ref: { app_id: "samurai-native", session_id: "session_bundle_sanitization" },
        backend_session_id: null,
        metadata: {
          artifact_id: "artifact_bundle_sanitization",
          nested: { evidence: "retain-this-evidence" }
        }
      });
      expect(event).toMatchObject({
        session_id: "session_bundle_sanitization",
        backend_session_id: null,
        payload: {
          artifact_id: "artifact_bundle_sanitization",
          title: "Portable artifact evidence",
          nested: { evidence: "retain-this-evidence" }
        }
      });
      expect(JSON.stringify(run.metadata)).not.toMatch(/provider|backend|native/i);
      expect(JSON.stringify(event.payload)).not.toMatch(/provider|backend|native/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a malicious transport containing provider-native Runtime identifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-runtime-transport-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        runtimeRuns: [{ id: "run_bundle_transport", status: "completed", phase: "settled", backend_session_id: null }],
        runtimeEvents: [{
          id: "event_bundle_transport",
          run_id: "run_bundle_transport",
          backend_session_id: null,
          event_type: "artifact_created",
          sequence: 1,
          payload: { artifact_id: "artifact_bundle_transport" }
        }]
      });
      const transport = await readWorkspaceBundleV4Transport(source);
      const eventPath = "completion/runtime-events.jsonl";
      const eventEntry = transport.entries.find((entry) => entry.path === eventPath)!;
      const event = JSON.parse(Buffer.from(eventEntry.content_base64, "base64").toString("utf8")) as Record<string, unknown>;
      event.payload = {
        artifact_id: "artifact_bundle_transport",
        providerThreadId: "provider-thread-to-remove",
        nested: { backend_conversation_id: "backend-conversation-to-remove", session_id: "session-to-remove" }
      };
      const maliciousContent = `${canonicalJson(event)}\n`;
      const manifest = {
        ...transport.manifest,
        files: { ...transport.manifest.files, [eventPath]: hash(maliciousContent) }
      };
      manifest.integrity_hash = hash(canonicalJson({
        files: manifest.files,
        record_counts: manifest.record_counts,
        ...(manifest.transfer_id ? { transfer_id: manifest.transfer_id } : {}),
        base_v3_integrity_hash: manifest.base_v3_integrity_hash,
        excluded_maintenance_account_ids: [...manifest.excluded_maintenance_account_ids].sort()
      }));
      const maliciousTransport = {
        ...transport,
        manifest,
        entries: transport.entries.map((entry) => entry.path === eventPath
          ? { ...entry, content_base64: Buffer.from(maliciousContent).toString("base64") }
          : entry)
      };

      await expect(writeWorkspaceBundleV4Transport({
        transport: maliciousTransport,
        destination: path.join(root, "rejected")
      })).rejects.toThrow("workspace_bundle_v4_provider_identifier_forbidden");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns the V4 integrity hash in a transfer receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-receipt-"));
    try {
      const source = path.join(root, "source");
      const targetWorkspaceId = "workspace_bundle_v4_import_target";
      await writeMinimalV4Bundle(source);
      const verified = await verifyWorkspaceBundleV4(source);
      const store = {
        storageRoot: root,
        database: {
          withContext: async (_context: unknown, callback: (sql: { query: (query: string) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<unknown>) => callback({
            query: async (query: string) => {
              if (query.includes("workspace_completion_migration_receipts")) return { rows: [{ id: "completion_receipt" }] };
              if (query.includes("workspace_completion_maintenance_identities")) return { rows: [{ exists: false }] };
              if (query.includes("workspace_members")) return { rows: [{ exists: false }] };
              return { rows: [] };
            }
          })
        }
      } as unknown as WorkspaceServerStore;
      const service = new WorkspaceBundleV4Service(store);
      const internals = service as unknown as {
        v3: { importNew: (context: unknown, input: unknown) => Promise<unknown> }
      };
      internals.v3.importNew = async () => ({
        workspaceId: targetWorkspaceId,
        manifest: {} as never,
        // The embedded V3 restore reports its own hash. V4 must replace this
        // with the outer Bundle hash before the receipt goes back to A.
        receipt: {
          format_version: 1,
          transfer_id: transferId,
          source_workspace_id: workspaceId,
          source_integrity_hash: verified.manifest.base_v3_integrity_hash,
          target_workspace_id: targetWorkspaceId,
          imported_at: timestamp,
          target_integrity_hash: verified.manifest.base_v3_integrity_hash
        }
      });

      const imported = await service.importNew({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_receipt_test"
      }, {
        sourceDirectory: source,
        targetWorkspaceId
      });
      const replayed = await service.importNew({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_receipt_test"
      }, {
        sourceDirectory: source,
        targetWorkspaceId
      });

      expect(imported.receipt).toMatchObject({
        format_version: 1,
        transfer_id: transferId,
        source_workspace_id: workspaceId,
        source_integrity_hash: verified.manifest.integrity_hash,
        target_workspace_id: targetWorkspaceId,
        target_integrity_hash: verified.manifest.integrity_hash
      });
      expect(imported.receipt).toEqual(replayed.receipt);
      expect(imported.receipt?.imported_at).toBe(verified.manifest.exported_at);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a V4 Bundle without a target Organization by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-target-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source);
      const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")) as never;
      const service = new WorkspaceBundleV4Service({ storageRoot: root } as unknown as WorkspaceServerStore);

      await expect(service.stageIncomingBundle({
        accountId: "account_owner",
        operationId: "operation_bundle_v4_target_test"
      }, {
        targetWorkspaceId: workspaceId,
        manifest
      })).resolves.toBeUndefined();

      const metadata = JSON.parse(await readFile(path.join(
        root,
        ".incoming-v4",
        "account_owner",
        "operation_bundle_v4_target_test.json"
      ), "utf8")) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("target_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires human-work attachment refs to match the portable Room file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-attachments-"));
    try {
      const valid = path.join(root, "valid");
      const invalid = path.join(root, "invalid");
      const agent = {
        workspace_id: workspaceId,
        id: "agent_bundle_attachment",
        created_by: "account_owner",
        version: 1,
        status: "active",
        enabled: true,
        created_at: timestamp,
        updated_at: timestamp
      };
      const work = {
        workspace_id: workspaceId,
        id: "work_bundle_attachment",
        room_id: "room_bundle_attachment",
        requester_account_id: "account_owner",
        default_agent_id: "agent_bundle_attachment",
        default_agent_version: 1,
        title: "Attached work",
        objective: "Review the file",
        completion_criteria: [],
        status: "queued",
        stop_state: "none",
        instruction_version: 1,
        control_generation: 0,
        operation_id: "operation_bundle_attachment",
        created_at: timestamp,
        updated_at: timestamp
      };
      const fileHash = hash("portable attachment\n");
      const ref = { kind: "file", id: fileHash, uri: "notes/brief.md", version: "1", label: "brief.md" };
      const instruction = {
        workspace_id: workspaceId,
        id: "instruction_bundle_attachment",
        work_id: work.id,
        room_id: work.room_id,
        version: 1,
        body: "Review this file",
        attachment_refs: [ref],
        source_kind: "request",
        state: "pending",
        created_by: "account_owner",
        created_at: timestamp
      };
      await writeMinimalV4Bundle(valid, {
        agents: [agent],
        humanWork: { work, instruction, fileHash, fileContent: "portable attachment\n" }
      });
      await expect(verifyWorkspaceBundleV4(valid)).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });

      await writeMinimalV4Bundle(invalid, {
        agents: [agent],
        humanWork: {
          work,
          instruction: { ...instruction, attachment_refs: [{ ...ref, id: "b".repeat(64) }] },
          fileHash,
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(invalid)).rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips Knowledge/Skill refs, versioned bodies, and lineage in human work", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-resource-refs-"));
    try {
      const source = path.join(root, "source");
      const restored = path.join(root, "restored");
      const knowledgeBody = "# Portable knowledge\n\nKeep the source decision.\n";
      const skillBody = "---\nname: portable-skill\n---\n\nUse the verified source.\n";
      const knowledgeRef = {
        kind: "knowledge",
        id: "knowledge_bundle_refs",
        uri: "knowledge/bundle-refs.md",
        version: "2",
        label: "Bundle knowledge"
      };
      const skillRef = {
        kind: "skill",
        id: "skill_bundle_refs",
        uri: "skills/bundle-refs/SKILL.md",
        version: "3",
        label: "Bundle skill"
      };
      const work = {
        workspace_id: workspaceId,
        id: "work_bundle_resource_refs",
        room_id: "room_bundle_attachment",
        requester_account_id: "account_owner",
        default_agent_id: "agent_bundle_resource_refs",
        default_agent_version: 1,
        title: "Resource refs work",
        objective: "Keep Knowledge and Skill context",
        completion_criteria: [],
        status: "completed",
        stop_state: "none",
        instruction_version: 1,
        control_generation: 0,
        operation_id: "operation_bundle_resource_refs",
        resource_refs: [knowledgeRef, skillRef],
        created_at: timestamp,
        updated_at: timestamp
      };
      const instruction = {
        workspace_id: workspaceId,
        id: "instruction_bundle_resource_refs",
        work_id: work.id,
        room_id: work.room_id,
        version: 1,
        body: "Use the portable context.",
        attachment_refs: [],
        resource_refs: [skillRef],
        source_kind: "request",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      };
      const batchId = "completion_file_batch_bundle_refs";
      const knowledgeHash = hash(knowledgeBody);
      const skillHash = hash(skillBody);
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_resource_refs",
          display_name: "Resource refs agent",
          description: "",
          role: "assistant",
          instructions: "Keep portable context",
          backend_id: "samurai-native",
          enabled: true,
          status: "active",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        humanWork: { work, instruction, fileHash: hash("portable attachment\n"), fileContent: "portable attachment\n" },
        completionResources: [{
          workspace_id: workspaceId,
          id: knowledgeRef.id,
          scope_kind: "workspace",
          room_id: null,
          resource_kind: "knowledge",
          title: knowledgeRef.label,
          lifecycle_state: "active",
          current_confirmed_version: 2,
          current_provisional_version: null
        }, {
          workspace_id: workspaceId,
          id: skillRef.id,
          scope_kind: "workspace",
          room_id: null,
          resource_kind: "skill",
          title: skillRef.label,
          lifecycle_state: "active",
          current_confirmed_version: 3,
          current_provisional_version: null
        }],
        completionResourceVersions: [{
          workspace_id: workspaceId,
          id: "resource_version_bundle_knowledge_2",
          resource_id: knowledgeRef.id,
          version: 2,
          file_path: knowledgeRef.uri,
          content_hash: knowledgeHash,
          content_size: Buffer.byteLength(knowledgeBody),
          lifecycle_state: "active"
        }, {
          workspace_id: workspaceId,
          id: "resource_version_bundle_skill_3",
          resource_id: skillRef.id,
          version: 3,
          file_path: skillRef.uri,
          content_hash: skillHash,
          content_size: Buffer.byteLength(skillBody),
          lifecycle_state: "active"
        }],
        completionFileBatches: [{
          workspace_id: workspaceId,
          id: batchId,
          scope_kind: "workspace",
          room_id: null,
          status: "renamed",
          created_at: timestamp,
          updated_at: timestamp
        }],
        completionFileBatchEntries: [{
          workspace_id: workspaceId,
          batch_id: batchId,
          path: knowledgeRef.uri,
          sha256: knowledgeHash,
          size: Buffer.byteLength(knowledgeBody)
        }, {
          workspace_id: workspaceId,
          batch_id: batchId,
          path: skillRef.uri,
          sha256: skillHash,
          size: Buffer.byteLength(skillBody)
        }],
        completionBodies: {
          [knowledgeRef.uri]: knowledgeBody,
          [skillRef.uri]: skillBody
        }
      });

      await expect(verifyWorkspaceBundleV4(source)).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });
      const transport = await readWorkspaceBundleV4Transport(source);
      const entries = new Map(transport.entries.map((entry) => [entry.path, Buffer.from(entry.content_base64, "base64").toString("utf8")]));
      expect(JSON.parse(entries.get("completion/human-works.jsonl")!.trim()).resource_refs).toEqual([knowledgeRef, skillRef]);
      expect(JSON.parse(entries.get("completion/human-work-instructions.jsonl")!.trim()).resource_refs).toEqual([skillRef]);
      expect(entries.get(`completion/files/${knowledgeRef.uri}`)).toBe(knowledgeBody);
      expect(entries.get(`completion/files/${skillRef.uri}`)).toBe(skillBody);

      await expect(writeWorkspaceBundleV4Transport({ transport, destination: restored })).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });
      expect(await readFile(path.join(restored, "completion", "files", knowledgeRef.uri), "utf8")).toBe(knowledgeBody);
      expect(await readFile(path.join(restored, "completion", "files", skillRef.uri), "utf8")).toBe(skillBody);
      expect(JSON.parse(await readFile(path.join(restored, "completion", "human-works.jsonl"), "utf8"))).toMatchObject({ resource_refs: [knowledgeRef, skillRef] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects human-work refs to an unknown Completion resource explicitly", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-resource-ref-error-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_unknown_ref",
          display_name: "Unknown ref agent",
          description: "",
          role: "assistant",
          instructions: "",
          backend_id: "samurai-native",
          enabled: true,
          status: "active",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        humanWork: {
          work: {
            workspace_id: workspaceId,
            id: "work_bundle_unknown_ref",
            room_id: "room_bundle_attachment",
            requester_account_id: "account_owner",
            default_agent_id: "agent_bundle_unknown_ref",
            default_agent_version: 1,
            title: "Unknown resource work",
            objective: "Fail closed",
            completion_criteria: [],
            status: "queued",
            stop_state: "none",
            instruction_version: 1,
            control_generation: 0,
            operation_id: "operation_bundle_unknown_ref",
            resource_refs: [{ kind: "knowledge", id: "knowledge_missing", uri: "knowledge/missing.md", version: "1" }],
            created_at: timestamp,
            updated_at: timestamp
          },
          instruction: {
            workspace_id: workspaceId,
            id: "instruction_bundle_unknown_ref",
            work_id: "work_bundle_unknown_ref",
            room_id: "room_bundle_attachment",
            version: 1,
            body: "Fail closed",
            attachment_refs: [],
            resource_refs: [],
            source_kind: "request",
            state: "pending",
            created_by: "account_owner",
            created_at: timestamp
          },
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(source)).rejects.toMatchObject({
        code: "workspace_bundle_v4_human_work_resource_reference_not_found",
        status: 404
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an unresolved legacy attachment marker readable and portable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-legacy-attachment-marker-"));
    try {
      const source = path.join(root, "source");
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_legacy_attachment",
          display_name: "Legacy attachment agent",
          description: "",
          role: "assistant",
          instructions: "",
          backend_id: "samurai-native",
          enabled: true,
          status: "active",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        humanWork: {
          work: {
            workspace_id: workspaceId,
            id: "work_bundle_legacy_attachment",
            room_id: "room_bundle_attachment",
            requester_account_id: "account_owner",
            default_agent_id: "agent_bundle_legacy_attachment",
            default_agent_version: 1,
            title: "Legacy attachment work",
            objective: "Review the historical file",
            completion_criteria: [],
            status: "failed",
            stop_state: "none",
            instruction_version: 1,
            control_generation: 0,
            operation_id: "operation_bundle_legacy_attachment",
            created_at: timestamp,
            updated_at: timestamp
          },
          instruction: {
            workspace_id: workspaceId,
            id: "instruction_bundle_legacy_attachment",
            work_id: "work_bundle_legacy_attachment",
            room_id: "room_bundle_attachment",
            version: 1,
            body: "Review the historical file",
            attachment_refs: [{
              kind: "legacy_unresolved",
              reason: "reference_unavailable",
              ref: { kind: "file", id: "a".repeat(64), uri: "notes/removed.md", version: "4", label: "removed.md" }
            }],
            source_kind: "request",
            state: "failed",
            created_by: "account_owner",
            created_at: timestamp
          },
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });

      await expect(verifyWorkspaceBundleV4(source)).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });
      const transport = await readWorkspaceBundleV4Transport(source);
      const instruction = JSON.parse(Buffer.from(
        transport.entries.find((entry) => entry.path === "completion/human-work-instructions.jsonl")!.content_base64,
        "base64"
      ).toString("utf8")) as Record<string, unknown>;
      expect(instruction.attachment_refs).toEqual([expect.objectContaining({ kind: "legacy_unresolved" })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects delegated assignments restored into an Agent DM", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-dm-delegation-"));
    try {
      const source = path.join(root, "source");
      const agentId = "agent_bundle_dm_default";
      const workId = "work_bundle_dm_delegation";
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: agentId,
          display_name: "DM Agent",
          description: "",
          role: "assistant",
          instructions: "",
          backend_id: "samurai-native",
          enabled: true,
          status: "active",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        agentRoomPermissions: [{
          workspace_id: workspaceId,
          room_id: "room_bundle_attachment",
          agent_id: agentId,
          can_view: true,
          can_edit: true,
          can_execute: true,
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        humanWork: {
          roomKind: "agent_dm",
          dmAccountId: "account_owner",
          work: {
            workspace_id: workspaceId,
            id: workId,
            room_id: "room_bundle_attachment",
            requester_account_id: "account_owner",
            default_agent_id: agentId,
            default_agent_version: 1,
            title: "DM delegated work",
            objective: "Keep DM private",
            completion_criteria: [],
            status: "waiting",
            stop_state: "none",
            instruction_version: 1,
            control_generation: 0,
            operation_id: "operation_bundle_dm_delegation",
            created_at: timestamp,
            updated_at: timestamp
          },
          instruction: {
            workspace_id: workspaceId,
            id: "instruction_bundle_dm_delegation",
            work_id: workId,
            assignment_id: "assignment_bundle_dm_parent",
            room_id: "room_bundle_attachment",
            version: 1,
            body: "Keep DM private",
            attachment_refs: [],
            source_kind: "request",
            state: "applied",
            created_by: "account_owner",
            created_at: timestamp
          },
          assignments: [{
            workspace_id: workspaceId,
            id: "assignment_bundle_dm_parent",
            work_id: workId,
            room_id: "room_bundle_attachment",
            parent_assignment_id: null,
            dependency_assignment_ids: [],
            origin_kind: "normal",
            agent_id: agentId,
            agent_version: 1,
            instruction_version: 1,
            attempt: 1,
            priority: 0,
            status: "completed",
            current_run_id: null,
            result: { status: "completed" },
            lease_owner: null,
            lease_expires_at: null,
            created_at: timestamp,
            updated_at: timestamp,
            started_at: timestamp,
            completed_at: timestamp
          }, {
            workspace_id: workspaceId,
            id: "assignment_bundle_dm_child",
            work_id: workId,
            room_id: "room_bundle_attachment",
            parent_assignment_id: "assignment_bundle_dm_parent",
            dependency_assignment_ids: [],
            origin_kind: "delegated",
            agent_id: agentId,
            agent_version: 1,
            instruction_version: 1,
            attempt: 0,
            priority: 0,
            status: "waiting",
            current_run_id: null,
            result: null,
            lease_owner: null,
            lease_expires_at: null,
            created_at: timestamp,
            updated_at: timestamp,
            started_at: null,
            completed_at: null
          }],
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });

      await expect(verifyWorkspaceBundleV4(source)).rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an inconsistent parent-continuation Agent version in a V4 Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-continuation-origin-"));
    try {
      const agent = {
        workspace_id: workspaceId,
        id: "agent_bundle_continuation",
        display_name: "Continuation Agent",
        description: "",
        role: "assistant",
        instructions: "Keep the work context",
        backend_id: "codex",
        enabled: true,
        status: "active",
        version: 2,
        created_by: "account_owner",
        created_at: timestamp,
        updated_at: timestamp
      };
      const work = {
        workspace_id: workspaceId,
        id: "work_bundle_continuation",
        room_id: "room_bundle_attachment",
        requester_account_id: "account_owner",
        default_agent_id: agent.id,
        default_agent_version: 2,
        title: "Continuation work",
        objective: "Continue the work",
        completion_criteria: [],
        status: "waiting",
        stop_state: "none",
        instruction_version: 2,
        control_generation: 0,
        operation_id: "operation_bundle_continuation",
        created_at: timestamp,
        updated_at: timestamp
      };
      const assignment = (id: string, parent_assignment_id: string | null, origin_kind: string, status: string, agent_version: number) => ({
        workspace_id: workspaceId,
        id,
        work_id: work.id,
        room_id: work.room_id,
        parent_assignment_id,
        dependency_assignment_ids: [],
        origin_kind,
        agent_id: agent.id,
        agent_version,
        instruction_version: parent_assignment_id ? 2 : 1,
        attempt: 0,
        priority: 0,
        status,
        current_run_id: null,
        result: parent_assignment_id ? null : { status: "completed" },
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: null,
        completed_at: parent_assignment_id ? null : timestamp
      });
      const invalid = path.join(root, "invalid");
      await writeMinimalV4Bundle(invalid, {
        agents: [agent],
        humanWork: {
          work,
          instruction: {
            workspace_id: workspaceId,
            id: "instruction_bundle_continuation_root",
            work_id: work.id,
            assignment_id: "assignment_bundle_continuation_root",
            room_id: work.room_id,
            version: 1,
            body: "Original work",
            attachment_refs: [],
            source_kind: "request",
            state: "applied",
            created_by: "account_owner",
            created_at: timestamp
          },
          instructions: [{
            workspace_id: workspaceId,
            id: "instruction_bundle_continuation_root",
            work_id: work.id,
            assignment_id: "assignment_bundle_continuation_root",
            room_id: work.room_id,
            version: 1,
            body: "Original work",
            attachment_refs: [],
            source_kind: "request",
            state: "applied",
            created_by: "account_owner",
            created_at: timestamp
          }, {
            workspace_id: workspaceId,
            id: "instruction_bundle_continuation_child",
            work_id: work.id,
            assignment_id: "assignment_bundle_continuation_child",
            room_id: work.room_id,
            version: 2,
            body: "Continue work",
            attachment_refs: [],
            source_kind: "reply",
            state: "pending",
            created_by: "account_owner",
            created_at: timestamp
          }],
          assignments: [
            assignment("assignment_bundle_continuation_root", null, "normal", "completed", 2),
            assignment("assignment_bundle_continuation_child", "assignment_bundle_continuation_root", "parent_continuation", "ready", 1)
          ],
          reservations: [{
            workspace_id: workspaceId,
            id: "reservation_bundle_continuation_root",
            work_id: work.id,
            assignment_id: "assignment_bundle_continuation_root",
            room_id: work.room_id,
            generation: 0,
            status: "released",
            operation_id: "operation_bundle_continuation_root",
            scheduled_at: timestamp,
            lease_owner: null,
            lease_expires_at: null,
            claimed_at: null,
            released_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp
          }, {
            workspace_id: workspaceId,
            id: "reservation_bundle_continuation_child",
            work_id: work.id,
            assignment_id: "assignment_bundle_continuation_child",
            room_id: work.room_id,
            generation: 0,
            status: "reserved",
            operation_id: "operation_bundle_continuation_child",
            scheduled_at: timestamp,
            lease_owner: null,
            lease_expires_at: null,
            claimed_at: null,
            released_at: null,
            created_at: timestamp,
            updated_at: timestamp
          }],
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(invalid)).rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a direct comment-reflection parent continuation without a delegated sibling", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-comment-continuation-"));
    try {
      const agentId = "agent_bundle_comment_continuation";
      const workId = "work_bundle_comment_continuation";
      const roomId = "room_bundle_attachment";
      const rootAssignmentId = "assignment_bundle_comment_root";
      const childAssignmentId = "assignment_bundle_comment_child";
      const commentId = "comment_bundle_continuation";
      const agent = {
        workspace_id: workspaceId,
        id: agentId,
        display_name: "Comment continuation agent",
        description: "",
        role: "assistant",
        instructions: "Continue from applied comments",
        backend_id: "samurai-native",
        enabled: true,
        status: "active",
        version: 1,
        created_by: "account_owner",
        created_at: timestamp,
        updated_at: timestamp
      };
      const work = {
        workspace_id: workspaceId,
        id: workId,
        room_id: roomId,
        requester_account_id: "account_owner",
        default_agent_id: agentId,
        default_agent_version: 1,
        title: "Comment continuation work",
        objective: "Continue from a human comment",
        completion_criteria: [],
        status: "waiting",
        stop_state: "none",
        instruction_version: 2,
        control_generation: 0,
        operation_id: "operation_bundle_comment_continuation",
        created_at: timestamp,
        updated_at: timestamp
      };
      const assignments = [{
        workspace_id: workspaceId,
        id: rootAssignmentId,
        work_id: workId,
        room_id: roomId,
        parent_assignment_id: null,
        dependency_assignment_ids: [],
        origin_kind: "normal",
        agent_id: agentId,
        agent_version: 1,
        instruction_version: 1,
        attempt: 1,
        priority: 0,
        status: "completed",
        current_run_id: null,
        result: { status: "completed" },
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: timestamp,
        completed_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: childAssignmentId,
        work_id: workId,
        room_id: roomId,
        parent_assignment_id: rootAssignmentId,
        dependency_assignment_ids: [],
        origin_kind: "parent_continuation",
        agent_id: agentId,
        agent_version: 1,
        instruction_version: 2,
        attempt: 0,
        priority: 0,
        status: "ready",
        current_run_id: null,
        result: null,
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: null,
        completed_at: null
      }];
      const instructions = [{
        workspace_id: workspaceId,
        id: "instruction_bundle_comment_root",
        work_id: workId,
        assignment_id: rootAssignmentId,
        room_id: roomId,
        version: 1,
        body: "Original work",
        attachment_refs: [],
        source_kind: "request",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "instruction_bundle_comment_child",
        work_id: workId,
        assignment_id: childAssignmentId,
        room_id: roomId,
        version: 2,
        body: "Apply this comment and continue",
        attachment_refs: [],
        source_kind: "comment_reflection",
        source_comment_id: commentId,
        source_comment_version: 1,
        state: "pending",
        created_by: "account_owner",
        created_at: timestamp
      }];
      const reservations = [{
        workspace_id: workspaceId,
        id: "reservation_bundle_comment_root",
        work_id: workId,
        assignment_id: rootAssignmentId,
        room_id: roomId,
        generation: 0,
        status: "released",
        operation_id: "operation_bundle_comment_root",
        scheduled_at: timestamp,
        lease_owner: null,
        lease_expires_at: null,
        claimed_at: null,
        released_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "reservation_bundle_comment_child",
        work_id: workId,
        assignment_id: childAssignmentId,
        room_id: roomId,
        generation: 0,
        status: "reserved",
        operation_id: "operation_bundle_comment_child",
        scheduled_at: timestamp,
        lease_owner: null,
        lease_expires_at: null,
        claimed_at: null,
        released_at: null,
        created_at: timestamp,
        updated_at: timestamp
      }];
      await writeMinimalV4Bundle(path.join(root, "source"), {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          comments: [{
            workspace_id: workspaceId,
            id: commentId,
            work_id: workId,
            room_id: roomId,
            version: 1,
            author_account_id: "account_owner",
            body: "Please continue with this correction",
            attachment_refs: [],
            created_at: timestamp
          }],
          assignments,
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });

      await expect(verifyWorkspaceBundleV4(path.join(root, "source"))).resolves.toMatchObject({
        manifest: { workspace_id: workspaceId }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a system instruction masquerading as a parent continuation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-system-continuation-"));
    try {
      const agent = {
        workspace_id: workspaceId,
        id: "agent_bundle_system_continuation",
        display_name: "System continuation agent",
        description: "",
        role: "assistant",
        instructions: "",
        backend_id: "samurai-native",
        enabled: true,
        status: "active",
        version: 1,
        created_by: "account_owner",
        created_at: timestamp,
        updated_at: timestamp
      };
      const workId = "work_bundle_system_continuation";
      const roomId = "room_bundle_attachment";
      const rootAssignmentId = "assignment_bundle_system_root";
      const childAssignmentId = "assignment_bundle_system_child";
      const work = {
        workspace_id: workspaceId,
        id: workId,
        room_id: roomId,
        requester_account_id: "account_owner",
        default_agent_id: agent.id,
        default_agent_version: 1,
        title: "System continuation work",
        objective: "Reject forged continuation evidence",
        completion_criteria: [],
        status: "waiting",
        stop_state: "none",
        instruction_version: 2,
        control_generation: 0,
        operation_id: "operation_bundle_system_continuation",
        created_at: timestamp,
        updated_at: timestamp
      };
      const assignments = [{
        workspace_id: workspaceId,
        id: rootAssignmentId,
        work_id: workId,
        room_id: roomId,
        parent_assignment_id: null,
        dependency_assignment_ids: [],
        origin_kind: "normal",
        agent_id: agent.id,
        agent_version: 1,
        instruction_version: 1,
        attempt: 1,
        priority: 0,
        status: "completed",
        current_run_id: null,
        result: { status: "completed" },
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: timestamp,
        completed_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: childAssignmentId,
        work_id: workId,
        room_id: roomId,
        parent_assignment_id: rootAssignmentId,
        dependency_assignment_ids: [],
        origin_kind: "parent_continuation",
        agent_id: agent.id,
        agent_version: 1,
        instruction_version: 2,
        attempt: 0,
        priority: 0,
        status: "ready",
        current_run_id: null,
        result: null,
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: null,
        completed_at: null
      }];
      const instructions = [{
        workspace_id: workspaceId,
        id: "instruction_bundle_system_root",
        work_id: workId,
        assignment_id: rootAssignmentId,
        room_id: roomId,
        version: 1,
        body: "Original request",
        attachment_refs: [],
        source_kind: "request",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "instruction_bundle_system_child",
        work_id: workId,
        assignment_id: childAssignmentId,
        room_id: roomId,
        version: 2,
        body: JSON.stringify({ kind: "parent_continuation", parent_assignment_id: rootAssignmentId }),
        attachment_refs: [],
        source_kind: "system",
        state: "pending",
        created_by: "account_owner",
        created_at: timestamp
      }];
      await writeMinimalV4Bundle(path.join(root, "source"), {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments,
          reservations: [{
            workspace_id: workspaceId,
            id: "reservation_bundle_system_root",
            work_id: workId,
            assignment_id: rootAssignmentId,
            room_id: roomId,
            generation: 0,
            status: "released",
            operation_id: "operation_bundle_system_root",
            scheduled_at: timestamp,
            lease_owner: null,
            lease_expires_at: null,
            claimed_at: null,
            released_at: timestamp,
            created_at: timestamp,
            updated_at: timestamp
          }, {
            workspace_id: workspaceId,
            id: "reservation_bundle_system_child",
            work_id: workId,
            assignment_id: childAssignmentId,
            room_id: roomId,
            generation: 0,
            status: "reserved",
            operation_id: "operation_bundle_system_child",
            scheduled_at: timestamp,
            lease_owner: null,
            lease_expires_at: null,
            claimed_at: null,
            released_at: null,
            created_at: timestamp,
            updated_at: timestamp
          }],
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(path.join(root, "source")))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a structurally proven v95 reply continuation while preserving its raw origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-legacy-reply-continuation-"));
    try {
      const source = path.join(root, "source");
      const agentId = "agent_bundle_legacy_reply";
      const workId = "work_bundle_legacy_reply";
      const rootAssignmentId = "assignment_bundle_legacy_root";
      const delegatedSiblingAssignmentId = "assignment_bundle_legacy_delegated";
      const childAssignmentId = "assignment_bundle_legacy_reply";
      const agent = {
        workspace_id: workspaceId,
        id: agentId,
        display_name: "Legacy reply agent",
        description: "",
        role: "assistant",
        instructions: "Keep the Room context",
        backend_id: "samurai-native",
        enabled: true,
        status: "active",
        version: 2,
        created_by: "account_owner",
        created_at: timestamp,
        updated_at: timestamp
      };
      const work = {
        workspace_id: workspaceId,
        id: workId,
        room_id: "room_bundle_attachment",
        requester_account_id: "account_owner",
        default_agent_id: agentId,
        default_agent_version: 2,
        title: "Legacy reply work",
        objective: "Continue the historical Room work",
        completion_criteria: [],
        status: "waiting",
        stop_state: "none",
        instruction_version: 3,
        control_generation: 0,
        operation_id: "operation_bundle_legacy_reply",
        created_at: timestamp,
        updated_at: timestamp
      };
      const assignments = [{
        workspace_id: workspaceId,
        id: rootAssignmentId,
        work_id: workId,
        room_id: work.room_id,
        parent_assignment_id: null,
        dependency_assignment_ids: [],
        origin_kind: "normal",
        agent_id: agentId,
        agent_version: 2,
        instruction_version: 1,
        attempt: 1,
        priority: 0,
        status: "completed",
        current_run_id: null,
        result: { status: "completed" },
        lease_owner: null,
        lease_expires_at: null,
        created_at: timestamp,
        updated_at: timestamp,
        started_at: timestamp,
        completed_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: delegatedSiblingAssignmentId,
        work_id: workId,
        room_id: work.room_id,
        parent_assignment_id: rootAssignmentId,
        dependency_assignment_ids: [],
        agent_id: agentId,
        agent_version: 2,
        instruction_version: 2,
        attempt: 1,
        priority: 0,
        status: "completed",
        current_run_id: null,
        result: { status: "completed" },
        lease_owner: null,
        lease_expires_at: null,
        started_at: timestamp,
        completed_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: childAssignmentId,
        work_id: workId,
        room_id: work.room_id,
        parent_assignment_id: rootAssignmentId,
        dependency_assignment_ids: [],
        // v95/v96 had no server-side origin metadata for either the
        // delegated sibling or this historical reply child.
        agent_id: agentId,
        agent_version: 2,
        instruction_version: 3,
        attempt: 0,
        priority: 0,
        status: "waiting",
        current_run_id: null,
        result: null,
        lease_owner: null,
        lease_expires_at: null,
        started_at: null,
        completed_at: null,
        created_at: timestamp,
        updated_at: timestamp
      }];
      // Deliberately keep the delegated system instruction after the reply;
      // normalization must use structural keys, not JSONL order.
      const instructions = [{
        workspace_id: workspaceId,
        id: "instruction_bundle_legacy_root",
        work_id: workId,
        assignment_id: rootAssignmentId,
        room_id: work.room_id,
        version: 1,
        body: "Original request",
        attachment_refs: [],
        source_kind: "request",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "instruction_bundle_legacy_reply",
        work_id: workId,
        assignment_id: childAssignmentId,
        room_id: work.room_id,
        version: 3,
        body: "Continue the work",
        attachment_refs: [],
        source_kind: "reply",
        state: "pending",
        created_by: "account_owner",
        created_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "instruction_bundle_legacy_delegated",
        work_id: workId,
        assignment_id: delegatedSiblingAssignmentId,
        room_id: work.room_id,
        version: 2,
        body: "Delegate the supporting work",
        attachment_refs: [],
        source_kind: "system",
        state: "applied",
        created_by: "account_owner",
        created_at: timestamp
      }];
      const reservations = [{
        workspace_id: workspaceId,
        id: "reservation_bundle_legacy_root",
        work_id: workId,
        assignment_id: rootAssignmentId,
        room_id: work.room_id,
        generation: 0,
        status: "released",
        operation_id: "operation_bundle_legacy_root",
        scheduled_at: timestamp,
        lease_owner: null,
        lease_expires_at: null,
        claimed_at: null,
        released_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "reservation_bundle_legacy_delegated",
        work_id: workId,
        assignment_id: delegatedSiblingAssignmentId,
        room_id: work.room_id,
        generation: 0,
        status: "released",
        operation_id: "operation_bundle_legacy_delegated",
        scheduled_at: timestamp,
        lease_owner: null,
        lease_expires_at: null,
        claimed_at: null,
        released_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
      }, {
        workspace_id: workspaceId,
        id: "reservation_bundle_legacy_reply",
        work_id: workId,
        assignment_id: childAssignmentId,
        room_id: work.room_id,
        generation: 0,
        status: "reserved",
        operation_id: "operation_bundle_legacy_reply",
        scheduled_at: timestamp,
        lease_owner: null,
        lease_expires_at: null,
        claimed_at: null,
        released_at: null,
        created_at: timestamp,
        updated_at: timestamp
      }];
      await writeMinimalV4Bundle(source, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments,
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });

      await expect(verifyWorkspaceBundleV4(source)).resolves.toMatchObject({ manifest: { workspace_id: workspaceId } });
      const transport = await readWorkspaceBundleV4Transport(source);
      const rawAssignments = Buffer.from(
        transport.entries.find((entry) => entry.path === "completion/human-work-assignments.jsonl")!.content_base64,
        "base64"
      ).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rawAssignments.find((assignment) => assignment.id === delegatedSiblingAssignmentId)).not.toHaveProperty("origin_kind");
      expect(rawAssignments.find((assignment) => assignment.id === childAssignmentId)).not.toHaveProperty("origin_kind");

      const restored = await writeWorkspaceBundleV4Transport({
        transport,
        destination: path.join(root, "restored")
      });
      expect(restored.manifest.workspace_id).toBe(workspaceId);

      const forgedSystemContinuation = path.join(root, "forged-system-continuation");
      await writeMinimalV4Bundle(forgedSystemContinuation, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions: instructions.map((instruction) => instruction.id === "instruction_bundle_legacy_delegated"
            ? { ...instruction, body: JSON.stringify({ kind: "parent_continuation", parent_assignment_id: rootAssignmentId }) }
            : instruction),
          assignments,
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(forgedSystemContinuation))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");

      const reassignedSibling = path.join(root, "reassigned-sibling");
      await writeMinimalV4Bundle(reassignedSibling, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments: assignments.map((assignment) => assignment.id === delegatedSiblingAssignmentId
            ? { ...assignment, result: { status: "cancelled", reason: "reassigned" } }
            : assignment),
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(reassignedSibling))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");

      const nonTerminalSibling = path.join(root, "non-terminal-sibling");
      await writeMinimalV4Bundle(nonTerminalSibling, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments: assignments.map((assignment) => assignment.id === delegatedSiblingAssignmentId
            ? { ...assignment, status: "running", completed_at: null }
            : assignment),
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(nonTerminalSibling))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");

      const nonTerminalDescendant = path.join(root, "non-terminal-descendant");
      const delegatedSibling = assignments.find((assignment) => assignment.id === delegatedSiblingAssignmentId)!;
      await writeMinimalV4Bundle(nonTerminalDescendant, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments: [
            ...assignments,
            {
              ...delegatedSibling,
              id: "assignment_bundle_legacy_delegated_child",
              parent_assignment_id: delegatedSiblingAssignmentId,
              origin_kind: "delegated",
              instruction_version: 2,
              status: "queued",
              result: null,
              started_at: null,
              completed_at: null
            }
          ],
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(nonTerminalDescendant))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");

      const missingSibling = path.join(root, "missing-sibling");
      await writeMinimalV4Bundle(missingSibling, {
        agents: [agent],
        humanWork: {
          work,
          instruction: instructions[0]!,
          instructions,
          assignments: assignments.filter((assignment) => assignment.id !== delegatedSiblingAssignmentId),
          reservations,
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(missingSibling))
        .rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous legacy normal parent reply fail-closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v4-legacy-reply-ambiguous-"));
    try {
      const source = path.join(root, "source");
      const child = {
        workspace_id: workspaceId,
        id: "assignment_bundle_ambiguous_child",
        work_id: "work_bundle_ambiguous_reply",
        room_id: "room_bundle_attachment",
        parent_assignment_id: "assignment_bundle_ambiguous_root",
        dependency_assignment_ids: [],
        origin_kind: "normal",
        agent_id: "agent_bundle_ambiguous_reply",
        agent_version: 1,
        instruction_version: 2,
        attempt: 0,
        priority: 0,
        status: "waiting",
        current_run_id: null,
        result: null,
        lease_owner: null,
        lease_expires_at: null,
        started_at: null,
        completed_at: null,
        created_at: timestamp,
        updated_at: timestamp
      };
      await writeMinimalV4Bundle(source, {
        agents: [{
          workspace_id: workspaceId,
          id: "agent_bundle_ambiguous_reply",
          display_name: "Ambiguous reply agent",
          description: "",
          role: "assistant",
          instructions: "",
          backend_id: "samurai-native",
          enabled: true,
          status: "active",
          version: 1,
          created_by: "account_owner",
          created_at: timestamp,
          updated_at: timestamp
        }],
        humanWork: {
          work: {
            workspace_id: workspaceId,
            id: "work_bundle_ambiguous_reply",
            room_id: "room_bundle_attachment",
            requester_account_id: "account_owner",
            default_agent_id: "agent_bundle_ambiguous_reply",
            default_agent_version: 1,
            title: "Ambiguous reply work",
            objective: "Reject ambiguous history",
            completion_criteria: [],
            status: "waiting",
            stop_state: "none",
            instruction_version: 2,
            control_generation: 0,
            operation_id: "operation_bundle_ambiguous_reply",
            created_at: timestamp,
            updated_at: timestamp
          },
          instruction: {
            workspace_id: workspaceId,
            id: "instruction_bundle_ambiguous_root",
            work_id: "work_bundle_ambiguous_reply",
            assignment_id: "assignment_bundle_ambiguous_root",
            room_id: "room_bundle_attachment",
            version: 1,
            body: "Original request",
            attachment_refs: [],
            source_kind: "request",
            state: "applied",
            created_by: "account_owner",
            created_at: timestamp
          },
          instructions: [{
            workspace_id: workspaceId,
            id: "instruction_bundle_ambiguous_root",
            work_id: "work_bundle_ambiguous_reply",
            assignment_id: "assignment_bundle_ambiguous_root",
            room_id: "room_bundle_attachment",
            version: 1,
            body: "Original request",
            attachment_refs: [],
            source_kind: "request",
            state: "applied",
            created_by: "account_owner",
            created_at: timestamp
          }, {
            workspace_id: workspaceId,
            id: "instruction_bundle_ambiguous_child",
            work_id: "work_bundle_ambiguous_reply",
            assignment_id: "assignment_bundle_ambiguous_child",
            room_id: "room_bundle_attachment",
            version: 2,
            body: "Reply",
            attachment_refs: [],
            source_kind: "reply",
            state: "pending",
            created_by: "account_owner",
            created_at: timestamp
          }],
          assignments: [
            {
              ...child,
              id: "assignment_bundle_ambiguous_root",
              parent_assignment_id: null,
              instruction_version: 1,
              status: "completed",
              result: { status: "completed" },
              attempt: 1,
              started_at: timestamp,
              completed_at: timestamp
            },
            child,
            {
              ...child,
              id: "assignment_bundle_ambiguous_sibling",
              instruction_version: 2,
              status: "failed",
              result: { status: "failed" },
              started_at: timestamp,
              completed_at: timestamp
            }
          ],
          fileHash: hash("portable attachment\n"),
          fileContent: "portable attachment\n"
        }
      });
      await expect(verifyWorkspaceBundleV4(source)).rejects.toThrow("workspace_bundle_v4_human_work_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeMinimalV4Bundle(
  root: string,
  input: {
    migrationReceipts?: readonly Record<string, unknown>[];
    agents?: readonly Record<string, unknown>[];
    agentRoomPermissions?: readonly Record<string, unknown>[];
    chatSessions?: readonly Record<string, unknown>[];
    chatMessages?: readonly Record<string, unknown>[];
    runtimeRuns?: readonly Record<string, unknown>[];
    runtimeEvents?: readonly Record<string, unknown>[];
    runtimeChanges?: readonly Record<string, unknown>[];
    runtimeActivities?: readonly Record<string, unknown>[];
    runtimeResourceUsage?: readonly Record<string, unknown>[];
    completionResources?: readonly Record<string, unknown>[];
    completionResourceVersions?: readonly Record<string, unknown>[];
    completionFileBatches?: readonly Record<string, unknown>[];
    completionFileBatchEntries?: readonly Record<string, unknown>[];
    completionBodies?: Readonly<Record<string, string | Uint8Array>>;
    humanWork?: {
      work: Record<string, unknown>;
      instruction: Record<string, unknown>;
      instructions?: readonly Record<string, unknown>[];
      comments?: readonly Record<string, unknown>[];
      assignments?: readonly Record<string, unknown>[];
      reservations?: readonly Record<string, unknown>[];
      fileHash: string;
      fileContent: string;
      roomKind?: "normal" | "agent_dm";
      dmAccountId?: string;
    };
    provenance?: { sourceOrganizationId: string; schemaRevision: number };
  } = {}
): Promise<void> {
  const base = path.join(root, "base-v3");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const baseFiles: Record<string, string> = {
    "workspace.json": canonicalJson({
      id: workspaceId,
      name: "Bundle v4 test",
      hosting_mode: "self_host",
      database_placement: "dedicated",
      storage_namespace: `workspaces/${workspaceId}`,
      created_by: "account_owner",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    }),
    "accounts.jsonl": "",
    "rooms.jsonl": "",
    "memberships.jsonl": `${canonicalJson({
      workspace_id: workspaceId,
      account_id: "account_owner",
      role: "owner",
      state: "active",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null
    })}\n`,
    "room-memberships.jsonl": "",
    "records.jsonl": "",
    "events.jsonl": "",
    "jobs.jsonl": "",
    "operations.jsonl": "",
    "invitations.jsonl": "",
    "audits.jsonl": "",
    "files.jsonl": ""
  };
  if (input.humanWork) {
    const room = {
      workspace_id: workspaceId,
      id: "room_bundle_attachment",
      name: "Attachments",
      version: 1,
      created_by: "account_owner",
      created_at: timestamp,
      updated_at: timestamp,
      ...(input.humanWork.roomKind === "agent_dm" ? {
        room_kind: "agent_dm",
        default_agent_id: input.humanWork.work.default_agent_id,
        default_agent_version: input.humanWork.work.default_agent_version,
        dm_account_id: input.humanWork.dmAccountId ?? "account_owner"
      } : {})
    };
    const file = {
      workspace_id: workspaceId,
      room_id: room.id,
      path: "notes/brief.md",
      version: 1,
      sha256: input.humanWork.fileHash,
      size: Buffer.byteLength(input.humanWork.fileContent),
      created_by: "account_owner",
      updated_by: "account_owner",
      created_at: timestamp,
      updated_at: timestamp
    };
    baseFiles["rooms.jsonl"] = `${canonicalJson(room)}\n`;
    baseFiles["room-memberships.jsonl"] = `${canonicalJson({
      workspace_id: workspaceId,
      room_id: room.id,
      account_id: "account_owner",
      role: "owner",
      state: "active",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null
    })}\n`;
    baseFiles["files.jsonl"] = `${canonicalJson(file)}\n`;
  }
  const baseHashes = Object.fromEntries(Object.entries(baseFiles).map(([name, content]) => [name, hash(content)]));
  for (const [name, content] of Object.entries(baseFiles)) await writeFile(path.join(base, name), content, "utf8");
  if (input.humanWork) {
    await mkdir(path.join(base, "files", "notes"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(base, "files", "notes", "brief.md"), input.humanWork.fileContent, { flag: "wx", mode: 0o600 });
    baseHashes["files/notes/brief.md"] = input.humanWork.fileHash;
  }
  const baseRecordCounts = { rooms: input.humanWork ? 1 : 0, memberships: 1, room_memberships: input.humanWork ? 1 : 0, records: 0, events: 0, jobs: 0, operations: 0, invitations: 0, audits: 0, files: input.humanWork ? 1 : 0 };
  const baseProvenance = input.provenance;
  const baseIntegrityPayload = baseProvenance
    ? {
      files: baseHashes,
      record_counts: baseRecordCounts,
      source: {
        hosting_mode: "self_host",
        database_placement: "dedicated",
        organization_id: baseProvenance.sourceOrganizationId
      },
      schema_version: baseProvenance.schemaRevision,
      schema_revision: baseProvenance.schemaRevision,
      transfer_id: transferId
    }
    : { files: baseHashes, record_counts: baseRecordCounts };
  const baseIntegrityHash = hash(canonicalJson(baseIntegrityPayload));
  await writeFile(path.join(base, "manifest.json"), canonicalJson({
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: timestamp,
    source: {
      hosting_mode: "self_host",
      database_placement: "dedicated",
      ...(baseProvenance ? { organization_id: baseProvenance.sourceOrganizationId } : {})
    },
    schema_version: baseProvenance?.schemaRevision ?? 26,
    ...(baseProvenance ? {
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision
    } : {}),
    transfer_id: transferId,
    files: baseHashes,
    record_counts: baseRecordCounts,
    integrity_hash: baseIntegrityHash
  }), "utf8");

  const completionRoot = path.join(root, "completion");
  await mkdir(completionRoot, { recursive: true, mode: 0o700 });
  const migrationReceipts = input.migrationReceipts ?? [];
  const agents = input.agents ?? [];
  const agentRoomPermissions = input.agentRoomPermissions ?? [];
  const chatSessions = input.chatSessions ?? [];
  const chatMessages = input.chatMessages ?? [];
  const runtimeRuns = input.runtimeRuns ?? [];
  const runtimeEvents = input.runtimeEvents ?? [];
  const runtimeChanges = input.runtimeChanges ?? [];
  const runtimeActivities = input.runtimeActivities ?? [];
  const runtimeResourceUsage = input.runtimeResourceUsage ?? [];
  const completionResources = input.completionResources ?? [];
  const completionResourceVersions = input.completionResourceVersions ?? [];
  const completionFileBatches = input.completionFileBatches ?? [];
  const completionFileBatchEntries = input.completionFileBatchEntries ?? [];
  for (const file of completionFiles) {
    const rows = file === "migration-receipts.jsonl"
      ? migrationReceipts
      : file === "agents.jsonl"
        ? agents
        : file === "agent-room-permissions.jsonl"
          ? agentRoomPermissions
        : file === "runtime-sessions.jsonl"
          ? chatSessions
          : file === "runtime-messages.jsonl"
            ? chatMessages
            : file === "runtime-runs.jsonl"
              ? runtimeRuns
              : file === "runtime-events.jsonl"
                ? runtimeEvents
                : file === "runtime-changes.jsonl"
                  ? runtimeChanges
                  : file === "runtime-activities.jsonl"
                    ? runtimeActivities
                    : file === "runtime-resource-usage.jsonl"
                      ? runtimeResourceUsage
                      : file === "resources.jsonl"
                        ? completionResources
                        : file === "resource-versions.jsonl"
                          ? completionResourceVersions
                          : file === "file-batches.jsonl"
                            ? completionFileBatches
                            : file === "file-batch-entries.jsonl"
                              ? completionFileBatchEntries
                              : [];
    const content = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
    await writeFile(path.join(completionRoot, file), content, { flag: "wx", mode: 0o600 });
  }
  for (const [relative, content] of Object.entries(input.completionBodies ?? {})) {
    const destination = path.join(completionRoot, "files", relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  }
  if (input.humanWork) {
    const instructions = input.humanWork.instructions ?? [input.humanWork.instruction];
    const comments = input.humanWork.comments ?? [];
    const assignments = input.humanWork.assignments ?? [];
    const reservations = input.humanWork.reservations ?? [];
    for (const [table, file] of humanWorkFiles) {
      const rows = table === "workspace_human_works"
        ? [input.humanWork.work]
        : table === "workspace_human_work_instructions"
          ? instructions
          : table === "workspace_human_work_comments"
            ? comments
          : table === "workspace_human_work_assignments"
            ? assignments
            : table === "workspace_human_work_launch_reservations"
              ? reservations
          : [];
      const content = rows.map((row) => canonicalJson(row)).join("\n") + (rows.length ? "\n" : "");
      await writeFile(path.join(completionRoot, file), content, { flag: "wx", mode: 0o600 });
    }
  }
  const files = await hashFiles(root);
  const recordCounts = Object.fromEntries(recordCountKeys.map((key) => [
    key,
    key === "migration_receipts"
      ? migrationReceipts.length
      : key === "agents"
        ? agents.length
        : key === "agent_room_permissions"
          ? agentRoomPermissions.length
        : key === "runtime_sessions"
          ? chatSessions.length
          : key === "runtime_messages"
            ? chatMessages.length
            : key === "runtime_runs"
              ? runtimeRuns.length
              : key === "runtime_events"
                ? runtimeEvents.length
              : key === "runtime_changes"
                ? runtimeChanges.length
                : key === "runtime_activities"
                  ? runtimeActivities.length
                : key === "runtime_resource_usage"
                  ? runtimeResourceUsage.length
                  : key === "resources"
                    ? completionResources.length
                    : key === "resource_versions"
                      ? completionResourceVersions.length
                      : key === "file_batches"
                        ? completionFileBatches.length
                        : key === "file_batch_entries"
                          ? completionFileBatchEntries.length
                          : 0
  ]));
  if (input.humanWork) {
    const humanWorkRows: Record<string, readonly Record<string, unknown>[]> = {
      workspace_human_works: [input.humanWork.work],
      workspace_human_work_assignments: input.humanWork.assignments ?? [],
      workspace_human_work_instructions: input.humanWork.instructions ?? [input.humanWork.instruction],
      workspace_human_work_comments: input.humanWork.comments ?? [],
      workspace_human_work_launch_reservations: input.humanWork.reservations ?? []
    };
    Object.assign(recordCounts, Object.fromEntries(humanWorkFiles.map(([table]) => [
      table.replace(/^workspace_/, ""),
      humanWorkRows[table]?.length ?? 0
    ])));
  }
  const v4RecordCounts = recordCounts;
  const v4ManifestBase = {
    format_version: 4,
    workspace_id: workspaceId,
    exported_at: timestamp,
    transfer_id: transferId,
    ...(baseProvenance ? {
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision,
      schema_version: baseProvenance.schemaRevision
    } : {}),
    base_v3_integrity_hash: baseIntegrityHash,
    excluded_maintenance_account_ids: [],
    files,
    record_counts: v4RecordCounts,
    integrity_hash: ""
  } as Record<string, unknown>;
  const v4IntegrityPayload = baseProvenance
    ? {
      files,
      record_counts: v4RecordCounts,
      transfer_id: transferId,
      base_v3_integrity_hash: baseIntegrityHash,
      excluded_maintenance_account_ids: [],
      source_organization_id: baseProvenance.sourceOrganizationId,
      schema_revision: baseProvenance.schemaRevision,
      schema_version: baseProvenance.schemaRevision
    }
    : {
      files,
      record_counts: v4RecordCounts,
      transfer_id: transferId,
      base_v3_integrity_hash: baseIntegrityHash,
      excluded_maintenance_account_ids: []
    };
  v4ManifestBase.integrity_hash = hash(canonicalJson(v4IntegrityPayload));
  await writeFile(path.join(root, "manifest.json"), canonicalJson(v4ManifestBase), "utf8");
}

async function hashFiles(root: string, prefix = ""): Promise<Record<string, string>> {
  const directory = path.join(root, prefix);
  const entries = readdir(directory, { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of (await entries).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await hashFiles(root, relative));
    else if (!(entry.name === "manifest.json" && prefix === "")) result[relative] = hashBytes(await readFile(path.join(root, relative)));
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

async function readFileText(file: string): Promise<string> {
  return (await readFile(file, "utf8"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
