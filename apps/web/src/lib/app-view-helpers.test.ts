import { describe, expect, it } from "vitest";
import { t } from "@samurai-agent/localization";
import { backendRunNote, backendRunStatusLabel } from "./app-view-helpers";
import type { BackendRunRecord } from "@samurai-agent/core-schemas";

const unknownRun = {
  id: "run-unknown",
  session_id: "session-1",
  backend_id: "backend-1",
  backend_kind: "external",
  input_message_id: "message-1",
  status: "outcome_unknown",
  input_summary: "外部処理",
  output_summary: "",
  created_at: "2026-01-01T00:00:00.000Z",
  started_at: "2026-01-01T00:00:00.000Z",
  completed_at: "2026-01-01T00:00:01.000Z",
  metadata: {}
} as BackendRunRecord;

describe("outcome_unknown presentation", () => {
  it("keeps the status separate and explains safe retry behavior", () => {
    const label = (key: Parameters<typeof t>[1]) => t("ja", key);
    expect(backendRunStatusLabel(unknownRun, label)).toBe("結果未確認");
    expect(backendRunNote(unknownRun, label)).toContain("自動再試行はしません");
    expect(backendRunNote(unknownRun, label)).toContain("新しいTurnは開始できます");
  });
});
