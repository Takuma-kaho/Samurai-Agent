import { describe, expect, it } from "vitest";
import {
  MessageEnvelopeSchema,
  OperationRecordSchema,
  createId,
  nowIso,
  stableHash
} from "./index";

describe("core schemas", () => {
  it("parses locale-aware message envelopes", () => {
    const envelope = MessageEnvelopeSchema.parse({
      id: createId("envelope"),
      source: "web",
      actor_identity: "owner",
      session_key: "web:owner:main",
      user_intent: "提案書を作って",
      attachments: [],
      input_locale: "ja",
      output_locale: "en",
      metadata: {},
      received_at: nowIso()
    });

    expect(envelope.input_locale).toBe("ja");
    expect(envelope.output_locale).toBe("en");
  });

  it("keeps operation records parseable for approval replay", () => {
    const now = nowIso();
    const operation = OperationRecordSchema.parse({
      id: createId("operation"),
      session_id: createId("session"),
      capability_id: "proposal_workspace",
      operation: "artifact.create",
      actor_identity: "owner",
      instruction_source: "owner_instruction",
      instruction_authority: "owner",
      channel: "web",
      input_hash: stableHash({ ok: true }),
      target_resource_refs: [],
      proposed_effects: ["Create draft"],
      status: "created",
      created_at: now,
      updated_at: now
    });

    expect(operation.operation).toBe("artifact.create");
  });
});
