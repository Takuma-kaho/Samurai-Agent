import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifierProcessTimeoutMs = 60_000;

describe("sandbox executor verification script", () => {
  it("runs the local host sandbox probe", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "scripts/verify-sandbox-executors.mjs",
      "--backend",
      "none",
      "--run",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: process.cwd(),
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    });

    const result = JSON.parse(stdout);
    expect(result.results).toEqual([
      expect.objectContaining({
        backend: "none",
        capability: expect.objectContaining({ available: true }),
        run: expect.objectContaining({
          status: "passed",
          stdout: "sandbox-ok"
        })
      })
    ]);
  }, verifierProcessTimeoutMs);

  it("blocks external sandbox runs without explicit confirmation", async () => {
    await expect(execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "scripts/verify-sandbox-executors.mjs",
      "--backend",
      "docker",
      "--run",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SAMURAI_SANDBOX_E2E_CONFIRM_EXTERNAL_EFFECTS: "false"
      },
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("external_effects_confirmation_required")
    });
  }, verifierProcessTimeoutMs);
});
