import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActivityIngestRequestSchema,
  DomainApiCatalogSchema,
  DomainApiErrorResponseSchema,
  DomainApiRequestSchema,
  DomainApiResponseSchema,
  EventReplayPageSchema,
  PublicEventEnvelopeSchema,
  domainApiVersion,
  eventCatalog,
  publicDomainOperationIds,
  publicOperationOutputSchemaFor,
  runControlCatalog,
  schemaForPublicContract
} from "../packages/domain-api/src/index.ts";
import { operationDefinitions } from "../packages/domain-operations/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "plans/phase-0-1-public-api-spec.json");
const publicOperationIdSet = new Set(publicDomainOperationIds);
const publicDefinitions = operationDefinitions
  .filter((definition) => publicOperationIdSet.has(definition.id) && definition.sources.includes("runtime_api"))
  .sort((left, right) => left.id.localeCompare(right.id));

if (publicDefinitions.length !== publicDomainOperationIds.length) {
  throw new Error(`phase01_public_operation_catalog_incomplete:${publicDefinitions.length}/${publicDomainOperationIds.length}`);
}

const contracts = publicDefinitions.map((definition) => ({
  id: definition.id,
  kind: definition.kind,
  version: definition.version,
  availability: definition.availability,
  input_schema: schemaForPublicContract(definition.input, `${definition.id}.input`),
  output_schema: schemaForPublicContract(publicOperationOutputSchemaFor(definition.id, definition.output), `${definition.id}.output`),
  idempotency: definition.idempotency,
  concurrency: definition.concurrency,
  sources: [...definition.sources]
}));

const catalog = DomainApiCatalogSchema.parse({
  api_version: domainApiVersion,
  contracts,
  events: eventCatalog,
  run_controls: runControlCatalog
});

const spec = {
  schema_version: 1,
  api_version: domainApiVersion,
  source_of_truth: [
    "packages/domain-api/src/index.ts",
    "packages/domain-operations/src/operations",
    "apps/server/src/workspace-server/domain-api-v1.ts"
  ],
  catalog,
  schemas: {
    request: schemaForPublicContract(DomainApiRequestSchema, "domain.api.request"),
    response: schemaForPublicContract(DomainApiResponseSchema, "domain.api.response"),
    error_response: schemaForPublicContract(DomainApiErrorResponseSchema, "domain.api.error"),
    activity_ingest: schemaForPublicContract(ActivityIngestRequestSchema, "activity.ingest.request"),
    event_envelope: schemaForPublicContract(PublicEventEnvelopeSchema, "event.envelope"),
    event_replay_page: schemaForPublicContract(EventReplayPageSchema, "event.replay.page")
  },
  endpoints: [
    {
      method: "GET",
      path: "/api/v1/workspaces/:workspaceId/domain/catalog",
      classification: "query",
      authentication: ["native_desktop_signed"]
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/:workspaceId/domain/operations/:operationId",
      classification: "domain_operation",
      authentication: ["native_desktop_signed"]
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/:workspaceId/domain/queries/:queryId",
      classification: "query",
      authentication: ["native_desktop_signed"]
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/:workspaceId/activities",
      classification: "activity_ingest",
      authentication: ["native_desktop_signed"]
    },
    {
      method: "POST",
      path: "/api/v1/workspaces/:workspaceId/runs/:runId/actions/:action",
      classification: "run_control",
      authentication: ["native_desktop_signed"]
    },
    {
      method: "GET",
      path: "/api/v1/workspaces/:workspaceId/events",
      classification: "event_replay",
      authentication: ["native_desktop_signed"]
    }
  ],
  authentication: {
    native_desktop_signed: {
      transport: "Ed25519 request signature",
      authority: "Server-resolved account, Workspace membership, Room permission"
    },
    external_oauth_compatibility: {
      transport: "OAuth 2.0 Authorization Code + PKCE bearer token",
      endpoint: "/mcp",
      note: "Phase 1 keeps the existing external OAuth/MCP compatibility ingress; token and Connection authority remain Server-owned."
    }
  },
  compatibility: {
    legacy_routes: "retained until Native/External clients migrate, usage is measurable, equivalent tests pass, and a deletion phase is separately approved",
    api_version: "Adding fields or Event types is compatible; removing, renaming, or changing meaning requires a major version.",
    event_version: "Event payload changes update the Event version independently from the API version.",
    delivery: "at_least_once",
    replay_source: "HTTP event history"
  },
  examples: {
    request: {
      context: { room_id: "room_example", session_id: "session_example" },
      input: { name: "Example Room" }
    },
    response: {
      api_version: "1",
      request_id: "request_example",
      result: { id: "room_example" },
      replayed: false
    },
    reconnect: {
      socket_subscribe: { event: "workspace:v1:subscribe", input: { room_id: "room_example" } },
      socket_event: "workspace:v1:event",
      after_disconnect: "GET /api/v1/workspaces/:workspaceId/events?room_id=room_example&after_cursor=<last_cursor>",
      duplicate_rule: "Ignore an Event whose event_id was already processed."
    },
    dedupe: {
      key: "same idempotency key and same request payload",
      result: "replayed=true",
      conflict: "same idempotency key with a different payload returns a conflict"
    },
    typed_client: "const client = new DomainApiClient(transport); await client.executeOperation(workspaceId, 'room.create', { context: {}, input: { name: 'Example Room' } }, { operationId: 'operation_example', idempotencyKey: 'operation_example' });"
  }
};

const output = `${JSON.stringify(spec, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(outputPath) || normalize(readFileSync(outputPath, "utf8")) !== normalize(output)) {
    throw new Error("phase01_public_api_spec_drift");
  }
  process.stdout.write(`verified Phase 0-1 public API spec: ${contracts.length} contracts, ${eventCatalog.length} event types\n`);
} else {
  writeFileSync(outputPath, output);
  process.stdout.write(`generated Phase 0-1 public API spec: ${contracts.length} contracts, ${eventCatalog.length} event types\n`);
}

function normalize(value) {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
