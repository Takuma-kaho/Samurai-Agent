import { describe, expect, it } from "vitest";
import { createId, nowIso, type OperationRecord } from "@samurai-agent/core-schemas";
import { createArtifactDraft, type ArtifactDraftStorePort } from "./index";

describe("artifact pipeline", () => {
  it("creates typed structured artifacts with filesystem content and metadata", async () => {
    const store = new MemoryArtifactStore();
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
    const content = store.readText(artifact.id);

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
    const store = new MemoryArtifactStore();
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
    const textContent = store.readText(artifact.id);
    const binaryContent = store.readBinary(artifact.id);

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

class MemoryArtifactStore implements ArtifactDraftStorePort {
  private readonly content = new Map<string, string | Uint8Array>();
  private readonly metadata = new Map<string, Parameters<ArtifactDraftStorePort["saveArtifactMetadata"]>[0]>();

  async writeArtifactContent(id: string, content: string | Uint8Array, options?: { extension?: string }): Promise<string> {
    this.content.set(id, typeof content === "string" ? content : new Uint8Array(content));
    return `artifacts/${id}.${options?.extension ?? "md"}`;
  }

  async saveArtifactMetadata(record: Parameters<ArtifactDraftStorePort["saveArtifactMetadata"]>[0]) {
    this.metadata.set(record.id, record);
    return record;
  }

  readText(id: string): string | undefined {
    const value = this.content.get(id);
    return typeof value === "string" ? value : undefined;
  }

  readBinary(id: string): Uint8Array | undefined {
    const value = this.content.get(id);
    return value instanceof Uint8Array ? value : undefined;
  }
}

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
