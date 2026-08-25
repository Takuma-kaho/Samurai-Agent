import {
  stableHash,
  type JsonValue,
  type ResourceRef,
  type UsageScopeRef
} from "@samurai-agent/core-schemas";
import {
  DomainOperationError,
  resourceTransferValueSchema,
  type ResourceCopyInput,
  type ResourceMoveInput,
  type ResourcePromoteInput,
  type ResourceTransferValue,
  type TransferableResourceKind,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import { delegatedParticipant, principalParticipantId, type ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, RoomAuthorizationService } from "./room-authorization-service.js";
import { type StoredSkill, SkillDomainService } from "./skill-domain-service.js";
import { type StoredWiki, WikiDomainService } from "./wiki-domain-service.js";

type TransferSource =
  | { kind: "wiki"; resource: StoredWiki; ref: ResourceRef; content: string }
  | { kind: "skill"; resource: StoredSkill; ref: ResourceRef; content: string };

/**
 * The only shared implementation for explicit external Resource transfer.
 * It keeps the source Room check, target Room check, formal Operation/Activity
 * evidence, and persistence-side version CAS together. A target Room is
 * never inferred from hierarchy or accepted merely because it is named by a
 * Client: External Apps must have it on their persisted Connection allow-list.
 */
export class ResourceTransferDomainService {
  constructor(
    private readonly dependencies: {
      wiki: WikiDomainService;
      skill: SkillDomainService<StoredSkill>;
      roomAuthorization: RoomAuthorizationService;
    }
  ) {}

  async copy(context: TrustedDomainContext, input: ResourceCopyInput): Promise<ResourceTransferValue> {
    const source = await this.loadSource(context, input.resource_kind, input.resource_id);
    await this.assertTargetRoom(context, input.target_room_id);
    const targetId = input.target_resource_id ?? transferId("copy", context, source.kind, source.resource.id, input.target_room_id);
    if (targetId === source.resource.id) {
      throw new DomainOperationError("conflict", "resource_transfer_target_id_matches_source");
    }
    const targetScope = { kind: "room" as const, room_id: input.target_room_id };
    const boundary = boundaryForTarget(context, input.target_room_id, sourceCreatedAt(source));
    if (source.kind === "wiki") {
      const result = await this.dependencies.wiki.runWikiMutation({
        trustedContext: context,
        operationName: "resource.copy",
        inputSummary: `Copy Knowledge ${source.resource.title} to an authorized Room.`,
        proposedEffects: ["Create an independent Room-scoped Knowledge copy with source provenance."],
        targetResourceRefs: [source.ref],
        resultResourceBoundaryMode: "managed_by_operation",
        execute: async (operation) => {
          let saved: StoredWiki | undefined;
          try {
            saved = await this.dependencies.wiki.copyWikiPage({
              source_id: source.resource.id,
              target_id: targetId,
              target_slug: `resource-copy-${transferSuffix(targetId)}`,
              target_usage_scope: targetScope,
              expected_source_resource_version: input.expected_resource_version,
              target_boundary: boundary
            });
          } catch (error) {
            throw this.dependencies.wiki.mapWikiWriteError(error);
          }
          if (!saved) throw this.dependencies.wiki.wikiPageNotFoundError(source.resource.id);
          const resource = wikiRef(saved);
          const rollbackPoint = await this.dependencies.wiki.createWikiRollback(operation, [source.ref, resource],
            { source: jsonRecord(source.resource), source_content: source.content },
            { copied_resource: jsonRecord(saved), source_id: source.resource.id });
          return { resource: saved, ref: resource, rollbackPoint, summary: `Copied Knowledge ${source.resource.title} to Room ${input.target_room_id}.` };
        }
      });
      return transferValue("wiki", source.ref, wikiRef(result.resource), result.resource.resource_version, result);
    }
    const result = await this.dependencies.skill.runSkillMutation<StoredSkill>({
      trustedContext: context,
      operationName: "resource.copy",
      inputSummary: `Copy Skill ${source.resource.title} to an authorized Room.`,
      proposedEffects: ["Create an independent Room-scoped Skill copy with source provenance."],
      targetResourceRefs: [source.ref],
      resultResourceBoundaryMode: "managed_by_operation",
      execute: async (operation) => {
        let saved: StoredSkill | undefined;
        try {
          saved = await this.dependencies.skill.copySkill({
            source_id: source.resource.id,
            target_id: targetId,
            target_usage_scope: targetScope,
            expected_source_resource_version: input.expected_resource_version,
            target_boundary: boundary
          });
        } catch (error) {
          throw this.dependencies.skill.mapSkillWriteError(error);
        }
        if (!saved) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
        const resource = skillRef(saved);
        const rollbackPoint = await this.dependencies.skill.createSkillRollback(operation, [source.ref, resource],
          { source: jsonRecord(source.resource), source_markdown: source.content },
          { copied_resource: jsonRecord(saved), source_id: source.resource.id });
        return { resource: saved, ref: resource, rollbackPoint, summary: `Copied Skill ${source.resource.title} to Room ${input.target_room_id}.` };
      }
    });
    return transferValue("skill", source.ref, skillRef(result.resource), requiredVersion(result.resource.resource_version), result);
  }

  async move(context: TrustedDomainContext, input: ResourceMoveInput): Promise<ResourceTransferValue> {
    const source = await this.loadSource(context, input.resource_kind, input.resource_id);
    await this.assertTargetRoom(context, input.target_room_id);
    const sourceRoomId = sourceRoomScope(source.resource, source.kind);
    if (sourceRoomId === input.target_room_id) {
      throw new DomainOperationError("conflict", "resource_transfer_move_noop");
    }
    if (source.kind === "wiki") {
      const result = await this.dependencies.wiki.runWikiMutation({
        trustedContext: context,
        operationName: "resource.move",
        inputSummary: `Move Knowledge ${source.resource.title} to an authorized Room.`,
        proposedEffects: ["Move the explicit Knowledge Room scope without implicit inheritance or share rewriting."],
        targetResourceRefs: [source.ref],
        resultResourceBoundaryMode: "managed_by_operation",
        skipPostMutationTargetBoundaryCheck: true,
        execute: async (operation) => {
          let saved: StoredWiki | undefined;
          try {
            saved = await this.dependencies.wiki.moveWikiPage({
              id: source.resource.id,
              source_room_id: sourceRoomId,
              target_room_id: input.target_room_id,
              expected_resource_version: input.expected_resource_version
            });
          } catch (error) {
            throw this.dependencies.wiki.mapWikiWriteError(error);
          }
          if (!saved) throw this.dependencies.wiki.wikiPageNotFoundError(source.resource.id);
          const resource = wikiRef(saved);
          const rollbackPoint = await this.dependencies.wiki.createWikiRollback(operation, [source.ref, resource],
            { source: jsonRecord(source.resource), source_content: source.content, source_room_id: sourceRoomId },
            { moved_resource: jsonRecord(saved), target_room_id: input.target_room_id });
          return { resource: saved, ref: resource, rollbackPoint, summary: `Moved Knowledge ${source.resource.title} to Room ${input.target_room_id}.` };
        }
      });
      return transferValue("wiki", source.ref, wikiRef(result.resource), result.resource.resource_version, result);
    }
    const result = await this.dependencies.skill.runSkillMutation<StoredSkill>({
      trustedContext: context,
      operationName: "resource.move",
      inputSummary: `Move Skill ${source.resource.title} to an authorized Room.`,
      proposedEffects: ["Move the explicit Skill Room scope without implicit inheritance or share rewriting."],
      targetResourceRefs: [source.ref],
      resultResourceBoundaryMode: "managed_by_operation",
      skipPostMutationTargetBoundaryCheck: true,
      execute: async (operation) => {
        let saved: StoredSkill | undefined;
        try {
          saved = await this.dependencies.skill.moveSkill({
            id: source.resource.id,
            source_room_id: sourceRoomId,
            target_room_id: input.target_room_id,
            expected_resource_version: input.expected_resource_version
          });
        } catch (error) {
          throw this.dependencies.skill.mapSkillWriteError(error);
        }
        if (!saved) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
        const resource = skillRef(saved);
        const rollbackPoint = await this.dependencies.skill.createSkillRollback(operation, [source.ref, resource],
          { source: jsonRecord(source.resource), source_markdown: source.content, source_room_id: sourceRoomId },
          { moved_resource: jsonRecord(saved), target_room_id: input.target_room_id });
        return { resource: saved, ref: resource, rollbackPoint, summary: `Moved Skill ${source.resource.title} to Room ${input.target_room_id}.` };
      }
    });
    return transferValue("skill", source.ref, skillRef(result.resource), requiredVersion(result.resource.resource_version), result);
  }

  async promote(context: TrustedDomainContext, input: ResourcePromoteInput): Promise<ResourceTransferValue> {
    const access = requiredRoomAccess(context);
    // Promotion crosses the Room boundary and creates a new Workspace-owned
    // projection. Room edit permission alone must never grant that broader
    // write; the delegated human/agent is checked against current Workspace
    // administration permission immediately before the source is copied.
    try {
      await this.dependencies.roomAuthorization.assertWorkspace(access.participant, "manage_settings");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw new DomainOperationError("source_not_allowed", `resource_transfer_workspace_authorization_denied:${error.reason}`);
      }
      throw error;
    }
    const source = await this.loadSource(context, input.resource_kind, input.resource_id);
    // Promotion intentionally creates a new Workspace-scoped projection. The
    // Room source and its evidence remain intact; there is no implicit Room
    // mutation or inherited write access to the resulting Workspace knowledge.
    const targetId = transferId("promote", context, source.kind, source.resource.id, "workspace");
    if (source.kind === "wiki") {
      const result = await this.dependencies.wiki.runWikiMutation({
        trustedContext: context,
        operationName: "resource.promote",
        inputSummary: `Promote Knowledge ${source.resource.title} as explicit Workspace knowledge.`,
        proposedEffects: ["Create an independent Workspace-scoped Knowledge projection with source provenance."],
        targetResourceRefs: [source.ref],
        resultResourceBoundaryMode: "managed_by_operation",
        execute: async (operation) => {
          let saved: StoredWiki | undefined;
          try {
            saved = await this.dependencies.wiki.copyWikiPage({
              source_id: source.resource.id,
              target_id: targetId,
              target_slug: `workspace-promote-${transferSuffix(targetId)}`,
              target_usage_scope: { kind: "workspace" },
              expected_source_resource_version: input.expected_resource_version
            });
          } catch (error) {
            throw this.dependencies.wiki.mapWikiWriteError(error);
          }
          if (!saved) throw this.dependencies.wiki.wikiPageNotFoundError(source.resource.id);
          const resource = wikiRef(saved);
          const rollbackPoint = await this.dependencies.wiki.createWikiRollback(operation, [source.ref, resource],
            { source: jsonRecord(source.resource), source_content: source.content },
            { promoted_resource: jsonRecord(saved), source_id: source.resource.id });
          return { resource: saved, ref: resource, rollbackPoint, summary: `Promoted Knowledge ${source.resource.title} to Workspace scope.` };
        }
      });
      return transferValue("wiki", source.ref, wikiRef(result.resource), result.resource.resource_version, result);
    }
    const result = await this.dependencies.skill.runSkillMutation<StoredSkill>({
      trustedContext: context,
      operationName: "resource.promote",
      inputSummary: `Promote Skill ${source.resource.title} as explicit Workspace knowledge.`,
      proposedEffects: ["Create an independent Workspace-scoped Skill projection with source provenance."],
      targetResourceRefs: [source.ref],
      resultResourceBoundaryMode: "managed_by_operation",
      execute: async (operation) => {
        let saved: StoredSkill | undefined;
        try {
          saved = await this.dependencies.skill.copySkill({
            source_id: source.resource.id,
            target_id: targetId,
            target_usage_scope: { kind: "workspace" },
            expected_source_resource_version: input.expected_resource_version
          });
        } catch (error) {
          throw this.dependencies.skill.mapSkillWriteError(error);
        }
        if (!saved) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
        const resource = skillRef(saved);
        const rollbackPoint = await this.dependencies.skill.createSkillRollback(operation, [source.ref, resource],
          { source: jsonRecord(source.resource), source_markdown: source.content },
          { promoted_resource: jsonRecord(saved), source_id: source.resource.id });
        return { resource: saved, ref: resource, rollbackPoint, summary: `Promoted Skill ${source.resource.title} to Workspace scope.` };
      }
    });
    return transferValue("skill", source.ref, skillRef(result.resource), requiredVersion(result.resource.resource_version), result);
  }

  private async loadSource(
    context: TrustedDomainContext,
    resourceKind: TransferableResourceKind,
    resourceId: string
  ): Promise<TransferSource> {
    const access = requiredRoomAccess(context);
    try {
      await this.dependencies.roomAuthorization.assertResource(access.participant, {
        roomId: access.roomId,
        action: "edit",
        resourceKind,
        resourceId
      });
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw new DomainOperationError("source_not_allowed", `resource_transfer_source_authorization_denied:${error.reason}`);
      }
      throw error;
    }
    if (resourceKind === "wiki") {
      const [resource, content] = await Promise.all([
        this.dependencies.wiki.getWikiPage(resourceId),
        this.dependencies.wiki.readWikiContent(resourceId)
      ]);
      if (!resource || content === undefined) throw this.dependencies.wiki.wikiPageNotFoundError(resourceId);
      if (sourceRoomScope(resource, "wiki") !== access.roomId) {
        throw new DomainOperationError("conflict", "resource_transfer_source_room_scope_required");
      }
      return { kind: "wiki", resource, ref: wikiRef(resource), content };
    }
    const [resource, content] = await Promise.all([
      this.dependencies.skill.getSkillForMutation(resourceId),
      this.dependencies.skill.readSkillMarkdown(resourceId)
    ]);
    if (!resource || content === undefined) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
    if (sourceRoomScope(resource, "skill") !== access.roomId) {
      throw new DomainOperationError("conflict", "resource_transfer_source_room_scope_required");
    }
    return { kind: "skill", resource, ref: skillRef(resource), content };
  }

  private async assertTargetRoom(context: TrustedDomainContext, targetRoomId: string): Promise<void> {
    const access = requiredRoomAccess(context);
    if (context.inputSource === "external_app") {
      if (!context.externalAllowedRoomIds?.includes(targetRoomId)) {
        throw new DomainOperationError("source_not_allowed", "resource_transfer_target_room_not_bound");
      }
    }
    try {
      await this.dependencies.roomAuthorization.assertRoom(access.participant, targetRoomId, "edit");
    } catch (error) {
      if (error instanceof RoomAuthorizationError) {
        throw new DomainOperationError("source_not_allowed", `resource_transfer_target_room_authorization_denied:${error.reason}`);
      }
      throw error;
    }
  }
}

function requiredRoomAccess(context: TrustedDomainContext): { roomId: string; participant: ParticipantPrincipal } {
  if (!context.roomId || !context.participant || context.participant.kind === "system") {
    throw new DomainOperationError("source_not_allowed", "resource_transfer_room_participant_required");
  }
  return { roomId: context.roomId, participant: context.participant };
}

function boundaryForTarget(
  context: TrustedDomainContext,
  targetRoomId: string,
  resourceCreatedAt?: string
): { sourceRoomId: string; ownerParticipantId: string; creatorParticipantId: string; resourceCreatedAt?: string } {
  const access = requiredRoomAccess(context);
  const delegated = delegatedParticipant(access.participant);
  if (delegated.kind === "system") {
    throw new DomainOperationError("source_not_allowed", "resource_transfer_human_owner_required");
  }
  return {
    sourceRoomId: targetRoomId,
    ownerParticipantId: delegated.kind === "agent" ? delegated.requestedByParticipantId : delegated.participantId,
    creatorParticipantId: principalParticipantId(access.participant),
    ...(resourceCreatedAt ? { resourceCreatedAt } : {})
  };
}

function sourceCreatedAt(source: TransferSource): string | undefined {
  return source.kind === "wiki" ? source.resource.created_at : source.resource.frontmatter.created_at;
}

function sourceRoomScope(resource: StoredWiki | StoredSkill, kind: TransferableResourceKind): string {
  const scope: UsageScopeRef | undefined = kind === "wiki"
    ? (resource as StoredWiki).usage_scope
    : (resource as StoredSkill).frontmatter.usage_scope;
  if (scope?.kind !== "room") {
    throw new DomainOperationError("conflict", "resource_transfer_source_room_scope_required");
  }
  return scope.room_id;
}

function wikiRef(resource: StoredWiki): ResourceRef {
  return { kind: "wiki", id: resource.id, uri: resource.file_path, label: resource.title, version: String(resource.resource_version) };
}

function skillRef(resource: StoredSkill): ResourceRef {
  return { kind: "skill", id: resource.id, uri: resource.file_path, label: resource.title, version: String(requiredVersion(resource.resource_version)) };
}

function transferId(
  action: "copy" | "promote",
  context: TrustedDomainContext,
  kind: TransferableResourceKind,
  sourceId: string,
  target: string
): string {
  const token = stableHash({
    action,
    key: context.idempotencyKey ?? context.correlationId,
    kind,
    source_id: sourceId,
    target
  }).slice(0, 24);
  return `resource_${action}_${token}`;
}

function transferSuffix(id: string): string {
  return stableHash(id).slice(0, 20);
}

function requiredVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DomainOperationError("conflict", "resource_transfer_resource_version_missing");
  }
  return value;
}

function transferValue(
  resourceKind: TransferableResourceKind,
  source: ResourceRef,
  target: ResourceRef,
  resourceVersion: number,
  result: { operation: ResourceTransferValue["operation"]; rollbackPoint?: ResourceTransferValue["rollbackPoint"]; activity: ResourceTransferValue["activity"] }
): ResourceTransferValue {
  return resourceTransferValueSchema.parse({
    resource: {
      resource_kind: resourceKind,
      source,
      target,
      resource_version: requiredVersion(resourceVersion)
    },
    operation: result.operation,
    ...(result.rollbackPoint ? { rollbackPoint: result.rollbackPoint } : {}),
    activity: result.activity
  });
}

function jsonRecord(value: unknown): Record<string, JsonValue> {
  const serialized = JSON.stringify(value);
  if (!serialized) return {};
  const parsed = JSON.parse(serialized) as JsonValue;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, JsonValue> : {};
}
