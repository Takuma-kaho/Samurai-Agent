import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalSendRecord } from "@samurai-agent/core-schemas";
import { WorkspaceStore } from "./workspace-store";

const roots: string[] = [];
const now = "2026-08-23T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external send dispatch safety", () => {
  it("atomically claims one concurrent dispatch and makes an expired claim outcome_unknown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-send-safety-"));
    roots.push(root);
    const first = await WorkspaceStore.create({ rootDir: root });
    const second = await WorkspaceStore.create({ rootDir: root });
    const send: ExternalSendRecord = {
      id: "send_sqlite_race",
      channel: "webhook",
      status: "approved",
      target: { url: "https://example.test/hook" },
      title: "Race",
      body: "Body",
      created_at: now,
      updated_at: now
    };
    await first.saveExternalSend(send);

    const claims = await Promise.all([
      first.claimExternalSendDispatch({ id: send.id, now, lease_until: "2026-08-23T00:01:00.000Z" }),
      second.claimExternalSendDispatch({ id: send.id, now, lease_until: "2026-08-23T00:01:00.000Z" })
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const expired = await first.reconcileExpiredExternalSendDispatches("2026-08-23T00:02:00.000Z");
    expect(expired).toMatchObject([{ id: send.id, status: "outcome_unknown" }]);
    await expect(first.claimExternalSendDispatch({ id: send.id, now: "2026-08-23T00:02:01.000Z", lease_until: "2026-08-23T00:03:00.000Z" })).resolves.toBeUndefined();
    await expect(first.getExternalSend(send.id)).resolves.toMatchObject({ status: "outcome_unknown" });

    await first.close();
    await second.close();
  });

  it("converts an active claim to outcome_unknown on workspace restart", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-send-restart-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    await store.saveExternalSend({
      id: "send_restart",
      channel: "webhook",
      status: "approved",
      target: { url: "https://example.test/hook" },
      title: "Restart",
      body: "Body",
      created_at: now,
      updated_at: now
    });
    await expect(store.claimExternalSendDispatch({ id: "send_restart", now, lease_until: "2099-01-01T00:00:00.000Z" })).resolves.toBeDefined();
    await store.close();

    const restarted = await WorkspaceStore.create({ rootDir: root });
    await expect(restarted.getExternalSend("send_restart")).resolves.toMatchObject({ status: "outcome_unknown" });
    await expect(restarted.claimExternalSendDispatch({ id: "send_restart", now, lease_until: "2099-01-01T00:01:00.000Z" })).resolves.toBeUndefined();
    await restarted.close();
  });
});
