import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord, ArtifactRevisionRecord } from "@samurai-agent/core-schemas";
import { ArtifactDetailView, artifactBinaryPreviewEligibility, filterChartValues, type NativeArtifactDetail } from "./ArtifactSurfacePanel";

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
  return renderToStaticMarkup(createElement(ArtifactDetailView, {
    detail,
    revisions: [current],
    canEdit,
    onSave: vi.fn(async () => undefined),
    onCompare: vi.fn(),
    onRestore: vi.fn(),
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
});
