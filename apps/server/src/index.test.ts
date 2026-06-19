import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createApiServer, type ApiServer } from "./index";

const roots: string[] = [];
const servers: ApiServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.io.close();
          server.httpServer.close(() => resolve());
          void server.store.close();
        })
    )
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("approval request API", () => {
  it("returns approval lifecycle payloads and conflicts on double decisions", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ approvalRequests: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    }, 201);

    const approved = await postJson<Record<string, unknown>>(`${baseUrl}/api/approval-requests/${turn.approvalRequests[0]!.id}/approve`, {});
    expect(approved).toHaveProperty("approvalRequest");
    expect(approved).toHaveProperty("operation");
    expect(approved).toHaveProperty("auditRecord");
    expect(approved).toHaveProperty("activity");

    const conflict = await postJson<Record<string, unknown>>(`${baseUrl}/api/approval-requests/${turn.approvalRequests[0]!.id}/deny`, {}, 409);
    expect(conflict.error).toBe("conflict");
  });

  it("returns updated activity in 409 body when approval expired", async () => {
    const { baseUrl, server } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ approvalRequests: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、あとでメール送信もして",
      output_locale: "ja"
    }, 201);
    const request = await server.store.getApprovalRequest(turn.approvalRequests[0]!.id);
    await server.store.updateApprovalRequest({
      ...request!,
      expires_at: "2020-01-01T00:00:00.000Z"
    });

    const expired = await postJson<Record<string, unknown>>(`${baseUrl}/api/approval-requests/${turn.approvalRequests[0]!.id}/approve`, {}, 409);
    expect(expired.error).toBe("conflict");
    expect(expired).toHaveProperty("approvalRequest");
    expect(expired).toHaveProperty("operation");
    expect(expired).toHaveProperty("auditRecord");
    expect(Array.isArray(expired.activity)).toBe(true);
  });
});

async function startTestServer(): Promise<{ baseUrl: string; server: ApiServer }> {
  const root = await mkdtemp(path.join(tmpdir(), "samurai-api-"));
  roots.push(root);
  const server = await createApiServer({ workspaceDataDir: root });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = server.httpServer.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server
  };
}

async function postJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}
