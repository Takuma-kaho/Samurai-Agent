import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBackendRegistry, MockBackend } from "@samurai-agent/agent-backends";
import { WorkspaceStore } from "@samurai-agent/workspace-store";
import { composeAgentRuntime } from "./runtime";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("Core 02 production composition", () => {
  it("routes Chat and Automation through the composed Host and fails closed for an unbound Gateway contact", async () => {
    vi.stubEnv("SAMURAI_BACKEND_DEFAULT", "mock");
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-composition-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = composeAgentRuntime({
      store,
      backendRegistry: new AgentBackendRegistry([new MockBackend()]),
      workspaceOptions: {
        productionLogger: () => undefined
      }
    });

    try {
      await runtime.startup();
      const ingressCases = [
        {
          name: "Chat",
          run: async () => {
            const session = await runtime.createSession({ title: "Composition Chat" });
            const result = await runtime.runChatTurn({
              sessionId: session.id,
              content: "composition chat",
              backend_id: "mock",
              idempotency_key: "composition-chat-1"
            });
            return result.backendRun.id;
          }
        },
        {
          name: "Gateway",
          run: async () => {
            const blocked = await runtime.handleGatewayInbound({
              channel: "webhook",
              source_identity: "composition-gateway",
              body: "initial pairing"
            });
            if (!blocked.pairing) throw new Error("composition_gateway_pairing_missing");
            await runtime.approveGatewayPairing(blocked.pairing.id);
            const result = await runtime.handleGatewayInbound({
              channel: "webhook",
              source_identity: "composition-gateway",
              body: "composition gateway",
              backend_id: "mock",
              metadata: { idempotency_key: "composition-gateway-1" }
            });
            expect(result.chat).toBeUndefined();
            expect(result.inbound).toMatchObject({ status: "blocked", error: "gateway_participant_authentication_required" });
            return undefined;
          }
        },
        {
          name: "Automation",
          run: async () => {
            await runtime.saveAutomationJob({
              title: "Composition automation",
              kind: "daily_digest",
              schedule: "once",
              target_instruction: "composition automation",
              next_run_at: new Date(0).toISOString()
            });
            const results = await runtime.runDueAutomationJobs(new Date(Date.now() + 1_000).toISOString());
            const automationRun = results[0]?.automationRun;
            if (!automationRun?.backend_run_id) throw new Error("composition_automation_backend_run_missing");
            return automationRun.backend_run_id;
          }
        }
      ];

      const observed = [];
      for (const ingressCase of ingressCases) {
        observed.push({ name: ingressCase.name, runId: await ingressCase.run() });
      }

      for (const entry of observed.filter((entry): entry is { name: string; runId: string } => typeof entry.runId === "string")) {
        const run = await store.getBackendRun(entry.runId);
        expect(run, `${entry.name} did not create a Backend Run`).toMatchObject({ id: entry.runId, status: "completed", backend_id: "mock" });
      }
      expect(new Set(observed.filter((entry) => entry.runId).map((entry) => entry.runId)).size).toBe(2);
    } finally {
      await runtime.shutdown();
      await store.close();
    }
  });

  it("registers a Chat Learning candidate after settlement without running Review inline", async () => {
    vi.stubEnv("SAMURAI_BACKEND_DEFAULT", "mock");
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-chat-review-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    const runtime = composeAgentRuntime({
      store,
      backendRegistry: new AgentBackendRegistry([new MockBackend()]),
      workspaceOptions: {
        productionLogger: () => undefined
      }
    });

    try {
      await runtime.startup();
      const session = await runtime.createSession({ title: "Chat Review" });
      let returned = false;
      const resultPromise = runtime.runChatTurn({
        sessionId: session.id,
        content: "この内容を記憶に保存してください。",
        backend_id: "mock",
        idempotency_key: "chat-review-1"
      }).then((result) => {
        returned = true;
        return result;
      });

      const result = await resultPromise;

      expect(returned).toBe(true);
      expect(result.backendRun.status).toBe("completed");
      expect((await store.listReflectionRuns()).filter((run) => run.source_run_id === result.backendRun.id)).toContainEqual(expect.objectContaining({ kind: "background_review", status: "queued" }));
    } finally {
      await runtime.shutdown();
      await store.close();
    }
  });
});
