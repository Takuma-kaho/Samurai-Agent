import { describe, expect, it } from "vitest";
import { workspaceAttachmentRequest } from "./workspace-attachment-requests";

describe("Desktop workspace attachment boundary", () => {
  it("accepts only an attachment path and preserves the Room write contract", () => {
    expect(workspaceAttachmentRequest({
      roomId: "room_product",
      path: "attachments/image-1.png",
      contentBase64: "aGk=",
      expectedVersion: 0,
      operationId: "attachment_write_1",
      privateKey: "must-not-leave-renderer"
    })).toEqual({
      roomId: "room_product",
      filePath: "attachments/image-1.png",
      operationId: "attachment_write_1",
      body: {
        room_id: "room_product",
        content_base64: "aGk=",
        expected_version: 0
      }
    });
  });

  it("rejects traversal, arbitrary files, invalid base64, and negative versions", () => {
    expect(() => workspaceAttachmentRequest({ roomId: "room_product", path: "../secret", contentBase64: "aGk=", expectedVersion: 0, operationId: "attachment_write_1" })).toThrow("path_invalid");
    expect(() => workspaceAttachmentRequest({ roomId: "room_product", path: "profile/secret.md", contentBase64: "aGk=", expectedVersion: 0, operationId: "attachment_write_1" })).toThrow("path_invalid");
    expect(() => workspaceAttachmentRequest({ roomId: "room_product", path: "attachments/file", contentBase64: "not-base64", expectedVersion: 0, operationId: "attachment_write_1" })).toThrow("contentBase64_invalid");
    expect(() => workspaceAttachmentRequest({ roomId: "room_product", path: "attachments/file", contentBase64: "aGk=", expectedVersion: -1, operationId: "attachment_write_1" })).toThrow("expectedVersion_invalid");
  });
});
