import { appendFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { WorkspaceStore } from "../../packages/workspace-store/src/index";
import { DurableDomainCommandBus, type DomainCommandCheckpoint } from "../../packages/runtime/src/commands/domain-command-bus";

const root = requiredEnvironment("SAMURAI_WORKER_ROOT");
const mode = requiredEnvironment("SAMURAI_CRASH_MODE");
const sideEffectFile = process.env.SAMURAI_WORKER_SIDE_EFFECT_FILE;
if (mode === "during_internal_transaction") {
  const database = new Database(path.join(root, "workspace.sqlite"));
  database.exec("CREATE TABLE IF NOT EXISTS domain_crash_fixture (id TEXT PRIMARY KEY)");
  database.exec("BEGIN IMMEDIATE");
  database.prepare("INSERT INTO domain_crash_fixture(id) VALUES (?)").run("partial");
  process.exit(93);
}
const crashCheckpoint: DomainCommandCheckpoint = mode === "before_handler" ? "claimed" : "handler_succeeded";
const executionClass = mode === "before_handler" ? "internal" : "external";
const idempotencyKey = mode === "before_handler" ? "crash-before-handler" : "crash-after-external";
const store = await WorkspaceStore.create({ rootDir: root });
const bus = new DurableDomainCommandBus(store, 100, {
  checkpoint(name) {
    if (name === crashCheckpoint) process.exit(mode === "before_handler" ? 91 : 92);
  }
});

await bus.execute({
  commandId: `test.${mode}`,
  inputSource: "runtime_api",
  payload: { mode },
  idempotencyKey,
  executionClass
}, async () => {
  if (sideEffectFile) await appendFile(sideEffectFile, "external-effect\n", "utf8");
  return { completed: true };
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_environment:${name}`);
  return value;
}
