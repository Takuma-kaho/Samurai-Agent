import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@samurai-agent/core-schemas";
import type { SurfaceRenderSpec } from "@samurai-agent/ui-protocol";
import CustomViewFrame from "./CustomViewFrame.vue";

describe("CustomViewFrame", () => {
  it("renders sandboxed srcdoc custom views with actions", async () => {
    const html = await renderCustomView(customViewSpec({
      html: "<main><h1>Board</h1><button onclick=\"dispatchSamuraiAction('move_card',{card_id:'card_1'})\">Move</button></main>"
    }));

    expect(html).toContain("custom-view-iframe");
    expect(html).toContain("allow-scripts");
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain("samuraiCustomView");
    expect(html).toContain("Move card");
  });

  it("keeps the JSON fallback when no html is provided", async () => {
    const html = await renderCustomView(customViewSpec({ payload_only: true }));

    expect(html).toContain("surface-json");
    expect(html).toContain("payload_only");
  });
});

async function renderCustomView(spec: SurfaceRenderSpec): Promise<string> {
  const app = createSSRApp({
    render() {
      return h(CustomViewFrame, {
        spec,
        saving: false,
        runAction: () => undefined
      });
    }
  });
  return renderToString(app);
}

function customViewSpec(data: Record<string, JsonValue>): SurfaceRenderSpec {
  return {
    id: "render_custom_board",
    kind: "custom_view",
    priority: "primary",
    state: "ready",
    title: "Board",
    resource_refs: [],
    props: {
      view_id: "board",
      renderer: "board",
      renderer_version: "1",
      sandbox: {
        mode: "iframe",
        allow_scripts: true,
        allow_forms: false,
        allow_same_origin: false,
        network_access: "none",
        workspace_access: "none"
      },
      capability: {
        token_id: "custom_view:board",
        allowed_actions: ["move_card"],
        read_resource_refs: [],
        write_operations: ["custom_view.action"]
      },
      actions: [{
        id: "move_card",
        label: "Move card",
        operation_kind: "custom_view.action"
      }],
      data
    }
  };
}
