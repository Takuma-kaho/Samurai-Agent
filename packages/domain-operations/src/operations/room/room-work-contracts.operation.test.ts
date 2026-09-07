import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import { domainOperationClient, legacyDomainOperationClient } from "../../generated/operation-client.generated.js";
import roomCreate from "./create.operation.js";
import roomWorkCommentApply from "./work-comment-apply.operation.js";
import roomWorkCommentCreate from "./work-comment-create.operation.js";
import roomWorkCommentReactionSet from "./work-comment-reaction-set.operation.js";
import roomWorkCreate from "./work-create.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api",
  workspaceId: "workspace_test",
  actorId: "account_test",
  roomId: "room_test",
  correlationId: "room-work-contract-test",
  idempotencyKey: "room-work-contract-test"
};

const timestamp = "2026-09-01T00:00:00.000Z";
const attachment = { kind: "file", id: "a".repeat(64), uri: "notes/test.md", version: "1", label: "Test attachment" } as const;
const work = {
  id: "work_test",
  room_id: "room_test",
  requester_id: "account_test",
  default_agent_id: "agent_test",
  title: "Test work",
  objective: "Complete the test work.",
  status: "queued" as const,
  instruction_version: 1,
  generation: 1,
  version: 1,
  assignees: [],
  created_at: timestamp,
  updated_at: timestamp
};

describe("Room-first work contracts", () => {
  it("keeps legacy Session entries out of the normal generated client", () => {
    expect("sessionCreate" in domainOperationClient).toBe(false);
    expect("chatTurnRun" in domainOperationClient).toBe(false);
    expect(legacyDomainOperationClient.sessionCreate()).toBe("session.create");
    expect(legacyDomainOperationClient.chatTurnRun()).toBe("chat.turn.run");
  });

  it("requires text or a Server-issued attachment and rejects Session-shaped input", () => {
    expect(roomWorkCreate.input.safeParse({ instruction: "", attachments: [] }).success).toBe(false);
    expect(roomWorkCreate.input.safeParse({ attachments: [attachment] }).success).toBe(true);
    expect(roomWorkCreate.input.safeParse({ attachments: [{ ...attachment, version: undefined }] }).success).toBe(false);
    expect(roomWorkCreate.input.safeParse({ attachments: [{ kind: "artifact", id: "artifact_test", uri: "samurai://artifact/artifact_test" }] }).success).toBe(false);
    expect(roomWorkCreate.input.safeParse({ instruction: "run", session_id: "session_test" }).success).toBe(false);
    expect(roomWorkCreate.input.safeParse({ instruction: "run", actor_id: "spoofed" }).success).toBe(false);
    expect(roomWorkCommentCreate.input.safeParse({ work_id: "work_test", body: "comment", session_id: "session_test" }).success).toBe(false);
    expect(roomWorkCommentApply.input.safeParse({ work_id: "work_test", comment_id: "comment_test", comment_version: 1, session_id: "session_test" }).success).toBe(false);
  });

  it("routes a human comment only to the comment Port", async () => {
    const createRoomWorkComment = vi.fn(async () => ({
      id: "comment_test",
      work_id: "work_test",
      author_id: "account_test",
      body: "Please check this result.",
      attachments: [],
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    }));
    const handler = roomWorkCommentCreate.createHandler({ createRoomWorkComment });

    await handler.execute(context, roomWorkCommentCreate.input.parse({ work_id: "work_test", body: "Please check this result." }));

    expect(createRoomWorkComment).toHaveBeenCalledWith(context, {
      roomId: "room_test",
      workId: "work_test",
      body: "Please check this result.",
      attachments: []
    });
  });

  it("keeps reactions separate from comment application and execution", async () => {
    const setRoomWorkCommentReaction = vi.fn(async () => ({
      id: "reaction_test",
      work_id: "work_test",
      comment_id: "comment_test",
      reaction: "like" as const,
      enabled: true,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp
    }));
    const handler = roomWorkCommentReactionSet.createHandler({ setRoomWorkCommentReaction });

    await handler.execute(context, roomWorkCommentReactionSet.input.parse({
      work_id: "work_test",
      comment_id: "comment_test",
      reaction: "like",
      enabled: true
    }));

    expect(setRoomWorkCommentReaction).toHaveBeenCalledWith(context, {
      roomId: "room_test",
      workId: "work_test",
      commentId: "comment_test",
      reaction: "like",
      enabled: true
    });
  });

  it("maps Room create selection or new-Agent configuration without trusting actor/session fields", async () => {
    const createRoom = vi.fn(async (_context: TrustedDomainContext, _input: unknown) => {
      return { id: "room_test", name: "Product", created_at: timestamp, updated_at: timestamp };
    });
    const handler = roomCreate.createHandler({ createRoom });

    await handler.execute(context, roomCreate.input.parse({ name: "Product", default_agent_id: "agent_test", agent_permission: { can_view: true, can_edit: true, can_execute: true } }));
    expect(createRoom).toHaveBeenNthCalledWith(1, context, {
      name: "Product",
      defaultAgentId: "agent_test",
      agentPermission: { canView: true, canEdit: true, canExecute: true }
    });

    await handler.execute(context, roomCreate.input.parse({
      name: "New Agent Room",
      new_agent: {
        name: "Builder",
        role: "builder",
        instructions: "Build the requested result.",
        backend_id: "samurai-native",
        permission: { can_view: true, can_edit: false, can_execute: true }
      }
    }));
    expect(createRoom).toHaveBeenLastCalledWith(context, {
      name: "New Agent Room",
      newAgent: {
        name: "Builder",
        role: "builder",
        instructions: "Build the requested result.",
        backendId: "samurai-native",
        enabled: true,
        permission: { canView: true, canEdit: false, canExecute: true }
      }
    });
    expect(roomCreate.input.safeParse({ name: "Invalid", default_agent_id: "agent_test", new_agent: { name: "Builder", role: "builder", instructions: "Build.", backend_id: "samurai-native" } }).success).toBe(false);
    expect(roomCreate.input.safeParse({ name: "Invalid", actor_id: "spoofed" }).success).toBe(false);
  });

  it("requires trusted Room context for work operations", async () => {
    const createRoomWork = vi.fn(async () => work);
    const handler = roomWorkCreate.createHandler({ createRoomWork });
    const noRoom = { ...context, roomId: undefined };

    await expect(handler.execute(noRoom, roomWorkCreate.input.parse({ instruction: "run" }))).rejects.toThrow("roomId");
    expect(createRoomWork).not.toHaveBeenCalled();
  });
});
