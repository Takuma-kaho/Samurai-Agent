import { AgentRecordSchema, RoomRecordSchema, nowIso, type AgentRecord, type RoomRecord, type SettingsRecord } from "@samurai-agent/core-schemas";
import type { Kysely } from "kysely";
import type { WorkspaceDb } from "../kernel/workspace-db-schema";

export const DEFAULT_ROOM_ID = "room_default";
export const DEFAULT_AGENT_ID = "agent_default";

/** SQLite owner for stable Room and Agent records. It has no filesystem root. */
export class RoomAgentRepository {
  constructor(private readonly db: Kysely<WorkspaceDb>) {}

  async ensureDefaults(settings: SettingsRecord): Promise<{ room: RoomRecord; agent: AgentRecord }> {
    const roomId = settings.default_room_id ?? DEFAULT_ROOM_ID;
    const agentId = settings.default_agent_id ?? DEFAULT_AGENT_ID;
    const now = nowIso();
    let room = await this.getRoom(roomId);
    if (!room) {
      room = { id: roomId, name: "Default Room", created_at: now, updated_at: now };
      await this.createRoom(room);
    }
    let agent = await this.getAgent(agentId);
    if (!agent) {
      agent = {
        id: agentId,
        name: "Default Agent",
        role: "Workspace assistant",
        instructions: "Help with the current user request using the Workspace context.",
        backend_id: settings.default_backend_id ?? "samurai-native",
        enabled: true,
        created_at: now,
        updated_at: now
      };
      await this.createAgent(agent);
    }
    if (settings.default_room_id === room.id && settings.default_agent_id === agent.id) return { room, agent };
    await this.db.updateTable("settings").set({
      default_room_id: room.id,
      default_agent_id: agent.id,
      updated_at: now
    }).where("id", "=", "default").execute();
    return { room, agent };
  }

  async createRoom(record: RoomRecord): Promise<RoomRecord> {
    const parsed = RoomRecordSchema.parse(record);
    await this.db.insertInto("rooms").values(parsed).execute();
    return parsed;
  }

  async getRoom(id: string): Promise<RoomRecord | undefined> {
    const row = await this.db.selectFrom("rooms").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? RoomRecordSchema.parse(row) : undefined;
  }

  async listRooms(): Promise<RoomRecord[]> {
    return (await this.db.selectFrom("rooms").selectAll().orderBy("updated_at", "desc").execute()).map((row) => RoomRecordSchema.parse(row));
  }

  async patchRoom(input: { id: string; name: string }): Promise<RoomRecord | undefined> {
    const current = await this.getRoom(input.id);
    if (!current) return undefined;
    const next = RoomRecordSchema.parse({ ...current, name: input.name, updated_at: nowIso() });
    await this.db.updateTable("rooms").set({ name: next.name, updated_at: next.updated_at }).where("id", "=", input.id).execute();
    return next;
  }

  async createAgent(record: AgentRecord): Promise<AgentRecord> {
    const parsed = AgentRecordSchema.parse(record);
    await this.db.insertInto("agents").values({ ...parsed, enabled: parsed.enabled ? 1 : 0 }).execute();
    return parsed;
  }

  async getAgent(id: string): Promise<AgentRecord | undefined> {
    const row = await this.db.selectFrom("agents").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? agentFromRow(row) : undefined;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return (await this.db.selectFrom("agents").selectAll().orderBy("updated_at", "desc").execute()).map(agentFromRow);
  }

  async patchAgent(input: { id: string; name?: string; role?: string; instructions?: string; enabled?: boolean }): Promise<AgentRecord | undefined> {
    const current = await this.getAgent(input.id);
    if (!current) return undefined;
    const next = AgentRecordSchema.parse({
      ...current,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      updated_at: nowIso()
    });
    await this.db.updateTable("agents").set({
      name: next.name,
      role: next.role,
      instructions: next.instructions,
      enabled: next.enabled ? 1 : 0,
      updated_at: next.updated_at
    }).where("id", "=", input.id).execute();
    return next;
  }

  async bindAgentBackend(input: { id: string; backend_id: string }): Promise<AgentRecord | undefined> {
    const current = await this.getAgent(input.id);
    if (!current) return undefined;
    const next = AgentRecordSchema.parse({ ...current, backend_id: input.backend_id, updated_at: nowIso() });
    await this.db.updateTable("agents").set({ backend_id: next.backend_id, updated_at: next.updated_at }).where("id", "=", input.id).execute();
    return next;
  }
}

function agentFromRow(row: WorkspaceDb["agents"]): AgentRecord {
  return AgentRecordSchema.parse({ ...row, enabled: row.enabled === 1 });
}
