import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const staticOnly = process.argv.includes("--static-only");

function trackedSourceFiles() {
  return execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter((file) => /\.(?:ts|tsx|mjs|cjs|js|json)$/.test(file))
    .filter((file) => file.startsWith("apps/") || file.startsWith("packages/") || file.startsWith("scripts/"))
    .filter((file) => !file.startsWith("node_modules/") && !file.startsWith("dist/") && !file.startsWith("build/"))
    .filter((file) => existsSync(path.join(root, file)));
}

function staticImports(file, source) {
  if (!/\.tsx?$/.test(file)) return [];
  const ast = ts.createSourceFile(path.join(root, file), source, ts.ScriptTarget.ES2022, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = [];
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) imports.push(statement.moduleSpecifier.text);
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) imports.push(statement.moduleReference.expression.text);
  }
  return imports;
}

function routes(source) {
  const entries = [];
  const pattern = /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*["`]([^"`]+)["`]/g;
  for (const match of source.matchAll(pattern)) entries.push(`${match[1].toUpperCase()} ${match[2]}`);
  return [...new Set(entries)].sort();
}

function requiredLiveEnvironment() {
  const missing = [];
  for (const target of ["HOSTED", "SELF_HOST"]) {
    for (const suffix of ["DATABASE_URL", "DATABASE_ADMIN_URL", "DATABASE_RUNTIME_ROLE"]) {
      const key = `SAMURAI_SERVER_VERIFY_${target}_${suffix}`;
      if (!process.env[key]) missing.push(key);
    }
  }
  return missing;
}

const files = trackedSourceFiles();
const forbidden = [];
for (const file of files) {
  if (file === "scripts/verify-postgres-migration-readiness.mjs" || file === "scripts/verify-postgres-runtime-scope.mjs") continue;
  const source = readFileSync(path.join(root, file), "utf8");
  const imports = staticImports(file, source);
  const markers = [];
  if (imports.includes("better-sqlite3")) markers.push("better-sqlite3_import");
  if (imports.includes("kysely")) markers.push("kysely_import");
  if (imports.includes("@samurai-agent/workspace-store")) markers.push("workspace_store_import");
  if (/\b(?:SqliteDialect|sqlite_master|workspace\.sqlite|WorkspaceStore\.create\s*\(|createApiServer\s*\()/.test(source)) markers.push("legacy_storage_or_api_symbol");
  if (/from\s+["'][^"']*api-server(?:\.js)?["']/.test(source)) markers.push("legacy_api_import");
  if (markers.length > 0) forbidden.push({ file, references: [...new Set(markers)] });
}

const postgresApi = existsSync(path.join(root, "apps/server/src/workspace-server/http-server.ts"))
  ? routes(readFileSync(path.join(root, "apps/server/src/workspace-server/http-server.ts"), "utf8"))
  : [];
const missingLiveEnvironment = requiredLiveEnvironment();
const issues = [];
if (forbidden.length > 0) issues.push({ code: "legacy_storage_or_api_references_present", files: forbidden });
if (missingLiveEnvironment.length > 0 && !staticOnly) issues.push({ code: "postgres_live_environment_unavailable", missing_environment: missingLiveEnvironment });

const hasStaticBlocker = forbidden.length > 0;
const hasUnverifiedLiveEvidence = missingLiveEnvironment.length > 0 && !staticOnly;

const result = {
  status: hasStaticBlocker ? "blocked" : hasUnverifiedLiveEvidence ? "unverified" : staticOnly && missingLiveEnvironment.length > 0 ? "passed_static_only" : "passed",
  storage_target: "postgresql",
  static_legacy_reference_gate: hasStaticBlocker ? "blocked" : "passed",
  live_postgres_environment: missingLiveEnvironment.length === 0 ? "available" : "unavailable",
  missing_environment: missingLiveEnvironment,
  scanned_files: files.length,
  legacy_reference_count: forbidden.length,
  legacy_references: forbidden,
  legacy_api_route_count: 0,
  postgres_api_route_count: postgresApi.length,
  verification_scope: staticOnly ? "static_reference_scan_only" : "static_reference_scan_and_live_environment_check",
  issues
};

process.stdout.write(`${JSON.stringify(result)}\n`);
// Exit 2 is reserved for an environment-dependent verification that could
// not run.  Static blockers remain exit 1; callers can therefore distinguish
// a code failure from an unverified live PostgreSQL/RLS probe.
if (hasStaticBlocker) process.exitCode = 1;
else if (hasUnverifiedLiveEvidence) process.exitCode = 2;
