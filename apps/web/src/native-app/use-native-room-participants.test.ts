import { describe, expect, it } from "vitest";
import { nativeRoomParticipantDisplayName } from "./use-native-room-participants";

describe("nativeRoomParticipantDisplayName", () => {
  it("uses an authorized display name when available", () => {
    expect(nativeRoomParticipantDisplayName("account-a", 0, { "account-a": "表示名" })).toEqual({ label: "表示名" });
  });

  it("keeps missing names identifiable without displaying the Account ID", () => {
    expect(nativeRoomParticipantDisplayName("account-a", 1, {})).toEqual({ label: "参加者2", reason: "表示名未取得" });
  });
});
