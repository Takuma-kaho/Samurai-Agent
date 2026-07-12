import { createHash } from "node:crypto";
import { getDomainCommandEntry } from "@samurai-agent/action-catalog";
import {
  GeneratedSurfaceDefinitionSchema,
  GeneratedSurfaceRevisionRecordSchema,
  GeneratedSurfaceValidationReportSchema,
  createId,
  nowIso,
  stableHash,
  type GeneratedSurfaceActionDeclaration,
  type GeneratedSurfaceDefinition,
  type GeneratedSurfaceRevisionRecord,
  type GeneratedSurfaceValidationReport,
  type ResourceRef,
  type SurfaceGenerationRequest
} from "@samurai-agent/core-schemas";

export const generatedSurfaceCsp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

export interface GeneratedSurfaceBundleInput {
  title: string;
  html: string;
  css?: string;
  script?: string;
  actions: GeneratedSurfaceActionDeclaration[];
  input_data_schema?: Record<string, unknown>;
}

export function validateGeneratedSurfaceBundle(request: SurfaceGenerationRequest, bundle: GeneratedSurfaceBundleInput): GeneratedSurfaceValidationReport {
  const issues: Array<{ code: string; message: string }> = [];
  const htmlBytes = Buffer.byteLength(bundle.html, "utf8");
  const cssBytes = Buffer.byteLength(bundle.css ?? "", "utf8");
  const scriptBytes = Buffer.byteLength(bundle.script ?? "", "utf8");
  if (!bundle.title.trim() || !bundle.html.trim()) issues.push({ code: "surface_bundle_required", message: "A title and HTML body are required." });
  if (htmlBytes > 200_000) issues.push({ code: "surface_html_too_large", message: "HTML exceeds 200 KB." });
  if (cssBytes > 100_000) issues.push({ code: "surface_css_too_large", message: "CSS exceeds 100 KB." });
  if (scriptBytes > 50_000) issues.push({ code: "surface_script_too_large", message: "Script exceeds 50 KB." });
  if (bundle.actions.length > 20) issues.push({ code: "surface_too_many_actions", message: "A surface can declare at most 20 actions." });
  if (/<(?:script|iframe|object|embed|base|form)\b/i.test(bundle.html)) issues.push({ code: "surface_html_forbidden_element", message: "HTML contains a forbidden element." });
  if (/\son[a-z]+\s*=/i.test(bundle.html)) issues.push({ code: "surface_html_inline_handler", message: "Inline event handlers are forbidden." });
  if (/(?:javascript:|https?:\/\/|\/\/[^\s"'])/i.test(`${bundle.html}\n${bundle.css ?? ""}`)) issues.push({ code: "surface_external_url", message: "External URLs are forbidden." });
  if (/(?:\beval\s*\(|\bFunction\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|document\.cookie|localStorage|sessionStorage|indexedDB|navigator\.sendBeacon|import\s*\()/i.test(bundle.script ?? "")) {
    issues.push({ code: "surface_script_forbidden_capability", message: "Script requests a forbidden capability." });
  }
  if (/<\/style/i.test(bundle.css ?? "") || /<\/script/i.test(bundle.script ?? "")) issues.push({ code: "surface_bundle_context_breakout", message: "Bundle content attempts to escape its style or script context." });
  const actionIds = new Set<string>();
  for (const action of bundle.actions) {
    if (actionIds.has(action.id)) issues.push({ code: "surface_action_duplicate", message: `Duplicate action id: ${action.id}` });
    actionIds.add(action.id);
    if (!request.allowed_domain_commands.includes(action.command_id)) issues.push({ code: "surface_action_not_allowed", message: `Command is not allowed by the generation request: ${action.command_id}` });
    const command = getDomainCommandEntry(action.command_id);
    if (!command || !command.input_sources.includes("generated_surface")) issues.push({ code: "surface_action_command_incompatible", message: `Command does not accept Generated Surface input: ${action.command_id}` });
  }
  const fallback = request.fallback_chain[0];
  return GeneratedSurfaceValidationReportSchema.parse({ valid: issues.length === 0, issues, html_bytes: htmlBytes, css_bytes: cssBytes, script_bytes: scriptBytes, action_count: bundle.actions.length, csp: generatedSurfaceCsp, ...(!issues.length || !fallback ? {} : { fallback }) });
}

export function buildGeneratedSurfaceRevision(input: {
  request: SurfaceGenerationRequest;
  bundle: GeneratedSurfaceBundleInput;
  existing?: GeneratedSurfaceDefinition;
  producerRunId?: string;
  promptFingerprint?: string;
  now?: string;
}): { definition: GeneratedSurfaceDefinition; revision: GeneratedSurfaceRevisionRecord; validation: GeneratedSurfaceValidationReport } {
  const validation = validateGeneratedSurfaceBundle(input.request, input.bundle);
  if (!validation.valid) throw new Error(`generated_surface_invalid:${validation.issues.map((issue) => issue.code).join(",")}`);
  const now = input.now ?? nowIso();
  const surfaceId = input.existing?.id ?? createId("surface");
  const revisionNumber = (input.existing?.current_revision ?? 0) + 1;
  const revisionId = createId("surface_revision");
  const root = `surfaces/${surfaceId}/revisions/${revisionNumber}`;
  const htmlRef: ResourceRef = { kind: "generated_surface_html", id: revisionId, uri: `${root}.html`, label: input.bundle.title };
  const cssRef: ResourceRef | undefined = input.bundle.css !== undefined ? { kind: "generated_surface_css", id: revisionId, uri: `${root}.css`, label: input.bundle.title } : undefined;
  const scriptRef: ResourceRef | undefined = input.bundle.script !== undefined ? { kind: "generated_surface_script", id: revisionId, uri: `${root}.js`, label: input.bundle.title } : undefined;
  const bundleHash = sha256(`${input.bundle.html}\0${input.bundle.css ?? ""}\0${input.bundle.script ?? ""}\0${JSON.stringify(input.bundle.actions)}`);
  const revision = GeneratedSurfaceRevisionRecordSchema.parse({
    id: revisionId, surface_id: surfaceId, revision: revisionNumber, parent_revision_id: input.existing?.current_revision_id,
    producer_run_id: input.producerRunId, prompt_fingerprint: input.promptFingerprint ?? stableHash(input.request.user_intent),
    knowledge_refs: input.request.selected_knowledge_refs, skill_refs: input.request.selected_skill_refs,
    html_ref: htmlRef, css_ref: cssRef, script_ref: scriptRef, bundle_hash: bundleHash, validation_report: validation, created_at: now
  });
  const definition = GeneratedSurfaceDefinitionSchema.parse({
    id: surfaceId,
    state: input.existing?.state ?? (input.request.expected_lifetime === "pinned" ? "pinned" : "ephemeral"),
    session_id: input.request.session_id,
    title: input.bundle.title,
    input_data_schema: input.bundle.input_data_schema ?? {},
    actions: input.bundle.actions,
    capability_manifest: { allowed_domain_commands: input.request.allowed_domain_commands, network_access: "none", workspace_write: "domain_commands_only" },
    source_refs: input.request.source_resource_refs,
    generation_run_id: input.producerRunId,
    content_hash: bundleHash,
    current_revision_id: revision.id,
    current_revision: revisionNumber,
    preview_url: `/api/generated-surfaces/${surfaceId}/revisions/${revision.id}/preview`,
    fallback_chain: input.request.fallback_chain,
    created_at: input.existing?.created_at ?? now,
    updated_at: now
  });
  return { definition, revision, validation };
}

export function parseGeneratedSurfaceOutput(value: unknown): GeneratedSurfaceBundleInput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const surface = "custom_view" in value && value.custom_view && typeof value.custom_view === "object" ? value.custom_view as Record<string, unknown> : value as Record<string, unknown>;
  if (typeof surface.title !== "string" || typeof surface.html !== "string" || !Array.isArray(surface.actions)) return undefined;
  return {
    title: surface.title,
    html: surface.html,
    ...(typeof surface.css === "string" ? { css: surface.css } : {}),
    ...(typeof surface.script === "string" ? { script: surface.script } : {}),
    actions: surface.actions as GeneratedSurfaceActionDeclaration[],
    ...(surface.input_data_schema && typeof surface.input_data_schema === "object" && !Array.isArray(surface.input_data_schema) ? { input_data_schema: surface.input_data_schema as Record<string, unknown> } : {})
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
