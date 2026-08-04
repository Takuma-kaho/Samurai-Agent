import type { WorkspaceStore } from "@samurai-agent/workspace-store";
import {
  canonicalRoomShareableResourceReference,
  type CanonicalRoomShareableResourceReference,
  type RoomShareableResourceReference
} from "@samurai-agent/room-permissions";

export interface ResolvedRoomShareableResource extends CanonicalRoomShareableResourceReference {
  /** Known creation time is preserved when a legacy resource first gains a boundary. */
  resourceCreatedAt?: string;
  /** A persisted source Room is never reassigned by an explicit share request. */
  sourceRoomId?: string;
}

type ResourceCatalogStore = Pick<WorkspaceStore,
  | "getSession"
  | "getOperation"
  | "getArtifact"
  | "getMemory"
  | "getWiki"
  | "getSkill"
  | "getCollectionSchema"
  | "getCollectionRecord"
  | "getGeneratedSurface"
>;

/**
 * Resolves a public typed share reference to one real Workspace resource.
 * It owns neither authorization nor persistence: the Room service performs
 * those after this catalog has established a canonical, existing target.
 */
export class RoomResourceCatalog {
  constructor(
    private readonly store: ResourceCatalogStore,
    private readonly canonicalFilePath: (input: string) => string,
    private readonly fileExists: (canonicalPath: string) => Promise<boolean>
  ) {}

  canonicalize(reference: RoomShareableResourceReference): CanonicalRoomShareableResourceReference {
    if (reference.kind === "file") return { kind: "file", resourceId: this.canonicalFilePath(reference.path) };
    return canonicalRoomShareableResourceReference(reference);
  }

  async resolve(reference: RoomShareableResourceReference): Promise<ResolvedRoomShareableResource | undefined> {
    const canonical = this.canonicalize(reference);
    switch (reference.kind) {
      case "session": {
        const session = await this.store.getSession(canonical.resourceId);
        return session ? withMetadata(canonical, session) : undefined;
      }
      case "artifact": {
        const artifact = await this.store.getArtifact(canonical.resourceId);
        if (!artifact) return undefined;
        const operation = artifact.source_operation_id ? await this.store.getOperation(artifact.source_operation_id) : undefined;
        return withMetadata(canonical, artifact, operation?.room_id);
      }
      case "memory": {
        const memory = await this.store.getMemory(canonical.resourceId);
        return memory ? withMetadata(canonical, memory) : undefined;
      }
      case "wiki": {
        const wiki = await this.store.getWiki(canonical.resourceId);
        return wiki ? withMetadata(canonical, wiki) : undefined;
      }
      case "skill": {
        const skill = await this.store.getSkill(canonical.resourceId);
        return skill ? withMetadata(canonical, skill) : undefined;
      }
      case "collection_schema": {
        const schema = await this.store.getCollectionSchema(canonical.resourceId);
        return schema ? withMetadata(canonical, schema) : undefined;
      }
      case "collection_record": {
        const record = await this.store.getCollectionRecord(reference.collectionId, reference.recordId);
        return record ? withMetadata(canonical, record) : undefined;
      }
      case "generated_surface": {
        const surface = await this.store.getGeneratedSurface(canonical.resourceId);
        if (!surface) return undefined;
        const session = surface.session_id ? await this.store.getSession(surface.session_id) : undefined;
        return withMetadata(canonical, surface, session?.room_id);
      }
      case "file":
        return await this.fileExists(canonical.resourceId) ? canonical : undefined;
    }
  }
}

function withMetadata(
  reference: CanonicalRoomShareableResourceReference,
  resource: unknown,
  sourceRoomId?: string
): ResolvedRoomShareableResource {
  const record = resource && typeof resource === "object" ? resource as Record<string, unknown> : {};
  const inferredSourceRoomId = sourceRoomId ?? roomIdFromRecord(record);
  return {
    ...reference,
    ...(typeof record.created_at === "string" ? { resourceCreatedAt: record.created_at } : {}),
    ...(inferredSourceRoomId ? { sourceRoomId: inferredSourceRoomId } : {})
  };
}

function roomIdFromRecord(record: Record<string, unknown>): string | undefined {
  if (typeof record.room_id === "string") return record.room_id;
  for (const key of ["origin_activity_context", "activity_context", "usage_scope"]) {
    const value = record[key];
    if (value && typeof value === "object" && typeof (value as Record<string, unknown>).room_id === "string") {
      return (value as Record<string, unknown>).room_id as string;
    }
  }
  return undefined;
}
