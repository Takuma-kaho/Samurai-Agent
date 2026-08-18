import {
  redactPrivateData,
  type ResourceRef,
  type UsageScopeRef
} from "@samurai-agent/core-schemas";
import {
  DomainOperationError,
  resourceRedactionValueSchema,
  type ResourceRedactInput,
  type ResourceRedactionValue,
  type TransferableResourceKind,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import { RoomAuthorizationError, RoomAuthorizationService } from "./room-authorization-service.js";
import { type StoredSkill, SkillDomainService } from "./skill-domain-service.js";
import { type StoredWiki, WikiDomainService } from "./wiki-domain-service.js";

type RedactableSource =
  | { kind: "wiki"; resource: StoredWiki; ref: ResourceRef; content: string }
  | { kind: "skill"; resource: StoredSkill; ref: ResourceRef; content: string };

/**
 * Performs the deliberately narrow, irreversible redaction operation. It
 * only removes known secret patterns already present in a Room-scoped
 * Knowledge or Skill Resource. The request does not carry a literal that
 * could itself become another persisted secret.
 */
export class ResourceRedactionDomainService {
  constructor(
    private readonly dependencies: {
      wiki: WikiDomainService;
      skill: SkillDomainService<StoredSkill>;
      roomAuthorization: RoomAuthorizationService;
    }
  ) {}

  async redact(context: TrustedDomainContext, input: ResourceRedactInput): Promise<ResourceRedactionValue> {
    const source = await this.loadSource(context, input.resource_kind, input.resource_id);
    const redactedContent = redactKnownSecretText(source.content);
    if (redactedContent === source.content) {
      throw new DomainOperationError("conflict", "resource_redact_no_known_secret_detected");
    }
    if (source.kind === "wiki") {
      const result = await this.dependencies.wiki.runWikiMutation({
        trustedContext: context,
        operationName: "resource.redact",
        inputSummary: `Redact known secret patterns from Knowledge ${source.resource.title}.`,
        proposedEffects: ["Remove detected secret-like values without retaining their original text in rollback evidence."],
        targetResourceRefs: [source.ref],
        execute: async () => {
          let saved: StoredWiki | undefined;
          try {
            saved = await this.dependencies.wiki.updateWikiPage({
              id: source.resource.id,
              content: redactedContent,
              expected_resource_version: input.expected_resource_version
            });
          } catch (error) {
            throw this.dependencies.wiki.mapWikiWriteError(error);
          }
          if (!saved) throw this.dependencies.wiki.wikiPageNotFoundError(source.resource.id);
          return {
            resource: saved,
            ref: wikiRef(saved),
            summary: `Redacted known secret patterns from Knowledge ${saved.title}.`
          };
        }
      });
      return redactionValue("wiki", wikiRef(result.resource), result.resource.resource_version, result);
    }
    const result = await this.dependencies.skill.runSkillMutation<StoredSkill>({
      trustedContext: context,
      operationName: "resource.redact",
      inputSummary: `Redact known secret patterns from Skill ${source.resource.title}.`,
      proposedEffects: ["Remove detected secret-like values without retaining their original text in rollback evidence."],
      targetResourceRefs: [source.ref],
      execute: async () => {
        let saved: StoredSkill | undefined;
        try {
          saved = await this.dependencies.skill.patchSkillRecord({
            id: source.resource.id,
            content: redactedContent,
            expected_resource_version: input.expected_resource_version
          });
        } catch (error) {
          throw this.dependencies.skill.mapSkillWriteError(error);
        }
        if (!saved) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
        return {
          resource: saved,
          ref: skillRef(saved),
          summary: `Redacted known secret patterns from Skill ${saved.title}.`
        };
      }
    });
    return redactionValue("skill", skillRef(result.resource), requiredVersion(result.resource.resource_version), result);
  }

  private async loadSource(
    context: TrustedDomainContext,
    resourceKind: TransferableResourceKind,
    resourceId: string
  ): Promise<RedactableSource> {
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
        throw new DomainOperationError("source_not_allowed", `resource_redact_authorization_denied:${error.reason}`);
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
        throw new DomainOperationError("conflict", "resource_redact_source_room_scope_required");
      }
      return { kind: "wiki", resource, ref: wikiRef(resource), content };
    }
    const [resource, content] = await Promise.all([
      this.dependencies.skill.getSkillForMutation(resourceId),
      this.dependencies.skill.readSkillMarkdown(resourceId)
    ]);
    if (!resource || content === undefined) throw this.dependencies.skill.skillMutationNotFound("skill_not_found");
    if (sourceRoomScope(resource, "skill") !== access.roomId) {
      throw new DomainOperationError("conflict", "resource_redact_source_room_scope_required");
    }
    return { kind: "skill", resource, ref: skillRef(resource), content };
  }
}

function requiredRoomAccess(context: TrustedDomainContext): { roomId: string; participant: ParticipantPrincipal } {
  if (!context.roomId || !context.participant || context.participant.kind === "system") {
    throw new DomainOperationError("source_not_allowed", "resource_redact_room_participant_required");
  }
  return { roomId: context.roomId, participant: context.participant };
}

function sourceRoomScope(resource: StoredWiki | StoredSkill, kind: TransferableResourceKind): string {
  const scope: UsageScopeRef | undefined = kind === "wiki"
    ? (resource as StoredWiki).usage_scope
    : (resource as StoredSkill).frontmatter.usage_scope;
  if (scope?.kind !== "room") {
    throw new DomainOperationError("conflict", "resource_redact_source_room_scope_required");
  }
  return scope.room_id;
}

function wikiRef(resource: StoredWiki): ResourceRef {
  return { kind: "wiki", id: resource.id, uri: resource.file_path, label: resource.title, version: String(resource.resource_version) };
}

function skillRef(resource: StoredSkill): ResourceRef {
  return { kind: "skill", id: resource.id, uri: resource.file_path, label: resource.title, version: String(requiredVersion(resource.resource_version)) };
}

function requiredVersion(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new DomainOperationError("conflict", "resource_redact_resource_version_missing");
  }
  return value;
}

function redactionValue(
  resourceKind: TransferableResourceKind,
  redactedResource: ResourceRef,
  resourceVersion: number,
  result: Pick<ResourceRedactionValue, "operation" | "activity">
): ResourceRedactionValue {
  return resourceRedactionValueSchema.parse({
    resource: {
      resource_kind: resourceKind,
      redacted_resource: redactedResource,
      resource_version: requiredVersion(resourceVersion),
      redaction_mode: "known_secret_patterns"
    },
    operation: result.operation,
    activity: result.activity
  });
}

function redactKnownSecretText(value: string): string {
  const withoutPrivateKeyBlocks = value.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted private key]"
  );
  return redactPrivateData(withoutPrivateKeyBlocks)
    .replace(/\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}\b/g, "[redacted]");
}
