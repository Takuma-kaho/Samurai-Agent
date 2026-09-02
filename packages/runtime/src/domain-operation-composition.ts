import { domainQueryIds, type DomainOperationPorts } from "@samurai-agent/domain-operations";
import type { RuntimeDomainServices } from "./domain-operation-services.js";
import { readOnlyQueryPort } from "./domain-operation-ports/read-only-query-port.js";
import { createArtifactDomainServicePorts } from "./domain-operation-ports/artifact-domain-service-ports.js";
import { createAppliedLearningEvaluationDomainServicePorts } from "./domain-operation-ports/applied-learning-evaluation-domain-service-ports.js";
import { createAutomationDomainServicePorts } from "./domain-operation-ports/automation-domain-service-ports.js";
import { createBrowserDomainServicePorts } from "./domain-operation-ports/browser-domain-service-ports.js";
import { createClientEventDomainServicePorts } from "./domain-operation-ports/client-event-domain-service-ports.js";
import { createCollectionDomainServicePorts } from "./domain-operation-ports/collection-domain-service-ports.js";
import { createCore05BackgroundReviewMutationDomainServicePorts } from "./domain-operation-ports/core05-background-review-mutation-domain-service-ports.js";
import { createConversationDomainServicePorts } from "./domain-operation-ports/conversation-domain-service-ports.js";
import { createExecutionDomainServicePorts } from "./domain-operation-ports/execution-domain-service-ports.js";
import { createExternalSendDomainServicePorts } from "./domain-operation-ports/external-send-domain-service-ports.js";
import { createExternalAppConnectionDomainServicePorts } from "./domain-operation-ports/external-app-connection-domain-service-ports.js";
import { createFileDomainServicePorts } from "./domain-operation-ports/file-domain-service-ports.js";
import { createGatewayDomainServicePorts } from "./domain-operation-ports/gateway-domain-service-ports.js";
import { createGeneratedSurfaceDomainServicePorts } from "./domain-operation-ports/generated-surface-domain-service-ports.js";
import { createLearningDomainServicePorts } from "./domain-operation-ports/learning-domain-service-ports.js";
import { createLearningResourceUseDomainServicePorts } from "./domain-operation-ports/learning-resource-use-domain-service-ports.js";
import { createLearningResourceVersionDomainServicePorts } from "./domain-operation-ports/learning-resource-version-domain-service-ports.js";
import { createMemoryDomainServicePorts } from "./domain-operation-ports/memory-domain-service-ports.js";
import { createObjectiveDomainServicePorts } from "./domain-operation-ports/objective-domain-service-ports.js";
import { createPluginDomainServicePorts } from "./domain-operation-ports/plugin-domain-service-ports.js";
import { createPresentationDomainServicePorts } from "./domain-operation-ports/presentation-domain-service-ports.js";
import { createSettingsDomainServicePorts } from "./domain-operation-ports/settings-domain-service-ports.js";
import { createSkillDomainServicePorts } from "./domain-operation-ports/skill-domain-service-ports.js";
import { createSystemDomainServicePorts } from "./domain-operation-ports/system-domain-service-ports.js";
import { createTranslationDomainServicePorts } from "./domain-operation-ports/translation-domain-service-ports.js";
import { createWikiDomainServicePorts } from "./domain-operation-ports/wiki-domain-service-ports.js";
import { createSearchDomainServicePorts } from "./domain-operation-ports/search-domain-service-ports.js";
import { createRoomAgentDomainServicePorts } from "./domain-operation-ports/room-agent-domain-service-ports.js";
import { createActivityHistoryDomainServicePorts } from "./domain-operation-ports/activity-history-domain-service-ports.js";
import { createResourceVersionDomainServicePorts } from "./domain-operation-ports/resource-version-domain-service-ports.js";
import { createWorkspaceContextDomainServicePorts } from "./domain-operation-ports/workspace-context-domain-service-ports.js";
import { createHumanChangeRequestDomainServicePorts } from "./domain-operation-ports/human-change-request-domain-service-ports.js";
import { createResourceTransferDomainServicePorts } from "./domain-operation-ports/resource-transfer-domain-service-ports.js";
import { createResourceRedactionDomainServicePorts } from "./domain-operation-ports/resource-redaction-domain-service-ports.js";

export type { RuntimeDomainServices } from "./domain-operation-services.js";

/**
 * Organization operations are exposed by the Workspace Server Account API,
 * not by the Room-scoped AgentRuntime. Keep their generated ports explicit so
 * the operation binder remains complete without pretending that a Room
 * participant can administer an Organization.
 */
type OrganizationOperationId =
  | "organization.create"
  | "organization.delete"
  | "organization.invitation.extend"
  | "organization.invitation.list"
  | "organization.invitation.reissue"
  | "organization.invitation.revoke"
  | "organization.list"
  | "organization.member.accept"
  | "organization.member.invite"
  | "organization.member.leave"
  | "organization.member.list"
  | "organization.member.remove"
  | "organization.member.role.change"
  | "organization.patch"
  | "organization.view"
  | "organization.workspace.archive"
  | "organization.workspace.create"
  | "organization.workspace.delete"
  | "organization.workspace.list"
  | "organization.workspace.member.grant"
  | "organization.workspace.member.revoke"
  | "organization.workspace.restore"
  | "workspace.bundle.export"
  | "workspace.bundle.restore"
  | "workspace.organization.move.commit"
  | "workspace.organization.move.preflight"
  | "workspace.organization.move.status";

type OrganizationOperationPorts = Pick<DomainOperationPorts, OrganizationOperationId>;

function organizationOperationUnavailable(operationId: OrganizationOperationId): never {
  throw new Error(`domain_operation_requires_organization_api:${operationId}`);
}

function createOrganizationOperationPorts(): OrganizationOperationPorts {
  return {
    "organization.create": {
      createOrganization: (_context, _input) => organizationOperationUnavailable("organization.create")
    },
    "organization.delete": {
      deleteOrganization: (_context, _input) => organizationOperationUnavailable("organization.delete")
    },
    "organization.invitation.extend": {
      extendOrganizationInvitation: (_context, _input) => organizationOperationUnavailable("organization.invitation.extend")
    },
    "organization.invitation.list": readOnlyQueryPort<OrganizationOperationPorts["organization.invitation.list"]>({
      listOrganizationInvitations: (_context, _input) => organizationOperationUnavailable("organization.invitation.list")
    }),
    "organization.invitation.reissue": {
      reissueOrganizationInvitation: (_context, _input) => organizationOperationUnavailable("organization.invitation.reissue")
    },
    "organization.invitation.revoke": {
      revokeOrganizationInvitation: (_context, _input) => organizationOperationUnavailable("organization.invitation.revoke")
    },
    "organization.list": readOnlyQueryPort<OrganizationOperationPorts["organization.list"]>({
      listOrganizations: (_context, _input) => organizationOperationUnavailable("organization.list")
    }),
    "organization.member.accept": {
      acceptOrganizationInvitation: (_context, _input) => organizationOperationUnavailable("organization.member.accept")
    },
    "organization.member.invite": {
      inviteOrganizationMember: (_context, _input) => organizationOperationUnavailable("organization.member.invite")
    },
    "organization.member.leave": {
      leaveOrganization: (_context, _input) => organizationOperationUnavailable("organization.member.leave")
    },
    "organization.member.list": readOnlyQueryPort<OrganizationOperationPorts["organization.member.list"]>({
      listOrganizationMembers: (_context, _input) => organizationOperationUnavailable("organization.member.list")
    }),
    "organization.member.remove": {
      removeOrganizationMember: (_context, _input) => organizationOperationUnavailable("organization.member.remove")
    },
    "organization.member.role.change": {
      changeOrganizationMemberRole: (_context, _input) => organizationOperationUnavailable("organization.member.role.change")
    },
    "organization.patch": {
      patchOrganization: (_context, _input) => organizationOperationUnavailable("organization.patch")
    },
    "organization.view": readOnlyQueryPort<OrganizationOperationPorts["organization.view"]>({
      viewOrganization: (_context, _organizationId) => organizationOperationUnavailable("organization.view")
    }),
    "organization.workspace.archive": {
      archiveOrganizationWorkspace: (_context, _input) => organizationOperationUnavailable("organization.workspace.archive")
    },
    "organization.workspace.create": {
      createOrganizationWorkspace: (_context, _input) => organizationOperationUnavailable("organization.workspace.create")
    },
    "organization.workspace.delete": {
      deleteOrganizationWorkspace: (_context, _input) => organizationOperationUnavailable("organization.workspace.delete")
    },
    "organization.workspace.list": readOnlyQueryPort<OrganizationOperationPorts["organization.workspace.list"]>({
      listOrganizationWorkspaces: (_context, _input) => organizationOperationUnavailable("organization.workspace.list")
    }),
    "organization.workspace.member.grant": {
      grantOrganizationWorkspaceMembership: (_context, _input) => organizationOperationUnavailable("organization.workspace.member.grant")
    },
    "organization.workspace.member.revoke": {
      revokeOrganizationWorkspaceMembership: (_context, _input) => organizationOperationUnavailable("organization.workspace.member.revoke")
    },
    "organization.workspace.restore": {
      restoreOrganizationWorkspace: (_context, _input) => organizationOperationUnavailable("organization.workspace.restore")
    },
    "workspace.bundle.export": {
      exportWorkspaceBundle: (_context, _input) => organizationOperationUnavailable("workspace.bundle.export")
    },
    "workspace.bundle.restore": {
      restoreWorkspaceBundle: (_context, _input) => organizationOperationUnavailable("workspace.bundle.restore")
    },
    "workspace.organization.move.commit": {
      commitWorkspaceOrganizationMove: (_context, _input) => organizationOperationUnavailable("workspace.organization.move.commit")
    },
    "workspace.organization.move.preflight": readOnlyQueryPort<OrganizationOperationPorts["workspace.organization.move.preflight"]>({
      preflightWorkspaceOrganizationMove: (_context, _input) => organizationOperationUnavailable("workspace.organization.move.preflight")
    }),
    "workspace.organization.move.status": readOnlyQueryPort<OrganizationOperationPorts["workspace.organization.move.status"]>({
      getWorkspaceOrganizationMoveStatus: (_context, _operationId) => organizationOperationUnavailable("workspace.organization.move.status")
    })
  };
}

export function createDomainOperationPorts(services: RuntimeDomainServices): DomainOperationPorts {
  const ports = {
    ...createArtifactDomainServicePorts(services),
    ...createAppliedLearningEvaluationDomainServicePorts(services),
    ...createAutomationDomainServicePorts(services),
    ...createBrowserDomainServicePorts(services),
    ...createClientEventDomainServicePorts(services),
    ...createCollectionDomainServicePorts(services),
    ...createCore05BackgroundReviewMutationDomainServicePorts(services),
    ...createConversationDomainServicePorts(services),
    ...createExecutionDomainServicePorts(services),
    ...createExternalSendDomainServicePorts(services),
    ...createExternalAppConnectionDomainServicePorts(services),
    ...createFileDomainServicePorts(services),
    ...createGatewayDomainServicePorts(services),
    ...createGeneratedSurfaceDomainServicePorts(services),
    ...createLearningDomainServicePorts(services),
    ...createLearningResourceUseDomainServicePorts(services),
    ...createLearningResourceVersionDomainServicePorts(services),
    ...createMemoryDomainServicePorts(services),
    ...createObjectiveDomainServicePorts(services),
    ...createPluginDomainServicePorts(services),
    ...createPresentationDomainServicePorts(services),
    ...createSettingsDomainServicePorts(services),
    ...createSkillDomainServicePorts(services),
    ...createSystemDomainServicePorts(services),
    ...createTranslationDomainServicePorts(services),
    ...createWikiDomainServicePorts(services),
    ...createSearchDomainServicePorts(services),
    ...createRoomAgentDomainServicePorts(services),
    ...createActivityHistoryDomainServicePorts(services),
    ...createResourceVersionDomainServicePorts(services),
    ...createWorkspaceContextDomainServicePorts(services),
    ...createHumanChangeRequestDomainServicePorts(services),
    ...createResourceTransferDomainServicePorts(services),
    ...createResourceRedactionDomainServicePorts(services),
    ...createOrganizationOperationPorts()
  };
  const missingQueryPorts = domainQueryIds.filter((id) => !(id in ports));
  if (missingQueryPorts.length > 0) throw new Error(`domain_query_ports_incomplete:${missingQueryPorts.join(",")}`);
  return ports;
}
