import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";

const file = path.resolve(process.argv[2] ?? "reports/core-completion/evidence/domain-commands.json");
const evidence = JSON.parse(readFileSync(file, "utf8"));
const reportEvidence = file.includes(`${path.sep}reports${path.sep}core-completion${path.sep}evidence${path.sep}`);
if (reportEvidence && !["domain-command", "domain-command-race"].includes(evidence.evidence_kind)) {
  throw new Error("evidence_provenance_kind_missing");
}
if (evidence.status !== "passed") throw new Error("evidence_status_not_passed");
if (reportEvidence && (typeof evidence.generation_id !== "string" || evidence.result?.generation_id !== evidence.generation_id)) {
  throw new Error("evidence_generation_id_missing_or_mismatched");
}
for (const assertion of evidence.assertions ?? []) {
  if (!Object.hasOwn(assertion, "actual")) {
    throw new Error(`evidence_actual_missing:${assertion.name}`);
  }
  if (Object.hasOwn(assertion, "expected") && JSON.stringify(assertion.actual) !== JSON.stringify(assertion.expected)) {
    throw new Error(`evidence_actual_expected_mismatch:${assertion.name}`);
  }
  if (Object.hasOwn(assertion, "expected") && typeof assertion.expected_source !== "string") {
    throw new Error(`evidence_expected_source_missing:${assertion.name}`);
  }
}
if (!Number.isInteger(evidence.result?.gate_count) || evidence.result.gate_count < 1 || evidence.result?.repository_tests !== evidence.result?.repository_passed_tests) {
  throw new Error("evidence_result_mismatch");
}
if (["domain-command", "domain-command-race"].includes(evidence.evidence_kind)) {
  if (!Array.isArray(evidence.source_files) || typeof evidence.commit_sha !== "string" || typeof evidence.source_sha256 !== "string"
    || typeof evidence.source_graph_sha256 !== "string" || typeof evidence.contract_versions_sha256 !== "string") {
    throw new Error("evidence_provenance_missing");
  }
  const root = process.cwd();
  const current = committedSourceEvidence(root, evidence.source_files);
  for (const field of ["commit_sha", "source_sha256", "source_graph_sha256", "contract_versions_sha256"]) {
    if (current[field] !== evidence[field]) throw new Error(`evidence_provenance_mismatch:${field}`);
  }
  if (!current.worktree_clean || current.source_read_errors.length > 0) throw new Error("evidence_source_not_committed_and_clean");
}
process.stdout.write(`${JSON.stringify({ status: "passed", evidence: path.relative(process.cwd(), file) })}\n`);
