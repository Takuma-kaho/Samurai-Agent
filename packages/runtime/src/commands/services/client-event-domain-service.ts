import {
  ClientEventRecordSchema,
  type ClientEventRecord,
  type JsonValue
} from "@samurai-agent/core-schemas";

export interface ClientEventPersistencePort {
  acknowledge(eventId: string): Promise<ClientEventRecord | undefined>;
  deliver(eventId: string): Promise<ClientEventRecord | undefined>;
  expire(now?: string): Promise<ClientEventRecord[]>;
  fail(eventId: string, errorCode: string): Promise<ClientEventRecord | undefined>;
  save(event: ClientEventRecord): Promise<ClientEventRecord>;
}

export interface ClientEventDomainServiceDependencies {
  events: ClientEventPersistencePort;
  notFoundError: () => Error;
}

export class ClientEventDomainService {
  constructor(private readonly dependencies: ClientEventDomainServiceDependencies) {}

  async acknowledge(payload: Record<string, JsonValue>) {
    return this.requireEvent(await this.dependencies.events.acknowledge(requiredString(payload, "event_id")));
  }

  async deliver(payload: Record<string, JsonValue>) {
    return this.requireEvent(await this.dependencies.events.deliver(requiredString(payload, "event_id")));
  }

  async expire(payload: Record<string, JsonValue>) {
    const events = await this.dependencies.events.expire(optionalString(payload.now) || undefined);
    return { expired_count: events.length, events };
  }

  async fail(payload: Record<string, JsonValue>) {
    const event = await this.dependencies.events.fail(
      requiredString(payload, "event_id"),
      optionalString(payload.error_code) || "client_event_failed"
    );
    return this.requireEvent(event);
  }

  async save(payload: Record<string, JsonValue>) {
    return this.dependencies.events.save(ClientEventRecordSchema.parse(payload));
  }

  private requireEvent(event: ClientEventRecord | undefined): ClientEventRecord {
    if (!event) throw this.dependencies.notFoundError();
    return event;
  }
}

function optionalString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredString(payload: Record<string, JsonValue>, key: string): string {
  const value = optionalString(payload[key]);
  if (!value) throw new Error(`domain_operation_required_field:${key}`);
  return value;
}
