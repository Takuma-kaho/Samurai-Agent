import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GeneratedSurfaceBundleDetail, GeneratedSurfaceDetail } from "../lib/api";
import { GeneratedSurfaceFrame, generatedSurfaceActionFromMessage, generatedSurfaceConfirmationRequest, generatedSurfaceSrcdoc, shouldConsumeGeneratedSurfaceConfirmationRequest } from "./GeneratedSurfaceFrame";

const createdAt = "2026-09-08T00:00:00.000Z";

const detail: GeneratedSurfaceDetail = {
  surface: {
    id: "surface_report",
    state: "ephemeral",
    title: "月次レポート",
    input_data_schema: {},
    actions: [
      { id: "refresh", label: "更新", command_id: "collection.action.run", input_schema: {}, payload_template: {}, requires_confirmation: false },
      { id: "publish", label: "公開", command_id: "collection.action.run", input_schema: {}, payload_template: {}, requires_confirmation: true }
    ],
    capability_manifest: { allowed_domain_commands: ["collection.action.run"], network_access: "none", workspace_write: "domain_commands_only" },
    source_refs: [],
    content_hash: "surface_hash",
    current_revision_id: "surface_revision_1",
    current_revision: 1,
    preview_url: "/should-not-be-used",
    fallback_chain: ["artifact", "text"],
    created_at: createdAt,
    updated_at: createdAt
  },
  revisions: [{
    id: "surface_revision_1",
    surface_id: "surface_report",
    revision: 1,
    source_resource_refs: [],
    prompt_fingerprint: "prompt_hash",
    knowledge_refs: [],
    skill_refs: [],
    html_ref: { kind: "generated_surface_html", id: "surface_revision_1", uri: "generated/surface.html" },
    asset_refs: [],
    bundle_hash: "bundle_hash",
    validation_report: { valid: true, issues: [], html_bytes: 10, css_bytes: 0, script_bytes: 0, action_count: 2, csp: "default-src 'none'" },
    created_at: createdAt
  }],
  interactions: []
};

const bundle: GeneratedSurfaceBundleDetail = {
  surface: detail.surface,
  revision: detail.revisions[0]!,
  bundle: { html: "<main><button onclick=\"dispatchSamuraiAction('refresh',{scope:'latest'})\">更新</button></main>", css: "main { color: salmon; }", script: "window.surfaceReady = true;" },
  csp: "default-src 'none'"
};

describe("GeneratedSurfaceFrame", () => {
  it("builds a self-contained, network-free document with a revision-pinned bridge", () => {
    const document = generatedSurfaceSrcdoc(bundle);

    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("surface_id");
    expect(document).toContain("surface_report");
    expect(document).toContain("surface_revision_1");
    expect(document).toContain("samurai.generated_surface.action");
    expect(document).not.toContain("/should-not-be-used");
  });

  it("accepts only declared actions for the same Surface revision", () => {
    const accepted = generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "refresh",
      payload: { nested: { enabled: true } }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions });

    if (!accepted) throw new Error("expected confirmation action");

    expect(accepted).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "refresh",
      payload: { nested: { enabled: true } }
    });
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      surface_id: "surface_report",
      revision_id: "obsolete_revision",
      action_id: "refresh"
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "undeclared"
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
    expect(generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "refresh",
      payload: { oversized: "x".repeat(32 * 1024) }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions })).toBeUndefined();
  });

  it("retains an input payload for a confirmation action until the parent starts approval", () => {
    const accepted = generatedSurfaceActionFromMessage({
      type: "samurai.generated_surface.action",
      surface_id: "surface_report",
      revision_id: "surface_revision_1",
      action_id: "publish",
      payload: { audience: "customers", notify: true }
    }, { surfaceId: detail.surface.id, revisionId: "surface_revision_1", actions: detail.surface.actions });

    if (!accepted) throw new Error("expected confirmation action");

    expect(accepted).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "publish",
      payload: { audience: "customers", notify: true }
    });
    expect(generatedSurfaceConfirmationRequest(accepted, {
      surfaceId: "surface_report",
      revisionId: "surface_revision_1",
      actionId: "publish"
    })).toEqual(accepted);
    expect(generatedSurfaceConfirmationRequest(accepted, {
      surfaceId: "surface_report",
      revisionId: "surface_revision_2",
      actionId: "publish"
    })).toEqual({
      surfaceId: "surface_report",
      revisionId: "surface_revision_2",
      actionId: "publish",
      payload: {}
    });
    expect(shouldConsumeGeneratedSurfaceConfirmationRequest(accepted, accepted)).toBe(true);
    const newerRequest = { ...accepted };
    expect(shouldConsumeGeneratedSurfaceConfirmationRequest(newerRequest, accepted)).toBe(false);
  });

  it("renders the bundle only in an iframe without same-origin access", () => {
    const html = renderToStaticMarkup(createElement(GeneratedSurfaceFrame, {
      detail,
      bundle,
      onExport: async () => ({ file_name: "report.html", content_type: "text/html", content_base64: "" })
    }));

    expect(html).toContain("native-generated-surface-frame");
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("公開（確認）");
    expect(html).toContain("HTML");
    expect(html).toContain("ZIP");
  });
});
