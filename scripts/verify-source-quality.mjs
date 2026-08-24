import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const tracked = execFileSync("git", ["ls-files", "-z", "apps", "packages", "scripts", ".github", "package.json", "tsconfig.json"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "apps", "packages", "scripts", ".github", "package.json", "tsconfig.json"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean);
const textExtensions = /\.(?:cjs|cts|js|json|mjs|mts|py|ts|tsx|vue|yml|yaml)$/;
const files = [...new Set([...tracked, ...untracked])].filter((file) => textExtensions.test(file) && existsSync(path.join(root, file)));
const issues = [];
let formatChecked = 0;
let lintChecked = 0;

for (const file of files) {
  const source = readFileSync(path.join(root, file), "utf8");
  formatChecked += 1;
  if (source.includes("\r\n")) issues.push({ rule: "no-crlf", file });
  if (/[^\S\r\n]+$/m.test(source)) issues.push({ rule: "no-trailing-whitespace", file });
  if (source.length > 0 && !source.endsWith("\n")) issues.push({ rule: "final-newline", file });
  if (/^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m.test(source)) issues.push({ rule: "no-conflict-marker", file });

  if (/\.(?:ts|tsx|vue)$/.test(file)) {
    lintChecked += 1;
    if (/expect\s*\(\s*true\s*\)/.test(source)) issues.push({ rule: "no-noop-assertion", file });
    if (/(?:describe|it|test)\.(?:skip|only)\s*\(/.test(source)) issues.push({ rule: "no-skip-or-only-test", file });
  }
}

const result = {
  status: issues.length === 0 ? "passed" : "failed",
  format_checked: formatChecked,
  lint_checked: lintChecked,
  issues
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (issues.length > 0) process.exitCode = 1;
