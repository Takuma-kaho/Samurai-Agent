import { describe, expect, it } from "vitest";
import { buildExternalAssistContext } from "./external-assist-context.js";
import type { ExternalAssistRecord } from "@samurai-agent/core-schemas";

describe("external assist context", () => {
  it("keeps provider hints isolated and records the prefetch", async () => {
    const records: ExternalAssistRecord[] = [];
    const result = await buildExternalAssistContext({
      providers: [{ id: "provider-1", prefetch: async () => [{ id: "hint-1", summary: "unverified", confidence: 0.4 }] }],
      store: {
        listExternalAssistRecords: async () => records,
        saveExternalAssistRecord: async (record) => { records.push(record); return record; }
      },
      sessionId: "session-1",
      query: "query",
      role: "assistive",
      recentMessages: [],
      sessionSearch: []
    });
    expect(result.hints.map((hint) => hint.id)).toEqual(["hint-1"]);
    expect(result.included_in_active_memory).toBe(false);
    expect(records).toHaveLength(1);
  });

  it("normalizes hint boundaries and redacts provider secrets", async () => {
    const records: ExternalAssistRecord[] = [];
    const hints = Array.from({ length: 6 }, (_, index) => ({ id: index === 0 ? "  " : ` id-${index} `, title: " title ", summary: index === 1 ? " " : " summary ", source_uri: " https://example.test ", source_label: " source ", confidence: index === 2 ? 4 : index === 3 ? -2 : 0.5 }));
    const result = await buildExternalAssistContext({
      providers: [{ id: "provider-1", prefetch: async () => hints }],
      store: {
        listExternalAssistRecords: async () => records,
        saveExternalAssistRecord: async (record) => { records.push(record); return record; }
      }, sessionId: "session-1", query: "query", role: "assistive", recentMessages: [], sessionSearch: []
    });
    expect(result.hints).toHaveLength(5);
    expect(result.hints[0]?.id).toMatch(/^external_hint_/);
    expect(result.hints[1]?.summary).toContain("External assist hint");
    expect(result.hints[2]?.confidence).toBe(1);
    expect(result.hints[3]?.confidence).toBe(0);

    const failed: ExternalAssistRecord[] = [];
    await buildExternalAssistContext({
      providers: [{ id: "provider-1", prefetch: async () => { throw new Error("Bearer secret-token authorization=abc-token"); } }],
      store: { listExternalAssistRecords: async () => failed, saveExternalAssistRecord: async (record) => { failed.push(record); return record; } },
      sessionId: "session-1", query: "query", role: "assistive", recentMessages: [], sessionSearch: []
    });
    expect(failed[0]?.error).not.toContain("secret-token");
    expect(failed[0]?.error).not.toContain("abc-token");
  });
});
