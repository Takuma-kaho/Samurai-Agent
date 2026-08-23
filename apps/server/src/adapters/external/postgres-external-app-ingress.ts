import { createHash } from "node:crypto";
import {
  ExternalAppConnectionRecordSchema,
  ActivityRecordSchema,
  type ExternalAppConnectionRecord,
  type JsonValue,
  type TrustedWorkspaceContext
} from "@samurai-agent/core-schemas";
import {
  getDomainCommandEntry,
  getDomainQueryEntry,
  type DomainCommandEntry,
  type DomainQueryEntry
} from "@samurai-agent/action-catalog";
import {
  ExternalAppContextResolver,
  ExternalAppIngress,
  type ActivityIngestPort,
  type DomainCommandRuntimeResult,
  type DomainQueryRuntimeResult,
  type TrustedDomainRuntimeContext
} from "@samurai-agent/runtime";
import type { ActivityRecord } from "@samurai-agent/core-schemas";
import type { ParticipantPrincipal } from "@samurai-agent/room-permissions";
import {
  WorkspaceServerError,
  createInternalWorkspaceConnectionCaller,
  type WorkspaceCompletionService,
  type WorkspaceFileStore,
  type WorkspaceRequestContext,
  type WorkspaceServerCommandService,
  type WorkspaceExternalRoomAction,
  type WorkspaceExternalRoomPrincipal,
  type WorkspaceConnectionDescriptor
} from "@samurai-agent/workspace-server";
import { PostgresArtifact } from "../runtime/postgres-artifact";
import { PostgresCollection } from "../runtime/postgres-collection";
import { PostgresKnowledgeMemory } from "../runtime/postgres-knowledge-memory";
import { PostgresKnowledgeWiki } from "../runtime/postgres-knowledge-wiki";
import { currentPostgresExternalIntegrationContext } from "./postgres-external-integration-store";

type ExternalRoomPrincipal = {
  kind: "human" | "agent";
  participantId?: string;
  agentId?: string;
  requestedByParticipantId?: string;
};

/** PostgreSQL Connection authority used by OAuth and the formal External App
 * ingress. It reads only the server-owned descriptor and turns an expired or
 * malformed descriptor into a deny result; it never creates Room membership. */
export class PostgresExternalConnectionLookup {
  constructor(private readonly commands: WorkspaceServerCommandService) {}

  async getExternalAppConnection(id: string): Promise<ExternalAppConnectionRecord | undefined>;
  async getExternalAppConnection(input: { workspaceId: string; connectionId: string }): Promise<ExternalAppConnectionRecord | undefined>;
  async getExternalAppConnection(value: string | { workspaceId: string; connectionId: string }): Promise<ExternalAppConnectionRecord | undefined> {
    const connectionId = typeof value === "string" ? value : value.connectionId;
    const descriptor = await this.commands.getExternalConnectionDescriptor({ id: connectionId });
    if (!descriptor || (typeof value !== "string" && descriptor.workspaceId !== value.workspaceId)) return undefined;
    return connectionFromDescriptor(descriptor);
  }

  async getExternalAppConnectionByConnector(input: { workspaceId: string; connectorId: string }): Promise<ExternalAppConnectionRecord | undefined> {
    const descriptor = await this.commands.getExternalConnectionDescriptor(input);
    return descriptor ? connectionFromDescriptor(descriptor) : undefined;
  }

}

/** Room permission adapter for the formal ingress. Human delegation uses the
 * normal Room function; Agent delegation uses the separate Agent permission
 * function and still requires the requesting human to remain readable. */
export class PostgresExternalRoomAuthorization {
  constructor(
    private readonly commands: WorkspaceServerCommandService,
    private readonly workspaceId?: string
  ) {}

  private requiredWorkspaceId(): string {
    const workspaceId = this.workspaceId ?? currentPostgresExternalIntegrationContext().workspaceId;
    if (!workspaceId) throw new Error("external_app_workspace_required");
    return workspaceId;
  }

  async assertRoom(principal: ParticipantPrincipal | ExternalRoomPrincipal, roomId: string, action: WorkspaceExternalRoomAction): Promise<void> {
    const normalizedPrincipal = normalizeRoomPrincipal(principal);
    if (normalizedPrincipal.kind === "system") throw new Error("external_app_system_principal_denied");
    if (normalizedPrincipal.kind === "external_app") {
      return this.assertRoom(normalizedPrincipal.delegatedBy, roomId, action);
    }
    const workspaceId = this.requiredWorkspaceId();
    const externalPrincipal: WorkspaceExternalRoomPrincipal = normalizedPrincipal.kind === "human"
      ? { kind: "human", participantId: normalizedPrincipal.participantId }
      : { kind: "agent", agentId: normalizedPrincipal.agentId, requestedByParticipantId: normalizedPrincipal.requestedByParticipantId };
    const allowed = await this.commands.canExternalRoomAccess({ workspaceId, roomId, principal: externalPrincipal, action });
    if (!allowed) throw new Error("external_app_room_permission_denied");
  }

  /** The resolver supplies the Workspace ID to a new adapter instance before
   * each formal call. Keeping it explicit prevents a room ID from selecting a
   * tenant. */
  withWorkspace(workspaceId: string): PostgresExternalRoomAuthorization {
    return new PostgresExternalRoomAuthorization(this.commands, workspaceId);
  }

}

export interface PostgresExternalAppIngressDependencies {
  files: WorkspaceFileStore;
  commands: WorkspaceServerCommandService;
  completion: WorkspaceCompletionService;
  knowledgeWiki: PostgresKnowledgeWiki;
  knowledgeMemory: PostgresKnowledgeMemory;
  collections: PostgresCollection;
  artifacts: PostgresArtifact;
}

/** PG implementation of the Core09 formal ingress. The MCP adapter reaches
 * this class only through ExternalAppIngress; it does not receive a Store or
 * filesystem capability. */
export class PostgresExternalAppIngressFactory {
  private readonly connections: PostgresExternalConnectionLookup;
  private readonly authorization: PostgresExternalRoomAuthorization;

  constructor(private readonly dependencies: PostgresExternalAppIngressDependencies) {
    this.connections = new PostgresExternalConnectionLookup(dependencies.commands);
    this.authorization = new PostgresExternalRoomAuthorization(dependencies.commands);
  }

  create(workspaceId: string): ExternalAppIngress {
    const authorization = this.authorization.withWorkspace(workspaceId);
    const resolver = new ExternalAppContextResolver({
      workspaceId,
      connections: this.connections,
      roomAuthorization: authorization
    });
    const activityIngest = new PostgresExternalActivityIngest(this.dependencies, authorization);
    return new ExternalAppIngress({
      resolver,
      runtime: {
        runDomainQuery: (input, trusted) => this.runQuery(input, trusted, workspaceId, authorization),
        runDomainCommand: (input, trusted) => this.runCommand(input, trusted, workspaceId, authorization)
      },
      activityIngest
    });
  }

  connectionLookup(): PostgresExternalConnectionLookup {
    return this.connections;
  }

  private async runQuery(
    input: { query_id: string; payload?: unknown; input_source: "external_app" },
    trusted: TrustedDomainRuntimeContext,
    workspaceId: string,
    authorization: PostgresExternalRoomAuthorization
  ): Promise<DomainQueryRuntimeResult> {
    const entry = getDomainQueryEntry(input.query_id);
    if (!entry || entry.availability !== "active" || !entry.allowed_sources.includes("external_app")) {
      throw new Error(`domain_query_not_available:${input.query_id}`);
    }
    const payload = objectValue(input.payload);
    const roomId = requiredRoom(trusted);
    await authorization.assertRoom(trusted.participant!, roomId, "read");
    const context = requestContext(trusted, workspaceId);
    let result: unknown;
    switch (input.query_id) {
      case "workspace.context.get":
        result = await this.workspaceContext(context, roomId);
        break;
      case "room.view":
        result = await this.roomView(context, roomId);
        break;
      case "wiki.search":
        result = await this.wikiSearch(context, roomId, payload);
        break;
      case "memory.search":
        result = await this.memorySearch(context, roomId, payload);
        break;
      case "skill.search":
        result = await this.skillSearch(context, roomId, payload);
        break;
      case "file.read":
        result = await this.fileRead(context, roomId, requiredString(payload.path, "path"));
        break;
      case "file.list":
        result = await this.fileList(context, roomId, requiredString(payload.path, "path"));
        break;
      case "file.inspect":
        result = await this.fileInspect(context, roomId, requiredString(payload.path, "path"));
        break;
      case "collection.search":
        result = await this.collectionSearch(context, roomId, payload);
        break;
      case "collection.schema.get":
        result = await this.dependencies.collections.getSchema(context, roomId, requiredString(payload.collection_id, "collection_id"));
        break;
      case "collection.records.list":
        result = await this.dependencies.collections.listRecords(context, roomId, requiredString(payload.collection_id, "collection_id"));
        break;
      case "activity.history.list":
        result = await this.activityList(context, roomId, payload);
        break;
      case "resource.version.get":
        result = await this.resourceVersion(context, roomId, payload);
        break;
      default:
        throw new Error(`domain_query_not_connected:${input.query_id}`);
    }
    return runtimeResult("query", entry, input.query_id, payload, result, trusted.correlationId);
  }

  private async runCommand(
    input: { command_id: string; payload?: unknown; input_source: "external_app"; idempotency_key: string },
    trusted: TrustedDomainRuntimeContext,
    workspaceId: string,
    authorization: PostgresExternalRoomAuthorization
  ): Promise<DomainCommandRuntimeResult> {
    const entry = getDomainCommandEntry(input.command_id);
    if (!entry || entry.availability !== "active" || !entry.allowed_sources.includes("external_app")) {
      throw new Error(`domain_command_not_available:${input.command_id}`);
    }
    const payload = objectValue(input.payload);
    const roomId = requiredRoom(trusted);
    await authorization.assertRoom(trusted.participant!, roomId, "execute");
    const context = requestContext(trusted, workspaceId, input.idempotency_key);
    let result: unknown;
    const ids: string[] = [];
    switch (input.command_id) {
      case "artifact.create": {
        const created = await this.dependencies.artifacts.create(context, {
          roomId,
          title: requiredString(payload.title, "title"),
          content: requiredString(payload.content, "content"),
          ...(stringValue(payload.kind) ? { kind: payload.kind as never } : {}),
          ...(stringValue(payload.output_locale) ? { locale: payload.output_locale as never } : {}),
          ...(objectValue(payload.metadata) ? { metadata: payload.metadata as Record<string, JsonValue> } : {})
        });
        result = created;
        ids.push(created.artifact.id);
        break;
      }
      case "artifact.revise": {
        const saved = await this.dependencies.artifacts.revise(context, {
          roomId,
          artifactId: requiredString(payload.artifact_id, "artifact_id"),
          content: requiredString(payload.content, "content"),
          baseRevisionId: stringValue(payload.base_revision_id),
          expectedRevision: numberValue(payload.expected_revision),
          editorSource: stringValue(payload.editor_source) as never,
          changeSummary: stringValue(payload.change_summary),
          provenance: objectValue(payload.provenance) as Record<string, JsonValue> | undefined,
          extension: stringValue(payload.extension)
        });
        result = { artifact: saved.artifact, revision: saved.revision };
        ids.push(saved.artifact.id, saved.revision.id);
        break;
      }
      case "artifact.restore_revision": {
        const saved = await this.dependencies.artifacts.restoreRevision(context, {
          roomId,
          artifactId: requiredString(payload.artifact_id, "artifact_id"),
          revisionId: requiredString(payload.revision_id, "revision_id"),
          baseRevisionId: stringValue(payload.base_revision_id),
          expectedRevision: numberValue(payload.expected_revision),
          changeSummary: stringValue(payload.change_summary)
        });
        result = { artifact: saved.artifact, revision: saved.revision };
        ids.push(saved.artifact.id, saved.revision.id);
        break;
      }
      case "collection.schema.save": {
        const collection = await this.dependencies.collections.saveSchema(context, roomId, payload as never, numberValue(payload.expected_resource_version));
        const { replayed, ...resource } = collection;
        result = { resource, replayed };
        ids.push(collection.id);
        break;
      }
      case "collection.record.create": {
        const record = await this.dependencies.collections.createRecord(context, roomId, {
          id: stringValue(payload.record_id) ?? createStableId("collection_record", context.operationId),
          collection_id: requiredString(payload.collection_id, "collection_id"),
          data: objectValue(payload.data) as never,
          resource_refs: Array.isArray(payload.resource_refs) ? payload.resource_refs as never : [],
          version: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        ids.push(`${record.collection_id}:${record.id}`);
        break;
      }
      case "collection.patch.apply": {
        const record = await this.dependencies.collections.applyPatch(context, roomId, requiredString(payload.collection_id, "collection_id"), requiredString(payload.record_id, "record_id"), {
          id: stringValue(payload.patch_id),
          changes: objectValue(payload.changes) as never,
          expected_version: numberValue(payload.expected_version)
        });
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        ids.push(`${record.collection_id}:${record.id}`);
        break;
      }
      case "collection.record.delete": {
        const record = await this.dependencies.collections.deleteRecord(context, roomId, requiredString(payload.collection_id, "collection_id"), requiredString(payload.record_id, "record_id"), requiredNumber(payload.expected_version, "expected_version"));
        const { replayed, ...resource } = record;
        result = { resource, replayed };
        ids.push(`${record.collection_id}:${record.id}`);
        break;
      }
      case "wiki.proposal.create": {
        const created = await this.dependencies.commands.createCompletionResource(context, {
          scope: { kind: "room", roomId },
          kind: "knowledge",
          knowledgeKind: "explanation",
          title: requiredString(payload.title, "title"),
          content: requiredString(payload.content, "content"),
          metadata: {
            wiki: true,
            wiki_state: "proposed",
            slug: stringValue(payload.slug) ?? requiredString(payload.title, "title").toLowerCase().replace(/[^a-z0-9一-龯ぁ-んァ-ヶ]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160),
            tags: Array.isArray(payload.tags) ? payload.tags.filter((value): value is string => typeof value === "string") : [],
            content_locale: stringValue(payload.content_locale) ?? "ja"
          },
          reason: "External App Wiki proposal"
        });
        result = { resource: created.resource };
        ids.push(created.resource.id);
        break;
      }
      case "wiki.patch": {
        const id = requiredString(payload.wiki_id, "wiki_id");
        const current = await this.dependencies.knowledgeWiki.get(context, id);
        assertExpectedVersion(payload.expected_resource_version, Number(current.wiki.version));
        const saved = await this.dependencies.commands.updateCompletionResource(context, id, {
          scope: current.scope,
          kind: "knowledge",
          knowledgeKind: current.wiki.knowledge_kind === "experience_rule" ? "experience_rule" : "explanation",
          title: stringValue(payload.title) ?? current.wiki.title,
          content: stringValue(payload.content) ?? current.content,
          metadata: { ...current.metadata, ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}) },
          reason: "External App Wiki patch",
          expectedVersion: Number(current.wiki.version)
        });
        result = { resource: saved.resource, wiki: await this.dependencies.knowledgeWiki.get(context, id) };
        ids.push(id);
        break;
      }
      case "wiki.archive": {
        const id = requiredString(payload.wiki_id, "wiki_id");
        const current = await this.dependencies.knowledgeWiki.get(context, id);
        assertExpectedVersion(payload.expected_resource_version, Number(current.wiki.version));
        const saved = await this.dependencies.commands.setCompletionResourceArchived(context, { resourceId: id, archived: true, expectedVersion: Number(current.wiki.version), reason: "External App Wiki archive" });
        result = { resource: saved.resource, wiki: await this.dependencies.knowledgeWiki.get(context, id) };
        ids.push(id);
        break;
      }
      case "skill.patch": {
        const id = requiredString(payload.skill_id, "skill_id");
        const current = await this.dependencies.completion.getSkillDocument(context, id);
        assertExpectedVersion(payload.expected_resource_version, current.resource.version);
        const support = await this.dependencies.completion.listSkillFiles(context, id, current.version.version, 200);
        const supportFiles = await Promise.all(support.map(async (file) => ({ path: file.relativePath, content: await this.dependencies.completion.getSkillFile(context, id, file.relativePath, current.version.version).then((value) => value.content) })));
        const metadata = {
          ...current.version.metadata,
          skill: true,
          ...(stringValue(payload.description) ? { description: payload.description } : {}),
          ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
          ...(typeof payload.pinned === "boolean" ? { pinned: payload.pinned } : {})
        };
        const saved = await this.dependencies.commands.updateCompletionResource(context, id, {
          scope: current.resource.scope,
          kind: "skill",
          title: stringValue(payload.title) ?? current.resource.title,
          content: stringValue(payload.content) ?? current.content,
          metadata,
          reason: "External App Skill patch",
          expectedVersion: current.version.version,
          supportFiles
        });
        result = { resource: saved.resource };
        ids.push(id);
        break;
      }
      case "skill.candidate.create": {
        const title = requiredString(payload.title, "title");
        const content = requiredString(payload.content, "content");
        const sourceRefs = Array.isArray(payload.source_refs) ? payload.source_refs : [];
        const evidenceActivityIds = sourceRefs.flatMap((value): string[] => {
          const item = objectValue(value);
          const activityId = stringValue(item.activity_id);
          return activityId ? [activityId] : [];
        });
        const created = await this.dependencies.commands.createCompletionResource(context, {
          scope: { kind: "room", roomId },
          kind: "skill",
          title,
          content,
          metadata: {
            when: "External Appから候補作成を依頼されたとき",
            inputs: "External Appが提供した入力",
            preconditions: "同じRoomのexecute権限と接続の有効性が確認されていること",
            steps: ["候補本文を確認する", "必要なら修正してから利用する"],
            completion: "人が候補を確認し、再利用可能なSkillとして扱えること",
            failure: "失敗理由をActivityに残し、候補を自動公開しないこと",
            knowledge_ids: sourceRefs.flatMap((value) => {
              const item = objectValue(value);
              return stringValue(item.id) ? [item.id] : [];
            }),
            skill_state: "candidate",
            description: stringValue(payload.description) ?? "",
            tags: Array.isArray(payload.tags) ? payload.tags.filter((value): value is string => typeof value === "string") : [],
            required_capabilities: Array.isArray(payload.required_capabilities) ? payload.required_capabilities.filter((value): value is string => typeof value === "string") : [],
            source_refs: sourceRefs as never
          },
          reason: "External App Skill candidate",
          ...(evidenceActivityIds.length > 0 ? { evidenceActivityIds } : {})
        });
        result = { resource: created.resource };
        ids.push(created.resource.id);
        break;
      }
      case "resource.copy": {
        const id = requiredString(payload.resource_id, "resource_id");
        const kind = requiredString(payload.resource_kind, "resource_kind");
        const targetRoomId = requiredString(payload.target_room_id, "target_room_id");
        const targetResourceId = stringValue(payload.target_resource_id);
        await authorization.assertRoom(trusted.participant!, targetRoomId, "edit");
        const copied = await this.dependencies.completion.copyResource(context, {
          resourceId: id,
          targetScope: { kind: "room", roomId: targetRoomId },
          ...(targetResourceId ? { targetResourceId } : {}),
          expectedVersion: requiredNumber(payload.expected_resource_version, "expected_resource_version"),
          reason: requiredString(payload.reason, "reason")
        });
        result = { resource: copied.resource, resource_kind: kind };
        ids.push(copied.resource.id);
        break;
      }
      case "resource.move": {
        const id = requiredString(payload.resource_id, "resource_id");
        const targetRoomId = requiredString(payload.target_room_id, "target_room_id");
        const targetResourceId = stringValue(payload.target_resource_id);
        await authorization.assertRoom(trusted.participant!, targetRoomId, "edit");
        const moved = await this.dependencies.completion.moveResource(context, {
          resourceId: id,
          targetRoomId,
          ...(targetResourceId ? { targetResourceId } : {}),
          expectedVersion: requiredNumber(payload.expected_resource_version, "expected_resource_version"),
          reason: requiredString(payload.reason, "reason")
        });
        result = { resource: moved.resource };
        ids.push(moved.resource.id);
        break;
      }
      case "resource.promote": {
        const id = requiredString(payload.resource_id, "resource_id");
        const targetResourceId = stringValue(payload.target_resource_id);
        const promoted = await this.dependencies.completion.promoteToWorkspace(context, {
          resourceId: id,
          ...(targetResourceId ? { targetResourceId } : {}),
          expectedVersion: requiredNumber(payload.expected_resource_version, "expected_resource_version"),
          reason: requiredString(payload.reason, "reason")
        });
        result = { resource: promoted.resource };
        ids.push(promoted.resource.id);
        break;
      }
      case "resource.redact": {
        const id = requiredString(payload.resource_id, "resource_id");
        const current = await this.dependencies.completion.getResource(context, id);
        assertExpectedVersion(payload.expected_resource_version, current.resource.version);
        result = await this.dependencies.completion.redactResource(context, { resourceId: id, reason: requiredString(payload.reason, "reason") });
        ids.push(id);
        break;
      }
      case "policy.change.request":
      case "profile.change.request":
      case "soul.change.request": {
        const summary = safeHumanChangeText(payload.proposed_change_summary, "proposed_change_summary");
        const affectedFields = Array.isArray(payload.affected_fields)
          ? payload.affected_fields.map((value) => safeHumanChangeText(value, "affected_fields"))
          : [];
        const requestKind = input.command_id.slice(0, input.command_id.indexOf(".")) as "policy" | "profile" | "soul";
        const activity = await this.dependencies.commands.ingestCompletionActivity(context, {
          id: `completion_activity_${hash(`${context.workspaceId}|human-change|${input.idempotency_key}`)}`,
          roomId,
          sourceApp: `external-app:${trusted.source?.app_id ?? "unknown"}`,
          sourceId: input.command_id,
          operationId: context.operationId,
          instructionSummary: `Human ${requestKind} change request: ${summary}`,
          resultSummary: `人の確認が必要な${requestKind}変更要求を記録しました。`,
          changedResources: [requestKind],
          verificationOutcome: "confirmed",
          failureState: "none",
          outcome: "completed",
          payload: { request_kind: requestKind, proposed_change_summary: summary, affected_fields: affectedFields }
        });
        result = { request_kind: requestKind, status: "requested", proposed_change_summary: summary, affected_fields: affectedFields, activity: activity.activity };
        ids.push(activity.activity.id);
        break;
      }
      default:
        throw new Error(`domain_command_not_connected:${input.command_id}`);
    }
    await this.recordDomainActivity(context, trusted, input.command_id, input.idempotency_key, ids);
    return runtimeResult("command", entry, input.command_id, payload, result, trusted.correlationId);
  }

  private async workspaceContext(context: WorkspaceRequestContext, roomId: string): Promise<Record<string, unknown>> {
    const [workspace, rooms, wiki, memory] = await Promise.all([
      this.dependencies.commands.getWorkspace(context),
      this.dependencies.commands.listRooms(context),
      this.dependencies.knowledgeWiki.list(context, roomId, false),
      this.dependencies.knowledgeMemory.list(context, roomId, false)
    ]);
    const room = rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new WorkspaceServerError("room_not_found_or_access_denied", 404);
    return {
      workspace: { name: workspace.name, rules: [] },
      room: {
        id: room.id,
        name: room.name,
        permissions: ["read"],
        prohibited: []
      },
      resources: [...wiki.map((page) => knowledgeItem(page)), ...memory.map((page) => memoryItem(page))].slice(0, 16)
    };
  }

  private async roomView(context: WorkspaceRequestContext, roomId: string): Promise<Record<string, unknown>> {
    const room = (await this.dependencies.commands.listRooms(context)).find((candidate) => candidate.id === roomId);
    if (!room) throw new WorkspaceServerError("room_not_found_or_access_denied", 404);
    return { id: room.id, name: room.name, ...(room.parentRoomId ? { parent_room_id: room.parentRoomId } : {}) };
  }

  private async wikiSearch(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = stringValue(payload.query)?.toLocaleLowerCase() ?? "";
    const pages = await this.dependencies.knowledgeWiki.list(context, roomId, false);
    return { items: pages.filter((page) => !query || `${page.wiki.title} ${page.wiki.slug} ${page.content}`.toLocaleLowerCase().includes(query)).slice(offsetOf(payload), offsetOf(payload) + limitOf(payload)).map(knowledgeItem) };
  }

  private async memorySearch(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = stringValue(payload.query) ?? "";
    const memories = await this.dependencies.knowledgeMemory.search(context, roomId, query, Math.min(200, limitOf(payload) + offsetOf(payload)));
    return { items: memories.slice(offsetOf(payload), offsetOf(payload) + limitOf(payload)).map(memoryItem) };
  }

  private async skillSearch(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const page = await this.dependencies.completion.searchSkillsPage(context, { roomId, query: stringValue(payload.query) ?? "", limit: Math.min(200, limitOf(payload) + offsetOf(payload)) });
    const items = await Promise.all(page.items.slice(offsetOf(payload), offsetOf(payload) + limitOf(payload)).map(async (resource) => {
      const body = await this.dependencies.completion.getSkillDocument(context, resource.id);
      return {
        id: resource.id,
        title: resource.title,
        description: stringValue(body.version.metadata.description) ?? "",
        version: body.version.version,
        updated_at: resource.updatedAt,
        file_path: body.version.filePath,
        metadata: body.version.metadata
      };
    }));
    return { items };
  }

  private async collectionSearch(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = (stringValue(payload.query) ?? "").toLocaleLowerCase();
    const schemas = await this.dependencies.collections.listSchemas(context, roomId);
    return { items: schemas.filter((schema) => !query || JSON.stringify(schema).toLocaleLowerCase().includes(query)).slice(offsetOf(payload), offsetOf(payload) + limitOf(payload)).map((schema) => ({ id: schema.id, title: labelFor(schema.labels) ?? schema.id, version: schema.resource_version, updated_at: new Date().toISOString(), file_path: schema.file_path, schema })) };
  }

  private async fileRead(context: WorkspaceRequestContext, roomId: string, filePath: string): Promise<Record<string, unknown>> {
    await this.assertKnownFile(context, roomId, filePath);
    const file = await this.dependencies.files.read(context, { roomId, path: filePath });
    return { content: file.content.toString("utf8"), file_path: filePath, version: file.file.version, content_hash: file.file.sha256 };
  }

  private async fileList(context: WorkspaceRequestContext, roomId: string, root: string): Promise<Record<string, unknown>> {
    if (!root.startsWith("artifacts")) return { resource: { entries: [] } };
    const artifacts = await this.dependencies.artifacts.list(context, roomId);
    return { resource: { entries: artifacts.filter((artifact) => artifact.file_ref.uri === root || root === "artifacts" || artifact.file_ref.uri.startsWith(`${root.replace(/\/$/, "")}/`)).map((artifact) => ({ path: artifact.file_ref.uri, label: artifact.title, size: numberValue(artifact.metadata.byte_size) ?? 0 })) } };
  }

  private async fileInspect(context: WorkspaceRequestContext, roomId: string, filePath: string): Promise<Record<string, unknown>> {
    const artifacts = await this.dependencies.artifacts.list(context, roomId);
    const match = artifacts.find((artifact) => artifact.file_ref.uri === filePath);
    if (!match) throw new WorkspaceServerError("workspace_file_not_found", 404);
    return { resource: { path: filePath, provenance: { artifact_ids: [match.id] } } };
  }

  private async assertKnownFile(context: WorkspaceRequestContext, roomId: string, filePath: string): Promise<void> {
    if (filePath.startsWith("artifacts/")) {
      if (!(await this.dependencies.artifacts.list(context, roomId)).some((artifact) => artifact.file_ref.uri === filePath)) throw new WorkspaceServerError("workspace_file_not_found", 404);
      return;
    }
    const [wiki, memory, skills, collections] = await Promise.all([
      this.dependencies.knowledgeWiki.list(context, roomId, true),
      this.dependencies.knowledgeMemory.list(context, roomId, true),
      this.dependencies.completion.listSkills(context, { roomId, limit: 200 }),
      this.dependencies.collections.listSchemas(context, roomId)
    ]);
    const skillPaths = await Promise.all(skills.map(async (skill) => {
      const document = await this.dependencies.completion.getSkillDocument(context, skill.id);
      const support = await this.dependencies.completion.listSkillFiles(context, skill.id, document.version.version, 200);
      return [document.version.filePath, ...support.map((file) => file.filePath)];
    }));
    const known = [
      ...wiki.map((page) => page.wiki.file_path),
      ...memory.map((page) => page.memory.file_path),
      ...skillPaths.flat(),
      ...collections.map((schema) => schema.file_path)
    ];
    if (!known.includes(filePath)) throw new WorkspaceServerError("workspace_file_not_found", 404);
  }

  private async activityList(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const activities = await this.dependencies.commands.listCompletionActivities(context, {
      roomId,
      ...(stringValue(payload.activity_id) ? { activityId: stringValue(payload.activity_id) } : {}),
      ...(stringValue(payload.source_kind) ? { sourceApp: stringValue(payload.source_kind) } : {}),
      ...(stringValue(payload.source_id) ? { sourceId: stringValue(payload.source_id) } : {}),
      ...(stringValue(payload.status) ? { outcome: stringValue(payload.status) } : {}),
      limit: limitOf(payload),
      offset: offsetOf(payload)
    });
    return {
      items: activities.map((activity) => ({
        id: activity.id,
        room_id: activity.roomId,
        source_app: activity.sourceApp,
        ...(activity.sourceId ? { source_id: activity.sourceId } : {}),
        ...(activity.operationId ? { operation_id: activity.operationId } : {}),
        instruction_summary: activity.instructionSummary,
        ...(activity.resultSummary ? { result_summary: activity.resultSummary } : {}),
        changed_resources: [...activity.changedResources],
        verification_outcome: activity.verificationOutcome,
        failure_state: activity.failureState,
        outcome: activity.outcome,
        payload: activity.payload,
        created_at: activity.createdAt,
        finalized_at: activity.finalizedAt,
        occurred_at: activity.finalizedAt || activity.createdAt
      }))
    };
  }

  private async resourceVersion(context: WorkspaceRequestContext, roomId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const kind = requiredString(payload.resource_kind, "resource_kind");
    const id = requiredString(payload.resource_id, "resource_id");
    if (kind === "wiki") {
      const page = await this.dependencies.knowledgeWiki.get(context, id);
      return { resource_key: `${kind}:${id}`, version: Number(page.wiki.version) };
    }
    if (kind === "memory") {
      const page = await this.dependencies.knowledgeMemory.get(context, id);
      return { resource_key: `${kind}:${id}`, version: Number(page.memory.version) };
    }
    if (kind === "skill") {
      const skill = await this.dependencies.completion.getResource(context, id);
      return { resource_key: `${kind}:${id}`, version: skill.resource.version };
    }
    if (kind === "collection_schema") {
      const schema = await this.dependencies.collections.getSchema(context, roomId, id);
      return { resource_key: `${kind}:${id}`, version: schema.resource_version };
    }
    if (kind === "collection_record") {
      const collectionId = requiredString(payload.collection_id, "collection_id");
      const record = await this.dependencies.collections.getRecord(context, roomId, collectionId, id);
      return { resource_key: `${kind}:${collectionId}:${id}`, version: record.version ?? 1 };
    }
    if (kind === "artifact") {
      const record = await this.dependencies.commands.getRecord(context, { roomId, recordType: "artifact", id });
      return { resource_key: `${kind}:${id}`, version: record.version };
    }
    throw new WorkspaceServerError("workspace_resource_version_invalid", 400);
  }

  private async recordDomainActivity(context: WorkspaceRequestContext, trusted: TrustedDomainRuntimeContext, operation: string, idempotencyKey: string, changedResources: string[]): Promise<void> {
    try {
      await this.dependencies.commands.ingestCompletionActivity(context, {
        id: `completion_activity_${hash(`${context.workspaceId}|${idempotencyKey}|${operation}`)}`,
        roomId: requiredRoom(trusted),
        sourceApp: `external-operation:${trusted.source?.app_id ?? "unknown"}`,
        sourceId: operation,
        operationId: idempotencyKey,
        instructionSummary: `External App Domain Operation: ${operation}`,
        resultSummary: `${operation} completed through the PostgreSQL Core`,
        changedResources,
        verificationOutcome: "confirmed",
        failureState: "none",
        outcome: "completed",
        payload: {
          operation,
          connector_id: trusted.source?.connector_id ?? "",
          connection_id: trusted.connectionId
        }
      });
    } catch {
      throw new Error("external_domain_operation_activity_outcome_unknown");
    }
  }
}

class PostgresExternalActivityIngest implements ActivityIngestPort {
  constructor(
    private readonly dependencies: PostgresExternalAppIngressDependencies,
    private readonly authorization: PostgresExternalRoomAuthorization
  ) {}

  async ingestFinalizedActivity(input: Parameters<ActivityIngestPort["ingestFinalizedActivity"]>[0]): Promise<ActivityRecord> {
    const context = input.context;
    if (!context.room_id) throw new Error("external_app_activity_room_required");
    const accountId = delegatedAccountId(context.principal);
    const request = requestContextFromWorkspaceContext(context, accountId);
    await this.authorization.assertRoom(participantPrincipal(context.principal), context.room_id, "execute");
    const result = await this.dependencies.commands.ingestCompletionActivity(request, {
      id: `completion_activity_${hash(`${context.workspace_id}|${input.idempotencyKey}`)}`,
      roomId: context.room_id,
      sourceApp: `external-app:${context.source.app_id ?? "unknown"}`,
      sourceId: context.source.connector_id,
      operationId: input.idempotencyKey,
      instructionSummary: input.instructionSummary,
      ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      ...(input.correctionOfActivityId ? { correctionOfActivityId: input.correctionOfActivityId } : {}),
      changedResources: (input.resourceUsage ?? []).map((usage) => usage.resource_ref.id),
      verificationOutcome: verificationOutcome(input.verification),
      failureState: input.failure ? "unresolved" : input.status === "completed" ? "none" : "unresolved",
      outcome: input.status === "outcome_unknown" ? "unknown" : input.status,
      payload: {
        external_activity: true,
        connector_id: context.source.connector_id ?? "",
        app_id: context.source.app_id ?? "",
        ...(input.domainOperationIds?.length ? { domain_operation_ids: input.domainOperationIds } : {}),
        ...(input.resourceUsage?.length ? {
          resource_usage: input.resourceUsage.map((usage) => ({
            id: usage.id,
            resource_ref: usage.resource_ref,
            stage: usage.stage,
            ...(usage.resource_version ? { resource_version: usage.resource_version } : {}),
            ...(usage.content_hash ? { content_hash: usage.content_hash } : {})
          }))
        } : {})
      },
      ...(context.session_ref ? { sessionRef: { appId: context.session_ref.app_id, sessionId: context.session_ref.session_id, ...(context.session_ref.turn_id ? { turnId: context.session_ref.turn_id } : {}), ...(context.session_ref.message_id ? { messageId: context.session_ref.message_id } : {}) } } : {})
    });
    const finalizedAt = result.activity.finalizedAt ?? new Date().toISOString();
    return ActivityRecordSchema.parse({
      id: result.activity.id,
      workspace_id: context.workspace_id,
      room_id: context.room_id,
      principal: context.principal,
      source: context.source,
      status: input.status,
      idempotency_key: input.idempotencyKey,
      instruction_summary: input.instructionSummary,
      ...(input.resultSummary ? { result_summary: input.resultSummary } : {}),
      verification: input.verification ?? [],
      ...(input.failure
        ? { failure: input.failure }
        : input.status === "completed"
          ? {}
          : { failure: { code: `external_activity_${input.status}`, summary: `External activity ended with ${input.status}.` } }),
      ...(input.correctionOfActivityId ? { correction_of_activity_id: input.correctionOfActivityId } : {}),
      ...(input.backendRunId ? { backend_run_id: input.backendRunId } : {}),
      domain_operation_ids: input.domainOperationIds ?? [],
      provenance: {
        kind: input.provenanceKind === "system" ? "system" : "domain_operation",
        source_id: context.source.connector_id ?? context.source.app_id,
        recorded_at: result.activity.createdAt
      },
      created_at: result.activity.createdAt,
      updated_at: finalizedAt,
      finalized_at: finalizedAt
    });
  }

  async startActivity(): Promise<never> { throw new Error("external_activity_recording_not_supported"); }
  async linkBackendRun(): Promise<never> { throw new Error("external_activity_backend_link_not_supported"); }
  async recordResourceUsage(): Promise<never> { throw new Error("external_activity_resource_usage_not_supported"); }
  async finalizeActivity(): Promise<never> { throw new Error("external_activity_finalization_not_supported"); }
}

function connectionFromDescriptor(descriptor: WorkspaceConnectionDescriptor): ExternalAppConnectionRecord | undefined {
  if (descriptor.allowedRoomIds.length === 0) return undefined;
  const active = descriptor.status === "active" && !descriptor.revokedAt && new Date(descriptor.expiresAt).getTime() > Date.now();
  const delegatedPrincipal = descriptor.agentId
    ? { kind: "agent" as const, agent_id: descriptor.agentId, requested_by_participant_id: descriptor.principalAccountId }
    : { kind: "human" as const, participant_id: descriptor.principalAccountId };
  const createdBy = descriptor.agentId
    ? { kind: "agent" as const, agent_id: descriptor.agentId, requested_by_participant_id: descriptor.createdBy }
    : { kind: "human" as const, participant_id: descriptor.createdBy };
  const candidate = {
    id: descriptor.id,
    workspace_id: descriptor.workspaceId,
    connector_id: descriptor.connectorId,
    app_id: descriptor.appId,
    status: active ? "active" as const : "revoked" as const,
    delegated_principal: delegatedPrincipal,
    allowed_room_ids: [...descriptor.allowedRoomIds],
    ingress_classes: descriptor.ingressClasses.filter((value): value is "query" | "domain_operation" | "activity_ingest" => value === "query" || value === "domain_operation" || value === "activity_ingest"),
    non_secret_metadata: {},
    created_by: createdBy,
    created_at: descriptor.createdAt,
    updated_at: descriptor.updatedAt,
    ...(active ? {} : { revoked_at: descriptor.revokedAt ?? descriptor.expiresAt })
  };
  const parsed = ExternalAppConnectionRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

function requestContext(trusted: TrustedDomainRuntimeContext, workspaceId: string, operationId = trusted.idempotencyKey ?? trusted.correlationId): WorkspaceRequestContext {
  const accountId = delegatedAccountId(trusted.participant);
  const normalizedOperationId = `external_${hash(`${workspaceId}|${operationId}`)}`;
  const caller = trusted.connectionId
    ? createInternalWorkspaceConnectionCaller({
        principalAccountId: accountId,
        connectionId: trusted.connectionId,
        requestId: `external_request_${hash(`${workspaceId}|${trusted.correlationId}`)}`,
        operationId: normalizedOperationId,
        timestamp: String(Date.now())
      })
    : undefined;
  return { workspaceId, accountId, operationId: normalizedOperationId, ...(caller ? { caller } : {}) };
}

function requestContextFromWorkspaceContext(context: TrustedWorkspaceContext, accountId: string): WorkspaceRequestContext {
  const connectionId = context.connection_id;
  const operationId = `external_${hash(`${context.workspace_id}|${context.correlation_id}`)}`;
  const caller = connectionId ? createInternalWorkspaceConnectionCaller({
    principalAccountId: accountId,
    connectionId,
    requestId: `external_request_${hash(context.correlation_id)}`,
    operationId,
    timestamp: String(Date.now())
  }) : undefined;
  return { workspaceId: context.workspace_id, accountId, operationId, ...(caller ? { caller } : {}) };
}

function runtimeResult(kind: "query", entry: DomainQueryEntry, id: string, payload: Record<string, unknown>, result: unknown, correlationId?: string): DomainQueryRuntimeResult;
function runtimeResult(kind: "command", entry: DomainCommandEntry, id: string, payload: Record<string, unknown>, result: unknown, correlationId?: string): DomainCommandRuntimeResult;
function runtimeResult(kind: "query" | "command", entry: DomainQueryEntry | DomainCommandEntry, id: string, payload: Record<string, unknown>, result: unknown, correlationId = "external"): DomainQueryRuntimeResult | DomainCommandRuntimeResult {
  const base = {
    ok: true as const,
    contract_version: "postgres-external-1",
    execution_id: `external_execution_${hash(`${correlationId}|${id}|${JSON.stringify(payload)}`)}`,
    input_source: "external_app" as const,
    payload: payload as Record<string, JsonValue>,
    render_specs: [],
    result
  };
  if (kind === "query") return {
    ...base,
    query: entry as DomainQueryEntry
  };
  return {
    ...base,
    command: entry as DomainCommandEntry
  };
}

function knowledgeItem(page: { wiki: { id: string; title: string; slug: string; version?: string; updated_at: string; file_path: string; state: string; pinned?: boolean }; content: string }): Record<string, unknown> {
  return { id: page.wiki.id, title: page.wiki.title, slug: page.wiki.slug, summary: page.content.slice(0, 240), ...(page.wiki.version ? { version: numericOrString(page.wiki.version) } : {}), updated_at: page.wiki.updated_at, file_path: page.wiki.file_path, state: page.wiki.state, pinned: page.wiki.pinned === true };
}

function memoryItem(page: { memory: { id: string; topic: string; version?: string; updated_at: string; file_path: string; state: string; pinned?: boolean }; content: string }): Record<string, unknown> {
  return { id: page.memory.id, title: page.memory.topic, summary: page.content.slice(0, 240), ...(page.memory.version ? { version: numericOrString(page.memory.version) } : {}), updated_at: page.memory.updated_at, file_path: page.memory.file_path, state: page.memory.state, pinned: page.memory.pinned === true };
}

function delegatedAccountId(principal: ParticipantPrincipal | TrustedWorkspaceContext["principal"] | undefined): string {
  if (!principal) throw new Error("external_app_principal_missing");
  if (principal.kind === "external_app") {
    const delegated = "delegatedBy" in principal ? principal.delegatedBy : principal.delegated_by;
    return delegated.kind === "human"
      ? ("participantId" in delegated ? delegated.participantId : delegated.participant_id)
      : ("requestedByParticipantId" in delegated ? delegated.requestedByParticipantId : delegated.requested_by_participant_id);
  }
  if (principal.kind === "human") return "participantId" in principal ? principal.participantId : principal.participant_id;
  if (principal.kind === "agent") return "requestedByParticipantId" in principal ? principal.requestedByParticipantId : principal.requested_by_participant_id;
  throw new Error("external_app_principal_invalid");
}

function participantPrincipal(principal: TrustedWorkspaceContext["principal"]): ParticipantPrincipal {
  switch (principal.kind) {
    case "human":
      return { kind: "human", participantId: principal.participant_id };
    case "agent":
      return { kind: "agent", agentId: principal.agent_id, requestedByParticipantId: principal.requested_by_participant_id };
    case "external_app": {
      const delegated = principal.delegated_by.kind === "human"
        ? { kind: "human" as const, participantId: principal.delegated_by.participant_id }
        : { kind: "agent" as const, agentId: principal.delegated_by.agent_id, requestedByParticipantId: principal.delegated_by.requested_by_participant_id };
      return { kind: "external_app", appId: principal.app_id, ...(principal.connector_id ? { connectorId: principal.connector_id } : {}), delegatedBy: delegated };
    }
    case "system":
      return { kind: "system", participantId: principal.system_id };
  }
}

function normalizeRoomPrincipal(principal: ParticipantPrincipal | ExternalRoomPrincipal): ParticipantPrincipal {
  if (principal.kind === "human") {
    const participantId = principal.participantId;
    if (!participantId) throw new Error("external_app_principal_invalid");
    return { kind: "human", participantId };
  }
  if (principal.kind === "agent") {
    const agentId = principal.agentId;
    const requestedByParticipantId = principal.requestedByParticipantId;
    if (!agentId || !requestedByParticipantId) throw new Error("external_app_principal_invalid");
    return { kind: "agent", agentId, requestedByParticipantId };
  }
  if (principal.kind === "external_app" || principal.kind === "system") return principal;
  throw new Error("external_app_principal_invalid");
}

function verificationOutcome(value: unknown): "confirmed" | "failed" | "not_run" | "unknown" {
  if (!Array.isArray(value) || value.length === 0) return "unknown";
  if (value.some((item) => objectValue(item).status === "failed")) return "failed";
  if (value.every((item) => objectValue(item).status === "passed")) return "confirmed";
  if (value.every((item) => objectValue(item).status === "not_run")) return "not_run";
  return "unknown";
}

function labelFor(value: unknown): string | undefined {
  const labels = objectValue(value);
  return stringValue(labels.ja) ?? stringValue(labels.en) ?? Object.values(labels).find((item): item is string => typeof item === "string");
}

function requiredRoom(trusted: TrustedDomainRuntimeContext): string {
  if (!trusted.roomId) throw new Error("external_app_room_required");
  return trusted.roomId;
}

function requiredString(value: unknown, key: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${key}_required`);
  return result;
}

function safeHumanChangeText(value: unknown, key: string): string {
  const text = requiredString(value, key);
  if (text.length > 4_000 || /(?:api[_-]?key|(?:access|refresh)?[_-]?token|secret|password|cookie|authorization)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp)_[A-Za-z0-9_-]{12,}/i.test(text)) {
    throw new WorkspaceServerError("human_change_request_input_invalid", 422);
  }
  return text;
}

function requiredNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${key}_required`);
  return value;
}

function assertExpectedVersion(value: unknown, current: number): void {
  if (value !== undefined && value !== current) throw new Error("expected_version_changed");
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function offsetOf(payload: Record<string, unknown>): number {
  const value = numberValue(payload.offset);
  return value && value > 0 ? Math.min(value, 10_000) : 0;
}

function limitOf(payload: Record<string, unknown>): number {
  const value = numberValue(payload.limit);
  return value ? Math.min(200, Math.max(1, value)) : 50;
}

function createStableId(prefix: string, value: string): string {
  return `${prefix}_${hash(value).slice(0, 40)}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numericOrString(value: string): number | string {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}
