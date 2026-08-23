import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { evaluateVerifierAssertions, reportVerifierFailures, verifierEvidenceStatus } from "./lib/verifier-assertions.mjs";

const root = process.cwd();
const platform = process.platform;
const arch = process.arch;
const prefix = `@esbuild+${platform}-${arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(`${prefix}0.25.`))
  ?? readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix));
if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/");
const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild");
const tempDir = path.join("/tmp", "samurai-core-additions-verifier");
mkdirSync(tempDir, { recursive: true });
const tempModules = path.join(tempDir, "node_modules");
if (!existsSync(tempModules)) symlinkSync(path.join(root, "node_modules"), tempModules, "dir");
const output = path.join(tempDir, "core-additions-new-contracts.mjs");
const sourceFiles = [
  "packages/core-schemas/src/index.ts",
  "packages/action-catalog/src/index.ts",
  "packages/capability-registry/src/index.ts",
  "packages/artifacts/src/index.ts",
  "packages/workspace-store/src/workspace-store.ts",
  "packages/runtime/src/agent-runtime.ts",
  "packages/ui-protocol/src/index.ts",
  "scripts/fixtures/artifact-revisions.ts",
  "scripts/fixtures/artifact-pdf-export.ts",
  "scripts/fixtures/backend-delegated-capabilities.ts",
  "scripts/fixtures/browser-capability-boundary.ts",
  "scripts/fixtures/image-artifact.ts",
  "scripts/fixtures/graph-artifact.ts",
  "scripts/fixtures/management-surfaces-core.ts",
  "scripts/lib/verifier-assertions.mjs"
];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/core-additions-new.ts"), "--bundle", "--platform=node", "--format=esm", "--external:better-sqlite3", `--outfile=${output}`, "--log-level=warning"], { cwd: root, stdio: "inherit" });
  const lines = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim().split(/\n/).map((line) => JSON.parse(line));
  const [backend, artifact, pdf, browser, image, graph, management] = lines;
  const evidenceDir = path.join(root, "reports/core-additional-scope/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const sourceSha256 = createHash("sha256").update(sourceFiles.map((file) => `${file}\0${readFileSync(path.join(root, file))}`).join("\0")).digest("hex");
  const head = readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();
  const commitSha = head.startsWith("ref: ") ? readFileSync(path.join(root, ".git", head.slice(5)), "utf8").trim() : head;
  const failures = [];
  const writeEvidence = (id, assertions, result) => {
    const assertionFailures = evaluateVerifierAssertions(assertions, result);
    failures.push(...assertionFailures.map((failure) => `${id}: ${failure}`));
    writeFileSync(path.join(evidenceDir, `${id}.json`), `${JSON.stringify({ schema_version: 1, test_id: id, status: verifierEvidenceStatus(result, assertionFailures), command: "node scripts/verify-core-additions-new-contracts.mjs", commit_sha: commitSha, source_sha256: sourceSha256, source_files: sourceFiles, assertions, ...(assertionFailures.length ? { failures: assertionFailures } : {}), result }, null, 2)}\n`);
  };
  writeEvidence("X01", [
    { name: "Codex search mode and sources normalize", actual: backend.codex_search_mode_and_sources, expected: true }
  ], backend);
  writeEvidence("X02", [
    { name: "Claude non-interactive search tools are probed", actual: backend.claude_noninteractive_tools, expected: true }
  ], backend);
  writeEvidence("X03", [
    { name: "Subagent event retains parent relation", actual: backend.subagent_parent_relation, expected: true }
  ], backend);
  writeEvidence("X04", [
    { name: "Real screenshot bytes require adapter", actual: browser.real_screenshot_bytes, expected: true },
    { name: "Browser interaction uses adapter", actual: browser.interact, expected: true },
    { name: "HTML snapshot stays distinct", actual: browser.html_snapshot_distinct, expected: true },
    { name: "Missing adapter is explicit", actual: browser.unavailable_explicit, expected: true }
  ], browser);
  writeEvidence("X05", [
    { name: "Unavailable command cannot be promoted", actual: backend.unavailable_not_promoted, expected: true },
    { name: "Authentication and version reasons stay distinct", actual: backend.reason_codes_distinct, expected: true }
  ], backend);
  writeEvidence("D06", [
    { name: "Surface and chat edits share revision lineage", actual: artifact.revisions, expected: 3 },
    { name: "Stale base revision is rejected", actual: artifact.conflict_rejected, expected: true },
    { name: "Revision restore creates new revision", actual: artifact.restored_revision, expected: true }
  ], artifact);
  writeEvidence("D03", [
    { name: "PDF bytes are valid", actual: pdf.valid_pdf_header, expected: true },
    { name: "Source Artifact is traced", actual: pdf.source_artifact_traced, expected: true },
    { name: "Source revision is traced", actual: pdf.source_revision_traced, expected: true }
  ], pdf);
  writeEvidence("D07", [
    { name: "Image generation creates revision", actual: image.generated_revision, expected: true },
    { name: "Image generation stores provenance", actual: image.provenance, expected: true },
    { name: "Missing provider is rejected", actual: image.missing_provider_rejected, expected: true }
  ], image);
  writeEvidence("D08", [
    { name: "Image edit creates child revision", actual: image.edited_revision, expected: true },
    { name: "Image revision restores", actual: image.restored_revision, expected: true }
  ], image);
  writeEvidence("D09", [
    { name: "Graph creates and edits", actual: graph.graph_created && graph.graph_edited, expected: true },
    { name: "Dangling edge is rejected", actual: graph.invalid_reference_rejected, expected: true },
    { name: "Graph reload and restore work", actual: graph.reload_equal && graph.restore_revision, expected: true }
  ], graph);
  writeEvidence("E02", [{ name: "Wiki is readable and editable", actual: management.wiki_read_edit_graph, expected: true }], management);
  writeEvidence("E03", [{ name: "Wiki lint detects broken, duplicate, and orphan pages", actual: management.wiki_lint_broken_duplicate_orphan, expected: true }], management);
  writeEvidence("E04", [{ name: "Wiki graph and backlinks are rebuilt", actual: management.wiki_backlinks, expected: true }], management);
  writeEvidence("E05", [{ name: "Skill edits and lifecycle leave history", actual: management.skill_edit_disable_history, expected: true }], management);
  writeEvidence("E06", [{ name: "Automation pauses, resumes, and keeps run history", actual: management.automation_pause_resume_history, expected: true }], management);
  writeEvidence("E10", [{ name: "Management resource context returns to main Chat", actual: management.main_chat_context_contract, expected: true }], management);
  writeEvidence("G01", [{ name: "Surface and agent paths use Domain Commands", actual: management.shared_domain_commands, expected: true }], management);
  reportVerifierFailures("core-additions-new-contracts", failures);
  process.stdout.write(`${JSON.stringify({ status: failures.length ? "failed" : "passed", evidence: ["X01", "X02", "X03", "X04", "X05", "D03", "D06", "D07", "D08", "D09", "E02", "E03", "E04", "E05", "E06", "E10", "G01"] })}\n`);
} finally {
  rmSync(output, { force: true });
}
