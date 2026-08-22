import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { createServer, type Server } from "node:http";
import express from "express";
import { registerBackendEventRoutes } from "../../apps/server/src/routes/backend-events";
import { AgentRuntime } from "../../packages/runtime/src/index";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";

const root = await mkdtemp(path.join(tmpdir(), "samurai-event-replay-"));
let store = await WorkspaceStore.create({ rootDir: root });
let runtime = new AgentRuntime(store);
let server: Server;
const now = "2026-07-11T00:00:00.000Z";
const socketPath = path.join(root, "backend-events.sock");
const startServer = async () => { const app = express(); registerBackendEventRoutes(app, store, runtime); server = createServer(app); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); }); };
const stopServer = async () => new Promise<void>((resolve) => server.close(() => resolve()));
const getEvents = async (after: number, limit: number) => new Promise<any[]>((resolve, reject) => {
  const req = request({ socketPath, path: `/api/backend-runs/event-run/events?after_sequence=${after}&limit=${limit}`, method: "GET" }, (response) => {
    let body = ""; response.setEncoding("utf8"); response.on("data", (chunk) => body += chunk); response.on("end", () => response.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`HTTP ${response.statusCode}: ${body}`)));
  }); req.on("error", reject); req.end();
});
try {
  const roomId = (await store.getSettings()).default_room_id!;
  await store.createSession({ id: "event-session", session_key: "web:event:main", room_id: roomId, title: "Event replay", ui_locale: "en", output_locale: "en", created_at: now, updated_at: now });
  await store.saveBackendRun({
    id: "event-run", session_id: "event-session", input_message_id: "event-input", backend_id: "fixture",
    backend_kind: "mock", status: "running", started_at: now, input_summary: "event replay", metadata: {}
  });
  for (let sequence = 1; sequence <= 100; sequence += 1) {
    await store.saveBackendEvent({
      id: `event-${sequence}`, run_id: "event-run", session_id: "event-session",
      event_type: sequence === 100 ? "run_completed" : "text_delta", sequence,
      payload: sequence === 100
        ? { terminal_evidence: { kind: "completed", source: "canonical_event" } }
        : { text: `event-${sequence}` },
      resource_refs: [], created_at: new Date(Date.parse(now) + sequence).toISOString()
    });
  }
  await startServer();

  const received: number[] = [];
  let cursor = 0;
  let pages = 0;
  while (cursor < 51) {
    const page = await getEvents(cursor, 17);
    if (page.length === 0) break;
    received.push(...page.map((event) => event.sequence));
    cursor = page.at(-1)!.sequence;
    pages += 1;
  }
  await stopServer();
  await runtime.shutdownMcpProcessPool();
  await store.close();
  await rm(socketPath, { force: true });
  store = await WorkspaceStore.create({ rootDir: root });
  runtime = new AgentRuntime(store);
  await startServer();
  while (true) {
    const page = await getEvents(cursor, 17);
    if (page.length === 0) break;
    received.push(...page.map((event) => event.sequence));
    cursor = page.at(-1)!.sequence;
    pages += 1;
  }
  assert.deepEqual(received, Array.from({ length: 100 }, (_, index) => index + 1));
  assert.equal(new Set(received).size, 100);
  assert.deepEqual(await getEvents(100, 17), []);

  process.stdout.write(`${JSON.stringify({ status: "passed", api_server_restarted: true, http_transport: "unix_socket", persisted_events: 100, replayed_events: received.length, pages, missing: 0, duplicates: 0, final_cursor: cursor })}\n`);
} finally {
  if (server!) await stopServer().catch(() => undefined);
  await runtime.shutdownMcpProcessPool().catch(() => undefined);
  await store.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
