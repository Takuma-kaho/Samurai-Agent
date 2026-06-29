import { describe, expect, it } from "vitest";
import { builtinSurfaceRendererRegistryEntries, negotiateSurfaceRenderSpec, parseSurfaceOperation, SurfaceOperationDispatchPlanSchema, SurfaceRenderSpecSchema, surfaceOperationResultKinds, surfaceRenderKinds } from "./index";

describe("surface operation protocol", () => {
  it("fills ids for lightweight message submit clients", () => {
    const operation = parseSurfaceOperation({
      kind: "message.submit",
      session_id: "session_1",
      content: "hello"
    });

    expect(operation).toMatchObject({
      kind: "message.submit",
      session_id: "session_1",
      content: "hello"
    });
    expect(operation?.id.startsWith("surface_")).toBe(true);
  });

  it("keeps collection patch clients backward compatible without patch ids", () => {
    const operation = parseSurfaceOperation({
      kind: "collection.record.patch",
      collection_id: "contacts",
      record_id: "record_1",
      changes: { name: "Samurai" }
    });

    expect(operation).toMatchObject({
      kind: "collection.record.patch",
      collection_id: "contacts",
      record_id: "record_1",
      changes: { name: "Samurai" }
    });
    expect(operation?.id.startsWith("surface_")).toBe(true);
    expect(operation?.kind === "collection.record.patch" ? operation.patch_id.startsWith("collection_patch_") : false).toBe(true);
  });

  it("validates surface dispatch plans", () => {
    const plan = SurfaceOperationDispatchPlanSchema.parse({
      operation_id: "surface_1",
      operation_kind: "table.patch",
      dispatch_target: "artifact_pipeline",
      runtime_method: "runStructuredSurfaceOperation",
      operation_name: "artifact.create",
      result_kind: "table_patch",
      render_kind: "table",
      requires_session: true,
      writes_workspace: true,
      output_resource_kind: "table",
      proposed_effects: ["Persist table patch as an artifact."]
    });

    expect(plan.dispatch_target).toBe("artifact_pipeline");
  });

  it("declares renderer registry entries for every standard render kind", () => {
    const declaredKinds = new Set(builtinSurfaceRendererRegistryEntries.map((entry) => entry.kind));

    expect(surfaceRenderKinds.every((kind) => declaredKinds.has(kind))).toBe(true);
  });

  it("validates render specs returned by Host surface operations", () => {
    const renderSpec = SurfaceRenderSpecSchema.parse({
      id: "render_1",
      kind: "chat",
      priority: "primary",
      title: "Chat",
      resource_refs: [{
        kind: "session",
        id: "session_1",
        uri: "sessions/session_1",
        label: "Chat"
      }],
      props: {
        session_id: "session_1",
        backend_run_id: "run_1",
        backend_status: "completed",
        message_ids: ["message_1"],
        primary_message_id: "message_1",
        artifact_ids: [],
        memory_ids: [],
        reflection_suggestion_ids: []
      }
    });

    expect(renderSpec.kind).toBe("chat");
    expect(renderSpec.state).toBe("ready");
    expect(renderSpec.resource_refs[0]?.kind).toBe("session");
  });

  it("validates collection record render props with resolved refs and embeds", () => {
    const renderSpec = SurfaceRenderSpecSchema.parse({
      id: "render_collection_record",
      kind: "collection_record",
      priority: "primary",
      resource_refs: [],
      props: {
        collection_id: "contacts",
        record_id: "record_1",
        file_path: "collections/contacts/records/record_1.json",
        data: {
          name: "Takuma",
          manager_id: "manager",
          profile: { role: "owner" }
        },
        record_resource_refs: [],
        resolved_refs: [{
          ref_id: "manager_id",
          field: "manager_id",
          target_collection_id: "contacts",
          target_record_id: "manager",
          record: {
            id: "manager",
            collection_id: "contacts",
            data: { name: "Manager" },
            resource_refs: [],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            file_path: "collections/contacts/records/manager.json"
          },
          resource_ref: {
            kind: "collection_record",
            id: "manager",
            uri: "collections/contacts/records/manager.json",
            label: "contacts/manager"
          }
        }],
        missing_refs: [],
        embed_fields: [{
          embed_id: "profile",
          field: "profile",
          value: { role: "owner" }
        }]
      }
    });

    expect(renderSpec.kind).toBe("collection_record");
    expect(renderSpec.props.resolved_refs).toHaveLength(1);
  });

  it("validates dynamic form table chart render contracts", () => {
    const form = SurfaceRenderSpecSchema.parse({
      id: "render_form",
      kind: "form",
      priority: "primary",
      resource_refs: [],
      props: {
        form_id: "form_contact",
        fields: [{
          name: "name",
          label: "Name",
          type: "text",
          required: true
        }],
        submit_label: "Save",
        operation_kind: "form.submit"
      }
    });
    const table = SurfaceRenderSpecSchema.parse({
      id: "render_table",
      kind: "table",
      priority: "secondary",
      state: "ready",
      resource_refs: [],
      props: {
        table_id: "contacts",
        columns: [{ key: "name", label: "Name", type: "text" }],
        rows: [{ id: "row_1", name: "Samurai" }],
        patchable: true
      }
    });
    const chart = SurfaceRenderSpecSchema.parse({
      id: "render_chart",
      kind: "chart",
      priority: "primary",
      state: "error",
      resource_refs: [],
      props: {
        chart_id: "chart_1",
        chart_type: "bar",
        data_refs: ["collection/contacts"]
      },
      fallback: {
        kind: "table",
        message: "Show chart data as a table.",
        props: {
          table_id: "chart_1_data",
          columns: [],
          rows: []
        }
      },
      errors: [{ code: "chart_data_missing", message: "Chart data is missing.", retryable: true }]
    });

    expect(form.props.form_id).toBe("form_contact");
    expect(table.props.rows[0]?.name).toBe("Samurai");
    expect(chart.fallback?.kind).toBe("table");
    expect(chart.errors?.[0]?.retryable).toBe(true);
  });

  it("exposes structured surface result kinds for Host dispatch", () => {
    expect(surfaceOperationResultKinds).toEqual(expect.arrayContaining([
      "artifact",
      "form_submission",
      "table_patch",
      "chart_request",
      "custom_view_action"
    ]));
  });

  it("negotiates unsupported render kinds to valid fallbacks", () => {
    const chart = SurfaceRenderSpecSchema.parse({
      id: "render_chart",
      kind: "chart",
      priority: "primary",
      resource_refs: [],
      props: {
        chart_id: "chart_1",
        chart_type: "bar",
        data_refs: ["collection/progress"]
      },
      fallback: {
        kind: "table",
        message: "Show chart data as a table.",
        props: {
          table_id: "chart_1_data",
          columns: [{ key: "value", label: "Value", type: "number" }],
          rows: [{ id: "row_1", value: 10 }]
        }
      }
    });

    const negotiated = negotiateSurfaceRenderSpec(chart, {
      supported_kinds: ["chat", "table", "artifact", "status_timeline"]
    });

    expect(negotiated.kind).toBe("table");
    expect(negotiated.negotiation).toMatchObject({
      requested_kind: "chart",
      reason: "unsupported_kind",
      applied_fallback: true
    });
  });

  it("negotiates unsupported custom renderers to artifact fallback", () => {
    const customView = SurfaceRenderSpecSchema.parse({
      id: "render_custom",
      kind: "custom_view",
      priority: "primary",
      resource_refs: [{ kind: "artifact", id: "artifact_1", uri: "artifacts/a.md" }],
      props: {
        view_id: "kanban",
        renderer: "kanban",
        renderer_version: "1",
        actions: [],
        data: { column_count: 3 }
      },
      fallback: {
        kind: "artifact",
        message: "Open artifact fallback.",
        props: {
          artifact_id: "artifact_1",
          file_path: "artifacts/a.md",
          title: "Kanban export"
        }
      }
    });

    const negotiated = negotiateSurfaceRenderSpec(customView, {
      supported_kinds: ["chat", "custom_view", "artifact", "status_timeline"],
      custom_view_renderers: [{ renderer: "calendar", versions: ["1"] }]
    });

    expect(negotiated.kind).toBe("artifact");
    expect(negotiated.negotiation).toMatchObject({
      requested_kind: "custom_view",
      requested_renderer: "kanban",
      reason: "unsupported_custom_renderer",
      applied_fallback: true
    });
  });

  it("returns an error status render spec when no valid fallback exists", () => {
    const chart = SurfaceRenderSpecSchema.parse({
      id: "render_chart",
      kind: "chart",
      priority: "secondary",
      title: "Progress chart",
      resource_refs: [],
      props: {
        chart_id: "chart_1",
        chart_type: "bar",
        data_refs: []
      }
    });

    const negotiated = negotiateSurfaceRenderSpec(chart, {
      supported_kinds: ["chat", "status_timeline"]
    });

    expect(negotiated).toMatchObject({
      kind: "status_timeline",
      state: "error",
      props: {
        status: "renderer_unsupported",
        requested_kind: "chart"
      },
      negotiation: {
        requested_kind: "chart",
        reason: "unsupported_kind",
        applied_fallback: false
      }
    });
  });
});
