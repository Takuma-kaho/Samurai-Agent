/**
 * Core 06 authorization classification for every active Domain Operation.
 *
 * This is intentionally a closed, explicit registry.  It must never infer a
 * Room boundary from an operation name, effect kind, or output resource kind:
 * adding an operation without putting it here fails during definition setup.
 */
export type RoomContentAction = "read" | "edit" | "execute";

export type DomainResourceTarget =
  | { kind: "artifact" | "memory" | "wiki" | "skill" | "file" | "generated_surface"; idField: string; onlyIfExisting?: boolean }
  | { kind: "collection_schema"; idField: string; onlyIfExisting?: boolean }
  | { kind: "collection_record"; collectionIdField: string; recordIdField: string; onlyIfExisting?: boolean }
  | { kindField: "resource_kind"; idField: "resource_id"; allowedKinds: readonly ["memory", "wiki", "skill"] }
  | { resourceRefField: "source_ref"; allowedKinds: readonly ["artifact", "memory", "wiki", "skill", "collection_record"] };

export type DomainAccessClassification =
  | { scope: "room_collaboration" }
  // Gateway admission is intentionally narrower than Workspace control. It
  // permits the unbound Gateway transport to record and pair inbound contact,
  // but never grants Room, Chat, Agent, Tool, or Workspace content access.
  | { scope: "gateway_admission" }
  | { scope: "workspace_control" }
  | { scope: "legacy_owner" }
  | { scope: "room_content"; action: RoomContentAction; target?: DomainResourceTarget | readonly DomainResourceTarget[] };

const classifications = new Map<string, DomainAccessClassification>();

function register(classification: DomainAccessClassification, ...ids: readonly string[]): void {
  for (const id of ids) {
    if (classifications.has(id)) throw new Error(`domain_operation_access_duplicate:${id}`);
    classifications.set(id, Object.freeze(classification));
  }
}

// These operations use the Room/Workspace participant service, which performs
// their target-specific checks before it changes membership or ownership.
register({ scope: "room_collaboration" },
  "agent.backend.bind", "agent.create", "agent.list", "agent.patch", "agent.view", "agent.workspace_permission.set",
  "room.agent.permission.set", "room.agent.remove", "room.create", "room.list", "room.member.add", "room.member.list",
  "room.member.remove", "room.member.role.change", "room.owner.recover", "room.owner.transfer", "room.ownerless.list", "room.patch",
  "room.resource.share", "room.resource.share.list", "room.resource.share.revoke", "room.view",
  "workspace.member.add", "workspace.member.list", "workspace.member.remove", "workspace.member.role.change", "workspace.owner.transfer"
);

// Pairing records are transport admission state, not Workspace management.
// Keep this one ingress operation separate so an unbound external contact
// cannot inherit any wider authority from the Gateway transport.
register({ scope: "gateway_admission" }, "gateway.inbound.route");

// These controls intentionally concern Workspace-wide operational state, not
// Room content. They remain an explicit Workspace-admin path.
register({ scope: "workspace_control" },
  "automation.job.release_lock", "automation.job.requeue", "automation.job.run", "automation.job.save", "automation.job.set_status",
  "client.event.ack", "client.event.deliver", "client.event.expire", "client.event.fail", "client.event.save",
  "gateway.concurrency_lock.expire", "gateway.mcp_config.save", "gateway.pairing_policy.save",
  "gateway.pairing.approve", "gateway.pairing.expire", "gateway.pairing.reject", "gateway.pairing.revoke", "gateway.pairing.rotate",
  "gateway.routing_policy.save", "gateway.sandbox.delete", "gateway.sandbox.recreate", "gateway.sandbox.sync", "gateway.state.repair",
  "collection.reindex", "plugin.status.set", "session.search.reindex", "settings.patch", "wiki.reindex", "workspace.backup.create", "workspace.backup.restore", "workspace.repair"
);

// These paths can touch data that predates a formal Room boundary.  They are
// therefore Owner-only, not merely Workspace-admin controls.
register({ scope: "legacy_owner" },
  "automation.memory_review.run", "curator.pause", "curator.restore", "curator.resume", "curator.run", "curator.snapshot.create", "curator.snapshot.list", "learning.snapshot.prune"
);

register({ scope: "room_content", action: "edit" }, "artifact.create", "graph.create", "generated_surface.create", "memory.session.create", "memory.topic.create", "message.presentation.update", "objective.create", "objective.transition", "wiki.proposal.create");
register({ scope: "room_content", action: "edit", target: {
  resourceRefField: "source_ref",
  allowedKinds: ["artifact", "memory", "wiki", "skill", "collection_record"]
} }, "resource.translation.save", "resource.translation_job.save");
register({ scope: "room_content", action: "execute" }, "artifact.export_pdf", "browser.download_to_workspace", "browser.extract", "browser.interact", "browser.navigate", "browser.screenshot", "chat.turn.run", "evaluation.run", "external.send", "external.send.dispatch", "external.send.prepare", "image.generate", "learning.background_review.apply", "mcp.call", "presentation.plan", "reflection.run", "reflection.suggestion.apply", "sandbox.exec", "session.create", "skill.optimization.cancel", "skill.optimization.promote", "skill.optimization.reject", "skill.optimization.rollback", "skill.optimization.start", "work_item.follow_up", "work_item.steer");
register({ scope: "room_content", action: "read" }, "collection.schema.docs", "collection.search", "file.list", "memory.search", "session.search", "skill.search", "wiki.search");
register({ scope: "room_content", action: "edit", target: { kind: "artifact", idField: "artifact_id" } }, "artifact.repair", "artifact.restore_revision", "artifact.revise", "graph.patch", "image.edit");
register({ scope: "room_content", action: "edit", target: [
  { kind: "collection_schema", idField: "collection_id" },
  { kind: "collection_record", collectionIdField: "collection_id", recordIdField: "record_id" }
] }, "collection.patch.apply", "collection.record.delete");
// A new record has no boundary yet. Its parent schema is the existing Room
// resource whose edit permission decides whether the new record may exist.
register({ scope: "room_content", action: "edit", target: { kind: "collection_schema", idField: "collection_id" } }, "collection.record.create");
register({ scope: "room_content", action: "edit", target: { kind: "collection_schema", idField: "id", onlyIfExisting: true } }, "collection.schema.save");
register({ scope: "room_content", action: "read", target: { kind: "collection_schema", idField: "collection_id" } }, "collection.records.list", "collection.schema.get", "collection.view.present");
register({ scope: "room_content", action: "execute", target: { kind: "collection_schema", idField: "collection_id" } }, "collection.action.run");
// A new file has no Resource boundary yet, so its creation is decided by the
// active Room's edit permission. Existing files, including unbounded legacy
// files, must still be checked through their Resource boundary.
register({ scope: "room_content", action: "edit", target: { kind: "file", idField: "path", onlyIfExisting: true } }, "file.patch", "file.write");
register({ scope: "room_content", action: "read", target: { kind: "file", idField: "path" } }, "file.inspect", "file.read");
register({ scope: "room_content", action: "execute", target: { kind: "generated_surface", idField: "surface_id" } }, "generated_surface.action.run", "generated_surface.export");
register({ scope: "room_content", action: "edit", target: { kind: "generated_surface", idField: "surface_id" } }, "generated_surface.revise", "generated_surface.interaction.record");
register({ scope: "room_content", action: "read", target: { kind: "generated_surface", idField: "surface_id" } }, "generated_surface.state");
register({ scope: "room_content", action: "edit", target: { kind: "memory", idField: "memory_id" } }, "memory.archive");
register({ scope: "room_content", action: "edit", target: { kindField: "resource_kind", idField: "resource_id", allowedKinds: ["memory", "wiki", "skill"] } }, "learning.resource.usage.record", "learning.resource.version.restore", "learning.resource.version.update");
register({ scope: "room_content", action: "edit" }, "skill.candidate.create");
register({ scope: "room_content", action: "edit", target: { kind: "skill", idField: "candidate_id" } }, "skill.project.save");
register({ scope: "room_content", action: "edit", target: { kind: "skill", idField: "skill_id" } }, "skill.lifecycle.apply", "skill.patch", "skill.support_file.save", "skill.usage.record");
register({ scope: "room_content", action: "read", target: { kind: "skill", idField: "skill_id" } }, "skill.view");
register({ scope: "room_content", action: "edit", target: { kind: "wiki", idField: "wiki_id" } }, "wiki.accept", "wiki.archive", "wiki.patch", "wiki.reject");
register({ scope: "room_content", action: "edit" }, "rollback.restore", "work_item.create");

/** No fallback is allowed: a new operation must choose its ownership boundary. */
export function domainOperationAccess(id: string): DomainAccessClassification {
  const classification = classifications.get(id);
  if (!classification) throw new Error(`domain_operation_access_missing:${id}`);
  return classification;
}

export function domainOperationAccessEntries(): ReadonlyMap<string, DomainAccessClassification> {
  return classifications;
}
