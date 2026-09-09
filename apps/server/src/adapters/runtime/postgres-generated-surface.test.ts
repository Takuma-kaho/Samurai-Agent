import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { GeneratedSurfaceDefinition, GeneratedSurfaceRevisionRecord, JsonValue, SurfaceInteractionRecord } from "@samurai-agent/core-schemas";
import { WorkspaceServerError, type WorkspaceRecord, type WorkspaceRequestContext } from "@samurai-agent/workspace-server";
import {
  PostgresGeneratedSurface,
  applyRuntimeRoomWorkSourceRefs,
  generatedSurfaceRoomWorkSourceRef,
  type GeneratedSurfaceActionTarget,
  type GeneratedSurfaceTargetCommandResult
} from "./postgres-generated-surface";

const context: WorkspaceRequestContext = {
  workspaceId: "workspace-r15-generated-surface",
  accountId: "account-r15-generated-surface",
  operationId: "operation-r15-generated-surface"
};

const roomId = "room-r15-generated-surface";
const surfaceId = "surface-r15-generated-surface";
const revisionId = "revision-r15-2";

function createSurface(input: { revisionId?: string; revision?: number; actionCommandId?: string; sessionId?: string | null } = {}): GeneratedSurfaceDefinition {
  const currentRevisionId = input.revisionId ?? revisionId;
  const currentRevision = input.revision ?? 2;
  const actionCommandId = input.actionCommandId ?? "collection.action.run";
  return {
    id: surfaceId,
    state: "pinned",
    ...(input.sessionId === null ? {} : { session_id: input.sessionId ?? "session-r15-generated-surface" }),
    title: "R15 confirmation surface",
    input_data_schema: {},
    actions: [{
      id: "publish",
      label: "Publish",
      command_id: actionCommandId,
      input_schema: {},
      payload_template: { collection_id: "orders", action_id: "publish" },
      requires_confirmation: true
    }],
    capability_manifest: {
      allowed_domain_commands: [actionCommandId],
      network_access: "none",
      workspace_write: "domain_commands_only"
    },
    source_refs: [],
    content_hash: `surface-hash-${currentRevision}`,
    current_revision_id: currentRevisionId,
    current_revision: currentRevision,
    preview_url: "/preview",
    fallback_chain: ["text"],
    created_at: "2026-09-08T00:00:00.000Z",
    updated_at: "2026-09-08T00:00:00.000Z"
  };
}

function createActionRequest(actionPayload: Record<string, JsonValue> = { record_id: "order-1", payload: { status: "approved" } }) {
  return {
    room_id: roomId,
    surface_id: surfaceId,
    revision_id: revisionId,
    action_id: "publish",
    action_payload: actionPayload,
    interaction_id: "interaction-r15-action",
    message_id: "message-r15-action"
  } as const;
}

function createRevision(): GeneratedSurfaceRevisionRecord {
  return {
    id: revisionId,
    surface_id: surfaceId,
    revision: 2,
    source_resource_refs: [{ kind: "room_work", id: "model-forged-work", uri: "samurai://room_work/model-forged-work" }],
    prompt_fingerprint: "prompt-fingerprint",
    knowledge_refs: [],
    skill_refs: [],
    html_ref: { kind: "generated_surface_html", id: revisionId, uri: "surfaces/surface-r15/revisions/2.html", label: "R15 confirmation surface" },
    bundle_hash: "bundle-hash",
    validation_report: {
      valid: true,
      issues: [],
      html_bytes: 1,
      css_bytes: 0,
      script_bytes: 0,
      action_count: 1,
      csp: "default-src 'none'"
    },
    created_at: "2026-09-08T00:00:00.000Z"
  };
}

describe("Generated Surface Room Work provenance", () => {
  it("replaces provider room_work refs with the admitted server-owned Work ref", () => {
    const value = applyRuntimeRoomWorkSourceRefs({
      definition: {
        ...createSurface(),
        source_refs: [{ kind: "room_work", id: "model-forged-work", uri: "samurai://room_work/model-forged-work" }]
      },
      revision: createRevision()
    }, "work-r15-generated-surface");
    const sourceRef = generatedSurfaceRoomWorkSourceRef("work-r15-generated-surface");

    expect(value.definition.source_refs).toEqual([sourceRef]);
    expect(value.revision.source_resource_refs).toEqual([sourceRef]);
    expect(sourceRef).toEqual({
      kind: "room_work",
      id: "work-r15-generated-surface",
      uri: "samurai://room_work/work-r15-generated-surface",
      label: "work-r15-generated-surface"
    });
  });
});

function createRecord(
  workspaceId: string,
  room: string,
  recordType: string,
  id: string,
  payload: Record<string, unknown>,
  version = 1
): WorkspaceRecord {
  return {
    workspaceId,
    roomId: room,
    recordType,
    id,
    version,
    payload,
    contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z"
  };
}

class FakeCommands {
  private readonly records = new Map<string, WorkspaceRecord>();
  readonly interactions: SurfaceInteractionRecord[] = [];
  readonly assertRoomExecutable = vi.fn(async (_context: unknown, _room: string) => {
    if (!this.executionAllowed) throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
  });
  executionAllowed = true;

  constructor(surface: GeneratedSurfaceDefinition) {
    this.replaceSurface(surface);
  }

  replaceSurface(surface: GeneratedSurfaceDefinition): void {
    this.records.set(this.key(roomId, "generated_surface", surface.id), createRecord(
      context.workspaceId,
      roomId,
      "generated_surface",
      surface.id,
      surface as unknown as Record<string, unknown>
    ));
  }

  async getRecord(_context: unknown, input: { roomId: string; recordType: string; id: string }): Promise<WorkspaceRecord> {
    const record = this.records.get(this.key(input.roomId, input.recordType, input.id));
    if (!record) throw new WorkspaceServerError("workspace_record_not_found", 404);
    return record;
  }

  async putRecord(
    requestContext: { workspaceId: string },
    input: { roomId: string; recordType: string; id: string; expectedVersion: number; payload: Record<string, unknown> }
  ): Promise<{ record: WorkspaceRecord }> {
    const key = this.key(input.roomId, input.recordType, input.id);
    const current = this.records.get(key);
    if ((current?.version ?? 0) !== input.expectedVersion) {
      throw new WorkspaceServerError("workspace_record_version_conflict", 409);
    }
    const record = createRecord(requestContext.workspaceId, input.roomId, input.recordType, input.id, input.payload, input.expectedVersion + 1);
    this.records.set(key, record);
    if (input.recordType === "surface_interaction") this.interactions.push(input.payload as unknown as SurfaceInteractionRecord);
    return { record };
  }

  private key(room: string, recordType: string, id: string): string {
    return `${room}:${recordType}:${id}`;
  }
}

function createHarness(targetCommand?: (requestContext: WorkspaceRequestContext, input: { roomId: string; commandId: string; payload: Record<string, JsonValue>; operationId: string }) => Promise<GeneratedSurfaceTargetCommandResult>) {
  const commands = new FakeCommands(createSurface());
  const command = vi.fn(targetCommand ?? (async () => ({ result: { accepted: true } })));
  const adapter = new PostgresGeneratedSurface(commands as never, {} as never, command);
  return { adapter, commands, command };
}

describe("PostgresGeneratedSurface confirmation action boundary", () => {
  it("does not allow the client to override a server-owned payload_template", async () => {
    const harness = createHarness();

    await expect(harness.adapter.prepareAction(context, createActionRequest({
      collection_id: "attacker-collection",
      action_id: "publish",
      record_id: "order-1",
      payload: { status: "approved" }
    }))).rejects.toMatchObject({
      code: "generated_surface_action_payload_template_override",
      status: 409
    });
    expect(harness.command).not.toHaveBeenCalled();
  });

  it("rejects a durable target when its revision, action, command, or payload is changed", async () => {
    const cases: Array<{
      label: string;
      expectedCode: string;
      expectedStatus: number;
      mutate: (target: GeneratedSurfaceActionTarget) => GeneratedSurfaceActionTarget;
    }> = [
      {
        label: "revision",
        expectedCode: "generated_surface_revision_stale",
        expectedStatus: 409,
        mutate: (target) => ({ ...target, revision_id: "revision-r15-old" })
      },
      {
        label: "action",
        expectedCode: "generated_surface_action_not_declared",
        expectedStatus: 403,
        mutate: (target) => ({ ...target, action_id: "delete" })
      },
      {
        label: "command",
        expectedCode: "generated_surface_action_target_stale",
        expectedStatus: 409,
        mutate: (target) => ({ ...target, command_id: "artifact.create" })
      },
      {
        label: "payload",
        expectedCode: "generated_surface_action_payload_template_override",
        expectedStatus: 409,
        mutate: (target) => ({ ...target, payload: { ...target.payload, collection_id: "attacker-collection" } })
      }
    ];

    for (const scenario of cases) {
      const harness = createHarness();
      const prepared = await harness.adapter.prepareAction(context, createActionRequest());

      await expect(harness.adapter.executeActionTarget(context, scenario.mutate(prepared.target))).rejects.toMatchObject({
        code: scenario.expectedCode,
        status: scenario.expectedStatus
      });
      expect(harness.command, scenario.label).not.toHaveBeenCalled();
      expect(harness.commands.interactions, scenario.label).toHaveLength(0);
    }
  });

  it("rechecks Room execute permission immediately before side effects", async () => {
    const harness = createHarness();
    const prepared = await harness.adapter.prepareAction(context, createActionRequest());
    harness.commands.assertRoomExecutable
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new WorkspaceServerError("room_not_executable_or_access_denied", 403);
      });

    await expect(harness.adapter.executeActionTarget(context, prepared.target)).rejects.toMatchObject({
      code: "room_not_executable_or_access_denied",
      status: 403
    });
    expect(harness.commands.assertRoomExecutable).toHaveBeenCalledTimes(3);
    expect(harness.command).not.toHaveBeenCalled();
    expect(harness.commands.interactions).toHaveLength(0);
  });

  it("uses a deterministic scoped operation ID for a target side effect", async () => {
    const harness = createHarness(async () => ({ result: { accepted: true } }));
    const rendererContext = { ...context, operationId: "32e2fabb-da94-41eb-831b-8ab06dd8df4d" };
    const prepared = await harness.adapter.prepareAction(rendererContext, createActionRequest());

    await expect(harness.adapter.executeActionTarget(rendererContext, prepared.target)).resolves.toMatchObject({
      target_result: { accepted: true }
    });
    expect(harness.commands.assertRoomExecutable).toHaveBeenCalledTimes(3);
    const [targetContext, targetInput] = harness.command.mock.calls[0]!;
    expect(targetContext).toMatchObject({
      ...rendererContext,
      operationId: expect.stringMatching(/^surface_[a-f0-9]{8}$/)
    });
    expect(targetInput).toMatchObject({
      roomId,
      commandId: "collection.action.run",
      payload: {
        collection_id: "orders",
        action_id: "publish",
        record_id: "order-1",
        payload: { status: "approved" }
      },
      operationId: targetContext.operationId
    });
    expect(targetContext.operationId).not.toBe(rendererContext.operationId);
    expect(harness.commands.interactions).toHaveLength(1);
    expect(harness.commands.interactions[0]).toMatchObject({
      id: "interaction-r15-action",
      kind: "action",
      surface_id: surfaceId,
      revision_id: revisionId,
      command_id: "collection.action.run",
      command_result: { ok: true, result: { accepted: true } }
    });
  });

  it("records a failed action interaction when the target command fails", async () => {
    const harness = createHarness(async () => {
      throw new Error("target_command_failed");
    });
    const prepared = await harness.adapter.prepareAction(context, createActionRequest());

    await expect(harness.adapter.executeActionTarget(context, prepared.target)).rejects.toMatchObject({
      code: "generated_surface_action_failed",
      status: 409,
      details: { interaction_id: "interaction-r15-action" }
    });
    expect(harness.commands.assertRoomExecutable).toHaveBeenCalledTimes(3);
    expect(harness.commands.interactions).toHaveLength(1);
    expect(harness.commands.interactions[0]).toMatchObject({
      id: "interaction-r15-action",
      kind: "action",
      surface_id: surfaceId,
      revision_id: revisionId,
      command_id: "collection.action.run",
      command_result: { ok: false, error: "target_command_failed" }
    });
  });
});

describe("PostgresGeneratedSurface state boundary", () => {
  it.each([
    ["pin", "pinned", "pinned"],
    ["unpin", "ephemeral", "unpinned"],
    ["archive", "archived", "dismissed"]
  ] as const)("changes a session-less Surface state for %s", async (action, expectedState, expectedInteractionKind) => {
    const harness = createHarness();
    harness.commands.replaceSurface(createSurface({ sessionId: null }));

    const result = await harness.adapter.state({ ...context, operationId: `${context.operationId}-${action}` }, {
      room_id: roomId,
      surface_id: surfaceId,
      action
    });

    expect(result).toMatchObject({
      id: surfaceId,
      state: expectedState,
      current_revision_id: revisionId
    });
    expect(harness.commands.interactions).toHaveLength(1);
    expect(harness.commands.interactions[0]).toMatchObject({
      kind: expectedInteractionKind,
      surface_id: surfaceId,
      revision_id: revisionId
    });
    expect(harness.commands.interactions[0]).not.toHaveProperty("session_id");
  });
});
