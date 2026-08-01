import { AgentRecordSchema, RoomRecordSchema, createId, nowIso, type AgentRecord, type RoomRecord } from "@samurai-agent/core-schemas";

export interface RoomAgentStorePort {
  createRoom(record: RoomRecord): Promise<RoomRecord>;
  getRoom(id: string): Promise<RoomRecord | undefined>;
  listRooms(): Promise<RoomRecord[]>;
  patchRoom(input: { id: string; name: string }): Promise<RoomRecord | undefined>;
  createAgent(record: AgentRecord): Promise<AgentRecord>;
  getAgent(id: string): Promise<AgentRecord | undefined>;
  listAgents(): Promise<AgentRecord[]>;
  patchAgent(input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean }): Promise<AgentRecord | undefined>;
  bindAgentBackend(input: { id: string; backend_id: string }): Promise<AgentRecord | undefined>;
}

/** Domain API for stable collaboration identities, separate from Backend state. */
export class RoomAgentDomainService {
  constructor(
    private readonly store: RoomAgentStorePort,
    private readonly backendRegistered: (backendId: string) => boolean,
    private readonly requestError: (code: "not_found" | "conflict", message: string) => Error
  ) {}

  async createRoom(input: { name: string }): Promise<RoomRecord> {
    const now = nowIso();
    return this.store.createRoom(RoomRecordSchema.parse({ id: createId("room"), name: input.name, created_at: now, updated_at: now }));
  }

  async patchRoom(input: { id: string; name: string }): Promise<RoomRecord> {
    const room = await this.store.patchRoom(input);
    if (!room) throw this.requestError("not_found", `room_not_found:${input.id}`);
    return room;
  }

  listRooms(): Promise<RoomRecord[]> { return this.store.listRooms(); }

  async viewRoom(id: string): Promise<RoomRecord> {
    const room = await this.store.getRoom(id);
    if (!room) throw this.requestError("not_found", `room_not_found:${id}`);
    return room;
  }

  async createAgent(input: { name: string; role: string; instructions: string; backendId: string; enabled?: boolean }): Promise<AgentRecord> {
    this.assertBackend(input.backendId);
    const now = nowIso();
    return this.store.createAgent(AgentRecordSchema.parse({
      id: createId("agent"), name: input.name, role: input.role, instructions: input.instructions,
      backend_id: input.backendId, enabled: input.enabled ?? true, created_at: now, updated_at: now
    }));
  }

  async patchAgent(input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean }): Promise<AgentRecord> {
    const agent = await this.store.patchAgent(input);
    if (!agent) throw this.requestError("not_found", `agent_not_found:${input.id}`);
    return agent;
  }

  async bindAgentBackend(input: { id: string; backendId: string }): Promise<AgentRecord> {
    this.assertBackend(input.backendId);
    const agent = await this.store.bindAgentBackend({ id: input.id, backend_id: input.backendId });
    if (!agent) throw this.requestError("not_found", `agent_not_found:${input.id}`);
    return agent;
  }

  listAgents(): Promise<AgentRecord[]> { return this.store.listAgents(); }

  async viewAgent(id: string): Promise<AgentRecord> {
    const agent = await this.store.getAgent(id);
    if (!agent) throw this.requestError("not_found", `agent_not_found:${id}`);
    return agent;
  }

  private assertBackend(backendId: string): void {
    if (!this.backendRegistered(backendId)) throw this.requestError("conflict", `backend_not_registered:${backendId}`);
  }
}
