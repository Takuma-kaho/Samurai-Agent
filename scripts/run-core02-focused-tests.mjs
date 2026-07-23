import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const bundleRoot = path.join(root, ".tmp-core02-vitest");
const vitest = path.join(root, "node_modules/.bin/vitest");
const group = process.argv[2] ?? "runtime";
if (group !== "runtime" && group !== "workspace") throw new Error(`core02_test_group_invalid:${group}`);

if (!existsSync(path.join(bundleRoot, "run-state-machine.test.mjs"))) throw new Error("core02_test_bundle_missing");
execFileSync(vitest, ["run", "--config", path.join(root, "vitest.core02.config.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    SAMURAI_CORE02_VITEST_ROOT: bundleRoot,
    SAMURAI_CORE02_VITEST_GROUP: group
  },
  stdio: "inherit"
});
