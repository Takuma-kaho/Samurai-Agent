import { describe, expect, it } from "vitest";
import { nativeRoomExpansionToggle } from "./use-native-room-expansion";

describe("nativeRoomExpansionToggle", () => {
  it("starts from all visible parent Rooms and toggles only the selected parent", () => {
    const parents = new Set(["root", "other"]);
    expect([...nativeRoomExpansionToggle(undefined, parents, "root")].sort()).toEqual(["other"]);
    expect([...nativeRoomExpansionToggle(new Set(["other"]), parents, "root")].sort()).toEqual(["other", "root"]);
  });
});
