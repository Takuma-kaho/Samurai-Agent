import { describe, expect, it } from "vitest";
import { workspaceAttachmentRequest, workspaceAttachmentResourceRef, workspaceAttachmentUploadResult } from "./workspace-attachment-requests";

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

  it("keeps the target outside the signed attachment body", () => {
    const request = workspaceAttachmentRequest({
      roomId: "room_product",
      path: "attachments/image-1.png",
      contentBase64: "aGk=",
      expectedVersion: 0,
      operationId: "attachment_target_1",
      target: { connectionId: "server_a", workspaceId: "workspace_a" }
    });

    expect(request).toMatchObject({
      operationId: "attachment_target_1",
      target: { connectionId: "server_a", workspaceId: "workspace_a" },
      body: { room_id: "room_product", expected_version: 0 }
    });
    expect(request.body).not.toHaveProperty("target");
    expect(() => workspaceAttachmentRequest({
      roomId: "room_product",
      path: "attachments/image-1.png",
      contentBase64: "aGk=",
      expectedVersion: 0,
      operationId: "attachment_invalid_target",
      target: { connectionId: "", workspaceId: "workspace_a" }
    })).toThrow("workspace_target_invalid");
  });

  it("requires a server-issued immutable file reference", () => {
    const sha256 = "a".repeat(64);
    expect(workspaceAttachmentResourceRef({
      kind: "file",
      id: sha256,
      uri: "notes/brief.md",
      version: "1",
      label: "Brief document"
    })).toEqual({
      kind: "file",
      id: sha256,
      uri: "notes/brief.md",
      version: "1",
      label: "Brief document"
    });
    expect(() => workspaceAttachmentResourceRef({
      kind: "file",
      id: sha256,
      uri: "notes/brief.md"
    })).toThrow("workspace_attachment_ref_invalid");
    expect(() => workspaceAttachmentResourceRef({
      kind: "file",
      id: "not-a-sha256",
      uri: "notes/brief.md",
      version: "1"
    })).toThrow("workspace_attachment_ref_invalid");
    for (const uri of ["/notes/brief.md", "notes/../secret.md", "notes//brief.md", "notes/./brief.md", "notes\\brief.md"]) {
      expect(() => workspaceAttachmentResourceRef({ kind: "file", id: sha256, uri, version: "1" })).toThrow("workspace_attachment_ref_invalid");
    }
  });

  it("rejects inconsistent upload metadata instead of returning a partial reference", () => {
    const sha256 = "b".repeat(64);
    expect(workspaceAttachmentUploadResult({
      file: { path: "notes/brief.md", version: 2, sha256, size: 2 },
      resource_ref: { kind: "file", id: sha256, uri: "notes/brief.md", version: "2" }
    })).toMatchObject({ resource_ref: { id: sha256, uri: "notes/brief.md", version: "2" } });
    expect(() => workspaceAttachmentUploadResult({
      file: { path: "attachments/image-1.png", version: 2, sha256, size: 2 },
      resource_ref: { kind: "file", id: sha256, uri: "attachments/other.png", version: "2" }
    })).toThrow("workspace_attachment_response_invalid");
    expect(() => workspaceAttachmentUploadResult({
      file: { path: "../secret.md", version: 2, sha256, size: 2 },
      resource_ref: { kind: "file", id: sha256, uri: "../secret.md", version: "2" }
    })).toThrow("workspace_attachment_response_invalid");
  });
});
