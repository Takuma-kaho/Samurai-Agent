import type { WorkspaceMigration } from "../kernel/migration-runner";
import { coreBaselineMigration } from "./001-core-baseline";
import { gatewayDeliveryMigration } from "./002-gateway-delivery";
import { skillOptimizationMigration } from "./003-skill-optimization";
import { toolRunErrorCodeMigration } from "./004-tool-run-error-code";
import { gatewayPairingPolicyAllowedToolsMigration } from "./005-gateway-allowed-tools";
import { preCore04SchemaNormalizationMigration } from "./006-pre-core04-schema-normalization";
import { core05RoomAgentFoundationMigration } from "./007-core05-room-agent-foundation";

export const workspaceMigrations: readonly WorkspaceMigration[] = [
  coreBaselineMigration,
  gatewayDeliveryMigration,
  skillOptimizationMigration,
  toolRunErrorCodeMigration,
  gatewayPairingPolicyAllowedToolsMigration,
  preCore04SchemaNormalizationMigration,
  core05RoomAgentFoundationMigration
];

export { coreBaselineMigration, gatewayDeliveryMigration, skillOptimizationMigration, toolRunErrorCodeMigration, gatewayPairingPolicyAllowedToolsMigration, preCore04SchemaNormalizationMigration, core05RoomAgentFoundationMigration };
