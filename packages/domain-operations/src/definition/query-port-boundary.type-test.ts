import { defineQuery, domainQueryReadCapability, type DomainQueryPorts, type DomainWritePorts, domainWriteCapability, type ReadCapability } from "./index.js";
import { z } from "zod";

interface WriteOnlyPorts extends DomainWritePorts {
  save(value: string): Promise<void>;
}

declare const writeOnly: WriteOnlyPorts;

interface UnbrandedPorts extends DomainQueryPorts {
  read(): Promise<string>;
}

// The write capability brand is intentionally incompatible with a query
// capability.  This is the compile-time negative proof for Query Dispatcher
// construction; method-name heuristics are not used.
// @ts-expect-error A write capability cannot satisfy a query port.
const rejected: DomainQueryPorts = writeOnly;
void rejected;

interface ReadPorts extends DomainQueryPorts {
  read: ReadCapability<() => Promise<string>>;
}

const readOnlyDefinition = defineQuery<ReadPorts>()({
  id: "query.port.boundary",
  version: "1.0",
  availability: "active",
  title: "Query port boundary",
  description: "Compile-time query capability proof.",
  sources: ["runtime_api"],
  render: ["chat"],
  resourceKinds: ["query_port_boundary"],
  proposedEffects: ["Read query port boundary."],
  outputResourceKind: "query_port_boundary",
  uiDisplayCategory: "system",
  provenance: [],
  input: z.object({}).strict(),
  output: z.object({}).strict(),
  createHandler: () => ({ execute: () => ({ ok: true, value: {} }) })
});
void readOnlyDefinition;

const unbrandedQueryFactory = defineQuery<UnbrandedPorts>();
const rejectedUnbrandedDefinition = unbrandedQueryFactory({
  ...readOnlyDefinition,
  // @ts-expect-error Unbranded callable ports are never callable in a Query handler.
  createHandler: (ports) => ({ execute: () => ({ ok: true, value: ports.read() }) })
});
void rejectedUnbrandedDefinition;

// The runtime brand is a capability marker only; no operation handler may
// acquire a write brand through a query definition.
void domainQueryReadCapability;
void domainWriteCapability;
