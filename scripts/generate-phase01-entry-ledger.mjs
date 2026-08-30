import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SAMURAI_REPO_ROOT
  ? path.resolve(process.env.SAMURAI_REPO_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "plans/phase-0-1-entry-ledger.json");
const sourceRoots = [
  "apps/server/src",
  "apps/web/src",
  "apps/desktop/src",
  "packages/runtime/src/external-app",
  "packages/external-integration/src"
];

const files = sourceRoots.flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot))
  .filter((file) => /\.(?:ts|tsx|js|mjs)$/.test(file)));
const sourceTexts = new Map();
const testFiles = ["apps", "packages", "scripts"].flatMap((relativeRoot) => filesUnder(path.join(root, relativeRoot)))
  .filter((file) => /(?:\.test\.(?:ts|tsx|js|mjs)$|verify[^/]*\.(?:mjs|js)$)/.test(file));
const rows = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  sourceTexts.set(relative, source);
  collectHttpRoutes(relative, source);
  collectBridgeEntrances(relative, source);
  collectMcpEntrances(relative, source);
  collectSocketEntrances(relative, source);
}

const uniqueRows = [...new Map(rows.map((row) => [row.id, row])).values()]
  .sort((left, right) => left.id.localeCompare(right.id));
const sourceHashes = Object.fromEntries(files
  .map((file) => [path.relative(root, file).replaceAll(path.sep, "/"), sha256(readFileSync(file, "utf8"))])
  .sort(([left], [right]) => left.localeCompare(right)));
const ledger = {
  schema_version: 1,
  purpose: "Phase 0 entry classification and Phase 1 migration gate",
  phase_scope: Array.from({ length: 11 }, (_value, index) => index),
  requirements: [
    ["P0-01", "要件台帳", "会話で確定したPhase 0〜1の要件・証拠・受け渡し条件"],
    ["P0-02", "全入口分類", "HTTP・Bridge・MCP・Socketの未分類0件"],
    ["P0-03", "互換移行表", "旧入口の理由と撤去条件"],
    ["P0-04", "完了Gate", "契約・入口・Schema・境界の自動検査"],
    ["P1-01", "共通契約", "API version、Context、Result、Error、EventのSchema"],
    ["P1-02", "Operation・Query", "共通実行入口と読み取り専用入口"],
    ["P1-03", "Activity Ingest", "証拠の保存、重複、Conflict、secret否定検査"],
    ["P1-04", "Run Control", "cancel・resume・sync・recover・retryの状態遷移"],
    ["P1-05", "公開Event", "DB履歴、HTTP replay、Socket通知、認可"],
    ["P1-06", "初期Slice", "Room・Agent・Chat・Artifact"],
    ["P1-07", "Client互換", "Browser・Desktop・外部Clientと旧APIの共通Handler"],
    ["P1-08", "公開仕様", "JSON Schema、Catalog、例、互換規則"],
    ["P1-09", "完了検証", "実PostgreSQL・実Client・最終CI"],
  ].map(([id, title, acceptance]) => ({ id, title, acceptance })),
  source_roots: sourceRoots,
  source_hashes: sourceHashes,
  entries: uniqueRows
};
const output = `${JSON.stringify(ledger, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(outputPath) || normalize(readFileSync(outputPath, "utf8")) !== normalize(output)) {
    throw new Error("phase01_entry_ledger_drift");
  }
  process.stdout.write(`verified ${uniqueRows.length} Phase 0-1 entries\n`);
} else {
  writeFileSync(outputPath, output);
  process.stdout.write(`generated ${uniqueRows.length} Phase 0-1 entries\n`);
}

function collectHttpRoutes(relative, source) {
  const routePattern = /\bapp\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
  for (const match of source.matchAll(routePattern)) {
    const method = match[1].toUpperCase();
    const route = match[3];
    const line = lineNumber(source, match.index ?? 0);
    const classification = classifyHttp(method, route);
    rows.push(entry({
      id: `http:${relative}:${line}:${method}:${route}`,
      entry_kind: "http_route",
      source: relative,
      line,
      method,
      path: route,
      ...classification,
      compatibility: route.startsWith("/api/workspaces/") && !route.startsWith("/api/v1/")
    }));
  }
}

function collectBridgeEntrances(relative, source) {
  const bridgePattern = /\bworkspaceRequest(?:<[^>]+>)?\(\s*(["'`])([A-Z]+)\1\s*,\s*(["'`])([^"'`]+)\3/g;
  for (const match of source.matchAll(bridgePattern)) {
    const method = match[2];
    const suffix = match[4];
    const line = lineNumber(source, match.index ?? 0);
    const classification = classifyHttp(method, suffix);
    rows.push(entry({
      id: `bridge:${relative}:${line}:${method}:${suffix}`,
      entry_kind: "client_bridge",
      source: relative,
      line,
      method,
      path: suffix,
      ...classification,
      compatibility: true
    }));
  }
}

function collectMcpEntrances(relative, source) {
  if (!relative.endsWith("packages/external-integration/src/mcp.ts")) return;
  const toolPattern = /["'](samurai\.[a-z0-9_.-]+)["']/g;
  const seen = new Set();
  for (const match of source.matchAll(toolPattern)) {
    const tool = match[1];
    if (seen.has(tool)) continue;
    seen.add(tool);
    rows.push(entry({
      id: `mcp:${relative}:${tool}`,
      entry_kind: "mcp_tool",
      source: relative,
      line: lineNumber(source, match.index ?? 0),
      method: "CALL",
      path: tool,
      classification: tool.includes("activity") ? "activity_ingest" : isMutationName(tool) ? "domain_operation" : "query",
      classification_reason: "MCP tool catalog declares a read, Domain Operation, or Activity Ingest capability.",
      compatibility: true,
      contract_id: tool
    }));
  }
}

function collectSocketEntrances(relative, source) {
  const socketPattern = /\b(?:socket|client)\.on\(\s*(["'])([^"']+)\1/g;
  for (const match of source.matchAll(socketPattern)) {
    const event = match[2];
    if (!event.startsWith("workspace")) continue;
    rows.push(entry({
      id: `socket:${relative}:${lineNumber(source, match.index ?? 0)}:${event}`,
      entry_kind: "socket_event",
      source: relative,
      line: lineNumber(source, match.index ?? 0),
      method: "EVENT",
      path: event,
      classification: "event_delivery",
      classification_reason: "Socket.IO is a delivery/reconnect boundary; state changes use HTTP Domain APIs.",
      compatibility: !event.includes(":v1:") && !event.includes("workspace:v1")
    }));
  }
}

function classifyHttp(method, route) {
  const normalized = route.toLowerCase();
  if (normalized.startsWith("/api/v1/") && normalized.includes("/domain/catalog")) {
    return { classification: "query", classification_reason: "v1 contract catalog read boundary.", contract_id: "domain.catalog" };
  }
  if (normalized.startsWith("/api/v1/") && normalized.includes("/domain/operations/")) {
    return { classification: "domain_operation", classification_reason: "Canonical v1 Domain Operation execution boundary.", contract_id: "domain.operation" };
  }
  if (normalized.startsWith("/api/v1/") && normalized.includes("/domain/queries/")) {
    return { classification: "query", classification_reason: "Canonical v1 Query execution boundary.", contract_id: "domain.query" };
  }
  if (normalized.startsWith("/api/v1/") && normalized.includes("/activities")) {
    return { classification: "activity_ingest", classification_reason: "Canonical v1 Activity evidence input.", contract_id: "activity.ingest" };
  }
  if (normalized.includes("/runs/") && (normalized.includes("/actions/") || /\/(cancel|resume|sync|recover|retry)(?:$|[/?])/.test(normalized))) {
    return { classification: "run_control", classification_reason: "Run lifecycle control is a separate contract.", contract_id: "run.control" };
  }
  if (normalized.includes("/events") || normalized.includes("/realtime") || normalized.endsWith("/socket.io")) {
    return { classification: "event_delivery", classification_reason: "Event history or realtime delivery boundary." };
  }
  if (/(?:\/mcp|oauth|auth|connection|invitation|pairing|callback)/.test(normalized)) {
    return { classification: "auth_connection", classification_reason: "Authentication, OAuth, Connection, or pairing boundary." };
  }
  if (/(?:transfer|bundle|backup|restore|import|export|migration)/.test(normalized)) {
    return { classification: "backup_restore", classification_reason: "Workspace transfer, import/export, backup, or restore boundary." };
  }
  if (normalized.includes("/maintenance") || normalized.includes("/worker") || normalized.includes("/jobs") || normalized.includes("/reindex") || normalized.includes("/repair")) {
    return { classification: "internal_management", classification_reason: "Operational or maintenance route; not a public Phase 1 Domain API." };
  }
  if (normalized.includes("/domain/queries") || method === "GET") {
    return { classification: "query", classification_reason: "Read-only HTTP entry; mutation is not inferred from the route count." };
  }
  if (normalized.includes("/domain/operations")) {
    return { classification: "domain_operation", classification_reason: "Canonical v1 Domain Operation entry." };
  }
  return { classification: "domain_operation", classification_reason: "Authenticated state-changing HTTP entry; detailed migration remains in the ledger." };
}

function entry(value) {
  const compatibility = value.compatibility === true;
  const migrationPhase = compatibility
    ? "phase_1.7_or_later"
    : value.path?.startsWith("/api/v1/") || value.path?.startsWith("workspace:v1")
      ? "phase_1"
      : "phase_2_or_later";
  const directPersistenceEvidence = directPersistence(value);
  return {
    ...value,
    contract_id: value.contract_id ?? null,
    requirement_ids: requirementIds(value),
    current_handler: `${value.source}:${value.line}`,
    persistence_responsibility: persistenceResponsibility(value),
    authorization_scope: value.path.includes("room") || value.path.includes("artifact") || value.path.includes("chat") ? "workspace+room" : "workspace",
    idempotency: value.method === "GET" || value.method === "EVENT" ? "not_applicable" : "required_or_legacy_defined",
    emitted_event: value.classification === "event_delivery" ? "delivery_only" : "ledger_required",
    migration_phase: migrationPhase,
    compatibility_exit_condition: compatibility
      ? "Native/外部Clientのv1移行、旧利用数の確認、同等動作テスト、削除Phaseの別承認"
      : null,
    related_tests: relatedTests(value),
    direct_persistence: directPersistenceEvidence.length > 0,
    direct_persistence_evidence: directPersistenceEvidence,
    out_of_scope_reason: migrationPhase === "phase_2_or_later"
      ? "Phase 1の初期Slice外。削除・移行は後続Phaseで台帳から再評価する。"
      : null
  };
}

function requirementIds(value) {
  const requirements = new Set(["P0-01", "P0-02", "P0-04"]);
  if (value.compatibility === true) requirements.add("P0-03");
  if (value.classification === "query" || value.classification === "domain_operation") requirements.add("P1-02");
  if (value.classification === "activity_ingest") requirements.add("P1-03");
  if (value.classification === "run_control") requirements.add("P1-04");
  if (value.classification === "event_delivery") requirements.add("P1-05");
  if (value.classification === "auth_connection") requirements.add("P1-01");
  if (value.entry_kind === "client_bridge" || value.entry_kind === "mcp_tool") requirements.add("P1-07");
  if (value.path?.startsWith("/api/v1/") || value.path?.startsWith("workspace:v1")) requirements.add("P1-08");
  if (/room|agent|chat|artifact/.test(value.path ?? "")) requirements.add("P1-06");
  requirements.add("P1-09");
  return [...requirements];
}

function persistenceResponsibility(value) {
  switch (value.classification) {
    case "query": return "read_only_projection";
    case "domain_operation": return "domain_application_handler";
    case "activity_ingest": return "activity_evidence_journal";
    case "run_control": return "runtime_run_state";
    case "event_delivery": return "event_journal_or_realtime_delivery";
    case "auth_connection": return "authentication_or_connection_state";
    case "backup_restore": return "workspace_transfer_state";
    case "internal_management": return "internal_operational_state";
    default: return "unclassified";
  }
}

function relatedTests(value) {
  const sourceBase = path.basename(value.source).replace(/\.(?:ts|tsx|js|mjs)$/, "").toLowerCase();
  const classification = value.classification.replaceAll("_", "-");
  return testFiles
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .filter((file) => {
      const candidate = file.toLowerCase();
      return candidate.includes(sourceBase) || candidate.includes(classification) || candidate.includes("domain") && /domain_operation|query/.test(value.classification);
    })
    .slice(0, 12);
}

function directPersistence(value) {
  // This check is intentionally limited to client/external entry files. Server
  // handlers are expected to own persistence; the Phase 0 violation is a
  // Browser/Desktop/MCP path bypassing that boundary.
  if (value.entry_kind !== "client_bridge" && value.entry_kind !== "mcp_tool") return [];
  const source = sourceTexts.get(value.source) ?? "";
  const matches = source.match(/\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|supabase|prisma|drizzle|workspace_(?:records|files|events))\b/gi) ?? [];
  return [...new Set(matches.map((match) => match.toLowerCase()))];
}

function isMutationName(value) {
  return /(?:create|update|patch|delete|remove|set|save|write|revise|restore|repair|send|dispatch|run|approve|deny|archive|copy|move|promote|cancel|resume|sync|recover|retry)/.test(value);
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
