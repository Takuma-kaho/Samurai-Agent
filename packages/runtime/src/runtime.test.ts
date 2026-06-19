import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { AgentRuntime, RuntimeRequestError } from "./index";

const roots: string[] = [];

async function createRuntime() {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-runtime-"));
  roots.push(root);
  const store = await WorkspaceStore.create({ rootDir: root });
  return {
    store,
    runtime: new AgentRuntime(store)
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent runtime", () => {
  it("runs chat through operation policy audit artifact", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書の短い下書きを作って",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.operations.some((operation) => operation.operation === "artifact.create")).toBe(true);
    expect(result.policyDecisions.some((decision) => decision.decision === "allow_auto")).toBe(true);
    expect(result.auditRecords.length).toBeGreaterThan(0);
  });

  it("keeps safe drafting while outbound work waits for approval", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    await store.close();

    expect(result.artifacts.length).toBeGreaterThan(0);
    expect(result.approvalRequests.length).toBeGreaterThan(0);
    expect(result.operations.some((operation) => operation.status === "pending_approval")).toBe(true);
  });

  it("approves approval-gated work as deferred without external execution", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0];
    expect(request).toBeDefined();

    const approved = await runtime.approveRequest(request!.id);
    await store.close();

    expect(approved.approvalRequest.status).toBe("approved");
    expect(approved.operation.status).toBe("deferred");
    expect(approved.auditRecord.outputs_summary).toContain("deferred");
  });

  it("denies approval-gated work and records audit", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });

    const denied = await runtime.denyRequest(result.approvalRequests[0]!.id, "owner", "不要です");
    await store.close();

    expect(denied.approvalRequest.status).toBe("denied");
    expect(denied.operation.status).toBe("denied");
    expect(denied.auditRecord.outputs_summary).toContain("denied");
  });

  it("returns conflict for double approval decisions", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0]!;
    await runtime.approveRequest(request.id);

    await expect(runtime.denyRequest(request.id)).rejects.toMatchObject({ code: "conflict" });
    await store.close();
  });

  it("expires pending requests as deferred and returns conflict payload", async () => {
    const { store, runtime } = await createRuntime();
    const session = await runtime.createSession();
    const result = await runtime.runChatTurn({
      sessionId: session.id,
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    });
    const request = result.approvalRequests[0]!;
    await store.updateApprovalRequest({
      ...request,
      expires_at: "2020-01-01T00:00:00.000Z"
    });

    await expect(runtime.approveRequest(request.id)).rejects.toSatisfy((error) => {
      return (
        error instanceof RuntimeRequestError &&
        error.code === "conflict" &&
        error.payload?.approvalRequest.status === "expired" &&
        error.payload.operation.status === "deferred" &&
        error.payload.auditRecord.outputs_summary.includes("expired")
      );
    });
    await store.close();
  });
});
