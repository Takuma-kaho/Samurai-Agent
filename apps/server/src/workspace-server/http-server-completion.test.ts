import { describe, expect, it, vi } from "vitest";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import type { PostgresRuntimeChatCompletionEvent } from "../adapters/runtime/postgres-runtime-chat.js";
import { createPostgresRuntimeToolExecutionPort, normalizeGeneratedSurfaceTargetResult, recordPostgresChatCompletionActivity, runtimeArtifactMetadata, runtimeArtifactSourceMetadata, runtimeChatAvailableProviderTools, workspaceFileResourceRef } from "./http-server.js";

describe("PostgreSQL Runtime Completion projection", () => {
  it("always submits the stable Activity ID so Completion can atomically replay it", async () => {
    const ingestedOperationIds: string[] = [];
    const ingestedActivityIds: Array<string | undefined> = [];
    const ingestedEpisodeKeys: string[] = [];
    const changedResourceIds: string[][] = [];
    const commands = {
      ingestCompletionActivity: async (context: { operationId: string }, input: { id?: string; externalEpisodeKey?: string; changedResources?: readonly string[] }) => {
        ingestedOperationIds.push(context.operationId);
        ingestedActivityIds.push(input.id);
        if (input.externalEpisodeKey) ingestedEpisodeKeys.push(input.externalEpisodeKey);
        changedResourceIds.push([...(input.changedResources ?? [])]);
        return { replayed: ingestedOperationIds.length > 1 };
      }
    };

    await recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent());
    await recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent());

    expect(ingestedOperationIds).toHaveLength(2);
    expect(ingestedOperationIds[0]).toMatch(/^runtime_chat_completion_/);
    expect(ingestedOperationIds[0]).not.toBe(ingestedOperationIds[1]);
    expect(ingestedActivityIds[0]).toBe(ingestedActivityIds[1]);
    expect(ingestedEpisodeKeys).toEqual(["run-a", "run-a"]);
    expect(changedResourceIds).toEqual([["message-output-a"], ["message-output-a"]]);
  });

  it("does not treat a conflicting Activity with the same ID as a successful projection", async () => {
    const commands = {
      ingestCompletionActivity: async () => {
        throw new WorkspaceServerError("workspace_completion_activity_id_conflict", 409);
      }
    };

    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).rejects.toMatchObject({
      code: "workspace_completion_activity_id_conflict",
      status: 409
    });
  });

  it("uses a new operation ledger entry after a failed projection", async () => {
    const ingestedOperationIds: string[] = [];
    const commands = {
      ingestCompletionActivity: async (context: { operationId: string }) => {
        ingestedOperationIds.push(context.operationId);
        if (ingestedOperationIds.length === 1) throw new Error("projection_write_failed");
        return {};
      }
    };

    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).rejects.toThrow("projection_write_failed");
    await expect(recordPostgresChatCompletionActivity(commands as never, projectionContext(), completionEvent())).resolves.toEqual(undefined);

    expect(ingestedOperationIds).toHaveLength(2);
    expect(ingestedOperationIds[0]).not.toBe(ingestedOperationIds[1]);
  });
});

describe("Workspace file ResourceRef response", () => {
  it("emits only the server-owned logical file identity", () => {
    expect(workspaceFileResourceRef({
      workspaceId: "workspace-file-ref",
      roomId: "room-file-ref",
      path: "notes/brief.md",
      version: 3,
      sha256: "a".repeat(64),
      size: 12,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z"
    })).toEqual({
      kind: "file",
      id: "a".repeat(64),
      uri: "notes/brief.md",
      version: "3",
      label: "notes/brief.md"
    });
  });
});

describe("Generated Surface target result boundary", () => {
  it("omits optional in-memory fields before persisting an Artifact action result", () => {
    expect(normalizeGeneratedSurfaceTargetResult({
      artifact: {
        id: "artifact-surface-save",
        title: "Surface save",
        source_operation_id: undefined
      },
      revision: {
        id: "artifact-revision-surface-save",
        change_summary: undefined
      },
      replayed: false
    })).toEqual({
      artifact: { id: "artifact-surface-save", title: "Surface save" },
      revision: { id: "artifact-revision-surface-save" },
      replayed: false
    });
  });

  it("rejects a non-serializable target result before it reaches the durable Activity ledger", () => {
    expect(() => normalizeGeneratedSurfaceTargetResult({ value: BigInt(1) })).toThrow("generated_surface_target_result_invalid");
  });
});

describe("Native Runtime provider tools", () => {
  it("keeps delegation out of the normal Chat capability set", () => {
    expect(runtimeChatAvailableProviderTools()).toEqual([
      "create_artifact",
      "revise_artifact",
      "create_generated_surface",
      "generated_surface.revise"
    ]);
    expect(runtimeChatAvailableProviderTools({ roomWorkBinding: true })).toEqual([
      "create_artifact",
      "revise_artifact",
      "create_generated_surface",
      "generated_surface.revise",
      "subagent_delegate"
    ]);
  });

  it("projects only the persisted server Work binding into Artifact source metadata", () => {
    const run = {
      id: "run-source-a",
      room_id: "room-source-a",
      metadata: {
        runtime_binding: {
          workspace_id: "workspace-source-a",
          room_id: "room-source-a",
          work_id: "work-source-a",
          assignee_id: "assignee-source-a"
        }
      }
    } as const;

    expect(runtimeArtifactSourceMetadata(run, "workspace-source-a", "room-source-a")).toEqual({
      source_work_id: "work-source-a",
      source_assignee_id: "assignee-source-a",
      source_run_id: "run-source-a"
    });
    expect(runtimeArtifactSourceMetadata({
      ...run,
      metadata: { source_work_id: "model-forged" }
    }, "workspace-source-a", "room-source-a")).toBeUndefined();
    expect(runtimeArtifactSourceMetadata({
      ...run,
      metadata: {
        runtime_binding: {
          workspace_id: "workspace-source-a",
          room_id: "room-source-a",
          session_id: "session-source-a",
          agent_id: "agent-source-a",
          backend_id: "samurai-native",
          generation: 1,
          agent_configuration_version: 1
        }
      }
    }, "workspace-source-a", "room-source-a")).toBeUndefined();
    expect(runtimeArtifactMetadata({
      source_work_id: "model-forged-work",
      source_assignee_id: "model-forged-assignee",
      source_run_id: "model-forged-run",
      custom: "keep"
    }, {
      source_work_id: "work-source-a",
      source_assignee_id: "assignee-source-a",
      source_run_id: "run-source-a"
    })).toEqual({
      source_work_id: "work-source-a",
      source_assignee_id: "assignee-source-a",
      source_run_id: "run-source-a",
      custom: "keep"
    });
    expect(() => runtimeArtifactSourceMetadata({
      ...run,
      metadata: { runtime_binding: { ...run.metadata.runtime_binding, room_id: "wrong-room" } }
    }, "workspace-source-a", "room-source-a")).toThrow("runtime_artifact_binding_mismatch");
    expect(() => runtimeArtifactSourceMetadata({
      ...run,
      metadata: { runtime_binding: { ...run.metadata.runtime_binding, assignee_id: "" } }
    }, "workspace-source-a", "room-source-a")).toThrow("runtime_artifact_binding_mismatch");
  });

  it("routes Artifact revisions and Generated Surface mutations through the bound Runtime port", async () => {
    const commands = { assertRoomExecutable: vi.fn(async () => undefined) };
    const artifacts = {
      create: vi.fn(async () => ({
        artifact: { id: "artifact-new", title: "New artifact", kind: "markdown", file_ref: { kind: "artifact_revision", id: "artifact-revision-1", uri: "artifacts/artifact-new/revisions/1.md" } },
        replayed: false
      })),
      revise: vi.fn(async () => ({
        artifact: { id: "artifact-existing", title: "Existing artifact", file_ref: { kind: "artifact_revision", id: "artifact-revision-2", uri: "artifacts/artifact-existing/revisions/2.md" } },
        revision: { id: "artifact-revision-2", revision: 2, file_ref: { kind: "artifact_revision", id: "artifact-revision-2", uri: "artifacts/artifact-existing/revisions/2.md" } },
        replayed: false
      }))
    };
    const generatedSurfaces = {
      create: vi.fn(async () => generatedSurfaceMutation("surface-new", "surface-revision-1", 1)),
      revise: vi.fn(async () => generatedSurfaceMutation("surface-existing", "surface-revision-2", 2))
    };
    const port = createPostgresRuntimeToolExecutionPort(commands as never, artifacts as never, generatedSurfaces as never, {} as never, {
      workspaceId: "workspace-tools",
      accountId: "account-tools"
    });
    const run = { id: "run-tools", room_id: "room-tools", metadata: {} } as never;
    const operation = { id: "operation-tools" } as never;

    const created = await port.execute({
      run,
      operation,
      runInput: {} as never,
      event: toolEvent("create_artifact", "artifact.create", { title: "New artifact", content: "Hello" })
    });
    expect(created.output).toMatchObject({ artifact_id: "artifact-new" });
    expect(created.resourceRefs.map((ref) => ref.kind)).toEqual(["artifact", "artifact_revision"]);

    const revised = await port.execute({
      run,
      operation: { id: "operation-revise" } as never,
      runInput: {} as never,
      event: toolEvent("revise_artifact", "artifact.revise", {
        artifact_id: "artifact-existing",
        content: "Revised",
        provenance: {}
      })
    });
    expect(artifacts.revise).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-revise" }), expect.objectContaining({
      artifactId: "artifact-existing",
      editorSource: "provider"
    }));
    expect(revised.resourceRefs.map((ref) => ref.kind)).toEqual(["artifact", "artifact_revision"]);

    const surfaceCreate = await port.execute({
      run,
      operation: { id: "operation-surface-create" } as never,
      runInput: {} as never,
      event: toolEvent("create_generated_surface", "generated_surface.create", generatedSurfaceToolInput())
    });
    expect(generatedSurfaces.create).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "operation-surface-create",
      runtimeRunId: "run-tools"
    }), "room-tools", expect.any(Object));
    expect(surfaceCreate.resourceRefs.map((ref) => ref.kind)).toEqual(["generated_surface", "generated_surface_revision"]);
    expect(generatedSurfaces.create).toHaveBeenLastCalledWith(
      expect.any(Object),
      "room-tools",
      expect.objectContaining({
        request: expect.objectContaining({ allowed_domain_commands: ["artifact.create"] }),
        bundle: expect.objectContaining({ actions: [expect.objectContaining({ command_id: "artifact.create" })] })
      })
    );

    await port.execute({
      run,
      operation: { id: "operation-surface-revise" } as never,
      runInput: {} as never,
      event: toolEvent("generated_surface.revise", "generated_surface.revise", {
        ...generatedSurfaceToolInput(),
        surface_id: "surface-existing"
      })
    });
    expect(generatedSurfaces.revise).toHaveBeenCalledWith(expect.objectContaining({ runtimeRunId: "run-tools" }), "room-tools", expect.objectContaining({ surface_id: "surface-existing" }));

    await expect(port.execute({
      run,
      operation,
      runInput: {} as never,
      event: toolEvent("create_artifact", "generated_surface.create", generatedSurfaceToolInput())
    })).rejects.toMatchObject({ code: "runtime_tool_identity_mismatch", status: 409 });
  });

  it("decodes binary Artifact input only from explicit base64 transport and rejects malformed input", async () => {
    const commands = { assertRoomExecutable: vi.fn(async () => undefined) };
    const artifacts = {
      create: vi.fn(async () => ({
        artifact: { id: "artifact-pdf", title: "PDF", kind: "pdf", file_ref: { kind: "artifact", id: "artifact-pdf", uri: "artifacts/artifact-pdf.pdf" } },
        replayed: false
      })),
      revise: vi.fn()
    };
    const port = createPostgresRuntimeToolExecutionPort(commands as never, artifacts as never, {} as never, {} as never, {
      workspaceId: "workspace-tools",
      accountId: "account-tools"
    });
    const bytes = Buffer.from("%PDF-1.7\nportable binary\n", "utf8");

    await port.execute({
      run: { id: "run-pdf", room_id: "room-tools", metadata: {} } as never,
      operation: { id: "operation-pdf" } as never,
      runInput: {} as never,
      event: toolEvent("create_artifact", "artifact.create", {
        title: "PDF",
        kind: "pdf",
        mime_type: "application/pdf",
        encoding: "binary",
        content_base64: bytes.toString("base64")
      })
    });

    expect(artifacts.create).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      kind: "pdf",
      mimeType: "application/pdf",
      encoding: "binary",
      content: expect.any(Uint8Array)
    }));
    expect([...((artifacts.create.mock.calls[0]?.[1] as { content: Uint8Array }).content ?? [])]).toEqual([...bytes]);

    await expect(port.execute({
      run: { id: "run-pdf-invalid", room_id: "room-tools", metadata: {} } as never,
      operation: { id: "operation-pdf-invalid" } as never,
      runInput: {} as never,
      event: toolEvent("create_artifact", "artifact.create", {
        title: "Invalid PDF",
        kind: "pdf",
        mime_type: "application/pdf",
        encoding: "binary",
        content_base64: "not-base64"
      })
    })).rejects.toMatchObject({ code: "content_base64_invalid", status: 400 });
  });
});

function toolEvent(providerToolName: string, actionId: string, argumentsValue: Record<string, unknown>) {
  return {
    tool_call_id: `${providerToolName}:${actionId}`,
    provider_tool_name: providerToolName,
    action_id: actionId,
    arguments: argumentsValue,
    payload: {}
  } as never;
}

function generatedSurfaceToolInput(): Record<string, unknown> {
  return {
    request: {
      user_intent: "Create a Room dashboard.",
      source_resource_refs: [],
      // Gemini sees the provider-facing Artifact tool and can naturally use
      // that name inside a Generated Surface action declaration.
      allowed_domain_commands: ["create_artifact"],
      selected_knowledge_refs: [],
      selected_skill_refs: [],
      client_capabilities: {},
      expected_lifetime: "session",
      fallback_chain: ["built_in_surface"]
    },
    bundle: {
      title: "Room dashboard",
      html: "<main>Dashboard</main>",
      actions: [{
        id: "create-dashboard-artifact",
        label: "Create dashboard Artifact",
        command_id: "create_artifact",
        input_schema: {},
        payload_template: { title: "Dashboard note", content: "Created from the Surface." }
      }]
    }
  };
}

function generatedSurfaceMutation(surfaceId: string, revisionId: string, revision: number) {
  return {
    definition: { id: surfaceId, title: "Room dashboard" },
    revision: {
      id: revisionId,
      revision,
      html_ref: { kind: "generated_surface_html", id: `${revisionId}-html`, uri: `surfaces/${surfaceId}/${revisionId}.html` }
    },
    replayed: false
  };
}

function projectionContext() {
  return {
    workspaceId: "workspace-a",
    accountId: "account-a",
    operationId: "request-a"
  };
}

function completionEvent(): PostgresRuntimeChatCompletionEvent {
  return {
    session: {
      id: "session-a",
      session_key: "workspace:workspace-a:thread-a",
      room_id: "room-a",
      title: "A session",
      ui_locale: "ja",
      output_locale: "ja",
      created_at: "2026-09-03T00:00:00.000Z",
      updated_at: "2026-09-03T00:00:00.000Z"
    },
    run: {
      id: "run-a",
      session_id: "session-a",
      room_id: "room-a",
      backend_id: "samurai-native",
      backend_kind: "samurai_native",
      status: "completed",
      phase: "settled",
      current_attempt: 1,
      input_message_id: "message-a",
      output_message_id: "message-output-a",
      requested_by_participant_id: "account-a",
      request_idempotency_key: "request-a",
      request_hash: "request-hash-a",
      started_at: "2026-09-03T00:00:00.000Z",
      completed_at: "2026-09-03T00:01:00.000Z",
      input_summary: "A request",
      output_summary: "A response",
      metadata: {}
    },
    resourceRefs: [
      { kind: "message", id: "message-output-a", uri: "runtime://messages/message-output-a" },
      { kind: "message", id: "message-output-a", uri: "runtime://messages/message-output-a" }
    ],
    instructionSummary: "A request"
  };
}
