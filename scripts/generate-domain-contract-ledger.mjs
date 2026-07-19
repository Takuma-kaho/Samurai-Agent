import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  collectionManageCompatibilityEntry,
  domainCommandEntries,
  domainLegacyCommandEntries,
  domainQueryEntries
} from "../packages/action-catalog/src/index.ts";
import { assertContractVersionDiscipline } from "./lib/domain-contract-version.mjs";

const requiredFields = [
  "kind",
  "id",
  "contract_version",
  "contract_fingerprint",
  "input_schema",
  "output_schema",
  "allowed_sources",
  "effect_kind",
  "idempotency_policy",
  "concurrency_policy",
  "availability",
  "runtime_requirements",
  "implementation_target",
  "render_kinds",
  "provenance",
  "oss_reference"
];

const ossReferences = [
  {
    source: "mulmoclaude",
    commit_sha: "14ba3afe41f682794c4412c3e12fcab34e610778",
    reference_file: "docs/plugin-runtime.md",
    decision: "adapted",
    reason: "Adopt schema and handler proximity plus registration collision checks as a local contract pattern; do not copy the host implementation."
  },
  {
    source: "hermes",
    commit_sha: "9df5f879b4a5925c0f8f947e7e16ed8e845932c3",
    reference_file: "tools/registry.py",
    decision: "adapted",
    reason: "Use registration and error-wrapping ideas while keeping Samurai handlers and ports independent."
  },
  {
    source: "openclaw",
    commit_sha: "855659a1dd0542f6fc76dcc8343335e983f9189c",
    reference_file: "packages/gateway-protocol/src/schema.ts",
    decision: "adapted",
    reason: "Adopt server-derived session context, effective inventories, shared execution paths, and idempotency-key boundaries."
  }
];
const project = (entry) => ({
  ...Object.fromEntries(requiredFields.filter((field) => field !== "oss_reference").map((field) => [field, entry[field]])),
  oss_reference: ossReferences
});
const stableJson = (value) => JSON.stringify(value, (_key, item) => {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  }
  return item;
});

const commands = domainCommandEntries.map(project);
const queries = domainQueryEntries.map(project);
const legacyCommands = domainLegacyCommandEntries.map((entry) => ({ ...project(entry), replacement: entry.replacement }));
const ledger = {
  schema_version: 1,
  contract_version: "1.0",
  source_of_truth: "packages/domain-operations/src/operations",
  required_fields: requiredFields,
  counts: {
    commands: commands.length,
    queries: queries.length,
    deprecated_commands: legacyCommands.length
  },
  compatibility_adapters: [{
    id: "collection.manage",
    kind: "provider_tool_compatibility",
    input_schema: collectionManageCompatibilityEntry.input_schema,
    routes: {
      schemaDocs: "collection.schema.docs",
      getSchema: "collection.schema.get",
      patchSchema: ["collection.schema.get", "collection.schema.save"],
      getItems: "collection.records.list",
      putSchema: "collection.schema.save",
      putItems: ["collection.record.create", "collection.patch.apply"]
    }
  }],
  provenance_policy: {
    oss_reference_required: true,
    unresolved_reference_policy: "fail generation when a reference is missing or its commit SHA is not pinned"
  },
  commands,
  queries,
  legacy_commands: legacyCommands
};
ledger.catalog_hash = createHash("sha256").update(stableJson(ledger)).digest("hex");
const output = JSON.stringify(ledger, null, 2) + "\n";
const outputPath = process.env.SAMURAI_DOMAIN_LEDGER_OUTPUT
  ? path.resolve(process.env.SAMURAI_DOMAIN_LEDGER_OUTPUT)
  : path.resolve(process.cwd(), "plans/domain-command-contract-ledger.json");
try {
  const previous = JSON.parse(await readFile(outputPath, "utf8"));
  assertContractVersionDiscipline(
    [...(previous.commands ?? []), ...(previous.queries ?? [])],
    [...commands, ...queries]
  );
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, output, "utf8");
console.log(`generated ${path.relative(process.cwd(), outputPath)} (${commands.length} commands, ${queries.length} queries, ${legacyCommands.length} deprecated)`);
