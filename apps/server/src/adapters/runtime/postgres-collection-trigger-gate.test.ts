import { describe, expect, it } from "vitest";
import type { CollectionSchema } from "@samurai-agent/core-schemas";
import { assertPostgresCollectionTriggerDeliverySupported } from "./postgres-collection";

function schema(triggers: CollectionSchema["triggers"]): CollectionSchema {
  return {
    id: "tasks",
    version: "1",
    labels: { en: "Tasks" },
    descriptions: { en: "Tasks" },
    fields: [],
    refs: [],
    embeds: [],
    derived_fields: [],
    triggers,
    actions: [],
    views: [],
    permissions: {}
  };
}

describe("PostgreSQL Collection trigger delivery gate", () => {
  it("rejects a matching enabled trigger before a record mutation can start", () => {
    expect(() => assertPostgresCollectionTriggerDeliverySupported(
      schema([{ id: "created", event: "record.created", action_id: "next" }]),
      "record.created"
    )).toThrow("collection_trigger_delivery_not_supported");
  });

  it("allows disabled or non-matching triggers until PostgreSQL delivery exists", () => {
    expect(() => assertPostgresCollectionTriggerDeliverySupported(
      schema([{ id: "disabled", event: "record.created", action_id: "next", enabled: false }]),
      "record.created"
    )).not.toThrow();
    expect(() => assertPostgresCollectionTriggerDeliverySupported(
      schema([{ id: "patch", event: "record.patched", action_id: "next" }]),
      "record.created"
    )).not.toThrow();
  });
});
