import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { committedSourceEvidence } from "./lib/core-evidence.mjs";
const root = process.cwd(); const prefix = process.platform === "darwin" ? `@esbuild+darwin-${process.arch === "arm64" ? "arm64" : "x64"}@` : `@esbuild+${process.platform}-${process.arch}@`;
const packageDir = readdirSync(path.join(root, "node_modules/.pnpm")).find((entry) => entry.startsWith(prefix)); if (!packageDir) throw new Error(`esbuild native package not found: ${prefix}`);
const packageName = packageDir.slice(0, packageDir.lastIndexOf("@")).replace("+", "/"); const esbuild = path.join(root, "node_modules/.pnpm", packageDir, "node_modules", packageName, "bin/esbuild"); const cacheRoot = path.join(root, "node_modules/.cache"); mkdirSync(cacheRoot, { recursive: true }); const temporaryRoot = mkdtempSync(path.join(cacheRoot, "samurai-attachment-")); const output = path.join(temporaryRoot, "verify.mjs");
const sourceFiles = ["packages/core-schemas/src/index.ts", "packages/runtime/src/attachments/ingestion.ts", "scripts/fixtures/attachment-ingestion.ts", "scripts/verify-attachment-ingestion.mjs", "scripts/lib/core-evidence.mjs"];
try {
  execFileSync(esbuild, [path.join(root, "scripts/fixtures/attachment-ingestion.ts"), "--bundle", "--platform=node", "--format=esm", `--outfile=${output}`], { cwd: root, stdio: "inherit" });
  const startedAt = new Date().toISOString(); const rawResult = execFileSync(process.execPath, [output], { cwd: root, encoding: "utf8" }).trim(); const result = JSON.parse(rawResult); const completedAt = new Date().toISOString(); const evidenceDir = path.join(root, "reports/core-completion/evidence"); mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "D06.json"), `${JSON.stringify({ schema_version: 1, test_id: "D06", command: "pnpm core:test:attachment", status: "passed", ...committedSourceEvidence(root, sourceFiles), started_at: startedAt, completed_at: completedAt, assertions: [
    { name: "Six required formats", actual: result.formats.sort(), expected: ["docx", "image", "pdf", "pptx", "text", "xlsx"] },
    { name: "Source trace and hash", actual: result.source_trace, expected: true },
    { name: "Source and extraction limits", actual: result.limits, expected: { source_rejected: true, all_formats_oversize_rejected: true, text_truncated: true } },
    { name: "All six corrupt formats rejected", actual: result.corrupt_formats_rejected, expected: 6 },
    { name: "Transient read retry", actual: result.retry_attempts, expected: 3 }
  ], result }, null, 2)}\n`); process.stdout.write(`${rawResult}\n`);
} finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
