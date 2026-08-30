import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 30_000 }).trim();
const safeRun = (command, args) => {
  try {
    return { ok: true, output: run(command, args) };
  } catch (error) {
    return { ok: false, output: String(error.signal ?? error.message) };
  }
};
const lines = (value) => value.split("\n").filter(Boolean);
const startedAt = new Date().toISOString();

const trackedCheck = safeRun("git", ["ls-files"]);
const untrackedCheck = safeRun("git", ["ls-files", "--others", "--exclude-standard"]);
const tracked = trackedCheck.ok ? lines(trackedCheck.output) : [];
const untracked = untrackedCheck.ok ? lines(untrackedCheck.output) : [];
const files = [...new Set([...tracked, ...untracked])].filter((file) => existsSync(path.join(root, file)));
const textExtensions = /\.(?:ts|tsx|cts|mts|js|mjs|cjs|vue|json|md|css|yml|yaml|toml)$/;
const textFiles = files.filter((file) => textExtensions.test(file) && !/^(?:node_modules|reports\/core-completion\/evidence)\//.test(file));
const contents = new Map();
const sourceReadErrors = [];
for (const file of textFiles) {
  try {
    const content = execFileSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", path.join(root, file)], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    contents.set(file, content);
  } catch {
    sourceReadErrors.push(file);
  }
}

const whitespaceIssues = [];
for (const [file, content] of contents) {
  content.split("\n").forEach((line, index) => {
    if (/[ \t]+$/.test(line) || /^(?:<<<<<<<|=======|>>>>>>>)/.test(line)) whitespaceIssues.push(`${file}:${index + 1}`);
  });
}

const duplicateCandidates = files.filter((file) => /(?:^|\/)[^/]+(?: 2| copy| copy \d+)\.(?:ts|tsx|cts|mts|js|mjs|cjs|vue|json|md)$/i.test(file));
const duplicateSources = duplicateCandidates.filter((file) => {
  const original = file.replace(/(?: 2| copy| copy \d+)(?=\.[^/]+$)/i, "");
  const duplicateContent = contents.get(file);
  const originalContent = contents.get(original);
  return duplicateContent !== undefined && originalContent !== undefined && duplicateContent === originalContent;
});

// Keep this gate focused on recognizable credential formats.  Fixtures are
// excluded below, while real source/config files are scanned for the common
// provider token families and PEM private keys.
const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  /\bsk-(?:live|test-)?[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\bya29\.[A-Za-z0-9_-]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:lin_api|lin_oauth)_[A-Za-z0-9_-]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/,
  /\bsq0atp-[A-Za-z0-9_-]{20,}\b/
];
const credentialAssignmentPattern = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passphrase|private[_-]?key|authorization|cookie|secret)\s*[:=]\s*["']([^\s"']{16,})["']/i;
const secretLeaks = [];
const secretAdvisories = [];
for (const [file, content] of contents) {
  const providerPatternMatch = secretPatterns.some((pattern) => pattern.test(content));
  const assignmentMatch = credentialAssignmentPattern.exec(content);
  if (!providerPatternMatch && !assignmentMatch) continue;
  // Tests and fixtures intentionally contain synthetic values. They are
  // scanned as advisories so the gate does not confuse test data with a real
  // release credential, while production/configuration files remain blocking.
  if (/\.(?:test|spec)\.|^scripts\/fixtures\//.test(file)) {
    secretAdvisories.push(file);
  } else {
    secretLeaks.push(file);
  }
}

const untrackedGenerated = untracked.filter((file) => !file.startsWith("reports/core-completion/") && /(?:^|\/)(?:dist|build|coverage|\.cache|tmp|temp|latest\.(?:json|md))(?:\/|$)/i.test(file));
const inspectionOk = trackedCheck.ok && untrackedCheck.ok && sourceReadErrors.length === 0;
const result = {
  status: inspectionOk && whitespaceIssues.length === 0 && duplicateSources.length === 0 && secretLeaks.length === 0 && untrackedGenerated.length === 0 ? "passed" : "partial",
  inspection_ok: inspectionOk,
  worktree_clean: false,
  diff_check_clean: whitespaceIssues.length === 0,
  whitespace_issues: whitespaceIssues,
  source_read_errors: sourceReadErrors,
  secret_leaks: secretLeaks,
  secret_advisories: secretAdvisories,
  duplicate_sources: duplicateSources,
  duplicate_candidates: duplicateCandidates,
  untracked_generated: untrackedGenerated,
  inspected_source_files: contents.size,
  dirty_entries: untracked.length
};
const completedAt = new Date().toISOString();
const sources = [
  "scripts/verify-release-hygiene.mjs",
  "scripts/verify-phase13-completion.mjs",
  "scripts/verify-domain-contracts.mjs",
  "scripts/lib/core-evidence.mjs",
  "contracts/domain-command-contract-ledger.json",
  "package.json"
];
const commitSha = run("git", ["rev-parse", "HEAD"]);
const sourceSha256 = createHash("sha256").update([...sources].sort().map((file) => `${file}\0${readFileSync(path.join(root, file), "utf8")}`).join("\0")).digest("hex");
const evidenceDirectory = path.join(root, "reports/core-completion/evidence");
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(path.join(evidenceDirectory, "G05.json"), `${JSON.stringify({
  schema_version: 1,
  test_id: "G05",
  command: "pnpm core:test:release-hygiene",
  status: result.status,
  commit_sha: commitSha,
  worktree_clean: false,
  source_sha256: sourceSha256,
  source_files: [...sources].sort(),
  started_at: startedAt,
  completed_at: completedAt,
  assertions: [
    { name: "inspection_ok", actual: result.inspection_ok, expected: true },
    { name: "source_files_readable", actual: result.source_read_errors.length, expected: 0 },
    { name: "diff_check_clean", actual: result.diff_check_clean, expected: true },
    { name: "secret_leaks", actual: result.secret_leaks.length, expected: 0 },
    { name: "exact_duplicate_sources", actual: result.duplicate_sources.length, expected: 0 },
    { name: "untracked_generated", actual: result.untracked_generated.length, expected: 0 }
  ],
  advisories: [{ name: "worktree_clean_release_certification", actual: false, expected: true }],
  result
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(result)}\n`);
if (result.status !== "passed") process.exitCode = 1;
