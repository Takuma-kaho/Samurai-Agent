import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendOutputEvent, BackendRunInput } from "@samurai-agent/agent-backends";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { handleBackendToolCall } from "./backend-feedback";

const roots: string[] = [];

async function createStore() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-backend-feedback-"));
  roots.push(root);
  return WorkspaceStore.create({ rootDir: root });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function backendRun(): BackendRunRecord {
  return {
    id: "run_feedback",
    session_id: "session_feedback",
    input_message_id: "message_feedback",
    backend_id: "test-backend",
    backend_kind: "samurai_native",
    status: "running",
    started_at: "2026-06-27T00:00:00.000Z",
    input_summary: "feedback test",
    metadata: {}
  } as BackendRunRecord;
}

function runInput(): BackendRunInput {
  return {
    session_id: "session_feedback",
    input_message_id: "message_feedback",
    user_input: "feedback test",
    input_locale: "en",
    output_locale: "en",
    metadata: {}
  } as BackendRunInput;
}

describe("backend feedback fallback", () => {
  it("keeps legacy provider tool fallback diagnostic-only for artifact and memory writes", async () => {
    const store = await createStore();
    const run = backendRun();
    const input = runInput();
    const settings = await store.getSettings();
    await store.createSession({
      id: run.session_id,
      session_key: "web:owner:feedback",
      title: "Feedback fallback",
      ui_locale: settings.ui_locale,
      output_locale: settings.output_locale,
      created_at: "2026-06-27T00:00:00.000Z",
      updated_at: "2026-06-27T00:00:00.000Z"
    });
    await store.saveBackendRun(run);

    const artifact = await handleBackendToolCall({
      store,
      run,
      runInput: input,
      event: {
        event_type: "tool_call_started",
        tool_call_id: "tool_artifact",
        payload: {
          provider_tool_name: "create_artifact",
          arguments: {
            title: "Legacy fallback artifact",
            content: "This valid payload must still go through Domain Command."
          }
        }
      } as BackendOutputEvent
    });
    const memory = await handleBackendToolCall({
      store,
      run,
      runInput: input,
      event: {
        event_type: "tool_call_started",
        tool_call_id: "tool_memory",
        payload: {
          provider_tool_name: "remember_topic",
          arguments: {
            topic: "fallback",
            content: "This valid payload must still go through Domain Command."
          }
        }
      } as BackendOutputEvent
    });
    await store.close();

    expect(artifact.artifacts).toEqual([]);
    expect(artifact.memories).toEqual([]);
    expect(artifact.operations).toEqual([]);
    expect(artifact.workspaceChanges).toEqual([]);
    expect(artifact.events).toEqual([
      expect.objectContaining({
        event_type: "tool_call_output",
        payload: expect.objectContaining({
          status: "ignored",
          action_id: "artifact.create",
          reason: "provider_tool_requires_domain_command"
        })
      })
    ]);
    expect(artifact.toolRuns).toEqual([
      expect.objectContaining({
        provider_tool_name: "create_artifact",
        action_id: "artifact.create",
        status: "ignored"
      })
    ]);

    expect(memory.artifacts).toEqual([]);
    expect(memory.memories).toEqual([]);
    expect(memory.operations).toEqual([]);
    expect(memory.workspaceChanges).toEqual([]);
    expect(memory.events).toEqual([
      expect.objectContaining({
        event_type: "tool_call_output",
        payload: expect.objectContaining({
          status: "ignored",
          action_id: "memory.topic.create",
          reason: "provider_tool_requires_domain_command"
        })
      })
    ]);
    expect(memory.toolRuns).toEqual([
      expect.objectContaining({
        provider_tool_name: "remember_topic",
        action_id: "memory.topic.create",
        status: "ignored"
      })
    ]);
  });
});
