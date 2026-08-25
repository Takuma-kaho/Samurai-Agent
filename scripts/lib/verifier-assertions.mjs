import { isDeepStrictEqual } from "node:util";

export function matchesVerifierExpectation(actual, expected) {
  if (typeof expected === "string") {
    const threshold = expected.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
    if (threshold) {
      const value = Number(actual);
      const target = Number(threshold[2]);
      if (!Number.isFinite(value)) return false;
      if (threshold[1] === ">=") return value >= target;
      if (threshold[1] === "<=") return value <= target;
      if (threshold[1] === ">") return value > target;
      return value < target;
    }
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && actual.length === expected.length
      && expected.every((value, index) => matchesVerifierExpectation(actual[index], value));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return expectedKeys.length === actualKeys.length
      && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key)
        && matchesVerifierExpectation(actual[key], expected[key]));
  }
  return isDeepStrictEqual(actual, expected);
}

export function evaluateVerifierAssertions(assertions, resultOrStatus) {
  const failures = [];
  const status = typeof resultOrStatus === "string" ? resultOrStatus : resultOrStatus?.status;
  if (resultOrStatus !== undefined && status !== "passed") {
    failures.push(`result status is ${status ?? "missing"}`);
  }
  if (!Array.isArray(assertions) || assertions.length === 0) {
    failures.push("assertions are missing");
    return failures;
  }
  for (const [index, assertion] of assertions.entries()) {
    if (!assertion || typeof assertion !== "object" || !("actual" in assertion) || !("expected" in assertion)) {
      failures.push(`assertion[${index}] is malformed`);
      continue;
    }
    if (!matchesVerifierExpectation(assertion.actual, assertion.expected)) {
      failures.push(`${assertion.name ?? `assertion[${index}]`} expected ${JSON.stringify(assertion.expected)} but received ${JSON.stringify(assertion.actual)}`);
    }
  }
  return failures;
}

export function verifierEvidenceStatus(resultOrStatus, failures) {
  const status = typeof resultOrStatus === "string" ? resultOrStatus : resultOrStatus?.status;
  if (status === "unverified" || status === "skipped") return "unverified";
  return failures.length > 0 ? "failed" : "passed";
}

export function reportVerifierFailures(testId, failures) {
  if (failures.length === 0) return;
  process.stderr.write(`[${testId}] ${failures.join("; ")}\n`);
  process.exitCode = 1;
}
