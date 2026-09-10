import { describe, expect, it, vi } from "vitest";
import type { GeneratedSurfaceDefinition, GeneratedSurfaceRevisionRecord } from "@samurai-agent/core-schemas";
import { domainQueryReadCapability, type TrustedDomainContext } from "../../definition/index.js";
import type { GeneratedSurfaceExportBundle, GeneratedSurfaceExportPorts } from "./export.operation.js";
import generatedSurfaceExport from "./export.operation.js";

const now = "2026-09-10T00:00:00.000Z";
const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "actor_test",
  correlationId: "correlation_test"
};

const surface: GeneratedSurfaceDefinition = {
  id: "surface_export_test",
  state: "pinned",
  title: "Export test surface",
  input_data_schema: {},
  actions: [],
  capability_manifest: { allowed_domain_commands: [], network_access: "none", workspace_write: "domain_commands_only" },
  source_refs: [],
  content_hash: "surface_hash",
  current_revision_id: "revision_export_test",
  current_revision: 1,
  preview_url: "/api/generated-surfaces/surface_export_test/revisions/revision_export_test/preview",
  fallback_chain: ["text"],
  created_at: now,
  updated_at: now
};

const revision: GeneratedSurfaceRevisionRecord = {
  id: "revision_export_test",
  surface_id: surface.id,
  revision: 1,
  source_resource_refs: [],
  prompt_fingerprint: "prompt_fingerprint",
  knowledge_refs: [],
  skill_refs: [],
  html_ref: { kind: "generated_surface_html", id: "revision_export_test", uri: "surfaces/surface_export_test/revisions/1.html", label: "Export test surface" },
  asset_refs: [],
  bundle_hash: "bundle_hash",
  validation_report: {
    valid: true,
    issues: [],
    html_bytes: 0,
    css_bytes: 0,
    script_bytes: 0,
    action_count: 0,
    csp: "default-src 'none'"
  },
  created_at: now
};

const asset = {
  path: "images/logo.png",
  content_base64: "AA==",
  mime_type: "image/png"
} satisfies NonNullable<GeneratedSurfaceExportBundle["assets"]>[number];

function readCapability<T extends (...args: any[]) => any>(fn: T): T & { readonly [domainQueryReadCapability]: true } {
  return Object.assign(fn, { [domainQueryReadCapability]: true as const });
}

function fixture(bundle: GeneratedSurfaceExportBundle): { ports: GeneratedSurfaceExportPorts; readBundle: ReturnType<typeof vi.fn> } {
  const readBundle = vi.fn(async (_revisionId: string) => bundle);
  return {
    readBundle,
    ports: {
      [domainQueryReadCapability]: true,
      getGeneratedSurface: readCapability(async (surfaceId: string) => surfaceId === surface.id ? surface : undefined),
      getGeneratedSurfaceRevision: readCapability(async (revisionId: string) => revisionId === revision.id ? revision : undefined),
      readGeneratedSurfaceBundle: readCapability(readBundle),
      generatedSurfaceQueryError: readCapability((message: string) => new Error(message))
    }
  };
}

async function runExport(bundle: GeneratedSurfaceExportBundle, format?: "html" | "zip") {
  const testFixture = fixture(bundle);
  const result = await generatedSurfaceExport.createHandler(testFixture.ports).execute(context, generatedSurfaceExport.input.parse({
    surface_id: surface.id,
    revision_id: revision.id,
    ...(format ? { format } : {})
  }));
  return { result, readBundle: testFixture.readBundle };
}

describe("generated_surface.export handler", () => {
  it.each(["html", "zip"] as const)("preserves validated assets for %s export", async (format) => {
    const bundle: GeneratedSurfaceExportBundle = {
      html: '<img src="images/logo.png">',
      css: "body { color: black; }",
      script: "",
      assets: [asset]
    };

    const { result, readBundle } = await runExport(bundle, format);

    expect(result).toEqual({ ok: true, value: expect.objectContaining({
      surface,
      revision,
      bundle,
      format,
      file_name: `${surface.id}-revision-${revision.revision}.${format}`
    }) });
    expect(readBundle).toHaveBeenCalledWith(revision.id);
  });

  it.each(["html", "zip"] as const)("keeps the asset-less %s bundle compatible", async (format) => {
    const bundle: GeneratedSurfaceExportBundle = {
      html: "<main>Export</main>",
      css: "body { margin: 0; }",
      script: "console.log('export');"
    };

    const { result } = await runExport(bundle, format);

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ bundle, format }) });
    expect(result.value.bundle).not.toHaveProperty("assets");
  });

  it.each([
    ["non-canonical base64", { ...asset, content_base64: "Zh==" }, "content_base64"],
    ["unpadded base64", { ...asset, content_base64: "AA" }, "content_base64"],
    ["absolute path", { ...asset, path: "/images/logo.png" }, "path"],
    ["parent path segment", { ...asset, path: "images/../logo.png" }, "path"],
    ["unsafe MIME parameters", { ...asset, mime_type: "text/plain; charset=utf-8" }, "mime_type"]
  ] as const)("rejects %s in the output contract", async (_caseName, invalidAsset, field) => {
    const bundle: GeneratedSurfaceExportBundle = {
      html: "<main>Export</main>",
      assets: [invalidAsset]
    };

    await expect(runExport(bundle)).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["bundle", "assets", 0, field] })
      ])
    });
  });
});
