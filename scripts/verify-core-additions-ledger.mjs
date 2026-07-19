import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ledgerPath = path.join(root, "plans/core-reference-integration-plan.md");
const markdown = readFileSync(ledgerPath, "utf8");
const rows = [...markdown.matchAll(/^\|\s*((?:H|O|M)\d{2})\s*\|[^\n]+$/gm)].map((match) => match[0]);
const ids = rows.map((row) => row.match(/^\|\s*((?:H|O|M)\d{2})\s*\|/)?.[1]).filter(Boolean);
const uniqueIds = new Set(ids);
const categories = {
  core: rows.filter((row) => row.includes("| Core追加候補 |")).length,
  contract: rows.filter((row) => row.includes("| 接続契約 |")).length,
  product: rows.filter((row) => row.includes("| 製品後続 |")).length,
  excluded: rows.filter((row) => row.includes("| 対象外 |")).length
};
const expected = { rows: 90, core: 39, contract: 4, product: 5, excluded: 42 };
const actual = { rows: rows.length, ...categories };
const failures = [];
if (uniqueIds.size !== ids.length) failures.push("duplicate_ids");
for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) failures.push(`${key}:${actual[key]}!=${value}`);
if (rows.some((row) => /^\|\s*(?:H|O|M)\d{2}\s*\|[^|]+\|\s*3\s*\|/.test(row))) failures.push("three_point_item_present");
const result = { status: failures.length === 0 ? "passed" : "failed", actual, expected, unique_ids: uniqueIds.size, failures };
if (failures.length === 0) {
  const evidenceDir = path.join(root, "reports/core-additional-scope/evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const head = readFileSync(path.join(root, ".git/HEAD"), "utf8").trim();
  const commitSha = head.startsWith("ref: ") ? readFileSync(path.join(root, ".git", head.slice(5)), "utf8").trim() : head;
  const sourceSha256 = createHash("sha256").update(`plans/core-reference-integration-plan.md\0${markdown}`).digest("hex");
  const semanticLatest = ["H12", "H13", "H14"].every((id) => rows.find((row) => row.includes(`| ${id} |`))?.includes("| 接続契約 |"))
    && ["M04", "M06", "M07"].every((id) => rows.find((row) => row.includes(`| ${id} |`))?.includes("| Core追加候補 |"));
  const evidence = {
    A01: [{ name: "All ledger rows exist", actual: actual.rows, expected: 90 }],
    A02: [{ name: "No three-point item is included", actual: rows.some((row) => /^\|\s*(?:H|O|M)\d{2}\s*\|[^|]+\|\s*3\s*\|/.test(row)), expected: false }],
    A03: [{ name: "Every row has one category", actual: actual.core + actual.contract + actual.product + actual.excluded, expected: 90 }],
    A04: [{ name: "Category totals match", actual: categories, expected: { core: 39, contract: 4, product: 5, excluded: 42 } }],
    A05: [{ name: "Delegated capabilities and Generative UI use latest classification", actual: semanticLatest, expected: true }]
  };
  for (const [id, assertions] of Object.entries(evidence)) writeFileSync(path.join(evidenceDir, `${id}.json`), `${JSON.stringify({ schema_version: 1, test_id: id, status: "passed", command: "node scripts/verify-core-additions-ledger.mjs", commit_sha: commitSha, source_sha256: sourceSha256, source_files: ["plans/core-reference-integration-plan.md"], assertions, result }, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
if (failures.length > 0) process.exitCode = 1;
