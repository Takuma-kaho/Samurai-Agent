import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  nowIso,
  stableDigest,
  type AutomationJobRecord,
  type CollectionRecord,
  type CollectionSchema
} from "@samurai-agent/core-schemas";
import { localOwnerParticipantId } from "@samurai-agent/room-permissions";
import { WorkspaceSimulatedCrashError, WorkspaceStore } from "./index";
import type { CollectionTriggerWriteRequest } from "./repositories/collection-repository";

const roots: string[] = [];

async function createStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-collection-trigger-"));
  roots.push(root);
  return { root, store: await WorkspaceStore.create({ rootDir: root }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function schema(): CollectionSchema {
  return {
    id: "tasks",
    version: "1",
    labels: { en: "Tasks" },
    descriptions: { en: "Tasks" },
    fields: [{ id: "title", type: "string", required: true }],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers: [
      { id: "created", event: "record.created", action_id: "created_action", kind: "patch_record" },
      { id: "patched", event: "record.patched", action_id: "patched_action", kind: "patch_record" }
    ],
    actions: [],
    views: [],
    permissions: {}
  };
}

function record(id: string, title: string, updatedAt = "2026-08-23T00:00:00.000Z"): CollectionRecord {
  return {
    id,
    collection_id: "tasks",
    version: 1,
    data: { title },
    resource_refs: [],
    created_at: "2026-08-23T00:00:00.000Z",
    updated_at: updatedAt
  };
}

function trigger(roomId: string, event: "record.created" | "record.patched", operationId: string): CollectionTriggerWriteRequest {
  const principal = { kind: "human" as const, participant_id: localOwnerParticipantId };
  return {
    event,
    operationId,
    delivery: {
      workspaceId: "workspace",
      roomId,
      authority: { kind: "direct_principal", principal },
      createdPrincipalSnapshot: principal,
      sourceSnapshot: { kind: "native_app", app_id: "samurai-native" }
    }
  };
}

function triggerJobId(input: {
  operationId: string;
  recordId: string;
  event: "record.created" | "record.patched";
  triggerIndex: number;
  triggerId: string;
  actionId: string;
}): string {
  return `automation_collection_trigger_${stableDigest({
    operationId: input.operationId,
    collectionId: "tasks",
    recordId: input.recordId,
    event: input.event,
    triggerIndex: input.triggerIndex,
    triggerId: input.triggerId,
    actionId: input.actionId
  })}`;
}

function unrelatedJob(id: string, roomId: string): AutomationJobRecord {
  const now = nowIso();
  const principal = { kind: "human" as const, participant_id: localOwnerParticipantId };
  return {
    id,
    title: "existing job",
    kind: "custom_instruction",
    status: "enabled",
    schedule: "once",
    target_instruction: "existing",
    delivery_target: { channel: "test" },
    workspace_id: "workspace",
    room_id: roomId,
    authority: { kind: "direct_principal", principal },
    created_principal_snapshot: principal,
    source_snapshot: { kind: "native_app", app_id: "samurai-native" },
    authorization_state: "ready",
    authorized_at: now,
    management_state: "allowed",
    next_run_at: now,
    failure_count: 0,
    max_attempts: 3,
    created_at: now,
    updated_at: now
  };
}

describe("Collection trigger file transaction", () => {
  it("commits create and patch trigger jobs with their record mutations", async () => {
    const { store } = await createStore();
    const roomId = (await store.getSettings()).default_room_id!;
    await store.saveCollectionSchema(schema());

    const created = await store.saveCollectionRecord(record("task-1", "before"), trigger(roomId, "record.created", "operation-create"));
    const patched = await store.applyCollectionRecordPatch({
      collectionId: created.collection_id,
      recordId: created.id,
      patch: {
        id: "patch-1",
        record_id: created.id,
        expected_version: created.version,
        changes: { title: "after" },
        source_operation_id: "operation-patch",
        created_at: "2026-08-23T00:01:00.000Z"
      },
      trigger: trigger(roomId, "record.patched", "operation-patch")
    });

    const jobs = await store.listAutomationJobs({ dueAt: "2099-01-01T00:00:00.000Z", enabledOnly: true });
    expect(patched.after.version).toBe(2);
    expect(jobs.map((job) => job.delivery_target.event).sort()).toEqual(["record.created", "record.patched"]);
    expect(jobs.every((job) => job.room_id === roomId && job.created_operation_id?.startsWith("operation-"))).toBe(true);
    await store.close();
  });

  it("rolls back a new record when durable trigger registration conflicts", async () => {
    const { root, store } = await createStore();
    const roomId = (await store.getSettings()).default_room_id!;
    await store.saveCollectionSchema(schema());
    const operationId = "operation-conflict";
    const id = triggerJobId({
      operationId,
      recordId: "task-conflict",
      event: "record.created",
      triggerIndex: 0,
      triggerId: "created",
      actionId: "created_action"
    });
    await store.saveAutomationJob(unrelatedJob(id, roomId));

    await expect(store.saveCollectionRecord(
      record("task-conflict", "must not persist"),
      trigger(roomId, "record.created", operationId)
    )).rejects.toThrow();

    expect(await store.getCollectionRecord("tasks", "task-conflict")).toBeUndefined();
    await expect(access(path.join(root, "collections", "tasks", "records", "task-conflict.json"))).rejects.toThrow();
    expect(await store.getAutomationJob(id)).toMatchObject({ id, title: "existing job" });
    await store.close();
  });

  it("keeps a crash-committed trigger job pending until create recovery settles its file", async () => {
    const { root, store: seeded } = await createStore();
    const roomId = (await seeded.getSettings()).default_room_id!;
    await seeded.saveCollectionSchema(schema());
    await seeded.close();

    const crashing = await WorkspaceStore.create({
      rootDir: root,
      fileTransactionFailureInjector(phase) {
        if (phase === "db_committed") throw new WorkspaceSimulatedCrashError("trigger_create_crash");
      }
    });
    await expect(crashing.saveCollectionRecord(
      record("task-recover", "recover me"),
      trigger(roomId, "record.created", "operation-recover")
    )).rejects.toThrow(WorkspaceSimulatedCrashError);
    const pendingJobId = triggerJobId({
      operationId: "operation-recover",
      recordId: "task-recover",
      event: "record.created",
      triggerIndex: 0,
      triggerId: "created",
      actionId: "created_action"
    });
    expect(await crashing.listAutomationJobs({ dueAt: "2099-01-01T00:00:00.000Z", enabledOnly: true })).toEqual([]);
    expect(await crashing.getAutomationJob(pendingJobId)).toMatchObject({ id: pendingJobId });
    expect(await crashing.acquireAutomationJobLock(pendingJobId, {
      now: "2026-08-23T00:00:00.000Z",
      lockedUntil: "2026-08-23T00:15:00.000Z",
      lockOwnerToken: "must-not-lock-before-file-recovery"
    })).toBeUndefined();
    await crashing.close();

    const recovered = await WorkspaceStore.create({ rootDir: root });
    expect(await recovered.getCollectionRecord("tasks", "task-recover")).toMatchObject({ id: "task-recover", version: 1 });
    expect(await recovered.countPendingWorkspaceFileTransactions()).toBe(0);
    expect(await recovered.listAutomationJobs({ dueAt: "2099-01-01T00:00:00.000Z", enabledOnly: true })).toHaveLength(1);
    await recovered.close();
  });

  it("keeps a crash-committed patch trigger job pending until patch recovery settles its file", async () => {
    const { root, store: seeded } = await createStore();
    const roomId = (await seeded.getSettings()).default_room_id!;
    await seeded.saveCollectionSchema(schema());
    const original = await seeded.saveCollectionRecord(record("task-patch-recover", "before"));
    await seeded.close();

    const crashing = await WorkspaceStore.create({
      rootDir: root,
      fileTransactionFailureInjector(phase) {
        if (phase === "db_committed") throw new WorkspaceSimulatedCrashError("trigger_patch_crash");
      }
    });
    await expect(crashing.applyCollectionRecordPatch({
      collectionId: original.collection_id,
      recordId: original.id,
      patch: {
        id: "patch-recover",
        record_id: original.id,
        expected_version: original.version,
        changes: { title: "after" },
        source_operation_id: "operation-patch-recover",
        created_at: "2026-08-23T00:02:00.000Z"
      },
      trigger: trigger(roomId, "record.patched", "operation-patch-recover")
    })).rejects.toThrow(WorkspaceSimulatedCrashError);
    expect(await crashing.listAutomationJobs({ dueAt: "2099-01-01T00:00:00.000Z", enabledOnly: true })).toEqual([]);
    await crashing.close();

    const recovered = await WorkspaceStore.create({ rootDir: root });
    expect(await recovered.getCollectionRecord("tasks", original.id)).toMatchObject({ version: 2, data: { title: "after" } });
    expect(await recovered.countPendingWorkspaceFileTransactions()).toBe(0);
    expect(await recovered.listAutomationJobs({ dueAt: "2099-01-01T00:00:00.000Z", enabledOnly: true })).toHaveLength(1);
    await recovered.close();
  });
});
