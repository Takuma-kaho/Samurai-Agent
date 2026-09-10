import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord, JsonValue } from "@samurai-agent/core-schemas";
import { ArtifactDetailView, artifactBinaryPreviewEligibility, artifactCurrentRevision, artifactRequestIsCurrent, artifactRestoreOperationSnapshot, artifactTableSnapshot, coerceTableCellValue, filterChartValues, invokeArtifactRevisionRequest, nativeArtifactDetailFromMutation, operationForArtifactSnapshot, parseTable, updateTable, type NativeArtifactDetail } from "./ArtifactSurfacePanel";

const createdAt = "2026-09-08T00:00:00.000Z";

function artifact(kind: ArtifactRecord["kind"], metadata: ArtifactRecord["metadata"] = {}): ArtifactRecord {
  return {
    id: `artifact_${kind}`,
    title: `${kind} report`,
    kind,
    locale: "ja",
    source_locales: ["ja"],
    file_ref: { kind: "artifact", id: `artifact_${kind}`, uri: `artifacts/${kind}.md` },
    metadata: { current_revision_id: `revision_${kind}`, current_revision: 1, content_type: kind === "table" || kind === "chart" ? "application/json" : "text/markdown", ...metadata },
    source_operation_id: "operation_1",
    created_by: "account_1",
    created_at: createdAt,
    updated_at: createdAt
  };
}

function revision(kind: ArtifactRecord["kind"]): ArtifactRevisionRecord {
  return {
    id: `revision_${kind}`,
    artifact_id: `artifact_${kind}`,
    revision: 1,
    provenance: {},
    file_ref: { kind: "artifact_revision", id: `revision_${kind}`, uri: `artifacts/revisions/${kind}.md` },
    blob_ref: { kind: "blob", id: `blob_${kind}`, uri: `blobs/${kind}` },
    content_hash: "hash_1",
    content_bytes: 10,
    created_at: createdAt
  };
}

function render(detail: NativeArtifactDetail, canEdit = true): string {
  const current = revision(detail.artifact.kind);
  const mutation = { artifact: detail.artifact, revision: current, replayed: false };
  return renderToStaticMarkup(createElement(ArtifactDetailView, {
    detail,
    revisions: [current],
    canEdit,
    onSave: vi.fn(async () => mutation),
    onCompare: vi.fn(),
    onRestore: vi.fn(async () => mutation),
    onCloseComparison: vi.fn(),
    onRequestAgentRevision: vi.fn()
  }));
}

describe("ArtifactDetailView", () => {
  it("renders Markdown as escaped preview plus an explicit human editor", () => {
    const html = render({ artifact: artifact("markdown"), content: "# Note\n\n<script>alert('x')</script>" });

    expect(html).toContain("本文を直接編集");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Agentに修正を依頼");
  });

  it("renders a typed, row-ID-backed table instead of a JSON-only fallback", () => {
    const html = render({
      artifact: artifact("table"),
      content: JSON.stringify([{ id: "row_a", title: "調査", score: 3, accepted: true, empty: null }])
    });

    expect(html).toContain("native-artifact-table");
    expect(html).toContain('aria-label="row_a score"');
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("表を保存");
  });

  it("draws a chart and its matching data table from actual label and value data", () => {
    const html = render({
      artifact: artifact("chart"),
      content: JSON.stringify({ unit: "件", data: [{ id: "done", label: "完了", value: 8, status: "完了" }, { id: "review", label: "確認", value: 3, status: "確認" }] })
    }, false);

    expect(html).toContain("<svg");
    expect(html).toContain("完了");
    expect(html).toContain("8 件");
    expect(html).toContain("表示データ");
    expect(html).toContain("status");
    expect(html).not.toContain("描画可能な値がありません");
  });

  it("filters chart rows once and uses the same result for the graph and table", () => {
    const values = [
      { id: "done", label: "完了", value: 8, dimensions: { status: "完了" } },
      { id: "review", label: "確認", value: 3, dimensions: { status: "確認" } }
    ];

    expect(filterChartValues(values, { status: "完了" })).toEqual([values[0]]);
    expect(filterChartValues(values, { status: "未着手" })).toEqual([]);
  });

  it("rejects malformed and oversized binary previews before rendering them", () => {
    expect(artifactBinaryPreviewEligibility("not base64!")).toEqual({ eligible: false, reason: "invalid" });
    expect(artifactBinaryPreviewEligibility("A".repeat(17 * 1024 * 1024))).toEqual({ eligible: false, reason: "too_large" });
    expect(artifactBinaryPreviewEligibility("AQID")).toEqual({ eligible: true, byteLength: 3 });
  });

  it("keeps the same logical Artifact save on one operation ID across a failed retry", () => {
    const first = operationForArtifactSnapshot(undefined, "draft-v1");
    expect(operationForArtifactSnapshot(first, "draft-v1")).toBe(first);
    expect(operationForArtifactSnapshot(first, "draft-v2").operationId).not.toBe(first.operationId);
  });

  it("propagates a cancelled Agent request as failure instead of consuming the request text", async () => {
    const target = { artifact: artifact("markdown"), revisionId: "revision_markdown", request: "見出しを修正" };
    await expect(invokeArtifactRevisionRequest(async () => false, target)).rejects.toThrow("artifact_revision_request_cancelled");
    await expect(invokeArtifactRevisionRequest(async () => { throw new Error("request_failed"); }, target)).rejects.toThrow("request_failed");
    await expect(invokeArtifactRevisionRequest(async () => true, target)).resolves.toBeUndefined();
  });

  it("rejects an older Artifact response after the selected resource or request generation changes", () => {
    expect(artifactRequestIsCurrent({ requestEpoch: 3, currentEpoch: 4, artifactId: "artifact_a", currentArtifactId: "artifact_a" })).toBe(false);
    expect(artifactRequestIsCurrent({ requestEpoch: 3, currentEpoch: 3, artifactId: "artifact_a", currentArtifactId: "artifact_b" })).toBe(false);
    expect(artifactRequestIsCurrent({ requestEpoch: 3, currentEpoch: 3, artifactId: "artifact_a", currentArtifactId: "artifact_a" })).toBe(true);
  });

  it("keeps a restore retry bound to the same Artifact and base revision", () => {
    const snapshot = artifactRestoreOperationSnapshot({ artifactId: "artifact_a", revisionId: "revision_old", baseRevisionId: "revision_current", expectedRevision: 4 });
    const operation = operationForArtifactSnapshot(undefined, snapshot);
    expect(operationForArtifactSnapshot(operation, snapshot)).toBe(operation);
    expect(artifactRestoreOperationSnapshot({ artifactId: "artifact_a", revisionId: "revision_old", baseRevisionId: "revision_other", expectedRevision: 4 })).not.toBe(snapshot);
  });

  it("keeps Table column types and row identity stable through blank, zero, false, and null values", () => {
    const parsed = parseTable(JSON.stringify([
      { id: "row_a", score: 3, enabled: false, empty: null },
      { id: "row_b", score: 0, enabled: true, empty: null }
    ]));
    expect(parsed?.columnTypes).toMatchObject({ score: "number", enabled: "boolean", empty: "json" });
    if (!parsed) throw new Error("expected parsed table");

    const blank = updateTable(parsed, "row_a", "score", "");
    const reentered = updateTable(blank, "row_a", "score", "12");
    const reorderedRoot = [...(reentered.root as Array<Record<string, JsonValue>>)].reverse();
    const reordered = updateTable({ ...reentered, root: reorderedRoot as JsonValue, rows: [...reentered.rows].reverse() }, "row_a", "enabled", false);

    expect(blank.rows.find((row) => row.id === "row_a")?.value.score).toBeNull();
    expect(reentered.rows.find((row) => row.id === "row_a")?.value.score).toBe(12);
    expect(reordered.rows.find((row) => row.id === "row_a")?.value.enabled).toBe(false);
    expect(reordered.rows.find((row) => row.id === "row_b")?.value.score).toBe(0);
    expect(coerceTableCellValue("boolean", false, true)).toBe(false);
    expect(coerceTableCellValue("number", "", 0)).toBeNull();
    expect(coerceTableCellValue("number", "0", null)).toBe(0);
  });

  it("keeps the submitted Table generation distinct from edits made while saving", () => {
    const parsed = parseTable(JSON.stringify([{ id: "row_a", score: 1 }]));
    if (!parsed) throw new Error("expected parsed table");
    const submitted = artifactTableSnapshot(parsed);
    const editedWhileSaving = updateTable(parsed, "row_a", "score", "2");
    expect(artifactTableSnapshot(editedWhileSaving)).not.toBe(submitted);
    expect(artifactTableSnapshot(parsed)).toBe(submitted);
  });

  it("does not enable direct table edits when row IDs are duplicated", () => {
    const parsed = parseTable(JSON.stringify([{ id: "same", score: 1 }, { id: "same", score: 2 }]));
    expect(parsed?.editable).toBe(false);
    expect(new Set(parsed?.rows.map((row) => row.id)).size).toBe(2);
  });

  it("uses the Server-returned revision and freshly read content after an Artifact mutation", () => {
    const nextArtifact = artifact("markdown", { current_revision_id: "revision_markdown_2", current_revision: 2 });
    const nextRevision = { ...revision("markdown"), id: "revision_markdown_2", revision: 2, artifact_id: nextArtifact.id };
    const detail = nativeArtifactDetailFromMutation(
      { artifact: nextArtifact, revision: nextRevision, replayed: false },
      { revision: nextRevision, content: "server content", contentEncoding: "utf8", contentType: "text/markdown" }
    );

    expect(detail.revision?.id).toBe("revision_markdown_2");
    expect(detail.content).toBe("server content");
  });

  it("uses an initially opened historical revision as the next edit base", () => {
    const currentArtifact = artifact("markdown", { current_revision_id: "revision_current", current_revision: 2 });
    const historical = revision("markdown");
    const current = { ...historical, id: "revision_current", revision: 2 };

    expect(artifactCurrentRevision({ artifact: currentArtifact, content: "historical", revision: historical }, [historical, current])).toEqual(historical);
  });

  it("does not trust a displayed revision from another Artifact", () => {
    const current = revision("markdown");
    const foreign = { ...current, id: "revision_foreign", artifact_id: "artifact_other" };
    expect(artifactCurrentRevision({ artifact: artifact("markdown"), content: "content", revision: foreign }, [current])).toEqual(current);
  });

  it("adds a fixed revision Agent request for both image and PDF artifacts", () => {
    const imageHtml = render({ artifact: artifact("image"), content: "AQID", contentEncoding: "base64", contentType: "image/png" });
    const pdfHtml = render({ artifact: artifact("pdf"), content: "AQID", contentEncoding: "base64", contentType: "application/pdf" });

    expect(imageHtml).toContain("Agentに画像の修正を依頼");
    expect(pdfHtml).toContain("AgentにPDFの修正を依頼");
  });
});
