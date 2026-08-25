import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const files = execFileSync("git", ["ls-files", "apps/server/src", "packages", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && existsSync(path.join(root, file)));
const issues = [];
for (const file of files) {
  const source = readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    if (["better-sqlite3", "kysely", "@samurai-agent/workspace-store"].includes(statement.moduleSpecifier.text)) {
      issues.push({ code: "postgres_runtime_legacy_storage_import", file, module: statement.moduleSpecifier.text });
    }
  }
}

const result = {
  status: issues.length === 0 ? "passed" : "failed",
  standard_storage: "postgresql",
  scanned_files: files.length,
  issues
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (issues.length > 0) process.exitCode = 1;
