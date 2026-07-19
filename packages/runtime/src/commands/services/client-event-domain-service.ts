import type { ClientEventRecord } from "@samurai-agent/core-schemas";

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

  acknowledge(id: string) {
    return this.dependencies.events.acknowledge(id);
  }

  deliver(id: string) {
    return this.dependencies.events.deliver(id);
  }

  expire(now?: string) {
    return this.dependencies.events.expire(now);
  }

  fail(id: string, errorCode: string) {
    return this.dependencies.events.fail(id, errorCode);
  }

  save(event: ClientEventRecord) {
    return this.dependencies.events.save(event);
  }

  notFoundError(): Error {
    return this.dependencies.notFoundError();
  }
}
