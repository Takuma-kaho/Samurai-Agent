import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ArtifactRecordSchema } from "@samurai-agent/core-schemas";
import { WorkspaceServerError, type WorkspaceRecord } from "@samurai-agent/workspace-server";
import { PostgresArtifact } from "./postgres-artifact";

const baseContext = {
  workspaceId: "workspace-artifact-transaction-test",
  accountId: "account-artifact-transaction-test",
  operationId: "artifact-create-transaction-test"
} as const;

class FakeFiles {
  private readonly values = new Map<string, { content: Buffer; version: number }>();

  async read(_context: unknown, input: { roomId: string; path: string }) {
    const value = this.values.get(`${input.roomId}:${input.path}`);
    if (!value) throw new WorkspaceServerError("workspace_file_not_found", 404);
    return {
      file: { path: input.path, version: value.version, sha256: createHash("sha256").update(value.content).digest("hex") },
      content: Buffer.from(value.content)
    };
  }

  async write(_context: unknown, input: { roomId: string; path: string; content: Buffer; expectedVersion: number }) {
    const key = `${input.roomId}:${input.path}`;
    const current = this.values.get(key);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new WorkspaceServerError("workspace_file_version_conflict", 409);
    const next = { content: Buffer.from(input.content), version: input.expectedVersion + 1 };
    this.values.set(key, next);
    return { file: { path: input.path, version: next.version, sha256: createHash("sha256").update(next.content).digest("hex") } };
  }

  async remove(_context: unknown, input: { roomId: string; path: string; expectedVersion: number }) {
    const key = `${input.roomId}:${input.path}`;
    const current = this.values.get(key);
    if (!current || current.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_file_version_conflict", 409);
    this.values.delete(key);
    return { file: { path: input.path, version: current.version + 1 } };
  }
}

class FakeCommands {
  private readonly rows = new Map<string, WorkspaceRecord>();

  async putRecord(context: { workspaceId: string }, input: { roomId: string; recordType: string; id: string; expectedVersion: number; payload: Record<string, unknown>; searchText?: string }) {
    const key = `${input.roomId}:${input.recordType}:${input.id}`;
    const current = this.rows.get(key);
    if ((current?.version ?? 0) !== input.expectedVersion) throw new WorkspaceServerError("workspace_record_version_conflict", 409);
    const record: WorkspaceRecord = {
      workspaceId: context.workspaceId,
      roomId: input.roomId,
      recordType: input.recordType,
      id: input.id,
      version: input.expectedVersion + 1,
      payload: input.payload,
      contentHash: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex"),
      createdAt: current?.createdAt ?? "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z"
    };
    this.rows.set(key, record);
    return { record, event: {} as never, replayed: false };
  }

  async getRecord(_context: unknown, input: { roomId: string; recordType: string; id: string }) {
    const record = this.rows.get(`${input.roomId}:${input.recordType}:${input.id}`);
    if (!record) throw new WorkspaceServerError("workspace_record_not_found", 404);
    return record;
  }

  async listRecords(_context: unknown, input: { roomId: string; recordType: string }) {
    return [...this.rows.values()].filter((record) => record.roomId === input.roomId && record.recordType === input.recordType);
  }

  async deleteRecord(_context: unknown, input: { roomId: string; recordType: string; id: string; expectedVersion: number }) {
    const key = `${input.roomId}:${input.recordType}:${input.id}`;
    const current = this.rows.get(key);
    if (!current || current.version !== input.expectedVersion) throw new WorkspaceServerError("workspace_record_version_conflict", 409);
    this.rows.delete(key);
    return { event: {} as never, replayed: false };
  }
}

function createAdapter(activity: { failNext: boolean }) {
  const files = new FakeFiles();
  const commands = new FakeCommands();
  let activityCalls = 0;
  const artifacts = new PostgresArtifact(commands as never, files as never, async () => {
    activityCalls += 1;
    if (activity.failNext) {
      activity.failNext = false;
      throw new Error("activity_outage");
    }
    return {} as never;
  });
  return { artifacts, commands, files, get activityCalls() { return activityCalls; } };
}

describe("PostgreSQL Artifact transaction recovery", () => {
  it("keeps a failed creation hidden and resumes it from the durable transaction record", async () => {
    const activity = { failNext: true };
    const adapter = createAdapter(activity);
    const input = { roomId: "room-artifact", title: "Transaction test", content: "body", kind: "markdown" as const };

    await expect(adapter.artifacts.create({ ...baseContext }, input)).rejects.toThrow("activity_outage");
    expect(await adapter.artifacts.list(baseContext, input.roomId)).toEqual([]);
    const artifactId = `artifact_${createHash("sha256").update(`${baseContext.workspaceId}|${baseContext.operationId}`).digest("hex").slice(0, 40)}`;
    await expect(adapter.artifacts.get(baseContext, input.roomId, artifactId)).rejects.toMatchObject({ code: "artifact_recovery_required" });

    const resumed = await adapter.artifacts.create({ ...baseContext }, input);
    expect(resumed.replayed).toBe(true);
    expect(resumed.content).toBe("body");
    expect((await adapter.artifacts.list(baseContext, input.roomId)).map((item) => item.id)).toEqual([artifactId]);
    expect(adapter.activityCalls).toBe(2);
    expect((await adapter.commands.listRecords(baseContext, { roomId: input.roomId, recordType: "artifact_transaction" })).length).toBe(0);
  });

  it("keeps a failed revision hidden and resumes both file and metadata sides", async () => {
    const activity = { failNext: false };
    const adapter = createAdapter(activity);
    const created = await adapter.artifacts.create({ ...baseContext }, { roomId: "room-artifact", title: "Revision test", content: "zero", kind: "markdown" });
    activity.failNext = true;
    const revisionContext = { ...baseContext, operationId: "artifact-revision-transaction-test" };
    const revisionInput = { roomId: "room-artifact", artifactId: created.artifact.id, content: "one", editorSource: "chat" as const };

    await expect(adapter.artifacts.revise(revisionContext, revisionInput)).rejects.toThrow("activity_outage");
    await expect(adapter.artifacts.getRevision(revisionContext, revisionInput.roomId, "missing-revision")).rejects.toMatchObject({ code: "workspace_record_not_found" });
    const transactionRows = await adapter.commands.listRecords(revisionContext, { roomId: revisionInput.roomId, recordType: "artifact_transaction" });
    expect(transactionRows).toHaveLength(1);
    const pendingRevisionId = (transactionRows[0]?.payload as { revision_id?: string }).revision_id;
    expect(pendingRevisionId).toEqual(expect.any(String));
    await expect(adapter.artifacts.getRevision(revisionContext, revisionInput.roomId, pendingRevisionId!)).rejects.toMatchObject({ code: "artifact_revision_recovery_required" });

    const resumed = await adapter.artifacts.revise(revisionContext, revisionInput);
    expect(resumed.replayed).toBe(true);
    expect(resumed.revision.revision).toBe(2);
    expect((await adapter.artifacts.readRevisionContent(revisionContext, revisionInput.roomId, resumed.revision.id)).toString()).toBe("one");
    expect((await adapter.commands.listRecords(revisionContext, { roomId: revisionInput.roomId, recordType: "artifact_transaction" })).length).toBe(0);
  });

  it("creates an immutable initial revision even for empty content", async () => {
    const adapter = createAdapter({ failNext: false });
    const created = await adapter.artifacts.create({ ...baseContext, operationId: "artifact-empty-create" }, {
      roomId: "room-artifact",
      title: "Empty artifact",
      content: "",
      kind: "markdown"
    });

    expect(created.content).toBe("");
    expect(created.revision).toMatchObject({ artifact_id: created.artifact.id, revision: 1, content_bytes: 0 });
    expect(await adapter.artifacts.listRevisions(baseContext, "room-artifact", created.artifact.id)).toHaveLength(1);
    const detail = await adapter.artifacts.getRevisionDetail(baseContext, "room-artifact", created.artifact.id, created.revision!.id);
    expect(detail.content).toBe("");
    expect(detail.content_bytes).toBeUndefined();
    expect(detail.encoding).toBe("utf8");
  });

  it("keeps binary revision bytes and MIME without base64 conversion", async () => {
    const adapter = createAdapter({ failNext: false });
    const bytes = new Uint8Array([0, 255, 16, 128]);
    const created = await adapter.artifacts.create({ ...baseContext, operationId: "artifact-binary-create" }, {
      roomId: "room-artifact",
      title: "Binary artifact",
      content: bytes,
      kind: "pdf",
      mimeType: "application/pdf",
      encoding: "binary"
    });

    expect(created.mime_type).toBe("application/pdf");
    expect(created.encoding).toBe("binary");
    expect(created.content).toBe("");
    expect(created.content_bytes).toEqual([...bytes]);
    const content = await adapter.artifacts.readContent(baseContext, "room-artifact", created.artifact.id);
    expect([...content.bytes]).toEqual([...bytes]);
    expect(content.mimeType).toBe("application/pdf");
    expect(content.encoding).toBe("binary");
    expect([...(await adapter.artifacts.readRevisionContent(baseContext, "room-artifact", created.revision!.id))]).toEqual([...bytes]);
  });

  it("migrates a legacy Artifact to revision one before creating revision two", async () => {
    const adapter = createAdapter({ failNext: false });
    const roomId = "room-artifact";
    const artifactId = "artifact_legacy";
    const legacyPath = `artifacts/${artifactId}.md`;
    const legacyBytes = Buffer.from("legacy body", "utf8");
    await adapter.files.write(baseContext, { roomId, path: legacyPath, content: legacyBytes, expectedVersion: 0 });
    const legacy = ArtifactRecordSchema.parse({
      id: artifactId,
      title: "Legacy artifact",
      kind: "markdown",
      locale: "ja",
      source_locales: ["ja"],
      file_ref: { kind: "artifact", id: artifactId, uri: legacyPath, version: "2026-08-24T00:00:00.000Z", label: "Legacy artifact" },
      metadata: {
        content_type: "text/markdown",
        content_encoding: "utf8",
        content_hash: createHash("sha256").update(legacyBytes).digest("hex"),
        byte_size: legacyBytes.byteLength,
        status: "draft"
      },
      source_operation_id: "legacy_create",
      created_by: baseContext.accountId,
      created_at: "2026-08-24T00:00:00.000Z",
      updated_at: "2026-08-24T00:00:00.000Z"
    });
    await adapter.commands.putRecord(baseContext, {
      roomId,
      recordType: "artifact",
      id: artifactId,
      payload: legacy,
      expectedVersion: 0
    });

    const revised = await adapter.artifacts.revise({ ...baseContext, operationId: "legacy-revise" }, {
      roomId,
      artifactId,
      content: "new body",
      editorSource: "chat"
    });
    const revisions = await adapter.artifacts.listRevisions(baseContext, roomId, artifactId);
    expect(revised.revision.revision).toBe(2);
    expect(revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    const original = await adapter.artifacts.getRevisionDetail(baseContext, roomId, artifactId, revisions[0]!.id);
    expect(original.content).toBe("legacy body");
    expect(original.revision.revision).toBe(1);
  });
});
