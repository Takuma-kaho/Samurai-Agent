import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./auth";
import { WorkspaceServerError } from "./errors";
import type { WorkspaceServerStore } from "./workspace-server-store";
import {
  readWorkspaceBundleV3Transport,
  verifyWorkspaceBundleV3,
  WORKSPACE_BUNDLE_MAX_ENTRY_BYTES,
  workspaceTransferBundleId,
  workspaceTransferRetryDestination,
  WorkspaceBundleV3Service,
  writeWorkspaceBundleV3Transport
} from "./workspace-bundle-v3";

describe("Workspace Bundle v3 credential boundary", () => {
  it("uses a fresh Bundle ID and sibling path for a transfer retry", async () => {
    const destination = path.join(os.tmpdir(), "samurai-transfer-bundle");

    expect(workspaceTransferBundleId("transfer_bundle_retry", 1)).toBe("bundle_transfer_bundle_retry");
    expect(workspaceTransferBundleId("transfer_bundle_retry", 4)).toBe("bundle_transfer_bundle_retry_attempt_4");
    expect(workspaceTransferBundleId("transfer_bundle_retry", 4)).not.toBe(workspaceTransferBundleId("transfer_bundle_retry", 1));
    expect(workspaceTransferRetryDestination(destination, 4)).toBe(`${path.resolve(destination)}.attempt-4`);
    expect(workspaceTransferRetryDestination(destination, 4)).not.toBe(path.resolve(destination));
  });

  it("serializes PostgreSQL Date values as ISO timestamps in an exported Bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-date-"));
    try {
      const workspaceId = "workspace_bundle_date_test";
      const timestamp = new Date("2026-08-24T00:00:00.000Z");
      const sql = {
        query: async <T extends Record<string, unknown>>(query: string): Promise<{ rows: T[] }> => {
          if (query.includes("samurai_can_workspace")) return { rows: [{ allowed: true } as T] };
          if (query.includes("FROM workspaces")) {
            return {
              rows: [{
                id: workspaceId,
                name: "Date bundle test",
                organization_id: "organization_source",
                hosting_mode: "self_host",
                database_placement: "dedicated",
                storage_namespace: `workspaces/${workspaceId}`,
                created_by: "account_owner",
                version: 1,
                created_at: timestamp,
                updated_at: timestamp
              } as T]
            };
          }
          if (query.includes("FROM workspace_members")) {
            return {
              rows: [{
                workspace_id: workspaceId,
                account_id: "account_owner",
                role: "owner",
                state: "active",
                version: 1,
                created_at: timestamp,
                updated_at: timestamp,
                revoked_at: null
              } as T]
            };
          }
          if (query.includes("FROM workspace_audit_entries")) {
            return {
              rows: [{
                source_audit_id: "audit_org_provenance",
                workspace_id: workspaceId,
                room_id: null,
                actor_account_id: "account_owner",
                action: "workspace.test",
                outcome: "success",
                operation_id: "operation_bundle_date_test",
                subject_kind: "workspace",
                subject_id: "workspace_bundle_date_test",
                before_version: 1,
                after_version: 2,
                details: {
                  source_organization_id: "organization_source",
                  nested: { targetOrganizationId: "organization_target", retained: true }
                },
                created_at: timestamp
              } as T]
            };
          }
          return { rows: [] };
        }
      };
      const store = {
        mode: "self_host",
        storageRoot: root,
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql),
          withReadSnapshot: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      } as unknown as WorkspaceServerStore;

      const exported = await new WorkspaceBundleV3Service(store).writePortableSnapshot({
        workspaceId,
        accountId: "account_owner",
        operationId: "operation_bundle_date_test"
      }, { destination: path.join(root, "bundle") });
      expect(exported.manifest.workspace_id).toBe(workspaceId);
      expect(exported.manifest).toMatchObject({
        schema_revision: 26
      });
      expect(exported.manifest).not.toHaveProperty("source_organization_id");
      expect(exported.manifest.source).not.toHaveProperty("organization_id");
      const workspace = JSON.parse(await readFile(path.join(root, "bundle", "workspace.json"), "utf8")) as Record<string, unknown>;
      expect(workspace).not.toHaveProperty("organization_id");
      await expect(verifyWorkspaceBundleV3(path.join(root, "bundle"))).resolves.toMatchObject({
        manifest: { schema_revision: 26 }
      });

      const membership = JSON.parse((await readFile(path.join(root, "bundle", "memberships.jsonl"), "utf8")).trim()) as {
        created_at: unknown;
        updated_at: unknown;
      };
      expect(membership.created_at).toBe(timestamp.toISOString());
      expect(membership.updated_at).toBe(timestamp.toISOString());
      const audit = JSON.parse((await readFile(path.join(root, "bundle", "audits.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(audit.details).toEqual({ nested: { retained: true } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters retired Workspace Knowledge/Memory from export and writes enabled_inherits_workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-export-"));
    try {
      const resourceContent = { title: "Room knowledge", content: "Keep room context", payload: {} };
      const resourceHash = hash(canonicalJson(resourceContent));
      const sql = {
        query: async <T extends Record<string, unknown>>(query: string): Promise<{ rows: T[] }> => {
          if (query.includes("samurai_can_workspace")) return { rows: [{ allowed: true } as T] };
          if (query.includes("FROM workspaces")) return { rows: [{
            id: workspaceId, name: "Export context", organization_id: null, hosting_mode: "self_host",
            database_placement: "dedicated", storage_namespace: `workspaces/${workspaceId}`,
            created_by: accountId, version: 1, created_at: timestamp, updated_at: timestamp
          } as T] };
          if (query.includes("samurai_server_schema_migrations")) return { rows: [{ revision: 129 } as T] };
          if (query.includes("FROM workspace_members")) return { rows: [{
            workspace_id: workspaceId, account_id: accountId, role: "owner", state: "active", version: 1,
            created_at: timestamp, updated_at: timestamp, revoked_at: null
          } as T] };
          if (query.includes("FROM room_members")) return { rows: [roomMembership("room_root") as T] };
          if (query.includes("FROM rooms")) return { rows: [room("room_root") as T] };
          if (query.includes("FROM workspace_learning_resources")) return { rows: [{
            workspace_id: workspaceId, id: "room_resource", scope_kind: "room", room_id: "room_root", resource_kind: "knowledge",
            state: "active", is_absolute_rule: false, ai_update_locked: false, confidence: null, source_job_id: null,
            source_attempt_id: null, ...resourceContent, version: 1, created_by: accountId, updated_by: accountId,
            archived_at: null, created_at: timestamp, updated_at: timestamp
          } as T, {
            workspace_id: workspaceId, id: "retired_workspace_memory", scope_kind: "workspace", room_id: null, resource_kind: "memory",
            state: "active", is_absolute_rule: false, ai_update_locked: false, confidence: null, source_job_id: null,
            source_attempt_id: null, title: "Old memory", content: "Do not export", payload: {}, version: 1,
            created_by: accountId, updated_by: accountId, archived_at: null, created_at: timestamp, updated_at: timestamp
          } as T] };
          if (query.includes("FROM workspace_learning_resource_versions")) return { rows: [{
            workspace_id: workspaceId, id: "room_resource_v1", resource_id: "room_resource", version: 1,
            change_kind: "created", scope_kind: "room", room_id: "room_root", state: "active", ai_update_locked: false,
            confidence: null, source_job_id: null, source_attempt_id: null, ...resourceContent,
            content_hash: resourceHash, reason: "created", actor_account_id: accountId, created_at: timestamp
          } as T] };
          if (query.includes("FROM workspace_learning_settings")) return { rows: [{
            workspace_id: workspaceId, id: "room:room_root", scope_kind: "room", room_id: "room_root", enabled: true,
            enabled_inherits_workspace: true, engine_id: "engine_local", model: "model_one", currency_limit: 10,
            token_limit: 1000, currency_used: 7, tokens_used: 70, currency_reserved: 0, tokens_reserved: 0,
            version: 1, updated_by: accountId, updated_at: timestamp
          } as T] };
          return { rows: [] };
        }
      };
      const store = {
        mode: "self_host",
        storageRoot: root,
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql),
          withReadSnapshot: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      } as unknown as WorkspaceServerStore;

      const exported = await new WorkspaceBundleV3Service(store).writePortableSnapshot({
        workspaceId, accountId, operationId: "operation_export_context"
      }, { destination: path.join(root, "bundle") });
      const resources = (await readFile(path.join(root, "bundle", "learning-resources.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(resources).toHaveLength(1);
      expect(resources[0]?.id).toBe("room_resource");
      const settings = JSON.parse((await readFile(path.join(root, "bundle", "learning-settings.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(settings).toMatchObject({ enabled_inherits_workspace: true, currency_used: 7, tokens_used: 70 });
      expect(exported.manifest.record_counts.learning_resources).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts historical source Organization provenance for old Bundles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-provenance-"));
    try {
      await writeHierarchyBundle(root, {
        sourceOrganizationId: "organization_source",
        schemaVersion: 78,
        schemaRevision: 78,
        rooms: [],
        roomMemberships: []
      });

      const verified = await verifyWorkspaceBundleV3(root);
      expect(verified.manifest).toMatchObject({
        source_organization_id: "organization_source",
        schema_version: 78,
        schema_revision: 78,
        source: { organization_id: "organization_source" }
      });

      const manifestPath = path.join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.schema_revision = 79;
      await writeFile(manifestPath, canonicalJson(manifest), "utf8");
      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_manifest_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a Bundle without a target Organization by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-target-"));
    try {
      await writeHierarchyBundle(root, { rooms: [], roomMemberships: [] });
      const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")) as never;
      const store = { storageRoot: root } as unknown as WorkspaceServerStore;
      const service = new WorkspaceBundleV3Service(store);
      await expect(service.stageIncomingBundle({
        accountId: accountId,
        operationId: "operation_bundle_target_test"
      }, {
        targetWorkspaceId: workspaceId,
        manifest
      })).resolves.toBeUndefined();
      const metadata = JSON.parse(await readFile(path.join(root, ".incoming", accountId, "operation_bundle_target_test.json"), "utf8")) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("target_organization_id");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a credential-shaped field inside a portable record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const workspaceId = "workspace_bundle_test";
      const files = new Map<string, string>([
        ["workspace.json", canonicalJson({
          id: workspaceId,
          name: "Bundle test",
          hosting_mode: "self_host",
          database_placement: "dedicated",
          storage_namespace: `workspaces/${workspaceId}`,
          created_by: "account_owner",
          version: 1,
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })],
        ["accounts.jsonl", ""],
        ["rooms.jsonl", ""],
        ["memberships.jsonl", ""],
        ["room-memberships.jsonl", ""],
        ["records.jsonl", `${canonicalJson({
          workspace_id: workspaceId,
          room_id: "room_one",
          record_type: "knowledge",
          id: "record_one",
          version: 1,
          payload: { client_secret: "must-not-export", oauth_client_secret: "must-also-not-export" },
          search_text: "",
          content_hash: "0".repeat(64),
          created_by: "account_owner",
          updated_by: "account_owner",
          created_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:00.000Z"
        })}\n`],
        ["events.jsonl", ""],
        ["jobs.jsonl", ""],
        ["operations.jsonl", ""],
        ["invitations.jsonl", ""],
        ["audits.jsonl", ""],
        ["files.jsonl", ""]
      ]);
      const hashes = Object.fromEntries([...files.entries()].map(([name, content]) => [name, hash(content)]).sort(([left], [right]) => left.localeCompare(right)));
      const recordCounts = {
        rooms: 0, memberships: 0, room_memberships: 0, records: 1, events: 0,
        jobs: 0, operations: 0, invitations: 0, audits: 0, files: 0
      };
      for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
      await writeFile(path.join(root, "manifest.json"), canonicalJson({
        format_version: 3,
        workspace_id: workspaceId,
        exported_at: "2026-08-14T00:00:00.000Z",
        source: { hosting_mode: "self_host", database_placement: "dedicated" },
        schema_version: 22,
        files: hashes,
        record_counts: recordCounts,
        integrity_hash: hash(canonicalJson({ files: hashes, record_counts: recordCounts }))
      }), "utf8");

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_contains_credential");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a legacy root Room with no parent field", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        schemaVersion: 21,
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")]
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { schema_version: 21 }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a workspace-scoped public Event and preserves its public fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [],
        roomMemberships: [],
        events: [{
          source_event_id: 17,
          workspace_id: workspaceId,
          room_id: null,
          kind: "workspace.agent.changed",
          record_type: "agent",
          record_id: "agent_one",
          operation_id: "operation_one",
          payload: { agent_id: "agent_one", action: "patched" },
          created_at: timestamp,
          event_id: "event_agent_one",
          event_version: "1.0",
          actor_kind: "human",
          actor_id: accountId,
          organization_id: null,
          cursor: "cursor_agent_one",
          correlation_id: "correlation_one",
          resources: [{ kind: "agent", id: "agent_one", uri: "samurai://agent/agent_one", label: "Agent" }]
        }]
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { record_counts: { events: 1 } }
      });
      const event = JSON.parse((await readFile(path.join(root, "events.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(event).toMatchObject({
        room_id: null,
        event_id: "event_agent_one",
        event_version: "1.0",
        actor_kind: "human",
        actor_id: accountId,
        cursor: "cursor_agent_one",
        correlation_id: "correlation_one"
      });
      expect(event.resources).toEqual([{ kind: "agent", id: "agent_one", uri: "samurai://agent/agent_one", label: "Agent" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a legacy V3 Event without public Event fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        events: [{
          source_event_id: 18,
          workspace_id: workspaceId,
          room_id: "room_root",
          kind: "legacy.event",
          record_type: null,
          record_id: null,
          operation_id: "legacy_operation",
          payload: { legacy: true },
          created_at: timestamp
        }]
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { record_counts: { events: 1 } }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed public Event fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [],
        roomMemberships: [],
        events: [{
          source_event_id: 19,
          workspace_id: workspaceId,
          room_id: null,
          kind: "workspace.agent.changed",
          record_type: "agent",
          record_id: "agent_one",
          operation_id: "operation_one",
          payload: {},
          created_at: timestamp,
          event_id: "event_agent_one",
          event_version: "broken",
          actor_kind: "human",
          actor_id: accountId,
          organization_id: null,
          cursor: "cursor_agent_one",
          correlation_id: "correlation_one",
          resources: []
        }]
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_schema_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a child Room whose direct member is absent from its parent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root"), room("room_child", "room_root")],
        roomMemberships: [roomMembership("room_child")]
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a cyclic Room hierarchy before Restore can write anything", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_a", "room_b"), room("room_b", "room_a")],
        roomMemberships: [roomMembership("room_a"), roomMembership("room_b")]
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a deliberately deep valid hierarchy without recursive validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const rooms: Record<string, unknown>[] = [];
      const roomMemberships: Record<string, unknown>[] = [];
      let parentRoomId: string | undefined;
      for (let index = 0; index < 1200; index += 1) {
        const roomId = `room_deep_${index}`;
        rooms.push(room(roomId, parentRoomId));
        roomMemberships.push(roomMembership(roomId));
        parentRoomId = roomId;
      }
      await writeHierarchyBundle(root, { rooms, roomMemberships });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({ manifest: { record_counts: { rooms: 1200 } } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a complete, credential-free learning history and binds every evidence row", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-activities.jsonl": [{
            workspace_id: workspaceId, room_id: "room_root", id: "activity_one", group_key: "group_one",
            principal_account_id: accountId, source_kind: "test", source_id: null, correction_of_activity_id: null,
            instruction_summary: "Deploy", result_summary: "Passed", outcome: "completed", verification_state: "confirmed",
            failure_state: "none", explicit_remember: false, payload: {}, created_at: timestamp, finalized_at: timestamp
          }],
          "learning-resources.jsonl": [{
            workspace_id: workspaceId, id: "resource_one", scope_kind: "room", room_id: "room_root",
            resource_kind: "knowledge", state: "active", is_absolute_rule: false, ai_update_locked: false,
            title: "Deploy procedure", content: "Run the verified deployment", payload: {}, version: 1,
            created_by: accountId, updated_by: accountId, archived_at: null, created_at: timestamp, updated_at: timestamp
          }],
          "learning-resource-versions.jsonl": [{
            workspace_id: workspaceId, id: "version_one", resource_id: "resource_one", version: 1,
            change_kind: "created", scope_kind: "room", room_id: "room_root", state: "active", ai_update_locked: false,
            title: "Deploy procedure", content: "Run the verified deployment", payload: {},
            content_hash: hash(canonicalJson({ title: "Deploy procedure", content: "Run the verified deployment", payload: {} })),
            reason: "Initial evidence", actor_account_id: accountId, created_at: timestamp
          }],
          "learning-evidence.jsonl": [{
            workspace_id: workspaceId, id: "evidence_one", resource_id: "resource_one", resource_version: 1,
            activity_id: "activity_one", kind: "activity", summary: "Deploy", created_at: timestamp
          }],
          "learning-settings.jsonl": [{
            workspace_id: workspaceId, id: "workspace", scope_kind: "workspace", room_id: null, enabled: true,
            engine_id: "engine_local", model: "model_one", currency_limit: 10, token_limit: 1000,
            currency_used: 0, tokens_used: 0, version: 1, updated_by: accountId, updated_at: timestamp
          }],
          "learning-jobs.jsonl": [{
            workspace_id: workspaceId, room_id: "room_root", id: "job_one", kind: "review", status: "completed",
            priority: "normal", group_key: "group_one", high_watermark_activity_id: "activity_one", next_run_at: timestamp,
            attempt_count: 1, max_attempts: 5, lease_owner: null, lease_expires_at: null, heartbeat_at: null,
            blocked_reason: null, engine_id: "engine_local", model: "model_one", created_by: accountId,
            updated_by: accountId, created_at: timestamp, updated_at: timestamp, completed_at: timestamp
          }],
          "learning-job-attempts.jsonl": [{
            workspace_id: workspaceId, id: "attempt_one", job_id: "job_one", attempt_no: 1, worker_id: "worker_one",
            engine_id: "engine_local", model: "model_one", status: "completed", input_hash: "b".repeat(64),
            output_hash: "c".repeat(64), output: {}, error_code: null, currency_used: 1, tokens_used: 10,
            started_at: timestamp, completed_at: timestamp
          }],
          "learning-resource-uses.jsonl": [{
            workspace_id: workspaceId, id: "use_one", resource_id: "resource_one", resource_version: 1,
            activity_id: "activity_one", outcome: "confirmed_success", summary: "Worked", created_at: timestamp
          }]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { record_counts: { learning_resources: 1, learning_jobs: 1 } }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a learning settings row whose id cannot be updated through its declared scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-settings.jsonl": [{
            workspace_id: workspaceId, id: "arbitrary_settings_id", scope_kind: "workspace", room_id: null,
            enabled: true, engine_id: null, model: null, currency_limit: null, token_limit: null,
            currency_used: 0, tokens_used: 0, version: 1, updated_by: accountId, updated_at: timestamp
          }]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects retired Workspace Knowledge/Memory while retaining Room learning and settings inheritance", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-resources.jsonl": [{
            workspace_id: workspaceId, id: "workspace_memory", scope_kind: "workspace", room_id: null,
            resource_kind: "memory", state: "active", is_absolute_rule: false, ai_update_locked: false,
            title: "Retired memory", content: "must be rejected", payload: {}, version: 1,
            created_by: accountId, updated_by: accountId, archived_at: null, created_at: timestamp, updated_at: timestamp
          }],
          "learning-settings.jsonl": [{
            workspace_id: workspaceId, id: "workspace", scope_kind: "workspace", room_id: null, enabled: true,
            enabled_inherits_workspace: false, engine_id: "engine_local", model: "model_one",
            currency_limit: 10, token_limit: 1000, currency_used: 3, tokens_used: 42,
            version: 1, updated_by: accountId, updated_at: timestamp
          }]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_memory_removed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves Room Knowledge/Skill and the inherit flag in portable validation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      const roomContent = { title: "Room knowledge", content: "Keep this", payload: {} };
      const skillContent = { title: "Workspace skill", content: "Keep this too", payload: {} };
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        learning: {
          "learning-resources.jsonl": [
            {
              workspace_id: workspaceId, id: "room_knowledge", scope_kind: "room", room_id: "room_root",
              resource_kind: "knowledge", state: "active", is_absolute_rule: false, ai_update_locked: false,
              ...roomContent, version: 1, created_by: accountId, updated_by: accountId,
              archived_at: null, created_at: timestamp, updated_at: timestamp
            },
            {
              workspace_id: workspaceId, id: "workspace_skill", scope_kind: "workspace", room_id: null,
              resource_kind: "skill", state: "active", is_absolute_rule: false, ai_update_locked: false,
              ...skillContent, version: 1, created_by: accountId, updated_by: accountId,
              archived_at: null, created_at: timestamp, updated_at: timestamp
            }
          ],
          "learning-resource-versions.jsonl": [
            {
              workspace_id: workspaceId, id: "room_knowledge_v1", resource_id: "room_knowledge", version: 1,
              change_kind: "created", scope_kind: "room", room_id: "room_root", state: "active", ai_update_locked: false,
              ...roomContent, content_hash: hash(canonicalJson(roomContent)), reason: "created",
              actor_account_id: accountId, created_at: timestamp
            },
            {
              workspace_id: workspaceId, id: "workspace_skill_v1", resource_id: "workspace_skill", version: 1,
              change_kind: "created", scope_kind: "workspace", room_id: null, state: "active", ai_update_locked: false,
              ...skillContent, content_hash: hash(canonicalJson(skillContent)), reason: "created",
              actor_account_id: accountId, created_at: timestamp
            }
          ],
          "learning-settings.jsonl": [
            {
              workspace_id: workspaceId, id: "workspace", scope_kind: "workspace", room_id: null, enabled: true,
              enabled_inherits_workspace: false, engine_id: "engine_local", model: "model_one",
              currency_limit: 10, token_limit: 1000, currency_used: 3, tokens_used: 42,
              version: 1, updated_by: accountId, updated_at: timestamp
            },
            {
              workspace_id: workspaceId, id: "room:room_root", scope_kind: "room", room_id: "room_root", enabled: true,
              enabled_inherits_workspace: true, engine_id: "engine_local", model: "model_one",
              currency_limit: 20, token_limit: 2000, currency_used: 4, tokens_used: 84,
              version: 1, updated_by: accountId, updated_at: timestamp
            }
          ]
        }
      });

      await expect(verifyWorkspaceBundleV3(root)).resolves.toMatchObject({
        manifest: { record_counts: { learning_resources: 2, learning_resource_versions: 2, learning_settings: 2 } }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("verifies sharing records while excluding notification and outbox files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: {
          "workspace-shares.jsonl": [{
            workspace_id: workspaceId, id: "share_one", source_kind: "room_knowledge", source_room_id: "room_root",
            source_agent_id: null, created_by: accountId, title: "Shared room knowledge", status: "active",
            visibility: "restricted", revision: 1, source_versions: [], manifest_path: "shares/share_one/1.json",
            content_hash: "a".repeat(64), byte_size: 12, public_locator: "l".repeat(43), created_at: timestamp,
            updated_at: timestamp, published_at: timestamp, revoked_at: null
          }],
          "workspace-share-recipients.jsonl": [{ workspace_id: workspaceId, share_id: "share_one", recipient_account_id: "recipient_external" }],
          "workspace-share-claims.jsonl": [{
            workspace_id: workspaceId, id: "claim_one", share_id: "share_one", recipient_account_id: "recipient_external",
            target_origin: "https://target.example", target_workspace_id: "target_workspace", operation_id: "operation_claim",
            request_hash: "b".repeat(64), content_hash: "a".repeat(64), created_at: timestamp
          }],
          "workspace-share-imports.jsonl": [{
            workspace_id: workspaceId, operation_id: "operation_import", recipient_account_id: accountId, kind: "room_knowledge",
            source_origin: "https://source.example", source_share_id: "share_one", source_locator: "locator_one",
            claim_id: "claim_one", request_hash: "b".repeat(64), content_hash: "a".repeat(64), target_room_id: "room_root",
            reserved_agent_id: null, reserved_resource_ids: [{ entryId: "entry_one", resourceId: "completion_resource_one" }], manifest_path: "shares/imports/operation_import.json",
            status: "committed", phase: "done", retryable: false, failure_code: null, lease_token: null, lease_until: null,
            result: { imported: true }, created_at: timestamp, updated_at: timestamp, committed_at: timestamp
          }],
          "workspace-share-import-resources.jsonl": [{ workspace_id: workspaceId, operation_id: "operation_import", entry_id: "entry_one", resource_id: "completion_resource_one" }],
          "workspace-share-file-transactions.jsonl": [{
            workspace_id: workspaceId, id: "file_transaction_one", owner_kind: "import", owner_id: "operation_import",
            actor_account_id: accountId, status: "committed", entries: [], created_at: timestamp, updated_at: timestamp, last_error_code: null
          }]
        }
      });

      const verified = await verifyWorkspaceBundleV3(root);
      expect(verified.manifest.record_counts).toMatchObject({
        share_records: 1, share_recipients: 1, share_claims: 1, share_imports: 1,
        share_import_resources: 1, share_file_transactions: 1
      });
      await expect(readFile(path.join(root, "account-notifications.jsonl"))).rejects.toThrow();
      await expect(readFile(path.join(root, "account-notification-outbox.jsonl"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports share manifest bytes under bundle paths instead of source storage paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-share-files-"));
    const storageRoot = path.join(root, "storage");
    const sourceWorkspaceRoot = path.join(storageRoot, "workspaces", workspaceId);
    const sourcePath = "workspace-shares/pending/share_one/source/manifest.json";
    const body = Buffer.from(JSON.stringify({ schema_version: 1, entries: [] }));
    try {
      await mkdir(path.join(sourceWorkspaceRoot, path.dirname(sourcePath)), { recursive: true });
      await writeFile(path.join(sourceWorkspaceRoot, sourcePath), body);
      const sql = {
        query: async <T extends Record<string, unknown>>(query: string): Promise<{ rows: T[] }> => {
          if (query.includes("samurai_can_workspace")) return { rows: [{ allowed: true } as T] };
          if (query.includes("FROM workspaces")) return { rows: [{
            id: workspaceId, name: "Share export", organization_id: null, hosting_mode: "self_host",
            database_placement: "dedicated", storage_namespace: `workspaces/${workspaceId}`,
            created_by: accountId, version: 1, created_at: timestamp, updated_at: timestamp
          } as T] };
          if (query.includes("samurai_server_schema_migrations")) return { rows: [{ revision: 134 } as T] };
          if (query.includes("FROM workspace_members")) return { rows: [{
            workspace_id: workspaceId, account_id: accountId, role: "owner", state: "active", version: 1,
            created_at: timestamp, updated_at: timestamp, revoked_at: null
          } as T] };
          if (query.includes("FROM room_members")) return { rows: [roomMembership("room_root") as T] };
          if (query.includes("FROM rooms")) return { rows: [room("room_root") as T] };
          if (query.includes("FROM workspace_shares")) return { rows: [{
            workspace_id: workspaceId, id: "share_one", source_kind: "room_knowledge", source_room_id: "room_root",
            source_agent_id: null, created_by: accountId, title: "Shared", status: "active", visibility: "public",
            revision: 1, source_versions: [], manifest_path: sourcePath, content_hash: hash(body), byte_size: body.byteLength,
            public_locator: "l".repeat(43), created_at: timestamp, updated_at: timestamp, published_at: timestamp, revoked_at: null
          } as T] };
          return { rows: [] };
        }
      };
      const store = {
        mode: "self_host",
        storageRoot,
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql),
          withReadSnapshot: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      } as unknown as WorkspaceServerStore;

      const exported = await new WorkspaceBundleV3Service(store).writePortableSnapshot({
        workspaceId, accountId, operationId: "operation_share_export"
      }, { destination: path.join(root, "bundle") });
      const row = JSON.parse((await readFile(path.join(root, "bundle", "workspace-shares.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(row.manifest_path).toMatch(/^share-files\/manifests\//);
      expect(row.manifest_path).not.toBe(sourcePath);
      expect(await readFile(path.join(root, "bundle", String(row.manifest_path)))).toEqual(body);
      await expect(verifyWorkspaceBundleV3(exported.directory)).resolves.toBeTruthy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revokes an active share during restore without republishing its locator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    const shareBody = Buffer.from(JSON.stringify({ schema_version: 1, entries: [] }));
    const shareBundlePath = `share-files/manifests/${hash("manifests:share_restore")}.json`;
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        shareFiles: [{ path: shareBundlePath, content: shareBody }],
        sharing: {
          "workspace-shares.jsonl": [{
            workspace_id: workspaceId, id: "share_restore", source_kind: "room_knowledge", source_room_id: "room_root",
            source_agent_id: null, created_by: accountId, title: "Restore share", status: "active", visibility: "restricted",
            revision: 1, source_versions: [], manifest_path: shareBundlePath, content_hash: hash(shareBody),
            byte_size: shareBody.byteLength, public_locator: "r".repeat(43), created_at: timestamp, updated_at: timestamp,
            published_at: timestamp, revoked_at: null
          }],
          "workspace-share-recipients.jsonl": [{ workspace_id: workspaceId, share_id: "share_restore", recipient_account_id: "recipient_external" }],
          "workspace-share-claims.jsonl": [{
            workspace_id: workspaceId, id: "claim_restore", share_id: "share_restore", recipient_account_id: "recipient_external",
            target_origin: "https://target.example", target_workspace_id: "target_workspace", operation_id: "operation_restore_claim",
            request_hash: "b".repeat(64), content_hash: "a".repeat(64), created_at: timestamp
          }]
        }
      });

      const updates: unknown[][] = [];
      let shareInserted = false;
      let locatorChecks = 0;
      let insertedLocator: unknown;
      const sql = {
        query: async <T extends Record<string, unknown>>(query: string, parameters: unknown[] = []): Promise<{ rows: T[] }> => {
          if (query.includes("FROM pg_proc")) return { rows: [{ pronargs: 6, proargnames: null } as T] };
          if (query.includes("samurai_can_workspace")) return { rows: [{ allowed: true } as T] };
          if (query.includes("UPDATE workspace_shares")) {
            updates.push(parameters);
            return { rows: [] };
          }
          if (query.includes("INSERT INTO workspace_shares")) {
            shareInserted = true;
            insertedLocator = parameters[14];
            return { rows: [] };
          }
          if (query.includes("SELECT EXISTS(SELECT 1 FROM workspace_shares WHERE public_locator")) {
            locatorChecks += 1;
            return { rows: [{ exists: locatorChecks === 1 } as T] };
          }
          if (query.includes("COUNT(*)")) {
            const table = query.match(/FROM ([a-z_]+)/)?.[1];
            const count = table === "rooms" || table === "room_members" ? 1
              : table === "workspace_members" ? 1
              : (table === "workspace_shares" || table === "workspace_share_recipients" || table === "workspace_share_claims") && shareInserted ? 1
              : 0;
            return { rows: [{ count: String(count) } as T] };
          }
          if (query.includes("FROM workspaces")) return { rows: [] };
          return { rows: [] };
        }
      };
      const store = {
        mode: "self_host",
        storageRoot: root,
        getWorkspace: async () => { throw new WorkspaceServerError("workspace_not_found", 404); },
        insertAudit: async () => undefined,
        database: {
          withContext: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql),
          withReadSnapshot: async <T>(_context: unknown, action: (value: typeof sql) => Promise<T>): Promise<T> => action(sql)
        }
      } as unknown as WorkspaceServerStore;

      await new WorkspaceBundleV3Service(store).importNew({
        accountId,
        operationId: "operation_restore_bundle"
      }, {
        sourceDirectory: root,
        targetWorkspaceId: "workspace_restore_target"
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]?.[0]).toBe("workspace_restore_target");
      expect(updates[0]?.[1]).toBe("share_restore");
      expect(updates[0]?.[2]).toBe(2);
      expect(updates[0]?.[3]).not.toBe(timestamp);
      expect(locatorChecks).toBe(2);
      expect(typeof insertedLocator).toBe("string");
      expect(insertedLocator).not.toBe("r".repeat(43));
      expect(String(insertedLocator)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const restoredShareBody = await readFile(path.join(root, "workspaces", "workspace_restore_target", "workspace-shares", "restored", "manifests", `${hash("manifests:share_restore")}.json`));
      expect(restoredShareBody).toEqual(shareBody);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an incomplete share import or file transaction before restore", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: {
          "workspace-share-imports.jsonl": [{
            workspace_id: workspaceId, operation_id: "operation_pending", recipient_account_id: accountId, kind: "room_knowledge",
            source_origin: "https://source.example", source_share_id: "share_one", source_locator: "locator_one",
            claim_id: "claim_one", request_hash: "b".repeat(64), content_hash: "a".repeat(64), target_room_id: "room_root",
            reserved_agent_id: null, reserved_resource_ids: [], manifest_path: null,
            status: "staging", phase: "fetch", retryable: true, failure_code: null, lease_token: null, lease_until: null,
            result: null, created_at: timestamp, updated_at: timestamp, committed_at: null
          }]
        }
      });
      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_incomplete_share_operation");
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const fileRoot = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(fileRoot, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: {
          "workspace-share-file-transactions.jsonl": [{
            workspace_id: workspaceId, id: "file_transaction_pending", owner_kind: "draft", owner_id: "share_one",
            actor_account_id: accountId, status: "prepared", entries: [], created_at: timestamp, updated_at: timestamp, last_error_code: null
          }]
        }
      });
      await expect(verifyWorkspaceBundleV3(fileRoot)).rejects.toThrow("workspace_bundle_incomplete_share_file_transaction");
    } finally {
      await rm(fileRoot, { recursive: true, force: true });
    }
  });

  it("rejects a failed import that still has retry state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-failed-import-state-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: {
          "workspace-share-imports.jsonl": [{
            workspace_id: workspaceId, operation_id: "operation_failed_nonterminal", recipient_account_id: accountId,
            kind: "room_knowledge", source_origin: "https://source.example", source_share_id: "share_one", source_locator: "locator_one",
            claim_id: "claim_one", request_hash: "b".repeat(64), content_hash: "a".repeat(64), target_room_id: "room_root",
            reserved_agent_id: null, reserved_resource_ids: [], manifest_path: null,
            status: "failed", phase: "files", retryable: true, failure_code: "failed_once", lease_token: "lease_one", lease_until: timestamp,
            result: null, created_at: timestamp, updated_at: timestamp, committed_at: null
          }]
        }
      });
      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_failed_share_import_not_terminal");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects import-resource rows unless their import is committed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-import-resource-state-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: {
          "workspace-share-imports.jsonl": [{
            workspace_id: workspaceId, operation_id: "operation_failed_resource", recipient_account_id: accountId,
            kind: "room_knowledge", source_origin: "https://source.example", source_share_id: "share_one", source_locator: "locator_one",
            claim_id: "claim_one", request_hash: "b".repeat(64), content_hash: "a".repeat(64), target_room_id: "room_root",
            reserved_agent_id: null, reserved_resource_ids: [{ entryId: "entry_one", resourceId: "resource_one" }], manifest_path: null,
            status: "failed", phase: "cleanup", retryable: false, failure_code: "failed_once", lease_token: null, lease_until: null,
            result: null, created_at: timestamp, updated_at: timestamp, committed_at: null
          }],
          "workspace-share-import-resources.jsonl": [{
            workspace_id: workspaceId, operation_id: "operation_failed_resource", entry_id: "entry_one", resource_id: "resource_one"
          }]
        }
      });
      await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires committed import reservations and link rows to match exactly", async () => {
    const cases = [
      {
        name: "duplicate reservation",
        reserved: [{ entryId: "entry_one", resourceId: "resource_one" }, { entryId: "entry_one", resourceId: "resource_one" }],
        links: [{ entry_id: "entry_one", resource_id: "resource_one" }]
      },
      {
        name: "reservation without a link",
        reserved: [{ entryId: "entry_one", resourceId: "resource_one" }, { entryId: "entry_two", resourceId: "resource_two" }],
        links: [{ entry_id: "entry_one", resource_id: "resource_one" }]
      },
      {
        name: "link without a reservation",
        reserved: [{ entryId: "entry_one", resourceId: "resource_one" }],
        links: [{ entry_id: "entry_one", resource_id: "resource_one" }, { entry_id: "entry_two", resource_id: "resource_two" }]
      }
    ] as const;
    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), `samurai-bundle-v3-import-mapping-${testCase.name.replaceAll(" ", "-")}-`));
      try {
        await writeHierarchyBundle(root, {
          rooms: [room("room_root")],
          roomMemberships: [roomMembership("room_root")],
          sharing: {
            "workspace-share-imports.jsonl": [{
              workspace_id: workspaceId, operation_id: "operation_import_mapping", recipient_account_id: accountId,
              kind: "room_knowledge", source_origin: "https://source.example", source_share_id: "share_one", source_locator: "locator_one",
              claim_id: "claim_one", request_hash: "b".repeat(64), content_hash: "a".repeat(64), target_room_id: "room_root",
              reserved_agent_id: null, reserved_resource_ids: testCase.reserved, manifest_path: "shares/imports/operation_import_mapping.json",
              status: "committed", phase: "done", retryable: false, failure_code: null, lease_token: null, lease_until: null,
              result: { imported: true }, created_at: timestamp, updated_at: timestamp, committed_at: timestamp
            }],
            "workspace-share-import-resources.jsonl": [{
              workspace_id: workspaceId, operation_id: "operation_import_mapping", ...testCase.links[0]
            }, ...testCase.links.slice(1).map((link) => ({
              workspace_id: workspaceId, operation_id: "operation_import_mapping", ...link
            }))]
          }
        });
        await expect(verifyWorkspaceBundleV3(root)).rejects.toThrow("workspace_bundle_v3_relation_invalid");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("requires committed file transaction bodies and verifies their type, hash, and byte size", async () => {
    const body = Buffer.from("committed share body\n");
    const bodyPath = "share-files/transactions/transaction_body/final";
    const transaction = {
      workspace_id: workspaceId, id: "transaction_body", owner_kind: "draft", owner_id: "share_one",
      actor_account_id: accountId, status: "committed", entries: [{
        staged_path: "workspace-shares/pending/transaction_body/staged",
        final_path: bodyPath,
        sha256: hash(body),
        byte_size: body.byteLength,
        manifest: { kind: "room_knowledge", entries: [] }
      }], created_at: timestamp, updated_at: timestamp, last_error_code: null
    };
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-transaction-missing-"));
    try {
      await writeHierarchyBundle(missingRoot, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        sharing: { "workspace-share-file-transactions.jsonl": [transaction] }
      });
      await expect(verifyWorkspaceBundleV3(missingRoot)).rejects.toThrow("workspace_bundle_share_file_transaction_body_missing");
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    const validRoot = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-transaction-valid-"));
    try {
      await writeHierarchyBundle(validRoot, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        shareFiles: [{ path: bodyPath, content: body }],
        sharing: { "workspace-share-file-transactions.jsonl": [transaction] }
      });
      await expect(verifyWorkspaceBundleV3(validRoot)).resolves.toMatchObject({ manifest: { format_version: 3 } });
      const wrongSizeRoot = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-transaction-size-"));
      try {
        await writeHierarchyBundle(wrongSizeRoot, {
          rooms: [room("room_root")],
          roomMemberships: [roomMembership("room_root")],
          shareFiles: [{ path: bodyPath, content: body }],
          sharing: {
            "workspace-share-file-transactions.jsonl": [{
              ...transaction,
              entries: [{ ...(transaction.entries[0] as Record<string, unknown>), byte_size: body.byteLength + 1 }]
            }]
          }
        });
        await expect(verifyWorkspaceBundleV3(wrongSizeRoot)).rejects.toThrow("workspace_bundle_share_file_transaction_body_mismatch");
      } finally {
        await rm(wrongSizeRoot, { recursive: true, force: true });
      }
    } finally {
      await rm(validRoot, { recursive: true, force: true });
    }
  });

  it("round-trips a transport entry at exactly 8 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    const destination = path.join(root, "restored");
    const content = Buffer.alloc(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES, 0x61);
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        workspaceFiles: [{ path: "payload.bin", content }]
      });

      const transport = await readWorkspaceBundleV3Transport(root);
      const restored = await writeWorkspaceBundleV3Transport({ transport, destination });

      expect(restored.manifest.integrity_hash).toBe(transport.manifest.integrity_hash);
      const restoredContent = await readFile(path.join(restored.directory, "files", "payload.bin"));
      expect(restoredContent.equals(content)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an exported transport entry over 8 MiB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "samurai-bundle-v3-"));
    try {
      await writeHierarchyBundle(root, {
        rooms: [room("room_root")],
        roomMemberships: [roomMembership("room_root")],
        workspaceFiles: [{ path: "payload.bin", content: Buffer.alloc(WORKSPACE_BUNDLE_MAX_ENTRY_BYTES + 1, 0x61) }]
      });

      await expect(readWorkspaceBundleV3Transport(root)).rejects.toThrow("workspace_bundle_v3_entry_too_large");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const workspaceId = "workspace_bundle_test";
const accountId = "account_owner";
const timestamp = "2026-08-14T00:00:00.000Z";

function room(id: string, parentRoomId?: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    id,
    ...(parentRoomId ? { parent_room_id: parentRoomId } : {}),
    name: id,
    version: 1,
    created_by: accountId,
    created_at: timestamp,
    updated_at: timestamp
  };
}

function roomMembership(roomId: string): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    room_id: roomId,
    account_id: accountId,
    role: "owner",
    state: "active",
    version: 1,
    created_at: timestamp,
    updated_at: timestamp,
    revoked_at: null
  };
}

async function writeHierarchyBundle(
  root: string,
  input: {
    schemaVersion?: number;
    schemaRevision?: number;
    sourceOrganizationId?: string;
    rooms: Record<string, unknown>[];
    roomMemberships: Record<string, unknown>[];
    events?: Record<string, unknown>[];
    workspaceFiles?: Array<{ path: string; content: Uint8Array }>;
    shareFiles?: Array<{ path: string; content: Uint8Array }>;
    learning?: Partial<Record<LearningFile, Record<string, unknown>[]>>;
    sharing?: Partial<Record<SharingFile, Record<string, unknown>[]>>;
  }
): Promise<void> {
  const workspaceFiles = input.workspaceFiles ?? [];
  const shareFiles = input.shareFiles ?? [];
  const files = new Map<string, string>([
    ["workspace.json", canonicalJson({
      id: workspaceId,
      name: "Bundle test",
      hosting_mode: "self_host",
      database_placement: "dedicated",
      storage_namespace: `workspaces/${workspaceId}`,
      created_by: accountId,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    })],
    ["accounts.jsonl", ""],
    ["rooms.jsonl", jsonLines(input.rooms)],
    ["memberships.jsonl", jsonLines([{
      workspace_id: workspaceId,
      account_id: accountId,
      role: "owner",
      state: "active",
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
      revoked_at: null
    }])],
    ["room-memberships.jsonl", jsonLines(input.roomMemberships)],
    ["records.jsonl", ""],
    ["events.jsonl", jsonLines(input.events ?? [])],
    ["jobs.jsonl", ""],
    ["operations.jsonl", ""],
    ["invitations.jsonl", ""],
    ["audits.jsonl", ""],
    ["files.jsonl", jsonLines(workspaceFiles.map(({ path: filePath, content }) => ({
      workspace_id: workspaceId,
      room_id: "room_root",
      path: filePath,
      version: 1,
      sha256: hash(content),
      size: content.byteLength,
      created_by: accountId,
      updated_by: accountId,
      created_at: timestamp,
      updated_at: timestamp
    })))]
  ]);
  if (input.learning) {
    for (const file of learningFiles) files.set(file, jsonLines(input.learning[file] ?? []));
  }
  if (input.sharing) {
    for (const file of sharingFiles) files.set(file, jsonLines(input.sharing[file] ?? []));
  }
  const recordCounts = {
    rooms: input.rooms.length,
    memberships: 1,
    room_memberships: input.roomMemberships.length,
    records: 0,
    events: input.events?.length ?? 0,
    jobs: 0,
    operations: 0,
    invitations: 0,
    audits: 0,
    files: workspaceFiles.length,
    ...(input.learning ? Object.fromEntries(learningFiles.map((file) => [learningCountName(file), input.learning?.[file]?.length ?? 0])) : {}),
    ...(input.sharing ? Object.fromEntries(sharingFiles.map((file) => [sharingCountName(file), input.sharing?.[file]?.length ?? 0])) : {})
  };
  const hashes = Object.fromEntries([
    ...[...files.entries()].map(([name, content]) => [name, hash(content)] as const),
    ...workspaceFiles.map(({ path: filePath, content }) => [`files/${filePath}`, hash(content)] as const),
    ...shareFiles.map(({ path: filePath, content }) => [filePath, hash(content)] as const)
  ].sort(([left], [right]) => left.localeCompare(right)));
  for (const [name, content] of files) await writeFile(path.join(root, name), content, "utf8");
  if (workspaceFiles.length > 0) await mkdir(path.join(root, "files"), { recursive: true });
  for (const { path: filePath, content } of workspaceFiles) {
    await writeFile(path.join(root, "files", filePath), content);
  }
  for (const { path: filePath, content } of shareFiles) {
    await mkdir(path.dirname(path.join(root, filePath)), { recursive: true });
    await writeFile(path.join(root, filePath), content);
  }
  const schemaVersion = input.schemaVersion ?? (input.learning ? 27 : 22);
  const sourceOrganizationId = input.sourceOrganizationId;
  const schemaRevision = input.schemaRevision;
  const manifest = {
    format_version: 3,
    workspace_id: workspaceId,
    exported_at: timestamp,
    source: {
      hosting_mode: "self_host",
      database_placement: "dedicated",
      ...(sourceOrganizationId ? { organization_id: sourceOrganizationId } : {})
    },
    schema_version: schemaVersion,
    ...(sourceOrganizationId ? { source_organization_id: sourceOrganizationId } : {}),
    ...(schemaRevision !== undefined ? { schema_revision: schemaRevision } : {}),
    files: hashes,
    record_counts: recordCounts,
    integrity_hash: ""
  } as Record<string, unknown>;
  const integrityPayload = sourceOrganizationId || schemaRevision !== undefined
    ? {
      files: hashes,
      record_counts: recordCounts,
      source: {
        hosting_mode: "self_host",
        database_placement: "dedicated",
        ...(sourceOrganizationId ? { organization_id: sourceOrganizationId } : {})
      },
      schema_version: schemaVersion,
      ...(schemaRevision !== undefined ? { schema_revision: schemaRevision } : {})
    }
    : { files: hashes, record_counts: recordCounts };
  manifest.integrity_hash = hash(canonicalJson(integrityPayload));
  await writeFile(path.join(root, "manifest.json"), canonicalJson(manifest), "utf8");
}

const learningFiles = [
  "learning-activities.jsonl",
  "learning-resources.jsonl",
  "learning-resource-versions.jsonl",
  "learning-evidence.jsonl",
  "learning-resource-links.jsonl",
  "learning-settings.jsonl",
  "learning-jobs.jsonl",
  "learning-job-attempts.jsonl",
  "learning-resource-uses.jsonl"
] as const;

type LearningFile = (typeof learningFiles)[number];

const sharingFiles = [
  "workspace-shares.jsonl",
  "workspace-share-recipients.jsonl",
  "workspace-share-claims.jsonl",
  "workspace-share-imports.jsonl",
  "workspace-share-import-resources.jsonl",
  "workspace-share-file-transactions.jsonl"
] as const;

type SharingFile = (typeof sharingFiles)[number];

function learningCountName(file: LearningFile): string {
  return file.replace(".jsonl", "").replaceAll("-", "_");
}

function sharingCountName(file: SharingFile): string {
  if (file === "workspace-shares.jsonl") return "share_records";
  return file.replace("workspace-", "").replace(".jsonl", "").replaceAll("-", "_");
}

function jsonLines(rows: Record<string, unknown>[]): string {
  return rows.map((row) => canonicalJson(row)).join(rows.length ? "\n" : "") + (rows.length ? "\n" : "");
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
