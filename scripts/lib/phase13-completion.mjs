export function evaluatePhase13Completion(checks) {
  const failed = checks.filter((check) => check.status === "failed");
  const unverified = checks.filter((check) => check.status === "unverified");
  const status = failed.length > 0
    ? "failed"
    : unverified.length > 0
      ? "passed_with_unverified"
      : "passed";

  return {
    status,
    complete: status === "passed",
    environment_verified: unverified.length === 0,
    exit_code: status === "failed" ? 1 : status === "passed_with_unverified" ? 2 : 0,
    failed,
    unverified
  };
}
