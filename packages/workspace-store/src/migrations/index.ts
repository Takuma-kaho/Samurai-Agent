import type { WorkspaceMigration } from "../kernel/migration-runner";
import { coreBaselineMigration } from "./001-core-baseline";
import { gatewayDeliveryMigration } from "./002-gateway-delivery";
import { skillOptimizationMigration } from "./003-skill-optimization";
import { toolRunErrorCodeMigration } from "./004-tool-run-error-code";
import { gatewayPairingPolicyAllowedToolsMigration } from "./005-gateway-allowed-tools";
import { preCore04SchemaNormalizationMigration } from "./006-pre-core04-schema-normalization";
import { core05RoomAgentFoundationMigration } from "./007-core05-room-agent-foundation";
import { core05LearningCompletionMigration } from "./008-core05-learning-completion";
import { core06RoomParticipantsMigration } from "./009-core06-room-participants";
import { core06IntegrityHardeningMigration } from "./010-core06-integrity-hardening";
import { core06SessionReferenceBoundaryMigration } from "./011-core06-session-reference-boundary";
import { core07ActivityHistoryMigration } from "./012-core07-activity-history";
import { core07WorkspaceJobsMigration } from "./013-core07-workspace-jobs";
import { core08ResourceSessionBoundaryMigration } from "./014-core08-resource-session-boundary";
import { core09ExternalIngressAutomationBoundaryMigration } from "./015-core09-external-ingress-automation-boundary";
import { core09AutomationManagerLocksMigration } from "./016-core09-automation-manager-locks";
import { externalIntegrationRecordsMigration } from "./017-external-integration-records";
import { externalIntegrationAuditRecordsMigration } from "./018-external-integration-audit-records";
import { externalIntegrationCaptureQuotaMigration } from "./019-external-integration-capture-quota";
import { externalIntegrationResourceVersionsMigration } from "./020-external-integration-resource-versions";
import { externalIntegrationManagedResourceVersionsMigration } from "./021-external-integration-managed-resource-versions";
import { externalContextSourceMigration } from "./022-external-context-source";
import { externalIntegrationIdempotencyMigration } from "./023-external-integration-idempotency";
import { externalConnectorInstallationUniquenessMigration } from "./024-external-connector-installation-uniqueness";
import { externalActivityWorkspaceScopeMigration } from "./025-external-activity-workspace-scope";
import { externalConnectorDisabledIndexMigration } from "./026-external-connector-disabled-index";
import { clientEventRoomScopeMigration } from "./027-client-event-room-scope";

export const workspaceMigrations: readonly WorkspaceMigration[] = [
  coreBaselineMigration,
  gatewayDeliveryMigration,
  skillOptimizationMigration,
  toolRunErrorCodeMigration,
  gatewayPairingPolicyAllowedToolsMigration,
  preCore04SchemaNormalizationMigration,
  core05RoomAgentFoundationMigration,
  core05LearningCompletionMigration,
  core06RoomParticipantsMigration,
  core06IntegrityHardeningMigration,
  core06SessionReferenceBoundaryMigration,
  core07ActivityHistoryMigration,
  core07WorkspaceJobsMigration,
  core08ResourceSessionBoundaryMigration,
  core09ExternalIngressAutomationBoundaryMigration,
  core09AutomationManagerLocksMigration,
  externalIntegrationRecordsMigration,
  externalIntegrationAuditRecordsMigration,
  externalIntegrationCaptureQuotaMigration,
  externalIntegrationResourceVersionsMigration,
  externalIntegrationManagedResourceVersionsMigration,
  externalContextSourceMigration,
  externalIntegrationIdempotencyMigration,
  externalConnectorInstallationUniquenessMigration,
  externalActivityWorkspaceScopeMigration,
  externalConnectorDisabledIndexMigration,
  clientEventRoomScopeMigration
];

export { coreBaselineMigration, gatewayDeliveryMigration, skillOptimizationMigration, toolRunErrorCodeMigration, gatewayPairingPolicyAllowedToolsMigration, preCore04SchemaNormalizationMigration, core05RoomAgentFoundationMigration, core05LearningCompletionMigration, core06RoomParticipantsMigration, core06IntegrityHardeningMigration, core06SessionReferenceBoundaryMigration, core07ActivityHistoryMigration, core07WorkspaceJobsMigration, core08ResourceSessionBoundaryMigration, core09ExternalIngressAutomationBoundaryMigration, core09AutomationManagerLocksMigration, externalIntegrationRecordsMigration, externalIntegrationAuditRecordsMigration, externalIntegrationCaptureQuotaMigration, externalIntegrationResourceVersionsMigration, externalIntegrationManagedResourceVersionsMigration, externalContextSourceMigration, externalIntegrationIdempotencyMigration, externalConnectorInstallationUniquenessMigration, externalActivityWorkspaceScopeMigration, externalConnectorDisabledIndexMigration, clientEventRoomScopeMigration };
