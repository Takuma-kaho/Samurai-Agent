import { describe, expect, it } from "vitest";
import {
  ActivityIngestRequestSchema,
  DomainApiRequestSchema,
  PublicEventEnvelopeSchema,
  eventPayloadSchemaFor,
  isApiVersionCompatible,
  isEventVersionCompatible,
  parsePublicEventPayload,
  runControlRequestSchemaFor
} from "./index";

const activityBase = {
  context: { room_id: "room_1" },
  source_event_id: "source_1",
  payload_hash: "a".repeat(64),
  dedupe_key: "dedupe_1",
  occurred_at: "2026-08-30T00:00:00.000Z",
  instruction_summary: "Record the completed work.",
  verification: [],
  domain_operation_ids: [],
  resource_usage: []
};

describe("public Domain API contract", () => {
  it("keeps authority out of the public request context", () => {
    expect(DomainApiRequestSchema.safeParse({
      context: { room_id: "room_1", actor_id: "spoofed" },
      input: {}
    }).success).toBe(false);
  });

  it("does not turn incomplete or unknown Activity outcomes into success", () => {
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "completed"
    }).success).toBe(false);
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "unknown",
      failure: { code: "success", summary: "not actually verified" }
    }).success).toBe(false);
    expect(ActivityIngestRequestSchema.safeParse({
      ...activityBase,
      outcome: "unknown",
      failure: { code: "transport_lost", summary: "The result was not confirmed." }
    }).success).toBe(true);
  });

  it("gives each Run Control action its own input schema", () => {
    expect(runControlRequestSchemaFor("cancel").safeParse({ context: {}, input: {} }).success).toBe(true);
    expect(runControlRequestSchemaFor("cancel").safeParse({ context: {}, input: { confirm_unknown: true } }).success).toBe(false);
    expect(runControlRequestSchemaFor("retry").safeParse({ context: {}, input: { confirm_unknown: true } }).success).toBe(true);
  });

  it("strictly validates known Event payloads while retaining a legacy fallback", () => {
    expect(eventPayloadSchemaFor("workspace.room.changed").safeParse({ room_id: "room_1", action: "created" }).success).toBe(true);
    expect(eventPayloadSchemaFor("workspace.room.changed").safeParse({ room_id: "room_1", action: "created", secret: "hidden" }).success).toBe(false);
    expect(eventPayloadSchemaFor("legacy.event").safeParse({ legacy: true }).success).toBe(true);
    expect(parsePublicEventPayload("legacy.event", {
      legacy: true,
      token: "must-not-leak",
      content: "full body must not leak",
      nested: { api_key: "also-hidden", keep: "ok" }
    })).toEqual({ legacy: true, nested: { keep: "ok" } });
    expect(PublicEventEnvelopeSchema.safeParse({
      event_id: "event_1",
      event_type: "workspace.room.changed",
      event_version: "1.0",
      cursor: "cursor_1",
      occurred_at: "2026-08-30T00:00:00.000Z",
      actor: { kind: "system" },
      scope: { workspace_id: "workspace_1", room_id: "room_1" },
      resources: [],
      payload: { room_id: "room_1", action: "created" }
    }).success).toBe(true);
  });

  it("keeps API and Event version compatibility independent", () => {
    expect(isApiVersionCompatible("1")).toBe(true);
    expect(isApiVersionCompatible("2")).toBe(false);
    expect(isEventVersionCompatible("1.7")).toBe(true);
    expect(isEventVersionCompatible("2.0")).toBe(false);
  });
});
