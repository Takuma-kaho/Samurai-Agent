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
  it("routes Chat, Gateway, and Automation through the composed Host", async () => {
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
            if (!result.chat) throw new Error("composition_gateway_chat_missing");
            return result.chat.backendRun.id;
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

      for (const entry of observed) {
        const run = await store.getBackendRun(entry.runId);
        expect(run, `${entry.name} did not create a Backend Run`).toMatchObject({ id: entry.runId, status: "completed", backend_id: "mock" });
      }
      expect(new Set(observed.map((entry) => entry.runId)).size).toBe(3);
    } finally {
      await runtime.shutdown();
      await store.close();
    }
  });

  it("waits for Chat Learning Review before returning a committed result", async () => {
    vi.stubEnv("SAMURAI_BACKEND_DEFAULT", "mock");
    const root = await mkdtemp(path.join(tmpdir(), "samurai-core02-chat-review-"));
    roots.push(root);
    const store = await WorkspaceStore.create({ rootDir: root });
    let reviewStarted!: () => void;
    const started = new Promise<void>((resolve) => { reviewStarted = resolve; });
    let releaseReview!: () => void;
    const release = new Promise<void>((resolve) => { releaseReview = resolve; });
    const runtime = composeAgentRuntime({
      store,
      backendRegistry: new AgentBackendRegistry([new MockBackend()]),
      workspaceOptions: {
        productionLogger: () => undefined,
        detachBackgroundReview: true,
        backgroundReviewRunner: {
          run: async () => {
            reviewStarted();
            await release;
            throw new Error("learning review failed");
          }
        }
      }
    });

    try {
      await runtime.startup();
      const session = await runtime.createSession({ title: "Chat Review" });
      let returned = false;
      const resultPromise = runtime.runChatTurn({
        sessionId: session.id,
        content: "chat review",
        backend_id: "mock",
        idempotency_key: "chat-review-1"
      }).then((result) => {
        returned = true;
        return result;
      });

      await started;
      expect(returned).toBe(false);
      releaseReview();
      const result = await resultPromise;

      expect(result.backendRun.status).toBe("completed");
      expect(result.reflectionRuns).toContainEqual(expect.objectContaining({ status: "failed" }));
      expect(result.backendEvents).toContainEqual(expect.objectContaining({
        event_type: "host_post_turn_failed",
        payload: expect.objectContaining({ operation_id: "learning_review" })
      }));
    } finally {
      await runtime.shutdown();
      await store.close();
    }
  });
});
