import { appendFile } from "node:fs/promises";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DurableDomainCommandBus } from "../../packages/runtime/src/commands/domain-command-bus";

const root = requiredEnvironment("SAMURAI_WORKER_ROOT");
const sideEffectFile = requiredEnvironment("SAMURAI_WORKER_SIDE_EFFECT_FILE");
const store = await WorkspaceStore.create({ rootDir: root });

try {
  const result = await new DurableDomainCommandBus(store, 2_000).execute({
    commandId: "test.multi_process",
    contractVersion: "1.0",
    inputSource: "runtime_api",
    payload: { value: 1 },
    idempotencyKey: "multi-process-same-key",
    workspaceId: "workspace",
    actorId: "actor",
    executionClass: "internal"
  }, async () => {
    await appendFile(sideEffectFile, "effect\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { result_id: "multi-process-result" };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await store.close();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
