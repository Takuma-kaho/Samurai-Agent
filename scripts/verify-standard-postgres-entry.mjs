import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const entry = path.join(root, "apps/server/src/index.ts");
const source = existsSync(entry) ? readFileSync(entry, "utf8") : "";
const issues = [];
if (!source.includes("startStandardServer")) issues.push({ code: "standard_entry_missing" });
if (!source.includes('import("@samurai-agent/workspace-server")')) issues.push({ code: "postgres_composition_import_missing" });
if (!source.includes("startWorkspaceServer")) issues.push({ code: "postgres_server_start_missing" });
if (source.includes("startLegacyServer")) issues.push({ code: "unexpected_compatibility_entry" });
const result = {
  status: issues.length === 0 ? "passed" : "failed",
  entry: path.relative(root, entry),
  standard_composition_root: "@samurai-agent/workspace-server",
  issues
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (issues.length > 0) process.exitCode = 1;
