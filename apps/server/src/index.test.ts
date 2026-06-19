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

  it("returns session scoped artifacts and memory details", async () => {
    const { baseUrl } = await startTestServer();
    const sessionA = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const sessionB = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turnA = await postJson<{ artifacts: Array<{ id: string }>; memories: Array<{ id: string; state: string }> }>(
      `${baseUrl}/api/chat/sessions/${sessionA.id}/messages`,
      {
        content: "提案書を作って、今後この文体を覚えて",
        output_locale: "ja"
      },
      201
    );
    await postJson(`${baseUrl}/api/chat/sessions/${sessionB.id}/messages`, {
      content: "別の提案書を作って",
      output_locale: "ja"
    }, 201);

    const detail = await getJson<{ artifacts: Array<{ id: string }>; memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${sessionA.id}`);
    const artifact = await getJson<Record<string, unknown>>(`${baseUrl}/api/artifacts/${turnA.artifacts[0]!.id}`);
    const memory = turnA.memories.find((item) => item.state === "topic")!;
    const memoryDetail = await getJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}`);

    expect(detail.artifacts.map((item) => item.id)).toContain(turnA.artifacts[0]!.id);
    expect(detail.memory.map((item) => item.id)).toContain(memory.id);
    expect(artifact).toHaveProperty("operation");
    expect(artifact).toHaveProperty("auditRecords");
    expect(memoryDetail).toHaveProperty("memory");
    expect(memoryDetail).toHaveProperty("content");
  });

  it("archives memory through API and removes it from normal views", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ memories: Array<{ id: string; state: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}/messages`, {
      content: "提案書を作って、今後この文体を覚えて",
      output_locale: "ja"
    }, 201);
    const memory = turn.memories.find((item) => item.state === "topic")!;

    const archived = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {
      session_id: session.id
    });
    const allMemory = await getJson<Array<{ id: string }>>(`${baseUrl}/api/memory`);
    const detail = await getJson<{ memory: Array<{ id: string }> }>(`${baseUrl}/api/chat/sessions/${session.id}`);
    const badRequest = await postJson<Record<string, unknown>>(`${baseUrl}/api/memory/${memory.id}/archive`, {}, 400);

    expect(archived).toHaveProperty("operation");
    expect(archived).toHaveProperty("auditRecord");
    expect(archived).toHaveProperty("activity");
    expect(archived).toHaveProperty("rollbackPoint");
    expect(allMemory.some((item) => item.id === memory.id)).toBe(false);
    expect(detail.memory.some((item) => item.id === memory.id)).toBe(false);
    expect(badRequest.error).toBe("session_id_required");
  });

  it("returns enriched search results", async () => {
    const { baseUrl } = await startTestServer();
    const session = await postJson<{ id: string }>(`${baseUrl}/api/chat/sessions`, {}, 201);
    const turn = await postJson<{ artifacts: Array<{ id: string }>; auditRecords: Array<{ id: string }> }>(
      `${baseUrl}/api/chat/sessions/${session.id}/messages`,
      {
        content: "検索用の提案書を作って",
        output_locale: "ja"
      },
      201
    );

    const messageResults = await getJson<Array<{ kind: string; session_id?: string }>>(`${baseUrl}/api/search?q=${encodeURIComponent("検索用")}`);
    const artifactResults = await getJson<Array<{ kind: string; id: string; session_id?: string; operation_id?: string }>>(
      `${baseUrl}/api/search?q=${encodeURIComponent("提案")}`
    );
    const auditResults = await getJson<Array<{ kind: string; id: string; session_id?: string; operation_id?: string }>>(
      `${baseUrl}/api/search?q=${encodeURIComponent("Create a local markdown draft artifact")}`
    );
    const emptyResults = await getJson<unknown[]>(`${baseUrl}/api/search?q=${encodeURIComponent("   ")}`);

    expect(messageResults.some((result) => result.kind === "message" && result.session_id === session.id)).toBe(true);
    expect(
      artifactResults.some((result) => result.kind === "artifact" && result.id === turn.artifacts[0]!.id && result.session_id === session.id && result.operation_id)
    ).toBe(true);
    expect(
      auditResults.some((result) => result.kind === "audit" && result.id === turn.auditRecords[0]!.id && result.session_id === session.id && result.operation_id)
    ).toBe(true);
    expect(emptyResults).toEqual([]);
  });

  it("persists settings through get and patch", async () => {
    const { baseUrl } = await startTestServer();

    const initial = await getJson<{ theme: string; ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`);
    const patched = await patchJson<{ theme: string; ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`, {
      theme: "dark",
      ui_locale: "en",
      output_locale: "fr",
      ignored: "value"
    });
    const persisted = await getJson<{ theme: string; ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`);
    const invalidPatch = await patchJson<{ theme: string; ui_locale: string; output_locale: string }>(`${baseUrl}/api/settings`, {
      theme: "neon",
      ui_locale: "xx"
    });

    expect(initial.theme).toBe("system");
    expect(patched).toMatchObject({ theme: "dark", ui_locale: "en", output_locale: "fr" });
    expect(persisted).toMatchObject({ theme: "dark", ui_locale: "en", output_locale: "fr" });
    expect(invalidPatch).toMatchObject({ theme: "dark", ui_locale: "en", output_locale: "fr" });
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

async function getJson<T>(url: string, expectedStatus = 200): Promise<T> {
  const response = await fetch(url);
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}

async function patchJson<T>(url: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json()) as T;
  expect(response.status).toBe(expectedStatus);
  return payload;
}
