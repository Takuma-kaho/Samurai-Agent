import type { CollectionRecord, CollectionSchema, MemoryFrontmatter, SkillFrontmatter, WikiFrontmatter } from "@samurai-agent/core-schemas";
import type { TrustedDomainContext } from "@samurai-agent/domain-operations";
import { collectionRecordResourceId, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, RoomAuthorizationService } from "./room-authorization-service.js";

export type VersionedWorkspaceResourceKind = "artifact" | "collection_schema" | "collection_record" | "wiki" | "skill" | "memory";

export interface ResourceVersionReadStore {
  listArtifactRevisions(artifactId: string): Promise<Array<{ revision: number }>>;
  getCollectionSchema(collectionId: string): Promise<(CollectionSchema & { file_path: string; resource_version?: number }) | undefined>;
  getCollectionRecord(collectionId: string, recordId: string): Promise<CollectionRecord | undefined>;
  getWiki(id: string): Promise<(WikiFrontmatter & { file_path: string; resource_version: number }) | undefined>;
  getSkill(id: string): Promise<{ frontmatter: SkillFrontmatter; resource_version: number } | undefined>;
  getMemory(id: string): Promise<(MemoryFrontmatter & { file_path: string }) | undefined>;
}

export interface ResourceVersionRequest {
  resource_kind: VersionedWorkspaceResourceKind;
  resource_id: string;
  collection_id?: string;
}

/** A narrow, read-only service for optimistic concurrency. It first applies
 * the same Room authorization used by normal queries, then reads exactly one
 * version through a capability-specific port. */
export class ResourceVersionDomainService {
  constructor(
    private readonly store: ResourceVersionReadStore,
    private readonly authorization: RoomAuthorizationService
  ) {}

  async get(context: TrustedDomainContext, input: ResourceVersionRequest): Promise<{
    resource_key: string;
    resource_kind: VersionedWorkspaceResourceKind;
    resource_id: string;
    version: number;
  }> {
    const access = await this.resolveAccess(context);
    const authorizationTarget = input.resource_kind === "collection_record"
      ? collectionRecordResourceId(requiredCollectionId(input), input.resource_id)
      : input.resource_id;
    await this.assertResource(access.principal, access.roomId, input.resource_kind, authorizationTarget);
    const version = await this.readVersion(input);
    if (version === undefined) throw new Error(`resource_version_not_found:${input.resource_kind}:${input.resource_id}`);
    return {
      resource_key: resourceKey(input),
      resource_kind: input.resource_kind,
      resource_id: input.resource_id,
      version
    };
  }

  private async resolveAccess(context: TrustedDomainContext): Promise<{ roomId: string; principal: ParticipantPrincipal }> {
    if (!context.participant || !context.roomId) throw new Error("resource_version_context_room_required");
    try {
      await this.authorization.assertRoom(context.participant, context.roomId, "read");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new Error(`resource_version_room_authorization_denied:${error.reason}`);
      throw error;
    }
    return { roomId: context.roomId, principal: context.participant };
  }

  private async assertResource(principal: ParticipantPrincipal, roomId: string, kind: VersionedWorkspaceResourceKind, resourceId: string): Promise<void> {
    try {
      await this.authorization.assertResource(principal, { roomId, action: "read", resourceKind: kind, resourceId });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) throw new Error(`resource_version_authorization_denied:${error.reason}`);
      throw error;
    }
  }

  private async readVersion(input: ResourceVersionRequest): Promise<number | undefined> {
    if (input.resource_kind === "artifact") return (await this.store.listArtifactRevisions(input.resource_id)).at(-1)?.revision;
    if (input.resource_kind === "collection_schema") return positiveVersion((await this.store.getCollectionSchema(input.resource_id))?.resource_version);
    if (input.resource_kind === "collection_record") return (await this.store.getCollectionRecord(requiredCollectionId(input), input.resource_id))?.version;
    if (input.resource_kind === "wiki") return positiveVersion((await this.store.getWiki(input.resource_id))?.resource_version);
    if (input.resource_kind === "skill") return positiveVersion((await this.store.getSkill(input.resource_id))?.resource_version);
    return positiveVersion((await this.store.getMemory(input.resource_id))?.version);
  }
}

function requiredCollectionId(input: ResourceVersionRequest): string {
  if (!input.collection_id) throw new Error("resource_version_collection_id_required");
  return input.collection_id;
}

function resourceKey(input: ResourceVersionRequest): string {
  return input.resource_kind === "collection_record"
    ? `collection_record:${requiredCollectionId(input)}:${input.resource_id}`
    : `${input.resource_kind}:${input.resource_id}`;
}

function positiveVersion(value: string | number | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
