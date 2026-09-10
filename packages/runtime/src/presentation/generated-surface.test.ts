import { describe, expect, it } from "vitest";
import { buildGeneratedSurfaceRevision, validateGeneratedSurfaceBundle } from "./generated-surface";

describe("buildGeneratedSurfaceRevision", () => {
  it("omits absent optional provenance fields so a server can canonically sign the result", () => {
    const created = buildGeneratedSurfaceRevision({
      request: {
        id: "surface_request_fixture",
        domain_operation_id: "operation_fixture",
        user_intent: "Create a confirmation surface.",
        source_resource_refs: [],
        allowed_domain_commands: ["collection.action.run"],
        selected_knowledge_refs: [],
        selected_skill_refs: [],
        client_capabilities: { generated_surface: true },
        expected_lifetime: "session",
        fallback_chain: ["built_in_surface"]
      },
      bundle: {
        title: "Confirmation",
        html: "<main>Confirmation</main>",
        actions: []
      },
      surfaceId: "surface_fixture",
      revisionId: "surface_revision_fixture"
    });

    expect(created.definition).toStrictEqual(JSON.parse(JSON.stringify(created.definition)));
    expect(created.revision).toStrictEqual(JSON.parse(JSON.stringify(created.revision)));
    expect(created.definition).not.toHaveProperty("session_id");
    expect(created.revision).not.toHaveProperty("parent_revision_id");
  });

  it("records content evidence for each file-backed asset", () => {
    const created = buildGeneratedSurfaceRevision({
      request: {
        id: "surface_request_asset_hash",
        domain_operation_id: "operation_asset_hash",
        user_intent: "Render a surface with a logo.",
        source_resource_refs: [],
        allowed_domain_commands: [],
        selected_knowledge_refs: [],
        selected_skill_refs: [],
        client_capabilities: { generated_surface: true },
        expected_lifetime: "session",
        fallback_chain: ["built_in_surface"]
      },
      bundle: {
        title: "Asset hash",
        html: "<img src=\"images/logo.png\">",
        actions: [],
        assets: [{ path: "images/logo.png", content: "logo", encoding: "utf8", mime_type: "image/png" }]
      },
      surfaceId: "surface_asset_hash",
      revisionId: "surface_revision_asset_hash"
    });

    expect(created.revision.asset_refs).toEqual([{
      kind: "generated_surface_asset",
      id: "surface_revision_asset_hash:images/logo.png",
      uri: "surfaces/surface_asset_hash/revisions/1/assets/images/logo.png",
      label: "images/logo.png",
      content_hash: "3598ce6f965b2481fe26316c06b30950c46ac7f8e7229f104aa78f579997668d"
    }]);
  });
});

describe("Generated Surface script capability validation", () => {
  const request = {
    id: "surface_request_script_fixture",
    domain_operation_id: "operation_script_fixture",
    user_intent: "Render a safe action button.",
    source_resource_refs: [],
    allowed_domain_commands: [],
    selected_knowledge_refs: [],
    selected_skill_refs: [],
    client_capabilities: { generated_surface: true },
    expected_lifetime: "session" as const,
    fallback_chain: ["built_in_surface"] as const
  };

  it("allows ordinary JavaScript function expressions", () => {
    const report = validateGeneratedSurfaceBundle(request, {
      title: "Safe action",
      html: "<button id=\"save\">Save</button>",
      script: "document.getElementById('save')?.addEventListener('click', function () { window.dispatchSamuraiAction('save', {}); });",
      actions: []
    });

    expect(report.valid).toBe(true);
  });

  it("continues to reject the dynamic Function constructor", () => {
    const report = validateGeneratedSurfaceBundle(request, {
      title: "Unsafe action",
      html: "<main>Unsafe</main>",
      script: "const makeCode = Function('return 1');",
      actions: []
    });

    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("surface_script_forbidden_capability");
  });
});
