import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ids = [
  ...Array.from({ length: 5 }, (_, index) => `A${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `X${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `B${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `D${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `G${String(index + 1).padStart(2, "0")}`)
];
const evidenceDir = path.join(process.cwd(), "reports/core-additional-scope/evidence");
const items = ids.map((id) => {
  const file = path.join(evidenceDir, `${id}.json`);
  if (!existsSync(file)) return { id, score: 0, reason: "evidence_missing" };
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  const assertions = Array.isArray(evidence.assertions) ? evidence.assertions : [];
  const complete = evidence.status === "passed" && assertions.length > 0 && assertions.every((item) => JSON.stringify(item.actual) === JSON.stringify(item.expected));
  return { id, score: complete ? 2 : 0, reason: complete ? "passed" : "evidence_failed" };
});
const score = items.reduce((sum, item) => sum + item.score, 0);
const report = { status: score === 100 ? "passed" : "failed", score, maximum: 100, items };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (score !== 100) process.exitCode = 1;
