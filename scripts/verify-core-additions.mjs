import { spawnSync } from "node:child_process";

for (const script of ["verify-core-additions-ledger.mjs", "verify-core-additions-tests.mjs", "verify-core-additions-score.mjs"]) {
  const result = spawnSync(process.execPath, [`scripts/${script}`], { cwd: process.cwd(), stdio: "inherit", env: { ...process.env, CI: "true" } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
