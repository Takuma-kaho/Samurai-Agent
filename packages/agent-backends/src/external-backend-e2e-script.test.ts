import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const verifierProcessTimeoutMs = 30_000;
const verifierTestTimeoutMs = verifierProcessTimeoutMs + 5_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("external backend verification script", () => {
  it("runs a configured Codex-style backend through the real adapter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-backend-e2e-"));
    roots.push(root);
    const executable = path.join(root, "codex-fixture");
    await writeFile(executable, [
      "#!/bin/sh",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-e2e-thread\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"thread_id\":\"codex-e2e-thread\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"external e2e ok\"}]}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"thread_id\":\"codex-e2e-thread\",\"output_summary\":\"external e2e ok\"}'"
    ].join("\n"));
    await chmod(executable, 0o755);

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/verify-external-backends.mjs",
      "--backend",
      "codex",
      "--run",
      "--confirm-external-effects",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SAMURAI_CODEX_COMMAND: executable,
        SAMURAI_CODEX_ARGS: "",
        SAMURAI_EXTERNAL_BACKEND_E2E_CONFIRM_EXTERNAL_EFFECTS: "false"
      },
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    });

    const result = JSON.parse(stdout);
    expect(result.results).toEqual([
      expect.objectContaining({
        backend_id: "codex",
        run: expect.objectContaining({
          status: "passed",
          terminal_event: "run_completed",
          backend_session_id: "codex-e2e-thread",
          output_summary: "external e2e ok"
        })
      })
    ]);
  }, verifierTestTimeoutMs);

  it("runs and resumes a configured Codex-style backend through the verifier", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-backend-resume-e2e-"));
    roots.push(root);
    const executable = path.join(root, "codex-resume-fixture");
    await writeFile(executable, [
      "#!/bin/sh",
      "cat >/dev/null",
      "if [ \"$1\" = \"exec\" ] && [ \"$2\" = \"resume\" ]; then",
      "  printf '%s\\n' '{\"type\":\"item.completed\",\"thread_id\":\"codex-e2e-thread\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"external resume ok\"}]}}'",
      "  printf '%s\\n' '{\"type\":\"turn.completed\",\"thread_id\":\"codex-e2e-thread\",\"output_summary\":\"external resume ok\"}'",
      "  exit 0",
      "fi",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"codex-e2e-thread\"}'",
      "printf '%s\\n' '{\"type\":\"item.completed\",\"thread_id\":\"codex-e2e-thread\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"external e2e ok\"}]}}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"thread_id\":\"codex-e2e-thread\",\"output_summary\":\"external e2e ok\"}'"
    ].join("\n"));
    await chmod(executable, 0o755);

    const { stdout } = await execFileAsync(process.execPath, [
      "scripts/verify-external-backends.mjs",
      "--backend",
      "codex",
      "--run",
      "--confirm-external-effects",
      "--resume",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SAMURAI_CODEX_COMMAND: executable,
        SAMURAI_CODEX_ARGS: "",
        SAMURAI_EXTERNAL_BACKEND_E2E_CONFIRM_EXTERNAL_EFFECTS: "false"
      },
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    });

    const result = JSON.parse(stdout);
    expect(result.results).toEqual([
      expect.objectContaining({
        backend_id: "codex",
        run: expect.objectContaining({
          status: "passed",
          backend_session_id: "codex-e2e-thread",
          output_summary: "external e2e ok"
        }),
        resume: expect.objectContaining({
          status: "passed",
          terminal_event: "run_completed",
          backend_session_id: "codex-e2e-thread",
          output_summary: "external resume ok"
        })
      })
    ]);
  }, verifierTestTimeoutMs);

  it("returns a structured failure and non-zero exit when a configured backend run fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-backend-failed-e2e-"));
    roots.push(root);
    const executable = path.join(root, "codex-failed-fixture");
    await writeFile(executable, [
      "#!/bin/sh",
      "cat >/dev/null",
      "printf '%s\\n' '{\"type\":\"error\",\"thread_id\":\"codex-e2e-thread\",\"error_code\":\"fixture_failure\",\"message\":\"fixture failed\"}'",
      "exit 1"
    ].join("\n"));
    await chmod(executable, 0o755);

    await expect(execFileAsync(process.execPath, [
      "scripts/verify-external-backends.mjs",
      "--backend",
      "codex",
      "--run",
      "--confirm-external-effects",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SAMURAI_CODEX_COMMAND: executable,
        SAMURAI_CODEX_ARGS: ""
      },
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("\"status\": \"failed\"")
    });
  });

  it("blocks real backend runs without explicit external effects confirmation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "samurai-external-backend-blocked-e2e-"));
    roots.push(root);
    const executable = path.join(root, "codex-blocked-fixture");
    const marker = path.join(root, "called");
    await writeFile(executable, [
      "#!/bin/sh",
      `printf called > ${JSON.stringify(marker)}`,
      "printf '%s\\n' '{\"type\":\"turn.completed\",\"thread_id\":\"codex-e2e-thread\",\"output_summary\":\"should not run\"}'"
    ].join("\n"));
    await chmod(executable, 0o755);

    await expect(execFileAsync(process.execPath, [
      "scripts/verify-external-backends.mjs",
      "--backend",
      "codex",
      "--run",
      "--resume",
      "--json",
      "--timeout-ms",
      "5000"
    ], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SAMURAI_CODEX_COMMAND: executable,
        SAMURAI_CODEX_ARGS: ""
      },
      timeout: verifierProcessTimeoutMs,
      maxBuffer: 1024 * 1024
    })).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("external_effects_confirmation_required")
    });

    await expect(import("node:fs/promises").then(({ stat }) => stat(marker))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
