import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const file = path.resolve(process.argv[2] ?? "reports/core-completion/evidence/domain-commands.json");
const evidence = JSON.parse(readFileSync(file, "utf8"));
if (evidence.status !== "passed") throw new Error("evidence_status_not_passed");
for (const assertion of evidence.assertions ?? []) {
  if (JSON.stringify(assertion.actual) !== JSON.stringify(assertion.expected)) {
    throw new Error(`evidence_actual_expected_mismatch:${assertion.name}`);
  }
}
if (evidence.result?.gate_count !== 81 || evidence.result?.repository_tests !== evidence.result?.repository_passed_tests) {
  throw new Error("evidence_result_mismatch");
}
process.stdout.write(`${JSON.stringify({ status: "passed", evidence: path.relative(process.cwd(), file) })}\n`);
