/**
 * Socket delivery and hierarchy/member mutations share this small local gate.
 * PostgreSQL's matching shared/exclusive advisory lock protects this across
 * Server processes; this local gate keeps delivery order deterministic among
 * Socket operations handled by one process.
 */
export class WorkspaceRealtimeGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(workspaceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(workspaceId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release?.();
      if (this.tails.get(workspaceId) === current) this.tails.delete(workspaceId);
    }
  }
}

export function workspaceSocketRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export function roomSocketRoom(workspaceId: string, roomId: string): string {
  return `workspace:${workspaceId}:room:${roomId}`;
}
