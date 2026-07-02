import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createId, nowIso, type OperationRecord } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { createArtifactDraft } from "./index";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact pipeline", () => {
  it("creates typed structured artifacts with filesystem content and metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-artifact-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const operation = testOperation();

    const artifact = await createArtifactDraft({
      store,
      operation,
      title: "Revenue table",
      kind: "table",
      content: {
        columns: ["month", "revenue"],
        rows: [["June", 1200]]
      },
      locale: "ja",
      sourceLocales: ["ja"],
      createdBy: "owner"
    });
    const content = await store.readArtifactContent(artifact.id);
    await store.close();

    expect(artifact.kind).toBe("table");
    expect(artifact.metadata).toMatchObject({
      content_type: "application/json",
      status: "draft",
      structured_payload: {
        columns: ["month", "revenue"],
        rows: [["June", 1200]]
      }
    });
    expect(content).toContain("\"revenue\"");
  });

  it("creates binary pdf artifacts with filesystem content and metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-artifact-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const operation = testOperation();

    const artifact = await createArtifactDraft({
      store,
      operation,
      title: "Monthly report",
      kind: "pdf",
      content: {
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        mime_type: "application/pdf",
        preview: "PDF report"
      },
      locale: "ja",
      sourceLocales: ["ja"],
      createdBy: "owner"
    });
    const textContent = await store.readArtifactContent(artifact.id);
    const binaryContent = await store.readArtifactBinaryContent(artifact.id);
    await store.close();

    expect(artifact.kind).toBe("pdf");
    expect(artifact.file_ref.uri.endsWith(".pdf")).toBe(true);
    expect(artifact.metadata).toMatchObject({
      content_type: "application/pdf",
      status: "draft",
      binary: true,
      byte_size: 4,
      preview: "PDF report"
    });
    expect(typeof artifact.metadata.content_hash).toBe("string");
    expect(textContent).toBeUndefined();
    expect(Array.from(binaryContent ?? [])).toEqual([0x25, 0x50, 0x44, 0x46]);
  });
});

function testOperation(): OperationRecord {
  const now = nowIso();
  return {
    id: createId("operation"),
    session_id: "session_test",
    capability_id: "artifact.create",
    operation: "artifact.create",
    actor_identity: "owner",
    instruction_source: "owner_instruction",
    instruction_authority: "trusted_owner",
    channel: "web",
    input_hash: "hash",
    target_resource_refs: [],
    proposed_effects: ["Create artifact"],
    status: "completed",
    created_at: now,
    updated_at: now
  };
}
