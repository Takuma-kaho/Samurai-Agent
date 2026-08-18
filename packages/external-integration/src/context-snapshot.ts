import {
  ContextSnapshotSchema,
  ExternalIntegrationError,
  hashCanonicalJson,
  type ContextSnapshot,
  type ExternalIntegrationStore,
  type ExternalWorkspaceTarget
} from "./contracts.js";
import { appendAuditEvent } from "./audit.js";

export interface SnapshotResource {
  id: string;
  version: number | string;
  title: string;
  summary: string;
  fixed?: boolean;
  pinned?: boolean;
}

export interface ContextSnapshotSource {
  workspaceName: string;
  roomName: string;
  roomPurpose?: string;
  workGoal?: string;
  fixedKnowledge: SnapshotResource[];
  pinnedKnowledge: SnapshotResource[];
  rules: string[];
  permissions: string[];
  tools: string[];
}

export interface ContextSnapshotServiceOptions {
  store: ExternalIntegrationStore;
  source: (target: ExternalWorkspaceTarget, signal?: AbortSignal) => Promise<ContextSnapshotSource>;
  now?: () => Date;
  id?: (target: ExternalWorkspaceTarget) => string;
}

export interface ContextSnapshotControl {
  signal: AbortSignal;
  markWriteStarted(): void;
}

/** Creates the bounded, frozen context sent at external-session startup. */
export class ContextSnapshotService {
  private readonly now: () => Date;
  private readonly id: (target: ExternalWorkspaceTarget) => string;

  constructor(private readonly options: ContextSnapshotServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? contextSnapshotId;
  }

  async create(target: ExternalWorkspaceTarget, control?: ContextSnapshotControl): Promise<ContextSnapshot> {
    assertNotCancelled(control);
    const source = await this.options.source(target, control?.signal);
    assertNotCancelled(control);
    const resources = uniqueResources([...source.fixedKnowledge, ...source.pinnedKnowledge]).sort((left, right) => left.id.localeCompare(right.id));
    const sections: SnapshotSection[] = [
      { name: "workspace", priority: 100, lines: [`Workspace: ${source.workspaceName}`, `Room: ${source.roomName}`] },
      { name: "purpose", priority: 95, lines: source.roomPurpose ? [`Room purpose: ${source.roomPurpose}`] : [] },
      { name: "goal", priority: 90, lines: source.workGoal ? [`Work goal: ${source.workGoal}`] : [] },
      { name: "fixed_knowledge", priority: 85, lines: resources.filter((item) => item.fixed).map(resourceLine) },
      { name: "pinned_knowledge", priority: 80, lines: resources.filter((item) => !item.fixed && item.pinned).map(resourceLine) },
      { name: "rules", priority: 75, lines: source.rules.map((value) => `- ${value}`) },
      { name: "permissions", priority: 70, lines: source.permissions.map((value) => `- ${value}`) },
      { name: "tools", priority: 65, lines: source.tools.map((value) => `- ${value}`) }
    ];
    const { content, omitted } = fitSections(sections, 1_500);
    const resourceVersions = resources.map((resource) => ({ resource_id: resource.id, version: resource.version }));
    const snapshot = ContextSnapshotSchema.parse({
      id: this.id(target),
      workspace_id: target.workspaceId,
      connection_id: target.connectionId,
      account_id: target.accountId,
      connector_id: target.connectorId,
      app_id: target.appId,
      room_id: target.roomId,
      external_session_id: target.externalSessionId,
      binding_version: target.bindingVersion,
      resource_versions: resourceVersions,
      content,
      omitted_sections: omitted,
      token_count: 1,
      /** The hash describes exactly what was sent, plus the explicit resource
       * versions and omissions that make that text meaningful. */
      content_hash: hashCanonicalJson({ content, resource_versions: resourceVersions, omitted }),
      snapshot_version: 1,
      created_at: this.now().toISOString(),
      frozen: true
    });
    const tokenCount = estimateTokens(snapshot.content);
    if (tokenCount > 1_500) throw new ExternalIntegrationError("context_snapshot_too_large");
    const bounded = ContextSnapshotSchema.parse({ ...snapshot, token_count: Math.max(1, tokenCount) });
    let saved: ContextSnapshot;
    let created = false;
    try {
      assertNotCancelled(control);
      control?.markWriteStarted();
      saved = await this.options.store.createRecord("context_snapshot", bounded);
      created = true;
    } catch (error) {
      // Two simultaneous startup calls can both observe no existing snapshot.
      // The deterministic target ID makes that race idempotent; never create a
      // second frozen context or report a false failure to the Client.
      if (!String(error).includes("external_record_exists")) throw error;
      const raced = await this.options.store.getRecord("context_snapshot", bounded.id);
      if (!raced) throw error;
      saved = raced;
    }
    if (saved.id !== bounded.id) throw new ExternalIntegrationError("mcp_invalid_result", "context_snapshot_identity_changed");
    if (!created) return saved;
    try {
      await appendAuditEvent(this.options.store, { eventType: "context.snapshot.created", workspaceId: target.workspaceId, connectionId: target.connectionId, connectorId: target.connectorId, accountId: target.accountId, resourceType: "context_snapshot", resourceId: saved.id, data: { room_id: target.roomId, external_session_id: target.externalSessionId, binding_version: target.bindingVersion, content_hash: saved.content_hash } });
    } catch {
      throw new ExternalIntegrationError("mcp_outcome_unknown", "context_snapshot_audit_outcome_unknown", false);
    }
    return saved;
  }
}

/** Stable identity for one frozen Project/Room/Session context. Project ref is
 * part of the key even though it is not Workspace content, so reusing an
 * external session id for another Project can never return the old snapshot. */
export function contextSnapshotId(target: ExternalWorkspaceTarget): string {
  return `snapshot_${hashCanonicalJson({
    workspace_id: target.workspaceId,
    connection_id: target.connectionId,
    account_id: target.accountId,
    connector_id: target.connectorId,
    app_id: target.appId,
    room_id: target.roomId,
    project_ref: target.projectRef,
    external_session_id: target.externalSessionId,
    binding_version: target.bindingVersion
  }).slice(0, 48)}`;
}

function assertNotCancelled(control: ContextSnapshotControl | undefined): void {
  if (control?.signal.aborted) throw new ExternalIntegrationError("mcp_cancelled", "mcp_request_cancelled_before_write", true);
}

interface SnapshotSection {
  name: string;
  priority: number;
  lines: string[];
}

function fitSections(sections: SnapshotSection[], budget: number): { content: string; omitted: string[] } {
  const chosen = sections
    .filter((section) => section.lines.length > 0)
    .sort((left, right) => right.priority - left.priority)
    .map((section) => ({ ...section, lines: [...section.lines] }));
  const omitted: string[] = [];
  while (chosen.length > 0) {
    const plainContent = renderSections(chosen);
    const content = omitted.length > 0
      ? `${plainContent}\n\nOmitted from startup snapshot: ${omitted.join(", ")}. Use scoped read tools when needed.`
      : plainContent;
    if (estimateTokens(content) <= budget) return { content, omitted };
    /* Workspace identity, Room purpose, and current goal are the last things
     * allowed to remain. A too-large critical source fails visibly instead of
     * silently deleting the information that authorizes the work. */
    const candidate = [...chosen]
      .filter((section) => !["workspace", "purpose", "goal"].includes(section.name))
      .sort((left, right) => left.priority - right.priority)[0];
    if (!candidate) break;
    if (candidate.lines.length > 1) {
      candidate.lines.pop();
    } else {
      omitted.push(candidate.name);
      chosen.splice(chosen.indexOf(candidate), 1);
    }
  }
  const content = renderSections(chosen);
  return { content: omitted.length > 0 ? `${content}\n\nOmitted from startup snapshot: ${omitted.join(", ")}. Use scoped read tools when needed.` : content, omitted };
}

function renderSections(sections: SnapshotSection[]): string {
  return sections
    .filter((section) => section.lines.length > 0)
    .map((section) => [`[${section.name}]`, ...section.lines].join("\n"))
    .join("\n\n");
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function resourceLine(resource: SnapshotResource): string {
  return `- ${resource.title} (id=${resource.id}, version=${resource.version}): ${resource.summary}`;
}

function uniqueResources(resources: SnapshotResource[]): SnapshotResource[] {
  const byId = new Map<string, SnapshotResource>();
  for (const resource of resources) {
    const current = byId.get(resource.id);
    if (!current || resource.version > current.version || resource.fixed || resource.pinned) byId.set(resource.id, resource);
  }
  return [...byId.values()];
}
