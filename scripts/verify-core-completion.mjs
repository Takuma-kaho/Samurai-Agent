import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const scorecardPath = path.join(root, "plans/core-completion-scorecard.json");
const args = new Set(process.argv.slice(2));
const writeReportRequested = args.has("--write-report");
const reportDir = writeReportRequested
  ? path.join(root, "reports/core-completion")
  : await mkdtemp(path.join(tmpdir(), "samurai-core-completion-"));
const categoryIndex = process.argv.indexOf("--category");
const selectedCategory = categoryIndex >= 0 ? process.argv[categoryIndex + 1] : undefined;

const scorecardSource = await readFile(scorecardPath, "utf8");
const scorecard = JSON.parse(scorecardSource);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const scorecardHash = createHash("sha256").update(scorecardSource).digest("hex");

function evidencePathFor(test) {
  return path.join(root, test.evidence ?? `reports/core-completion/evidence/${test.id}.json`);
}

async function inspectEvidence(test) {
  const evidencePath = evidencePathFor(test);
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
    const failures = [];
    if (evidence.schema_version !== scorecard.schema_version) failures.push("schema_version mismatch");
    if (scorecard.completion_requires.evidence_commit_must_match_head && evidence.commit_sha !== head) failures.push("commit_sha mismatch");
    if (scorecard.completion_requires.evidence_worktree_must_be_clean && evidence.worktree_clean !== true) failures.push("evidence was produced from a dirty worktree");
    if (evidence.test_id !== (test.evidence_test_id ?? test.id)) failures.push("test_id mismatch");
    if (evidence.command !== (test.evidence_command ?? test.command)) failures.push("command mismatch");
    if (evidence.status !== "passed") failures.push("status is not passed");
    if (!evidence.started_at || !evidence.completed_at) failures.push("timestamps missing");
    if (!Array.isArray(evidence.assertions) || evidence.assertions.length === 0) failures.push("assertions missing");
    if (!Array.isArray(evidence.source_files) || evidence.source_files.length === 0 || !evidence.source_sha256) {
      failures.push("source evidence missing");
    } else {
      try {
        const sourceFiles = [...evidence.source_files].sort();
        const sourceContents = await Promise.all(sourceFiles.map((file) => readFile(path.join(root, file))));
        const canonicalHash = createHash("sha256");
        sourceFiles.forEach((file, index) => canonicalHash.update(file).update("\0").update(sourceContents[index]).update("\0"));
        const canonicalSourceHash = canonicalHash.digest("hex");
        const legacySource = sourceFiles.map((file, index) => `${file}\0${sourceContents[index].toString("utf8")}`).join("\0");
        const legacySourceHash = createHash("sha256").update(legacySource).digest("hex");
        if (canonicalSourceHash !== evidence.source_sha256 && legacySourceHash !== evidence.source_sha256) failures.push("source_sha256 mismatch");
      } catch (error) {
        failures.push(`source verification failed: ${error.message}`);
      }
    }
    return { ...test, evidence: path.relative(root, evidencePath), score: failures.length === 0 ? 2 : 0, status: failures.length === 0 ? "passed" : "invalid", failures };
  } catch (error) {
    return { ...test, evidence: path.relative(root, evidencePath), score: 0, status: "missing", failures: [error.code === "ENOENT" ? "evidence missing" : `invalid evidence: ${error.message}`] };
  }
}

if (selectedCategory && !scorecard.categories[selectedCategory]) {
  throw new Error(`Unknown category: ${selectedCategory}`);
}

const selectedTests = selectedCategory ? scorecard.tests.filter((test) => test.category === selectedCategory) : scorecard.tests;
const tests = await Promise.all(selectedTests.map(inspectEvidence));
const gates = await Promise.all(scorecard.gates.map(inspectEvidence));
const score = tests.reduce((total, test) => total + test.score, 0);
const maximumScore = tests.length * scorecard.points_per_test;
const allGatesPassed = gates.every((gate) => gate.status === "passed");
const complete = !selectedCategory && score === scorecard.maximum_score && allGatesPassed;
const generatedAt = new Date().toISOString();
const report = { schema_version: scorecard.schema_version, scorecard_sha256: scorecardHash, commit_sha: head, generated_at: generatedAt, category: selectedCategory ?? null, score, maximum_score: maximumScore, all_gates_passed: allGatesPassed, complete, tests, gates };

await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
const missing = tests.filter((test) => test.score !== 2);
const failedGates = gates.filter((gate) => gate.status !== "passed");
const markdown = [`# Core Completion Report`, "", `- Commit: \`${head}\``, `- Score: **${score}/${maximumScore}**`, `- Required gates: **${gates.length - failedGates.length}/${gates.length}**`, `- Complete: **${complete ? "yes" : "no"}**`, "", "## Incomplete tests", "", ...(missing.length ? missing.map((test) => `- ${test.id}: ${test.failures.join(", ")}`) : ["- none"]), "", "## Failed gates", "", ...(failedGates.length ? failedGates.map((gate) => `- ${gate.id}: ${gate.failures.join(", ")}`) : ["- none"]), ""].join("\n");
await writeFile(path.join(reportDir, "latest.md"), markdown);

console.log(`Core completion: ${score}/${maximumScore}; gates ${gates.length - failedGates.length}/${gates.length}; complete=${complete}; report_dir=${reportDir}; persisted=${writeReportRequested}`);
if (!args.has("--report-only") && !complete) process.exitCode = 1;
