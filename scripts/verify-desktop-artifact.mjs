#!/usr/bin/env node

import { builtinModules } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const artifactDefinitions = [
  { id: "main", relativePath: "apps/desktop/dist/main.js" },
  { id: "preload", relativePath: "apps/desktop/dist/preload.cjs" }
];
const nodeBuiltinNames = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

if (isEntrypoint()) {
  const options = parseArgs(process.argv.slice(2));
  const verification = verifyDesktopArtifacts(options.root);
  printVerification(verification, options.json);
  process.exitCode = verification.ok ? 0 : 1;
}

/**
 * Read and verify the runtime references in the Desktop entry artifacts and
 * every relative JavaScript chunk reachable from those entries.
 *
 * The verifier intentionally reads only JavaScript artifacts. It does not
 * inspect adjacent source maps, because source map `sourcesContent` is
 * debugging data and is not executed by Electron.
 */
export function verifyDesktopArtifacts(root = defaultRoot) {
  const absoluteRoot = canonicalPath(path.resolve(root));
  const records = new Map();
  const visiting = new Set();
  const cycleEdges = new Set();
  let nextChunkId = 1;

  function visit(filePath, entryId, entry = false) {
    const absolutePath = canonicalPath(filePath);
    const displayPath = displayArtifactPath(absolutePath, absoluteRoot);

    if (!isPathInsideRoot(absolutePath, absoluteRoot)) {
      return createFailureArtifact({
        id: entryId,
        path: displayPath,
        absolutePath,
        entry,
        code: "artifact_outside_root",
        message: `Desktop artifact is outside the repository root: ${displayPath}`
      });
    }

    if (visiting.has(absolutePath)) return records.get(absolutePath);
    const existing = records.get(absolutePath);
    if (existing) {
      existing.entry ||= entry;
      return existing;
    }

    const id = entry ? entryId : `chunk-${nextChunkId++}`;
    const record = inspectArtifact({ id, path: displayPath, absolutePath, entry, root: absoluteRoot });
    records.set(absolutePath, record);
    if (!record.ok) return record;

    visiting.add(absolutePath);
    for (const reference of record.references) {
      const resolution = resolveRelativeJavaScriptReference(reference.specifier, absolutePath, absoluteRoot);
      if (resolution.kind === "skip") continue;
      if (resolution.kind === "error") {
        addViolation(record, {
          ...resolution.violation,
          kind: reference.kind,
          specifier: reference.specifier,
          line: reference.line,
          column: reference.column
        });
        continue;
      }

      reference.resolved_path = displayArtifactPath(resolution.path, absoluteRoot);
      if (visiting.has(resolution.path)) {
        const edgeKey = `${absolutePath}\0${resolution.path}`;
        if (!cycleEdges.has(edgeKey)) {
          cycleEdges.add(edgeKey);
          addViolation(record, {
            code: "relative_chunk_cycle",
            message: `Relative JavaScript chunk cycle detected: ${displayPath} -> ${reference.resolved_path}`,
            kind: reference.kind,
            specifier: reference.specifier,
            line: reference.line,
            column: reference.column,
            target: reference.resolved_path
          });
        }
        continue;
      }
      visit(resolution.path, entryId);
    }
    visiting.delete(absolutePath);
    refreshArtifactMessage(record);
    return record;
  }

  const entryArtifacts = artifactDefinitions.map(({ id, relativePath }) => {
    const record = visit(path.resolve(absoluteRoot, relativePath), id, true);
    record.path = relativePath;
    record.entry = true;
    refreshArtifactMessage(record);
    return record;
  });
  const entryPaths = new Set(entryArtifacts.map((artifact) => artifact.absolutePath));
  const chunkArtifacts = [...records.values()].filter((artifact) => !entryPaths.has(artifact.absolutePath));
  const allArtifacts = [...entryArtifacts, ...chunkArtifacts];
  const publicArtifacts = allArtifacts.map(publicArtifact);
  const publicChunks = chunkArtifacts.map(publicArtifact);
  const violations = publicArtifacts.flatMap((artifact) => artifact.violations.map((violation) => ({ artifact: artifact.path, ...violation })));
  const missing = publicArtifacts.filter((artifact) => artifact.code === "artifact_missing").map((artifact) => artifact.path);
  const unreadable = publicArtifacts.filter((artifact) => artifact.code === "artifact_unreadable").map((artifact) => artifact.path);
  const parseErrors = publicArtifacts.filter((artifact) => artifact.code === "artifact_parse_error").map((artifact) => artifact.path);
  const ok = allArtifacts.every((artifact) => artifact.ok);

  return {
    status: ok ? "passed" : "failed",
    ok,
    root: absoluteRoot,
    artifacts: publicArtifacts,
    chunks: publicChunks,
    references_checked: allArtifacts.reduce((sum, artifact) => sum + artifact.references.length, 0),
    violations,
    missing,
    unreadable,
    parse_errors: parseErrors
  };
}

/**
 * Parse JavaScript syntax and return only actual runtime import/require
 * declarations and calls. Text in comments, strings, or source maps is not
 * treated as a module reference.
 */
export function analyzeDesktopArtifact(source, artifactPath, root = defaultRoot) {
  const sourceFile = ts.createSourceFile(artifactPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = [];

  function addReference(kind, node, moduleNode) {
    if (!moduleNode || !ts.isStringLiteralLike(moduleNode)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(moduleNode.getStart(sourceFile));
    const specifier = moduleNode.text;
    references.push({
      kind,
      specifier,
      line: position.line + 1,
      column: position.character + 1,
      ...classifyReference(specifier, artifactPath, root)
    });
  }

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      addReference("import", node, node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      addReference("export", node, node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addReference("import-equals", node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addReference("dynamic-import", node, node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addReference("require", node, node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  const parseDiagnostics = [...sourceFile.parseDiagnostics];
  const parseError = parseDiagnostics.length > 0
    ? parseDiagnostics.map((diagnostic) => formatDiagnostic(diagnostic, sourceFile)).join("; ")
    : undefined;
  const violations = parseError
    ? [{ code: "artifact_parse_error", message: parseError }]
    : references.flatMap((reference) => reference.violations.map((violation) => ({ ...violation, kind: reference.kind, specifier: reference.specifier, line: reference.line, column: reference.column })));

  return { references, violations, parseError };
}

function inspectArtifact({ id, path: displayPath, absolutePath, entry, root }) {
  if (!isFile(absolutePath)) {
    return createFailureArtifact({
      id,
      path: displayPath,
      absolutePath,
      entry,
      code: "artifact_missing",
      message: `Desktop artifact is missing: ${displayPath}`
    });
  }

  let source;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (error) {
    return createFailureArtifact({
      id,
      path: displayPath,
      absolutePath,
      entry,
      code: "artifact_unreadable",
      message: `Desktop artifact could not be read: ${displayPath} (${errorMessage(error)})`
    });
  }

  const analysis = analyzeDesktopArtifact(source, absolutePath, root);
  const record = {
    id,
    path: displayPath,
    absolutePath,
    entry,
    ok: analysis.violations.length === 0,
    code: analysis.parseError ? "artifact_parse_error" : undefined,
    message: analysis.parseError
      ? `Desktop artifact has a JavaScript parse error: ${displayPath}`
      : analysis.violations.length === 0
        ? `${analysis.references.length} runtime import/require references checked`
        : `${analysis.violations.length} forbidden runtime reference(s) found`,
    references: analysis.references,
    violations: analysis.violations,
    parseError: analysis.parseError
  };
  return record;
}

function createFailureArtifact({ id, path: displayPath, absolutePath, entry, code, message }) {
  return {
    id,
    path: displayPath,
    absolutePath,
    entry,
    ok: false,
    code,
    message,
    references: [],
    violations: [{ code, message }]
  };
}

function addViolation(record, violation) {
  record.ok = false;
  record.violations.push(violation);
  refreshArtifactMessage(record);
}

function refreshArtifactMessage(record) {
  if (record.code === "artifact_missing") {
    record.message = `Desktop artifact is missing: ${record.path}`;
  } else if (record.code === "artifact_unreadable") {
    // The detailed read error is set when the artifact is inspected.
  } else if (record.code === "artifact_parse_error") {
    record.message = `Desktop artifact has a JavaScript parse error: ${record.path}`;
  } else if (record.violations.length === 0) {
    record.message = `${record.references.length} runtime import/require references checked`;
  } else {
    record.message = `${record.violations.length} forbidden runtime reference(s) found`;
  }
}

function publicArtifact(record) {
  const { absolutePath: _absolutePath, ...publicRecord } = record;
  return publicRecord;
}

function resolveRelativeJavaScriptReference(specifier, importerPath, root) {
  const normalizedSpecifier = stripSpecifierQuery(specifier).replaceAll("\\", "/");
  if (!normalizedSpecifier.startsWith(".")) return { kind: "skip" };
  if (!isJavaScriptModuleSpecifier(normalizedSpecifier)) return { kind: "skip" };

  const requestedPath = path.resolve(path.dirname(importerPath), normalizedSpecifier);
  const requestedCanonicalPath = canonicalPath(requestedPath);
  if (!isPathInsideRoot(requestedCanonicalPath, root)) {
    return {
      kind: "error",
      violation: {
        code: "relative_reference_outside_root",
        message: `Relative JavaScript reference escapes the repository root: ${specifier}`,
        target: displayArtifactPath(requestedCanonicalPath, root)
      }
    };
  }

  const candidatePaths = expandJavaScriptCandidates(requestedPath);
  const resolvedPath = candidatePaths.find(isFile);
  if (!resolvedPath) {
    return {
      kind: "error",
      violation: {
        code: "unresolved_relative_chunk",
        message: `Relative JavaScript chunk could not be resolved: ${specifier}`,
        target: displayArtifactPath(requestedPath, root)
      }
    };
  }

  const canonicalResolvedPath = canonicalPath(resolvedPath);
  if (!isPathInsideRoot(canonicalResolvedPath, root)) {
    return {
      kind: "error",
      violation: {
        code: "relative_reference_outside_root",
        message: `Relative JavaScript reference resolves outside the repository root: ${specifier}`,
        target: displayArtifactPath(canonicalResolvedPath, root)
      }
    };
  }
  return { kind: "follow", path: canonicalResolvedPath };
}

function expandJavaScriptCandidates(requestedPath) {
  if (path.extname(requestedPath)) return [requestedPath];
  return [
    requestedPath,
    `${requestedPath}.js`,
    `${requestedPath}.mjs`,
    `${requestedPath}.cjs`,
    path.join(requestedPath, "index.js"),
    path.join(requestedPath, "index.mjs"),
    path.join(requestedPath, "index.cjs")
  ];
}

function isJavaScriptModuleSpecifier(specifier) {
  const extension = path.extname(specifier).toLowerCase();
  return extension === "" || [".js", ".mjs", ".cjs", ".jsx", ".mjsx"].includes(extension);
}

function classifyReference(specifier, artifactPath, root) {
  const violations = [];
  const normalizedSpecifier = stripSpecifierQuery(specifier);

  if (hasTypeScriptExtension(normalizedSpecifier)) {
    violations.push({ code: "typescript_runtime_reference", message: `TypeScript runtime reference is not allowed: ${specifier}` });
  }

  if (isWorkspaceSourcePath(specifier, artifactPath, root)) {
    violations.push({ code: "workspace_source_reference", message: `Workspace source path is not allowed in a Desktop artifact: ${specifier}` });
  }

  if (isWorkspacePackageSpecifier(specifier)) {
    violations.push({ code: "workspace_bare_import", message: `Workspace package must be bundled into the Desktop artifact: ${specifier}` });
  } else if (isExternalSpecifier(specifier) && !isAllowedExternal(specifier)) {
    violations.push({ code: "non_allowlisted_external_reference", message: `Non-bundled external reference is not allowed: ${specifier}` });
  }

  return {
    external: isExternalSpecifier(specifier),
    allowed_external: isAllowedExternal(specifier),
    violations
  };
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
}

function parseArgs(args) {
  const options = { json: false, root: defaultRoot };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--root") {
      options.root = path.resolve(args[++index] ?? defaultRoot);
    } else if (arg.startsWith("--root=")) {
      options.root = path.resolve(arg.slice("--root=".length));
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/verify-desktop-artifact.mjs [--json] [--root <repository-root>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printVerification(verification, json) {
  if (json) {
    console.log(JSON.stringify(verification, null, 2));
    return;
  }

  console.log(`desktop-artifact: ${verification.status}`);
  for (const artifact of verification.artifacts) {
    console.log(`${artifact.ok ? "ok" : "fail"} ${artifact.path}: ${artifact.message}`);
    for (const violation of artifact.violations) {
      const location = violation.line ? `:${violation.line}:${violation.column}` : "";
      console.log(`  ${violation.code}${location}: ${violation.message}`);
    }
  }
}

function isAllowedExternal(specifier) {
  return specifier === "electron" || nodeBuiltinNames.has(specifier);
}

function isWorkspacePackageSpecifier(specifier) {
  return specifier === "@samurai-agent" || specifier.startsWith("@samurai-agent/");
}

function isExternalSpecifier(specifier) {
  return isBareModuleSpecifier(specifier) || specifier.startsWith("node:");
}

function isBareModuleSpecifier(specifier) {
  return !specifier.startsWith(".")
    && !specifier.startsWith("/")
    && !specifier.startsWith("#")
    && !specifier.startsWith("file:")
    && !specifier.startsWith("data:")
    && !specifier.startsWith("node:");
}

function isWorkspaceSourcePath(specifier, artifactPath, root) {
  const candidates = [specifier.replaceAll("\\", "/")];
  const resolvedPath = resolveLocalSpecifier(specifier, artifactPath);
  if (resolvedPath) candidates.push(resolvedPath.replaceAll("\\", "/"));

  const relativeWorkspaceSourcePattern = /(?:^|\/)(?:apps|packages|workers|scripts)\/[^/]+\/src(?:\/|$)/;
  const rootPath = path.resolve(root).replaceAll("\\", "/");
  return candidates.some((candidate) => {
    const normalized = candidate.replace(/^file:\/\//, "");
    return relativeWorkspaceSourcePattern.test(normalized)
      || isUnderWorkspaceSourceRoot(normalized, rootPath, "apps")
      || isUnderWorkspaceSourceRoot(normalized, rootPath, "packages")
      || isUnderWorkspaceSourceRoot(normalized, rootPath, "workers")
      || isUnderWorkspaceSourceRoot(normalized, rootPath, "scripts");
  });
}

function isUnderWorkspaceSourceRoot(candidate, rootPath, workspaceRoot) {
  const prefix = `${rootPath}/${workspaceRoot}/`;
  if (!candidate.startsWith(prefix)) return false;
  const remainder = candidate.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0) return false;
  const packageRelativePath = remainder.slice(separator + 1);
  return packageRelativePath === "src" || packageRelativePath.startsWith("src/");
}

function resolveLocalSpecifier(specifier, artifactPath) {
  try {
    if (specifier.startsWith("file:")) return fileURLToPath(new URL(specifier));
    if (specifier.startsWith(".")) return path.resolve(path.dirname(artifactPath), specifier);
    if (path.isAbsolute(specifier)) return path.normalize(specifier);
  } catch {
    return undefined;
  }
  return undefined;
}

function hasTypeScriptExtension(specifier) {
  return /\.tsx?$/i.test(specifier);
}

function stripSpecifierQuery(specifier) {
  return specifier.replace(/[?#].*$/, "");
}

function canonicalPath(filePath) {
  const absolutePath = path.resolve(filePath);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

function isPathInsideRoot(candidatePath, root) {
  const relative = path.relative(root, candidatePath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function displayArtifactPath(filePath, root) {
  const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
  return relative || ".";
}

function isFile(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function formatDiagnostic(diagnostic, sourceFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
  if (diagnostic.start === undefined) return message;
  const position = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return `${message} at ${position.line + 1}:${position.character + 1}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
