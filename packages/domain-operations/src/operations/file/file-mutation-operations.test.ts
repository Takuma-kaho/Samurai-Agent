import { describe, expect, it, vi } from "vitest";
import type { TrustedDomainContext } from "../../definition/index.js";
import filePatch from "./patch.operation.js";
import fileWrite from "./write.operation.js";

const context: TrustedDomainContext = {
  inputSource: "runtime_api", workspaceId: "workspace_test", actorId: "actor_test", correlationId: "correlation_test"
};
const session = { id: "session_1" } as never;
const envelope = { id: "envelope_1" } as never;
const operation = { id: "operation_1" } as never;

describe("File mutation operation handlers", () => {
  it("owns write, managed-collection reindex, and rollback order", async () => {
    const writeFileText = vi.fn(async () => undefined);
    const reindexManagedCollections = vi.fn(async () => undefined);
    const createFileRollback = vi.fn(async () => ({ id: "rollback_1" }) as never);
    const handler = fileWrite.createHandler({
      resolveFilePath: () => ({ absolutePath: "/workspace/data.json", relativePath: "data.json" }),
      ensureFileSession: async () => session,
      createFileEnvelope: () => envelope,
      readFileTextIfExists: async () => "old",
      ensureFileParent: async () => undefined,
      writeFileText,
      isManagedCollectionPath: () => true,
      reindexManagedCollections,
      createFileRollback,
      runFileMutation: async (input) => {
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      }
    });

    const result = await handler.execute(context, { path: "data.json", content: "new" });

    expect(writeFileText).toHaveBeenCalledWith("/workspace/data.json", "new");
    expect(writeFileText.mock.invocationCallOrder[0]).toBeLessThan(reindexManagedCollections.mock.invocationCallOrder[0]);
    expect(reindexManagedCollections.mock.invocationCallOrder[0]).toBeLessThan(createFileRollback.mock.invocationCallOrder[0]);
    expect(result.value.resource.content).toBe("new");
  });

  it("owns patch search and replacement", async () => {
    const writeFileText = vi.fn(async () => undefined);
    const handler = filePatch.createHandler({
      resolveFilePath: () => ({ absolutePath: "/workspace/note.txt", relativePath: "note.txt" }),
      ensureFileSession: async () => session,
      createFileEnvelope: () => envelope,
      readFileTextIfExists: async () => "hello world",
      ensureFileParent: async () => undefined,
      writeFileText,
      isManagedCollectionPath: () => false,
      reindexManagedCollections: async () => undefined,
      fileNotFoundError: () => new Error("file_not_found"),
      filePatchConflictError: () => new Error("search_not_found"),
      createFileRollback: async () => ({ id: "rollback_1" }) as never,
      runFileMutation: async (input) => {
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      }
    });

    const result = await handler.execute(context, { path: "note.txt", search: "world", replace: "samurai" });

    expect(writeFileText).toHaveBeenCalledWith("/workspace/note.txt", "hello samurai");
    expect(result.value.resource.content).toBe("hello samurai");
  });

  it("does not write when the patch target is missing", async () => {
    const writeFileText = vi.fn(async () => undefined);
    const handler = filePatch.createHandler({
      resolveFilePath: () => ({ absolutePath: "/workspace/missing.txt", relativePath: "missing.txt" }),
      ensureFileSession: async () => session,
      createFileEnvelope: () => envelope,
      readFileTextIfExists: async () => undefined,
      ensureFileParent: async () => undefined,
      writeFileText,
      isManagedCollectionPath: () => false,
      reindexManagedCollections: async () => undefined,
      fileNotFoundError: () => new Error("file_not_found"),
      filePatchConflictError: () => new Error("search_not_found"),
      createFileRollback: async () => ({ id: "rollback_1" }) as never,
      runFileMutation: async (input) => {
        const executed = await input.execute(operation);
        return { resource: executed.resource, operation, rollbackPoint: executed.rollbackPoint, activity: [] };
      }
    });

    await expect(handler.execute(context, { path: "missing.txt", search: "x", replace: "y" })).rejects.toThrow("file_not_found");
    expect(writeFileText).not.toHaveBeenCalled();
  });

  it("rejects fields from the other file mutation contract", () => {
    expect(fileWrite.input.safeParse({ path: "note.txt", content: "x", search: "x" }).success).toBe(false);
    expect(filePatch.input.safeParse({ path: "note.txt", search: "", replace: "x" }).success).toBe(false);
  });
});
