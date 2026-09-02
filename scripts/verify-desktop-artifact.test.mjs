import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyDesktopArtifacts } from "./verify-desktop-artifact.mjs";

test("follows relative JavaScript chunks and ignores source-map-like text", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, "apps/desktop/dist/main.js", [
      "// import './missing-from-comment.js'",
      `const sourceMapText = ${JSON.stringify('import "./missing-from-source-map.js"')};`,
      'import "./chunks/a.js";',
      'import("./chunks/b.js");'
    ].join("\n"));
    writeFixture(root, "apps/desktop/dist/preload.cjs", 'require("electron");');
    writeFixture(root, "apps/desktop/dist/chunks/a.js", 'export * from "./shared.js";');
    writeFixture(root, "apps/desktop/dist/chunks/b.js", 'require("./shared.js");');
    writeFixture(root, "apps/desktop/dist/chunks/shared.js", 'import "node:fs";');

    const result = verifyDesktopArtifacts(root);
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.deepEqual(result.chunks.map(({ path: artifactPath }) => artifactPath).sort(), [
      "apps/desktop/dist/chunks/a.js",
      "apps/desktop/dist/chunks/b.js",
      "apps/desktop/dist/chunks/shared.js"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly for an unresolved relative chunk", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, "apps/desktop/dist/main.js", 'import "./chunks/missing.js";');
    writeFixture(root, "apps/desktop/dist/preload.cjs", 'require("electron");');

    const result = verifyDesktopArtifacts(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(({ code }) => code === "unresolved_relative_chunk"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly for cycles and root-escaping relative chunks", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, "apps/desktop/dist/main.js", [
      'import "./chunks/a.js";',
      'import "../../../../outside.js";'
    ].join("\n"));
    writeFixture(root, "apps/desktop/dist/preload.cjs", 'require("electron");');
    writeFixture(root, "apps/desktop/dist/chunks/a.js", 'import "./b.js";');
    writeFixture(root, "apps/desktop/dist/chunks/b.js", 'import "./a.js";');

    const result = verifyDesktopArtifacts(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.some(({ code }) => code === "relative_chunk_cycle"));
    assert.ok(result.violations.some(({ code }) => code === "relative_reference_outside_root"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  return mkdtempSync(path.join(tmpdir(), "samurai-desktop-artifact-"));
}

function writeFixture(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${contents}\n`, "utf8");
}
