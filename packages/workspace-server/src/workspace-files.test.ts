import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileStore } from "./workspace-files";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace file transaction recovery", () => {
  it("replaces the previous physical version when its hash matches the DB ledger", async () => {
    const previous = Buffer.from("version one", "utf8");
    const next = Buffer.from("version two", "utf8");
    const harness = await createHarness({ previous, next, destination: previous, staged: next });

    await expect(harness.service.recover(harness.context)).resolves.toEqual({
      recovered: [harness.transaction.id],
      failed: []
    });
    await expect(readFile(harness.destination)).resolves.toEqual(next);
    await expect(readFile(harness.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.finalizeCalls).toBe(1);
  });

  it("stops on an unrelated destination and preserves both physical files", async () => {
    const previous = Buffer.from("version one", "utf8");
    const next = Buffer.from("version two", "utf8");
    const unrelated = Buffer.from("human edit", "utf8");
    const harness = await createHarness({ previous, next, destination: unrelated, staged: next });
    const finalize = privateFinalize(harness.service);

    await expect(finalize(harness.context, harness.transaction.id)).rejects.toMatchObject({
      code: "workspace_file_rename_recovery_required"
    });
    await expect(readFile(harness.destination)).resolves.toEqual(unrelated);
    await expect(readFile(harness.source)).resolves.toEqual(next);
    expect(harness.finalizeCalls).toBe(0);
  });

  it("accepts an already-renamed destination and removes only matching staged content", async () => {
    const previous = Buffer.from("version one", "utf8");
    const next = Buffer.from("version two", "utf8");
    const harness = await createHarness({ previous, next, destination: next, staged: next });

    await expect(harness.service.recover(harness.context)).resolves.toEqual({
      recovered: [harness.transaction.id],
      failed: []
    });
    await expect(readFile(harness.destination)).resolves.toEqual(next);
    await expect(readFile(harness.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(harness.finalizeCalls).toBe(1);
  });

  it("does not remove a changed staged file when the destination already has the new hash", async () => {
    const previous = Buffer.from("version one", "utf8");
    const next = Buffer.from("version two", "utf8");
    const changedStaged = Buffer.from("unexpected staged content", "utf8");
    const harness = await createHarness({ previous, next, destination: next, staged: changedStaged });
    const finalize = privateFinalize(harness.service);

    await expect(finalize(harness.context, harness.transaction.id)).rejects.toMatchObject({
      code: "workspace_file_rename_recovery_required"
    });
    await expect(readFile(harness.destination)).resolves.toEqual(next);
    await expect(readFile(harness.source)).resolves.toEqual(changedStaged);
    expect(harness.finalizeCalls).toBe(0);
  });

  it("does not overwrite an existing file when the transaction has no previous DB version", async () => {
    const next = Buffer.from("first version", "utf8");
    const unrelated = Buffer.from("untracked file", "utf8");
    const harness = await createHarness({ previous: undefined, next, destination: unrelated, staged: next });
    const finalize = privateFinalize(harness.service);

    await expect(finalize(harness.context, harness.transaction.id)).rejects.toMatchObject({
      code: "workspace_file_rename_recovery_required"
    });
    await expect(readFile(harness.destination)).resolves.toEqual(unrelated);
    await expect(readFile(harness.source)).resolves.toEqual(next);
    expect(harness.finalizeCalls).toBe(0);
  });

  it("does not create a destination from a corrupted staged file", async () => {
    const previous = Buffer.from("version one", "utf8");
    const next = Buffer.from("version two", "utf8");
    const changedStaged = Buffer.from("unexpected staged content", "utf8");
    const harness = await createHarness({ previous, next, destination: undefined, staged: changedStaged });
    const finalize = privateFinalize(harness.service);

    await expect(finalize(harness.context, harness.transaction.id)).rejects.toMatchObject({
      code: "workspace_file_rename_recovery_required"
    });
    await expect(readFile(harness.destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(harness.source)).resolves.toEqual(changedStaged);
    expect(harness.transaction.next_file).toMatchObject({ sha256: sha256(next) });
    expect(harness.finalizeCalls).toBe(0);
  });
});

async function createHarness(input: {
  previous: Buffer | undefined;
  next: Buffer;
  destination: Buffer | undefined;
  staged: Buffer;
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "samurai-workspace-files-"));
  roots.push(root);
  const workspaceId = "workspace_file_recovery";
  const roomId = "room_file_recovery";
  const transactionId = "file_tx_recovery";
  const targetPath = "notes/example.md";
  const stagedPath = `.staging/${transactionId}`;
  const workspaceRoot = path.join(root, "workspaces", workspaceId);
  const destination = path.join(workspaceRoot, "files", targetPath);
  const source = path.join(workspaceRoot, stagedPath);
  await mkdir(path.dirname(source), { recursive: true });
  await writeFile(source, input.staged);
  if (input.destination) {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, input.destination);
  }

  const transaction = {
    workspace_id: workspaceId,
    id: transactionId,
    target_path: targetPath,
    staged_path: stagedPath,
    previous_file: input.previous ? { sha256: sha256(input.previous), version: 1 } : null,
    next_file: { sha256: sha256(input.next), version: 2 },
    status: "db_committed" as const
  };
  const context = { workspaceId, accountId: "account_file_recovery" };
  let finalizeCalls = 0;
  const query = vi.fn(async (text: string) => {
    if (text.includes("FROM workspace_file_transactions") && text.includes("status = 'db_committed'")) {
      return { rows: [transaction] };
    }
    if (text.includes("FROM workspace_file_transactions")) return { rows: [transaction] };
    if (text.includes("FROM workspace_files")) {
      return {
        rows: [{
          workspace_id: workspaceId,
          room_id: roomId,
          path: targetPath,
          version: 2,
          sha256: sha256(input.next),
          size: input.next.byteLength,
          created_at: "2026-09-03T00:00:00.000Z",
          updated_at: "2026-09-03T00:01:00.000Z"
        }]
      };
    }
    if (text.includes("samurai_finalize_workspace_file_transaction")) {
      finalizeCalls += 1;
      return { rows: [{ finalized: true }] };
    }
    return { rows: [] };
  });
  const database = {
    withContext: vi.fn(async (_context: unknown, action: (sql: { query: typeof query }) => Promise<unknown>) => action({ query }))
  };
  const service = new WorkspaceFileStore({ storageRoot: root, database } as never);
  return { service, context, transaction, destination, source, get finalizeCalls() { return finalizeCalls; } };
}

function privateFinalize(service: WorkspaceFileStore): (context: { workspaceId: string; accountId: string }, transactionId: string) => Promise<void> {
  return (service as unknown as {
    finalize: (context: { workspaceId: string; accountId: string }, transactionId: string) => Promise<void>
  }).finalize.bind(service);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
