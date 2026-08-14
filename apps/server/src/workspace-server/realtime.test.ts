import { describe, expect, it } from "vitest";
import { emitRoomWorkspaceEvent, roomSocketRoom } from "./realtime";

describe("Workspace Server realtime isolation", () => {
  it("emits a Room update only to that Room channel", () => {
    const calls: Array<{ room: string; event: string; payload: unknown }> = [];
    const emitter = {
      to(room: string) {
        return {
          emit(event: string, payload: unknown) {
            calls.push({ room, event, payload });
          }
        };
      }
    };
    const update = { workspaceId: "workspace_a", roomId: "room_private" };

    emitRoomWorkspaceEvent(emitter, update);

    expect(calls).toEqual([{
      room: roomSocketRoom("workspace_a", "room_private"),
      event: "workspace:event",
      payload: update
    }]);
  });
});
