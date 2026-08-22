import {
  appendAuditEvent,
  ExternalIntegrationError,
  hashCanonicalJson,
  redactConnectorEvent,
  type ConnectorEvent,
  type ConnectorInstallation,
  type ConnectorManifest,
  type ExternalIntegrationAuthContext,
  type ExternalIntegrationStore,
  type ExternalSessionRecord,
  type ExternalWorkspaceTarget,
  type McpRequestControl
} from "@samurai-agent/external-integration";
import { contextSnapshotId } from "@samurai-agent/external-integration";
import { getDomainCommandEntry } from "@samurai-agent/domain-operations";
import type { McpQueryOperation, McpWorkspacePort } from "@samurai-agent/external-integration";
import type { ContextSnapshotSource } from "@samurai-agent/external-integration";
import type { AgentRuntime } from "../agent-runtime.js";
import type { ContextSnapshotService } from "@samurai-agent/external-integration";
import type { RoomBindingService } from "@samurai-agent/external-integration";

export interface RuntimeMcpWorkspacePortOptions {
  /** Operational integration records only. Workspace content never crosses
   * this adapter; it is reached through ExternalAppIngress queries. */
  integrationStore: ExternalIntegrationStore;
  runtime: Pick<AgentRuntime, "createExternalAppIngress">;
  bindings: RoomBindingService;
  snapshots: ContextSnapshotService;
}

export function createRuntimeContextSnapshotSource(input: { runtime: Pick<AgentRuntime, "createExternalAppIngress"> }): (target: ExternalWorkspaceTarget, signal?: AbortSignal) => Promise<ContextSnapshotSource> {
  return async (target, signal) => {
    const ingress = input.runtime.createExternalAppIngress(target.workspaceId);
    const ingressTarget = {
      requested_room_id: target.roomId,
      correlation_id: `context:${target.connectorId}:${target.externalSessionId}`
    };
    const evidence = { connector_id: target.connectorId, app_id: target.appId };
    const query = (queryId: string, payload: Record<string, unknown>) => ingress.query({
      evidence,
      target: ingressTarget,
      query_id: queryId,
      payload,
      ...(signal ? { signal } : {})
    });
    const [workspaceContext, room, wiki, memory] = await Promise.all([
      query("workspace.context.get", { room_id: target.roomId }),
      query("room.view", { id: target.roomId }),
      query("wiki.search", { query: "", limit: 8 }),
      query("memory.search", { query: "", limit: 8 })
    ]);
    const resources = [...contextResourceItems(wiki.result), ...contextResourceItems(memory.result)];
    const contextValue = resultOf(workspaceContext);
    const roomValue = resultOf(room);
    const workspace = requiredObject(contextValue.workspace, "workspace_context_workspace");
    const roomContext = requiredObject(contextValue.room, "workspace_context_room");
    return {
      workspaceName: requiredString(workspace.name, "workspace_context_name"),
      roomName: stringValue(roomContext.name) ?? stringValue(roomValue.name) ?? target.roomId,
      roomPurpose: stringValue(roomContext.purpose),
      workGoal: stringValue(roomContext.work_goal),
      fixedKnowledge: resources.filter((resource) => resource.fixed),
      pinnedKnowledge: resources.filter((resource) => !resource.fixed && resource.pinned),
      rules: arrayStrings(workspace.rules),
      permissions: [
        ...arrayStrings(roomContext.permissions).map((permission) => `Allowed: ${permission}`),
        ...arrayStrings(roomContext.prohibited).map((permission) => `Prohibited: ${permission}`)
      ],
      tools: [
        "samurai.capabilities", "samurai.room.binding.get", "samurai.context.snapshot", "samurai.room.binding.change", "samurai.approval.status",
        "samurai.knowledge.search", "samurai.knowledge.read", "samurai.skill.search", "samurai.skill.read", "samurai.skill.file.read",
        "samurai.artifact.list", "samurai.artifact.read", "samurai.collection.list", "samurai.collection.read",
        "samurai.activity.list", "samurai.activity.read", "samurai.activity.ingest",
        ...externalMutationOperations
          .filter((operation) => Boolean(getDomainCommandEntry(operation)?.allowed_sources.includes("external_app")))
          .map((operation) => `samurai.${operation}`)
      ]
    };
  };
}

const externalMutationOperations = [
  "artifact.create", "artifact.revise", "artifact.restore_revision", "collection.schema.save", "collection.record.create", "collection.patch.apply", "collection.record.delete",
  "wiki.proposal.create", "wiki.patch", "wiki.archive", "skill.candidate.create", "skill.patch",
  "resource.copy", "resource.move", "resource.promote", "resource.redact",
  "policy.change.request", "profile.change.request", "soul.change.request"
] as const;

/** Adapter from the public MCP contract to the existing Core09 formal
 * ExternalAppIngress. No MCP operation calls WorkspaceStore directly. */
export class RuntimeMcpWorkspacePort implements McpWorkspacePort {
  constructor(private readonly options: RuntimeMcpWorkspacePortOptions) {}

  async getBinding(input: { auth: ExternalIntegrationAuthContext; workspaceId: string; projectRef: string }, control?: McpRequestControl): Promise<Record<string, unknown> | undefined> {
    await this.assertActiveConnector(input.workspaceId, input.auth.connectorId);
    try {
      return await this.options.bindings.getAuthorizedBinding({
        auth: input.auth,
        workspaceId: input.workspaceId,
        projectRef: input.projectRef
      }) as unknown as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof ExternalIntegrationError) || error.code !== "room_binding_required") throw error;
      // The Workspace default is applied exactly once and may create a
      // binding. Mark that possible write before entering the default path so
      // a cancelled request cannot report a harmless read while the binding
      // continues in the background.
      assertNotCancelled(control);
      control?.markWriteStarted();
      try {
        return await this.options.bindings.getAuthorizedBindingOrDefault({
          auth: input.auth,
          workspaceId: input.workspaceId,
          projectRef: input.projectRef
        }, control?.signal) as unknown as Record<string, unknown>;
      } catch (defaultError) {
        if (defaultError instanceof ExternalIntegrationError && defaultError.code === "room_binding_required") return undefined;
        throw defaultError;
      }
    }
  }

  async assertTargetCurrent(target: ExternalWorkspaceTarget): Promise<void> {
    await this.options.bindings.assertTargetCurrent(target);
    await this.assertActiveConnector(target.workspaceId, target.connectorId);
  }

  async resolveTarget(auth: ExternalIntegrationAuthContext, input: { workspaceId: string; projectRef: string; externalSessionId: string }, control?: McpRequestControl): Promise<ExternalWorkspaceTarget> {
    assertNotCancelled(control);
    let target: ExternalWorkspaceTarget;
    try {
      const binding = await this.options.bindings.getAuthorizedBinding({
        auth,
        workspaceId: input.workspaceId,
        projectRef: input.projectRef
      });
      target = {
        workspaceId: input.workspaceId,
        roomId: binding.room_id,
        projectRef: input.projectRef,
        accountId: auth.accountId,
        connectionId: auth.connectionId,
        connectorId: auth.connectorId,
        appId: auth.appId,
        bindingVersion: binding.binding_version,
        externalSessionId: input.externalSessionId
      };
    } catch (error) {
      if (!(error instanceof ExternalIntegrationError) || error.code !== "room_binding_required") throw error;
      assertNotCancelled(control);
      control?.markWriteStarted();
      target = await this.options.bindings.resolveTarget({
        auth,
        workspaceId: input.workspaceId,
        projectRef: input.projectRef,
        externalSessionId: input.externalSessionId
      }, control?.signal);
    }
    const activeConnector = await this.assertActiveConnector(target.workspaceId, target.connectorId);
    const sessions = await this.options.integrationStore.listRecords("external_session", {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef,
      externalSessionId: target.externalSessionId
    });
    const existing = sessions.sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
    // An external Session is a work boundary, not a reusable connection
    // handle. Once its provider has emitted an end event, the Client must
    // start a new Session (and therefore receive a new frozen Context) even
    // when the Project still points at the same Room.
    if (existing?.ended_at) throw new ExternalIntegrationError("external_session_restart_required");
    if (existing && existing.connector_version !== activeConnector.manifest.version) {
      assertNotCancelled(control);
      control?.markWriteStarted();
      await this.endSessionForConnectorChange(existing, activeConnector.manifest.version);
      throw new ExternalIntegrationError("external_session_restart_required");
    }
    if (existing && (existing.room_id !== target.roomId || existing.binding_version !== target.bindingVersion)) {
      if (!existing.ended_at) {
        assertNotCancelled(control);
        control?.markWriteStarted();
        const version = await this.options.integrationStore.getRecordVersion("external_session", existing.id);
        if (version && await this.options.integrationStore.updateRecord("external_session", existing.id, version, { ...existing, ended_at: new Date().toISOString() })) {
          await appendAuditEvent(this.options.integrationStore, {
            eventType: "external.session.ended",
            workspaceId: existing.workspace_id,
            connectionId: existing.connection_id,
            connectorId: existing.connector_id,
            accountId: existing.account_id,
            resourceType: "external_session",
            resourceId: existing.id,
            data: { reason: "room_binding_changed", previous_room_id: existing.room_id, previous_binding_version: existing.binding_version }
          });
        }
      }
      throw new ExternalIntegrationError("external_session_restart_required");
    }
    if (!existing) {
      try {
        assertNotCancelled(control);
        control?.markWriteStarted();
        const sessionRecord = await this.options.integrationStore.createRecord("external_session", {
          id: externalSessionRecordId(target),
          external_session_id: target.externalSessionId,
          workspace_id: target.workspaceId,
          connection_id: target.connectionId,
          account_id: target.accountId,
          project_ref: target.projectRef,
          room_id: target.roomId,
          binding_version: target.bindingVersion,
          connector_id: target.connectorId,
          connector_version: activeConnector.manifest.version,
          capabilities: {},
          started_at: new Date().toISOString(),
          capture_completeness: activeConnector.manifest.full_capture === "supported" ? "full" : activeConnector.manifest.full_capture === "partial" ? "partial" : "unsupported"
        });
        try {
          await appendAuditEvent(this.options.integrationStore, { eventType: "external.session.started", workspaceId: target.workspaceId, connectionId: target.connectionId, connectorId: target.connectorId, accountId: target.accountId, resourceType: "external_session", resourceId: sessionRecord.id, data: { room_id: target.roomId, binding_version: target.bindingVersion, external_session_id: target.externalSessionId } });
        } catch {
          throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_start_audit_outcome_unknown", false);
        }
      } catch (error) {
        if (!String(error).includes("external_record_exists")) throw error;
      }
    }
    return target;
  }

  async getCapabilities(target: ExternalWorkspaceTarget): Promise<Record<string, unknown>> {
    const activeConnector = await this.assertActiveConnector(target.workspaceId, target.connectorId);
    return {
      connector_id: target.connectorId,
      app_id: target.appId,
      manifest: activeConnector.manifest,
      installation: activeConnector.installation,
      external_app_direction: "external_app_to_samurai",
      room_rechecked_per_call: true,
      context_snapshot: true,
      structured_activity_ingest: true,
      available_mutations: [
        ...externalMutationOperations
      ].filter((operation) => Boolean(getDomainCommandEntry(operation)?.allowed_sources.includes("external_app")))
    };
  }

  private async assertActiveConnector(workspaceId: string, connectorId: string): Promise<{
    manifest: ConnectorManifest;
    installation: ConnectorInstallation;
  }> {
    const manifest = await this.options.integrationStore.getRecord("connector_manifest", connectorId);
    const installations = await this.options.integrationStore.listRecords("connector_installation", {
      workspaceId,
      connectorId
    });
    const installation = installations
      .filter((item) => item.enabled && !item.disabled_at && item.version === manifest?.version && item.package_checksum === manifest?.package_checksum)
      .sort((left, right) => right.installed_at.localeCompare(left.installed_at))[0];
    if (!manifest || manifest.disabled_at || !installation) throw new ExternalIntegrationError("connector_disabled");
    return { manifest, installation };
  }

  private async endSessionForConnectorChange(session: ExternalSessionRecord, nextConnectorVersion: string): Promise<void> {
    const version = await this.options.integrationStore.getRecordVersion("external_session", session.id);
    if (!version) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown");
    const endedAt = new Date().toISOString();
    if (!await this.options.integrationStore.updateRecord("external_session", session.id, version, { ...session, ended_at: endedAt })) {
      const current = await this.options.integrationStore.getRecord("external_session", session.id);
      if (!current?.ended_at) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown");
      return;
    }
    try {
      await appendAuditEvent(this.options.integrationStore, {
        eventType: "external.session.ended",
        workspaceId: session.workspace_id,
        connectionId: session.connection_id,
        connectorId: session.connector_id,
        accountId: session.account_id,
        resourceType: "external_session",
        resourceId: session.id,
        data: { reason: "connector_version_changed", previous_connector_version: session.connector_version, next_connector_version: nextConnectorVersion }
      });
    } catch {
      throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_audit_outcome_unknown", false);
    }
  }

  async getContextSnapshot(target: ExternalWorkspaceTarget, control?: McpRequestControl): Promise<Record<string, unknown>> {
    const expectedSnapshotId = contextSnapshotId(target);
    const existing = (await this.options.integrationStore.listRecords("context_snapshot", {
      workspaceId: target.workspaceId,
      externalSessionId: target.externalSessionId
    })).find((snapshot) => snapshot.id === expectedSnapshotId
      && snapshot.room_id === target.roomId
      && snapshot.binding_version === target.bindingVersion
      && snapshot.connection_id === target.connectionId
      && snapshot.account_id === target.accountId
      && snapshot.connector_id === target.connectorId
      && snapshot.app_id === target.appId);
    assertNotCancelled(control);
    if (!existing) control?.markWriteStarted();
    const snapshot = existing ?? await this.options.snapshots.create(target, control);
    return snapshot as unknown as Record<string, unknown>;
  }

  async query(target: ExternalWorkspaceTarget, operation: McpQueryOperation, args: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>> {
    assertNotCancelled(control);
    const ingress = this.options.runtime.createExternalAppIngress(target.workspaceId);
    const runQuery = (queryId: string, queryPayload: Record<string, unknown>) => formalQuery(ingress, target, queryId, queryPayload, control);
    const page = pagedQuery(target, operation, args);
    const payload = { query: stringValue(args.query) ?? "", limit: page.fetchLimit, offset: page.offset };
    if (operation === "knowledge.search") {
      const queryId = args.kind === "memory" ? "memory.search" : "wiki.search";
      const result = await runQuery(queryId, payload);
      return pagedItems(await enrichSearchItems(target, searchItems(result.result), args.kind === "memory" ? "memory" : "wiki"), page);
    }
    if (operation === "knowledge.read") {
      const resource = await resolveKnowledgeResource(ingress, target, args, control);
      const resourcePath = requiredString(resource.file_path, "file_path");
      const requestedPath = stringValue(args.path);
      if (requestedPath && requestedPath !== resourcePath) throw new ExternalIntegrationError("mcp_invalid_arguments", "knowledge_path_mismatch");
      const value = resultOf(await runQuery("file.read", { path: resourcePath }));
      return { item: resourceEnvelope(target, value, { resourceId: requiredString(resource.id, "knowledge_id"), version: resourceVersion(resource.version), updatedAt: stringValue(resource.updated_at) }) };
    }
    if (operation === "skill.search") {
      const result = await runQuery("skill.search", payload);
      return pagedItems(await enrichSearchItems(target, searchItems(result.result), "skill"), page);
    }
    if (operation === "skill.read" || operation === "skill.file.read") {
      const skill = await findSkill(ingress, target, args, control);
      const path = operation === "skill.read"
        ? requiredString(skill.file_path, "file_path")
        : joinSkillSupportPath(requiredString(skill.file_path, "file_path"), requiredString(args.path, "path"));
      return { item: resourceEnvelope(target, resultOf(await runQuery("file.read", { path })), { resourceId: requiredString(skill.id, "skill_id"), version: resourceVersion(skill.version), updatedAt: stringValue(skill.updated_at) }) };
    }
    if (operation === "collection.list") {
      const result = await runQuery("collection.search", payload);
      return pagedItems(await enrichSearchItems(target, searchItems(result.result), "collection"), page);
    }
    if (operation === "collection.read") {
      const collectionId = requiredString(args.collection_id, "collection_id");
      const queryId = args.records === true ? "collection.records.list" : "collection.schema.get";
      const queryPayload = queryId === "collection.records.list" ? { collection_id: collectionId, ids: arrayStrings(args.ids), fields: arrayStrings(args.fields) } : { collection_id: collectionId };
      const value = resultOf(await runQuery(queryId, queryPayload));
      const versions = await this.getCurrentVersions(target, [`collection_schema:${collectionId}`], control);
      return { item: resourceEnvelope(target, value, { resourceId: collectionId, version: versions[`collection_schema:${collectionId}`] as number }) };
    }
    if (operation === "activity.list") {
      const result = await runQuery("activity.history.list", { ...activityQueryPayload(args), limit: page.fetchLimit, offset: page.offset });
      return pagedItems(activityItems(result.result).map((item) => resourceEnvelope(target, item, { resourceId: requiredString(item.id, "activity_id"), version: requiredString(item.id, "activity_id"), updatedAt: stringValue(item.occurred_at) })), page);
    }
    if (operation === "activity.read") {
      const activityId = requiredString(args.activity_id, "activity_id");
      const result = await runQuery("activity.history.list", { activity_id: activityId });
      const items = activityItems(result.result);
      if (items.length === 0) throw new ExternalIntegrationError("mcp_invalid_arguments", `activity_not_found:${activityId}`);
      return { item: resourceEnvelope(target, items[0] as Record<string, unknown>, { resourceId: activityId, version: activityId, updatedAt: stringValue(items[0]?.occurred_at) }) };
    }
    if (operation === "artifact.list") {
      const result = await runQuery("file.list", { path: stringValue(args.path) ?? "artifacts" });
      return pagedItems(await enrichArtifactList(target, result.result, ingress, control), page);
    }
    if (operation === "artifact.read") {
      const path = requiredString(args.path, "path");
      const inspect = resultOf(await runQuery("file.inspect", { path }));
      const artifactId = onlyArtifactId(inspect, path);
      const version = await this.currentResourceVersion(target, `artifact:${artifactId}`, control);
      // Resolve and authorize the indexed Artifact before reading filesystem
      // content. A raw path must never become an authorization bypass for an
      // unindexed or foreign Workspace file.
      const value = resultOf(await runQuery("file.read", { path }));
      return { item: resourceEnvelope(target, value, { resourceId: artifactId, version }) };
    }
    throw new Error(`mcp_query_not_supported:${operation}`);
  }

  async mutate(target: ExternalWorkspaceTarget, operation: string, args: Record<string, unknown>, idempotencyKey: string, expectedVersions: Record<string, number> = {}, control?: McpRequestControl): Promise<Record<string, unknown>> {
    const catalogEntry = getDomainCommandEntry(operation);
    if (!catalogEntry || catalogEntry.availability !== "active" || !catalogEntry.allowed_sources.includes("external_app")) {
      throw new ExternalIntegrationError("mcp_method_not_found", `domain_operation_not_available:${operation}`);
    }
    if (Object.keys(expectedVersions).length > 0) {
      const current = await this.getCurrentVersions(target, Object.keys(expectedVersions), control);
      if (!sameVersions(expectedVersions, current)) throw new ExternalIntegrationError("approval_version_changed", "expected_version_changed");
    }
    // The preflight above is only a helpful early rejection.  Existing
    // resources also receive their observed version in the formal command,
    // whose repository checks it in the same transaction as the write.
    const payload = mutationPayload(operation, args, expectedVersions);
    const ingress = this.options.runtime.createExternalAppIngress(target.workspaceId);
    assertNotCancelled(control);
    control?.markWriteStarted();
    return resultOf(await ingress.domainOperation({ evidence: evidence(target), target: ingressTarget(target, idempotencyKey), command_id: operation, payload, ...(control ? { signal: control.signal } : {}) }));
  }

  async ingestActivity(target: ExternalWorkspaceTarget, event: ConnectorEvent, control?: McpRequestControl): Promise<Record<string, unknown>> {
    const sanitizedEvent = redactConnectorEvent(event);
    if (sanitizedEvent.connector_id !== target.connectorId || sanitizedEvent.app_id !== target.appId || sanitizedEvent.external_session_id !== target.externalSessionId) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "activity_target_mismatch");
    }
    const session = (await this.options.integrationStore.listRecords("external_session", {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef,
      externalSessionId: target.externalSessionId
    })).sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
    if (!session || session.room_id !== target.roomId || session.binding_version !== target.bindingVersion) {
      throw new ExternalIntegrationError("external_session_restart_required");
    }
    if (session.connector_id !== sanitizedEvent.connector_id || session.connector_version !== sanitizedEvent.connector_version) {
      throw new ExternalIntegrationError("connector_version_unsupported", "activity_connector_version_changed");
    }
    const identityKey = `${target.projectRef}:${sanitizedEvent.connector_id}:${sanitizedEvent.connector_version}:${sanitizedEvent.external_session_id}:${sanitizedEvent.event_id}`;
    const payloadHash = hashCanonicalJson(sanitizedEvent);
    const existingEvent = (await this.options.integrationStore.listRecords("activity_event", {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef,
      connectorId: sanitizedEvent.connector_id,
      externalSessionId: sanitizedEvent.external_session_id
    })).find((record) => record.identity_key === identityKey);
    if (existingEvent) {
      if (existingEvent.payload_hash !== payloadHash) throw new ExternalIntegrationError("activity_event_conflict", "activity_event_payload_changed");
      if (isExternalSessionEndEvent(sanitizedEvent.event_kind) && !session.ended_at) {
        assertNotCancelled(control);
        control?.markWriteStarted();
        await this.endExternalSession(session);
      }
      return { accepted: true, duplicate: true, event: existingEvent.event };
    }
    if (session.ended_at) throw new ExternalIntegrationError("external_session_restart_required");
    // Core Activity requires a result for completed and an explicit failure
    // for every other terminal state. If a provider says "completed" without
    // a result, preserve the uncertainty instead of inventing success.
    const status = sanitizedEvent.outcome === "completed" && sanitizedEvent.result
      ? "completed"
      : sanitizedEvent.outcome === "cancelled"
        ? "cancelled"
        : sanitizedEvent.outcome === "failed"
          ? "failed"
          : "outcome_unknown";
    const failure = status === "completed"
      ? undefined
      : sanitizedEvent.failure
        ? { code: "connector_failure", summary: sanitizedEvent.failure }
        : status === "cancelled"
          ? { code: "cancelled", summary: "External Client reported cancellation without a failure message." }
          : status === "failed"
            ? { code: "connector_failure", summary: "External Client reported failure without a failure message." }
            : { code: "outcome_unknown", summary: "External Client did not provide a final outcome." };
    assertNotCancelled(control);
    control?.markWriteStarted();
    const result = await this.options.runtime.createExternalAppIngress(target.workspaceId).activityIngest({
      evidence: evidence(target),
      target: ingressTarget(target),
      idempotency_key: `connector:${sanitizedEvent.connector_id}:${sanitizedEvent.connector_version}:${sanitizedEvent.external_session_id}:${sanitizedEvent.event_id}:${payloadHash}`,
      instruction_summary: sanitizedEvent.instruction ?? sanitizedEvent.event_kind,
      status,
      ...(sanitizedEvent.result ? { result_summary: sanitizedEvent.result } : {}),
      ...(failure ? { failure } : {}),
      verification: [{
        id: `${sanitizedEvent.event_id}:verification`,
        kind: "backend" as const,
        status: sanitizedEvent.verification === "confirmed"
          ? "passed" as const
          : sanitizedEvent.verification === "failed"
            ? "failed" as const
            : sanitizedEvent.verification === "not_run"
              ? "not_run" as const
              : "inconclusive" as const,
        summary: `Connector verification: ${sanitizedEvent.verification}`,
        recorded_at: sanitizedEvent.occurred_at
      }],
      domain_operation_ids: [],
      ...(sanitizedEvent.changed_resources.length > 0 ? {
        resource_usage: sanitizedEvent.changed_resources.map((resource) => ({
          resource_ref: { kind: "external_resource", id: resource, uri: resource, label: resource },
          usage_scope: { kind: "room" as const, room_id: target.roomId },
          stage: "referenced" as const
        }))
      } : {}),
      ...(control ? { signal: control.signal } : {})
    });
    try {
      await this.options.integrationStore.createRecord("activity_event", {
        id: `activity_event_${hashCanonicalJson({ workspace_id: target.workspaceId, connection_id: target.connectionId, account_id: target.accountId, project_ref: target.projectRef, identity_key: identityKey })}`,
        identity_key: identityKey,
        payload_hash: payloadHash,
        dedupe_key: `${identityKey}:${payloadHash}`,
        created_at: sanitizedEvent.occurred_at,
        workspace_id: target.workspaceId,
        connection_id: target.connectionId,
        account_id: target.accountId,
        project_ref: target.projectRef,
        event: sanitizedEvent
      });
    } catch (error) {
      if (!String(error).includes("external_record_exists")) {
        throw new ExternalIntegrationError("mcp_outcome_unknown", "activity_event_dedupe_outcome_unknown", false);
      }
      const raced = (await this.options.integrationStore.listRecords("activity_event", {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        accountId: target.accountId,
        projectRef: target.projectRef,
        connectorId: sanitizedEvent.connector_id,
        externalSessionId: sanitizedEvent.external_session_id
      })).find((record) => record.identity_key === identityKey);
      if (!raced) throw error;
      if (raced.payload_hash !== payloadHash) throw new ExternalIntegrationError("activity_event_conflict", "activity_event_payload_changed");
      if (isExternalSessionEndEvent(sanitizedEvent.event_kind) && !session.ended_at) {
        await this.endExternalSession(session);
      }
      return { accepted: true, duplicate: true, event: raced.event };
    }
    if (isExternalSessionEndEvent(sanitizedEvent.event_kind)) {
      await this.endExternalSession(session);
    }
    return { accepted: true, duplicate: false, activity: result as Record<string, unknown> };
  }

  private async endExternalSession(session: ExternalSessionRecord): Promise<void> {
    const version = await this.options.integrationStore.getRecordVersion("external_session", session.id);
    if (!version) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown");
    const endedAt = new Date().toISOString();
    if (!await this.options.integrationStore.updateRecord("external_session", session.id, version, { ...session, ended_at: endedAt })) {
      const current = await this.options.integrationStore.getRecord("external_session", session.id);
      if (!current?.ended_at) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown");
      return;
    }
    try {
      await appendAuditEvent(this.options.integrationStore, {
        eventType: "external.session.ended",
        workspaceId: session.workspace_id,
        connectionId: session.connection_id,
        connectorId: session.connector_id,
        accountId: session.account_id,
        resourceType: "external_session",
        resourceId: session.id,
        data: { reason: "connector_session_end" }
      });
    } catch {
      throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_audit_outcome_unknown", false);
    }
  }

  async getCurrentVersions(target: ExternalWorkspaceTarget, keys: string[], control?: McpRequestControl): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const key of keys) {
      assertNotCancelled(control);
      if (key === "room_binding") {
        result[key] = await this.options.bindings.currentBindingVersion(target);
        assertNotCancelled(control);
        continue;
      }
      result[key] = await this.currentResourceVersion(target, key, control);
    }
    return result;
  }

  private async currentResourceVersion(target: ExternalWorkspaceTarget, key: string, control?: McpRequestControl): Promise<number> {
    const ingress = this.options.runtime.createExternalAppIngress(target.workspaceId);
    return formalResourceVersion(ingress, target, key, control);
  }

  async changeBinding(target: ExternalWorkspaceTarget, input: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>> {
    const roomId = requiredString(input.room_id, "room_id");
    const projectRef = requiredString(input.project_ref, "project_ref");
    assertNotCancelled(control);
    control?.markWriteStarted();
    const binding = await this.options.bindings.bind({
      auth: {
        workspaceId: target.workspaceId,
        accountId: target.accountId,
        connectionId: target.connectionId,
        connectorId: target.connectorId,
        appId: target.appId,
        scopes: ["room.binding.write", "approval.execute"],
        tokenVersion: 1,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      },
      workspaceId: target.workspaceId,
      accountId: target.accountId,
      projectRef,
      roomId,
      changedBy: target.accountId,
      ...(typeof input.expected_binding_version === "number" ? { expectedBindingVersion: input.expected_binding_version } : {}),
      ...(typeof input.expected_binding_present === "boolean" ? { expectedBindingPresent: input.expected_binding_present } : {})
    }, control?.signal);
    const sessions = await this.options.integrationStore.listRecords("external_session", {
      workspaceId: target.workspaceId,
      connectionId: target.connectionId,
      accountId: target.accountId,
      projectRef: target.projectRef,
      externalSessionId: target.externalSessionId
    });
    const session = sessions.sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
    if (session && !session.ended_at) {
      const version = await this.options.integrationStore.getRecordVersion("external_session", session.id);
      if (!version) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown", false);
      const ended = await this.options.integrationStore.updateRecord("external_session", session.id, version, { ...session, ended_at: new Date().toISOString() });
      if (!ended) {
        const current = await this.options.integrationStore.getRecord("external_session", session.id);
        if (!current?.ended_at) throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_state_unknown", false);
      }
      if (ended) {
        try {
          await appendAuditEvent(this.options.integrationStore, { eventType: "external.session.ended", workspaceId: session.workspace_id, connectionId: session.connection_id, connectorId: session.connector_id, accountId: session.account_id, resourceType: "external_session", resourceId: session.id, data: { reason: "room_binding_changed" } });
        } catch {
          throw new ExternalIntegrationError("mcp_outcome_unknown", "external_session_end_audit_outcome_unknown", false);
        }
      }
    }
    return binding as unknown as Record<string, unknown>;
  }
}

function evidence(target: ExternalWorkspaceTarget) {
  return { connector_id: target.connectorId, app_id: target.appId };
}

type ResourceEnvelopeMetadata = {
  resourceId: string;
  version: string | number;
  updatedAt?: string;
};

function resourceEnvelope(target: ExternalWorkspaceTarget, value: Record<string, unknown>, metadata: ResourceEnvelopeMetadata): Record<string, unknown> {
  return {
    resource_id: metadata.resourceId,
    room_id: target.roomId,
    version: metadata.version,
    evidence: evidence(target),
    provenance: {
      source: "samurai",
      access: "ExternalAppIngress",
      room_id: target.roomId,
      resource_id: metadata.resourceId
    },
    ...(metadata.updatedAt ? { updated_at: metadata.updatedAt } : {}),
    // The public envelope is fixed even though a Resource's own data differs
    // by kind. This prevents a formal query from adding undocumented MCP
    // top-level fields while preserving its typed, Room-authorized payload.
    data: value
  };
}

function resourceVersion(value: unknown): string | number {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_version_missing");
}

async function enrichSearchItems(target: ExternalWorkspaceTarget, items: Array<Record<string, unknown>>, kind: "memory" | "wiki" | "skill" | "collection"): Promise<Array<Record<string, unknown>>> {
  return items.map((item) => resourceEnvelope(target, item, {
    resourceId: requiredString(item.id, `${kind}_id`),
    version: resourceVersion(item.version),
    updatedAt: stringValue(item.updated_at)
  }));
}

async function enrichArtifactList(
  target: ExternalWorkspaceTarget,
  value: unknown,
  ingress: ReturnType<AgentRuntime["createExternalAppIngress"]>,
  control?: McpRequestControl
): Promise<Array<Record<string, unknown>>> {
  if (!isRecord(value) || !isRecord(value.resource)) throw new ExternalIntegrationError("mcp_invalid_arguments", "artifact_list_result_invalid");
  const resource = value.resource;
  const entries = Array.isArray(resource.entries) ? resource.entries.filter(isRecord) : [];
  const enriched = (await Promise.all(entries.map(async (entry) => {
    const path = requiredString(entry.path, "artifact_path");
    const inspect = resultOf(await formalQuery(ingress, target, "file.inspect", { path }, control));
    const artifactId = artifactIds(inspect)[0];
    if (!artifactId) return undefined;
    const revision = await formalResourceVersion(ingress, target, `artifact:${artifactId}`, control);
    return resourceEnvelope(target, entry, { resourceId: artifactId, version: revision });
  }))).filter((entry) => entry !== undefined);
  return enriched;
}

function externalSessionRecordId(target: ExternalWorkspaceTarget): string {
  return `external_session_${hashCanonicalJson({
    workspace_id: target.workspaceId,
    connection_id: target.connectionId,
    account_id: target.accountId,
    project_ref: target.projectRef,
    connector_id: target.connectorId,
    app_id: target.appId,
    external_session_id: target.externalSessionId
  }).slice(0, 32)}`;
}

function isExternalSessionEndEvent(eventKind: string): boolean {
  return /session(?:[_ .-]?end)\b/i.test(eventKind);
}

function ingressTarget(target: ExternalWorkspaceTarget, idempotencyKey?: string) {
  return {
    requested_room_id: target.roomId,
    correlation_id: `mcp:${target.connectorId}:${target.externalSessionId}`,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    ...(target.sessionRef ? { session_ref: { session_id: target.sessionRef.session_id, ...(target.sessionRef.turn_id ? { turn_id: target.sessionRef.turn_id } : {}), ...(target.sessionRef.message_id ? { message_id: target.sessionRef.message_id } : {}) } } : {})
  };
}

function formalQuery(
  ingress: ReturnType<AgentRuntime["createExternalAppIngress"]>,
  target: ExternalWorkspaceTarget,
  queryId: string,
  payload: Record<string, unknown>,
  control?: McpRequestControl
) {
  assertNotCancelled(control);
  return ingress.query({
    evidence: evidence(target),
    target: ingressTarget(target),
    query_id: queryId,
    payload,
    ...(control ? { signal: control.signal } : {})
  });
}

/** Version lookup is itself a Room-authorized formal Query. This keeps the
 * optimistic concurrency check outside the MCP adapter and avoids hidden
 * WorkspaceStore reads. */
async function formalResourceVersion(
  ingress: ReturnType<AgentRuntime["createExternalAppIngress"]>,
  target: ExternalWorkspaceTarget,
  key: string,
  control?: McpRequestControl
): Promise<number> {
  const payload = resourceVersionPayload(key);
  const response = resultOf(await formalQuery(ingress, target, "resource.version.get", payload, control));
  if (response.resource_key !== key || typeof response.version !== "number" || !Number.isInteger(response.version) || response.version <= 0) {
    throw new ExternalIntegrationError("mcp_invalid_arguments", `resource_version_not_found:${key}`);
  }
  return response.version;
}

function resourceVersionPayload(key: string): Record<string, unknown> {
  const [kind, ...parts] = key.split(":");
  if (kind === "collection_record" && parts.length === 2) {
    return { resource_kind: kind, collection_id: parts[0], resource_id: parts[1] };
  }
  if ((kind === "artifact" || kind === "collection_schema" || kind === "wiki" || kind === "skill" || kind === "memory") && parts.length === 1) {
    return { resource_kind: kind, resource_id: parts[0] };
  }
  throw new ExternalIntegrationError("mcp_invalid_arguments", `resource_version_key_invalid:${key}`);
}

/** Maps the public `expected_versions` envelope into the small set of
 * existing formal commands that own their own optimistic write contracts.
 * A Client cannot satisfy this with a preflight-only version read. */
function mutationPayload(operation: string, args: Record<string, unknown>, expectedVersions: Record<string, number>): Record<string, unknown> {
  if (operation === "artifact.revise" || operation === "artifact.restore_revision") {
    const artifactId = requiredString(args.artifact_id, "artifact_id");
    const key = `artifact:${artifactId}`;
    const expectedRevision = expectedVersions[key];
    if (!expectedRevision || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "artifact_expected_version_required");
    }
    if (!stringValue(args.base_revision_id)) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "artifact_base_revision_id_required");
    }
    return { ...args, expected_revision: expectedRevision };
  }
  if (operation === "collection.schema.save") {
    const collectionId = requiredString(args.id, "id");
    const key = `collection_schema:${collectionId}`;
    const expectedResourceVersion = expectedVersions[key];
    // A new schema has no existing version.  Updating one must carry exactly
    // the value read from `collection.read` and the repository CASes it.
    if (expectedResourceVersion === undefined) return args;
    if (Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "collection_schema_expected_version_invalid");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  if (operation === "collection.patch.apply") {
    const collectionId = requiredString(args.collection_id, "collection_id");
    const recordId = requiredString(args.record_id, "record_id");
    const key = `collection_record:${collectionId}:${recordId}`;
    const expectedVersion = expectedVersions[key];
    if (!expectedVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "collection_record_expected_version_required");
    }
    if (args.expected_version !== expectedVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "collection_record_expected_version_mismatch");
    }
    return args;
  }
  if (operation === "collection.record.delete") {
    const collectionId = requiredString(args.collection_id, "collection_id");
    const recordId = requiredString(args.record_id, "record_id");
    const key = `collection_record:${collectionId}:${recordId}`;
    const expectedVersion = expectedVersions[key];
    if (!expectedVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "collection_record_expected_version_required");
    }
    if (args.expected_version !== undefined && args.expected_version !== expectedVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "collection_record_expected_version_mismatch");
    }
    return { ...args, expected_version: expectedVersion };
  }
  if (operation === "wiki.patch") {
    const wikiId = requiredString(args.wiki_id, "wiki_id");
    const key = `wiki:${wikiId}`;
    const expectedResourceVersion = expectedVersions[key];
    if (!expectedResourceVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "wiki_expected_version_required");
    }
    if (args.expected_resource_version !== undefined && args.expected_resource_version !== expectedResourceVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "wiki_expected_version_mismatch");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  if (operation === "wiki.archive") {
    const wikiId = requiredString(args.wiki_id, "wiki_id");
    const key = `wiki:${wikiId}`;
    const expectedResourceVersion = expectedVersions[key];
    if (!expectedResourceVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "wiki_expected_version_required");
    }
    if (args.expected_resource_version !== undefined && args.expected_resource_version !== expectedResourceVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "wiki_expected_version_mismatch");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  if (operation === "skill.patch") {
    const skillId = requiredString(args.skill_id, "skill_id");
    const key = `skill:${skillId}`;
    const expectedResourceVersion = expectedVersions[key];
    if (!expectedResourceVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "skill_expected_version_required");
    }
    if (args.expected_resource_version !== undefined && args.expected_resource_version !== expectedResourceVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "skill_expected_version_mismatch");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  if (operation === "resource.copy" || operation === "resource.move" || operation === "resource.promote") {
    const resourceKind = requiredString(args.resource_kind, "resource_kind");
    if (resourceKind !== "wiki" && resourceKind !== "skill") {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_transfer_kind_invalid");
    }
    const resourceId = requiredString(args.resource_id, "resource_id");
    const key = `${resourceKind}:${resourceId}`;
    const expectedResourceVersion = expectedVersions[key];
    if (!expectedResourceVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_transfer_expected_version_required");
    }
    if (args.expected_resource_version !== undefined && args.expected_resource_version !== expectedResourceVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_transfer_expected_version_mismatch");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  if (operation === "resource.redact") {
    const resourceKind = requiredString(args.resource_kind, "resource_kind");
    if (resourceKind !== "wiki" && resourceKind !== "skill") {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_redact_kind_invalid");
    }
    const resourceId = requiredString(args.resource_id, "resource_id");
    const key = `${resourceKind}:${resourceId}`;
    const expectedResourceVersion = expectedVersions[key];
    if (!expectedResourceVersion || Object.keys(expectedVersions).length !== 1) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_redact_expected_version_required");
    }
    if (args.expected_resource_version !== undefined && args.expected_resource_version !== expectedResourceVersion) {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "resource_redact_expected_version_mismatch");
    }
    return { ...args, expected_resource_version: expectedResourceVersion };
  }
  return args;
}

function artifactIds(value: Record<string, unknown>): string[] {
  const resource = isRecord(value.resource) ? value.resource : undefined;
  const provenance = resource && isRecord(resource.provenance) ? resource.provenance : undefined;
  return Array.isArray(provenance?.artifact_ids)
    ? provenance.artifact_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
}

function onlyArtifactId(value: Record<string, unknown>, path: string): string {
  const ids = artifactIds(value);
  if (ids.length !== 1) throw new ExternalIntegrationError("mcp_invalid_arguments", `artifact_not_found_or_ambiguous:${path}`);
  return ids[0] as string;
}

function resultOf(value: { result: unknown }): Record<string, unknown> {
  return value.result && typeof value.result === "object" ? value.result as Record<string, unknown> : { value: value.result };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredString(value: unknown, key: string): string {
  const result = stringValue(value);
  if (!result) throw new ExternalIntegrationError("mcp_invalid_arguments", `${key}_required`);
  return result;
}

function requiredObject(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ExternalIntegrationError("mcp_invalid_result", `${key}_required`);
  return value;
}

function assertNotCancelled(control: McpRequestControl | undefined): void {
  if (control?.signal.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled_before_write", true);
}

function sameVersions(expected: Record<string, number>, current: Record<string, number>): boolean {
  const keys = Object.keys(expected).sort();
  return keys.length === Object.keys(current).length && keys.every((key) => expected[key] === current[key]);
}

function clampLimit(value: unknown): number {
  return Math.min(200, Math.max(1, typeof value === "number" && Number.isInteger(value) ? value : 5));
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 1_000) : [];
}

function activityQueryPayload(args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(stringValue(args.source_kind) ? { source_kind: args.source_kind } : {}),
    ...(stringValue(args.source_id) ? { source_id: args.source_id } : {}),
    ...(stringValue(args.status) ? { status: args.status } : {})
  };
}

interface PageRequest {
  operation: McpQueryOperation;
  limit: number;
  offset: number;
  fetchLimit: number;
  scopeHash: string;
}

function pagedQuery(target: ExternalWorkspaceTarget, operation: McpQueryOperation, args: Record<string, unknown>): PageRequest {
  const limit = clampLimit(args.limit);
  const scopeArgs = { ...args };
  delete scopeArgs.cursor;
  delete scopeArgs.limit;
  const scopeHash = hashCanonicalJson({
    operation,
    target: {
      workspace_id: target.workspaceId,
      room_id: target.roomId,
      project_ref: target.projectRef,
      account_id: target.accountId,
      connection_id: target.connectionId,
      connector_id: target.connectorId,
      app_id: target.appId,
      binding_version: target.bindingVersion,
      external_session_id: target.externalSessionId
    },
    args: scopeArgs
  });
  let offset = 0;
  const cursor = stringValue(args.cursor);
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { version?: number; operation?: string; scope_hash?: string; offset?: number };
      if (decoded.version !== 1 || decoded.operation !== operation || decoded.scope_hash !== scopeHash || !Number.isInteger(decoded.offset) || (decoded.offset as number) < 0) {
        throw new Error("cursor_mismatch");
      }
      offset = Math.min(10_000, decoded.offset as number);
    } catch {
      throw new ExternalIntegrationError("mcp_invalid_arguments", "cursor_invalid");
    }
  }
  return { operation, limit, offset, fetchLimit: Math.min(200, limit + 1), scopeHash };
}

function nextCursor(page: PageRequest, itemsLength: number): string | null {
  const hasMore = itemsLength > page.limit || (page.limit === 200 && itemsLength === 200);
  if (!hasMore) return null;
  return Buffer.from(JSON.stringify({ version: 1, operation: page.operation, scope_hash: page.scopeHash, offset: page.offset + page.limit }), "utf8").toString("base64url");
}

function pagedItems(items: Array<Record<string, unknown>>, page: PageRequest): Record<string, unknown> {
  const pageItems = items.slice(0, page.limit);
  const cursor = nextCursor(page, items.length);
  return { items: pageItems, next_cursor: cursor };
}

function contextResourceItems(value: unknown): Array<{ id: string; title: string; summary: string; version: number | string; fixed: boolean; pinned: boolean }> {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).items)
      ? (value as Record<string, unknown>).items as unknown[]
      : [];
  return items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const version = typeof item.version === "string"
      ? item.version.trim()
      : typeof item.version === "number" && Number.isInteger(item.version) && item.version > 0
        ? item.version
        : undefined;
    if (typeof item.id !== "string" || version === undefined || (typeof version === "string" && version.length === 0)) return [];
    return [{ id: item.id, title: stringValue(item.title) ?? item.id, summary: stringValue(item.summary) ?? stringValue(item.description) ?? "", version, fixed: item.fixed === true, pinned: item.pinned === true }];
  });
}

async function resolveKnowledgeResource(ingress: ReturnType<AgentRuntime["createExternalAppIngress"]>, target: ExternalWorkspaceTarget, args: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>> {
  const knowledgeId = stringValue(args.knowledge_id);
  const path = stringValue(args.path);
  if (!knowledgeId && !path) throw new ExternalIntegrationError("mcp_invalid_arguments", "knowledge_id_or_path_required");
  const queryId = args.kind === "memory" ? "memory.search" : "wiki.search";
  const needle = knowledgeId ?? path as string;
  const result = await formalQuery(ingress, target, queryId, { query: needle, limit: 200 }, control);
  const item = searchItems(result.result).find((candidate) => candidate.id === knowledgeId || candidate.file_path === path);
  if (!item) throw new ExternalIntegrationError("mcp_invalid_arguments", `knowledge_not_found:${needle}`);
  return item;
}

async function findSkill(ingress: ReturnType<AgentRuntime["createExternalAppIngress"]>, target: ExternalWorkspaceTarget, args: Record<string, unknown>, control?: McpRequestControl): Promise<Record<string, unknown>> {
  const skillId = requiredString(args.skill_id, "skill_id");
  const result = await formalQuery(ingress, target, "skill.search", { query: skillId, limit: 8 }, control);
  const item = searchItems(result.result).find((candidate) => candidate.id === skillId);
  if (!item) throw new ExternalIntegrationError("mcp_invalid_arguments", `skill_not_found:${skillId}`);
  return item;
}

function searchItems(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.items)) return value.items.filter(isRecord);
  return [];
}

function activityItems(value: unknown): Array<Record<string, unknown>> {
  return isRecord(value) && Array.isArray(value.items) ? value.items.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function joinSkillSupportPath(filePath: string, supportPath: string): string {
  const segments = supportPath.split(/[\\/]+/).filter(Boolean);
  if (segments.includes("..")) throw new Error("skill_support_path_invalid");
  const slash = filePath.lastIndexOf("/");
  return `${slash >= 0 ? filePath.slice(0, slash) : ""}/${segments.join("/")}`.replace(/^\//, "");
}
