import { describe, expect, it } from "vitest";
import { workspaceOperationHistoryRequest } from "./workspace-operation-history-requests";

describe("workspaceOperationHistoryRequest", () => {
  it("accepts an allowlisted Room-scoped history query", () => {
    expect(workspaceOperationHistoryRequest({
      roomId: "room_product",
      recordType: "domain_operation",
      target: { connectionId: "connection_local", workspaceId: "workspace_product", roomId: "room_product", selectionGeneration: 4 }
    })).toEqual({
      roomId: "room_product",
      recordType: "domain_operation",
      target: { connectionId: "connection_local", workspaceId: "workspace_product", roomId: "room_product", selectionGeneration: 4 }
    });
  });

  it("rejects arbitrary record selectors", () => {
    expect(() => workspaceOperationHistoryRequest({ roomId: "room_product", recordType: "workspace_users" }))
      .toThrow("workspace_operation_history_record_type_invalid");
  });
});
