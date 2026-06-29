import { describe, expect, it } from "vitest";
import type { BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import { FakeProviderAdapter } from "./provider";
import { NativeContextBuilder, NativeToolExecutor, NativeToolLoop, SamuraiNativeBackend } from "./native-backend";

describe("SamuraiNativeBackend components", () => {
  it("builds provider context from backend run input", () => {
    const context = new NativeContextBuilder().build(backendRunInput());

    expect(context.envelope.user_intent).toBe("write a note");
    expect(context.activeMemory[0]?.frontmatter).toMatchObject({
      id: "memory_1",
      state: "active",
      topic: "style",
      source_kind: "workspace_data"
    });
    expect(context.knowledgeWiki[0]?.slug).toBe("project-notes");
    expect(context.selectedSkills[0]?.disclosure_level).toBe("body");
    expect(context.availableTools).toEqual(["create_artifact"]);
  });

  it("keeps prompt, provider, and tool event responsibilities separate", async () => {
    const backend = new SamuraiNativeBackend({
      provider: new FakeProviderAdapter("fake/native", {
        content: "Created a draft.",
        toolCalls: [{ id: "tool_1", name: "create_artifact", arguments: { title: "Draft" } }],
        finishReason: "stop",
        usage: { output_tokens: 4 }
      }),
      contextBuilder: new NativeContextBuilder(),
      toolLoop: new NativeToolLoop()
    });
    const events: BackendOutputEvent[] = [];

    for await (const event of backend.runTurn(backendRunInput())) {
      events.push(event);
    }

    expect(events.map((event) => event.event_type)).toEqual([
      "run_started",
      "text_delta",
      "tool_call_started",
      "run_completed"
    ]);
    expect(events[0]?.payload).toMatchObject({
      input_locale: "en",
      output_locale: "en",
      locale_contract: {
        user_facing_text: "output_locale",
        enforcement: "provider_prompt",
        prompt_builder: "NativePromptBuilder"
      }
    });
    expect(events[2]?.payload).toMatchObject({
      tool_call_id: "tool_1",
      provider_tool_name: "create_artifact",
      action_id: "artifact.create",
      execution_boundary: "host_runtime",
      requires_host_execution: true,
      arguments: { title: "Draft" }
    });
    expect(events[3]?.payload).toMatchObject({
      output_summary: "Created a draft.",
      finish_reason: "stop",
      usage: { output_tokens: 4 }
    });
  });

  it("plans native provider tool calls as host-runtime executions", () => {
    const plan = new NativeToolExecutor().planToolCall({
      id: "tool_2",
      name: "request_external_send",
      arguments: { channel: "email", title: "Draft" }
    });

    expect(plan).toEqual({
      tool_call_id: "tool_2",
      provider_tool_name: "request_external_send",
      action_id: "external.send.prepare",
      execution_boundary: "host_runtime",
      requires_host_execution: true,
      arguments: {
        channel: "email",
        title: "Draft"
      }
    });
  });
});

function backendRunInput(): BackendRunInput {
  return {
    run_id: "run_1",
    session_id: "session_1",
    input_message_id: "message_1",
    envelope: {
      id: "envelope_1",
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      user_intent: "write a note",
      attachments: [],
      input_locale: "en",
      output_locale: "en",
      metadata: {},
      received_at: "2026-06-26T00:00:00.000Z"
    },
    user_input: "write a note",
    input_locale: "en",
    output_locale: "en",
    active_memory: [{
      id: "memory_1",
      topic: "style",
      content: "Keep it concise.",
      state: "active",
      selection_reason: "state:active"
    }],
    knowledge_wiki: [{
      id: "wiki_1",
      slug: "project-notes",
      title: "Project Notes",
      content: "Release notes",
      source_refs: []
    }],
    collection_notes: [{
      collection_id: "collection_1",
      file_path: "collections/notes.md",
      content: "Context only",
      role: "context_only"
    }],
    selected_skills: [{
      id: "skill_1",
      title: "Drafting",
      description: "Write concise drafts",
      tags: ["writing"],
      required_capabilities: ["create_artifact"],
      disclosure_level: "body",
      content: "Write the draft."
    }],
    session_search: [{
      kind: "message",
      id: "message_old",
      title: "Earlier note",
      summary: "Previous context"
    }],
    session_summary: {
      session_key: "web:owner:main",
      title: "Note",
      ui_locale: "en",
      output_locale: "en",
      message_count: 1,
      operation_count: 0,
      backend_run_count: 0,
      tool_run_count: 0,
      workspace_change_count: 0
    },
    external_assist: {
      role: "disabled",
      isolated_from_memory: true,
      included_in_active_memory: false,
      note: "External assist disabled.",
      hints: [],
      recent_failures: []
    },
    available_tools: ["create_artifact"],
    recent_messages: [],
    metadata: {}
  };
}
