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
  core06SessionReferenceBoundaryMigration
];

export { coreBaselineMigration, gatewayDeliveryMigration, skillOptimizationMigration, toolRunErrorCodeMigration, gatewayPairingPolicyAllowedToolsMigration, preCore04SchemaNormalizationMigration, core05RoomAgentFoundationMigration, core05LearningCompletionMigration, core06RoomParticipantsMigration, core06IntegrityHardeningMigration, core06SessionReferenceBoundaryMigration };
