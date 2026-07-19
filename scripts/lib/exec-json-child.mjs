import { execFileSync } from "node:child_process";
import process from "node:process";

/**
 * Run a JSON-producing child without allowing a hung verifier to look like a
 * successful check.  Preserve both streams on every failure, including hard
 * timeout, so fixture stage diagnostics remain actionable.
 */
export function execJsonChild(file, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    nodeArgs = [],
    timeout = 60_000,
    maxBuffer = 16 * 1024 * 1024,
    ...execOptions
  } = options;
  try {
    return execFileSync(process.execPath, [...nodeArgs, file], {
      cwd,
      encoding: "utf8",
      timeout,
      killSignal: "SIGTERM",
      maxBuffer,
      ...execOptions,
      env
    });
  } catch (error) {
    const failure = error && typeof error === "object" ? error : {};
    if (failure.code === "ETIMEDOUT" || failure.killed === true) {
      process.stderr.write(`[json-child] timeout:${file}:${timeout}ms\n`);
    }
    if (typeof failure.stdout === "string" && failure.stdout.length > 0) process.stderr.write(failure.stdout);
    if (typeof failure.stderr === "string" && failure.stderr.length > 0) process.stderr.write(failure.stderr);
    throw error;
  }
}
