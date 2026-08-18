import {
  ConnectorEventSchema,
  ExternalIntegrationError,
  hashCanonicalJson,
  type ConnectorEvent,
  type ExternalIntegrationStore
} from "./contracts.js";
import { redactExternalText, redactExternalValue } from "./capture.js";
import { randomBytes } from "node:crypto";

export interface NormalizedActivity {
  id: string;
  source: "external_app";
  connectorId: string;
  connectorVersion: string;
  externalSessionId: string;
  eventKind: string;
  instruction?: string;
  result?: string;
  changedResources: string[];
  verification: ConnectorEvent["verification"];
  outcome: ConnectorEvent["outcome"];
  failure?: string;
  occurredAt: string;
  unknownOutcome: boolean;
  payload: Record<string, unknown>;
}

export interface ActivityIngestServiceOptions {
  store: ExternalIntegrationStore;
  now?: () => Date;
  id?: () => string;
}

export interface ActivityIngestResult {
  duplicate: boolean;
  activity: NormalizedActivity;
}

/** Activity is durable evidence, so connector-provided free text and payloads
 * receive the same redaction as optional Capture before hashing or storage. */
export function redactConnectorEvent(input: ConnectorEvent): ConnectorEvent {
  const parsed = ConnectorEventSchema.parse(input);
  return ConnectorEventSchema.parse({
    ...parsed,
    ...(parsed.instruction ? { instruction: redactExternalText(parsed.instruction) } : {}),
    ...(parsed.result ? { result: redactExternalText(parsed.result) } : {}),
    ...(parsed.failure ? { failure: redactExternalText(parsed.failure) } : {}),
    payload: redactExternalValue(parsed.payload)
  });
}

export function normalizeConnectorEvent(input: ConnectorEvent): NormalizedActivity {
  const event = redactConnectorEvent(input);
  const payloadHash = hashEvent(event);
  return {
    id: `activity_${event.connector_id}_${event.connector_version}_${event.external_session_id}_${event.event_id}_${payloadHash.slice(0, 16)}`,
    source: "external_app",
    connectorId: event.connector_id,
    connectorVersion: event.connector_version,
    externalSessionId: event.external_session_id,
    eventKind: event.event_kind,
    ...(event.instruction ? { instruction: event.instruction } : {}),
    ...(event.result ? { result: event.result } : {}),
    changedResources: event.changed_resources,
    verification: event.verification,
    outcome: event.outcome,
    ...(event.failure ? { failure: event.failure } : {}),
    occurredAt: event.occurred_at,
    unknownOutcome: event.outcome === "unknown" || event.verification === "unknown",
    payload: event.payload
  };
}

/** Structured evidence enters Activity once, by connector event ID. This does
 * not create Knowledge or modify resources automatically. */
export class ActivityIngestService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: ActivityIngestServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? (() => `activity_record_${randomBytes(16).toString("hex")}`);
  }

  async ingest(input: ConnectorEvent): Promise<ActivityIngestResult> {
    const event = redactConnectorEvent(input);
    const normalized = normalizeConnectorEvent(event);
    const identityKey = `${event.connector_id}:${event.connector_version}:${event.external_session_id}:${event.event_id}`;
    const payloadHash = hashEvent(event);
    const existing = (await this.options.store.listRecords("activity_event"))
      .find((record) => record.identity_key === identityKey);
    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new ExternalIntegrationError("activity_event_conflict", "activity_event_payload_changed");
      }
      return { duplicate: true, activity: normalizeConnectorEvent(existing.event) };
    }
    const record = {
      id: this.id(),
      identity_key: identityKey,
      payload_hash: payloadHash,
      dedupe_key: `${identityKey}:${payloadHash}`,
      created_at: this.now().toISOString(),
      event
    };
    try {
      await this.options.store.createRecord("activity_event", record);
    } catch (error) {
      if (error instanceof Error && error.message.includes("external_record_exists")) {
        const raced = (await this.options.store.listRecords("activity_event")).find((candidate) => candidate.identity_key === identityKey);
        if (raced && raced.payload_hash === payloadHash) return { duplicate: true, activity: normalizeConnectorEvent(raced.event) };
        if (raced) throw new ExternalIntegrationError("activity_event_conflict", "activity_event_payload_changed");
      }
      throw error;
    }
    return { duplicate: false, activity: normalized };
  }
}

function hashEvent(event: ConnectorEvent): string {
  return hashCanonicalJson(event);
}
