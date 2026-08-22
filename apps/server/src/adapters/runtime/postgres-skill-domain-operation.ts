import {
  bindOperationDefinition,
  skillOptimizationCancel,
  skillOptimizationPromote,
  skillOptimizationReject,
  skillOptimizationRollback,
  skillOptimizationStart,
  type BoundOperationDefinition,
  type DomainResult,
  type TrustedDomainContext
} from "@samurai-agent/domain-operations";
import {
  SkillDomainService
} from "@samurai-agent/runtime";
import type { SkillOptimizationDataset, SkillOptimizationRun } from "@samurai-agent/core-schemas";
import { WorkspaceServerError } from "@samurai-agent/workspace-server";
import { PostgresSkillOptimization, type PostgresSkillOptimizationOptions } from "./postgres-skill-optimization";
import { PostgresDomainOperationLedger } from "./postgres-domain-operation-ledger";

const skillDefinitions = [
  [skillOptimizationCancel, "skill.optimization.cancel"],
  [skillOptimizationPromote, "skill.optimization.promote"],
  [skillOptimizationReject, "skill.optimization.reject"],
  [skillOptimizationRollback, "skill.optimization.rollback"],
  [skillOptimizationStart, "skill.optimization.start"]
] as const;

/**
 * PostgreSQL Skill optimization composition. Skill documents remain owned by
 * Completion; the formal Runtime service owns optimization state transitions.
 * Non-optimization Skill ports fail closed because their standard PG resource
 * surface is exposed by WorkspaceCompletionService, not duplicated here.
 */
export class PostgresSkillDomainOperations {
  readonly adapter: PostgresSkillOptimization;
  private readonly service: SkillDomainService;
  private readonly ledger: PostgresDomainOperationLedger;
  private readonly bindings = new Map<string, BoundOperationDefinition>();

  constructor(options: PostgresSkillOptimizationOptions & { autoStartOptimization?: boolean }) {
    this.adapter = new PostgresSkillOptimization(options);
    this.ledger = new PostgresDomainOperationLedger(options.database, options.workspaceId, options.accountId);
    this.service = new SkillDomainService({
      optimization: this.adapter,
      queries: unavailablePorts() as never,
      usage: unavailablePorts() as never,
      mutation: unavailablePorts() as never,
      conflictError: (message) => new WorkspaceServerError(message, 409)
    }, { autoStartOptimization: options.autoStartOptimization ?? false });
    const ports = {
      "skill.optimization.cancel": {
        cancelSkillOptimization: (input: Parameters<SkillDomainService["cancelOptimization"]>[0]) => this.service.cancelOptimization(input)
      },
      "skill.optimization.promote": {
        promoteSkillOptimization: (input: Parameters<SkillDomainService["promoteOptimization"]>[0]) => this.service.promoteOptimization(input)
      },
      "skill.optimization.reject": {
        rejectSkillOptimization: (input: Parameters<SkillDomainService["rejectOptimization"]>[0]) => this.service.rejectOptimization(input)
      },
      "skill.optimization.rollback": {
        rollbackSkillOptimization: (input: Parameters<SkillDomainService["rollbackOptimization"]>[0]) => this.service.rollbackOptimization(input)
      },
      "skill.optimization.start": {
        startSkillOptimization: (input: Parameters<SkillDomainService["startOptimization"]>[0]) => this.service.startOptimization(input)
      }
    };
    for (const [definition, id] of skillDefinitions) {
      const key = id as keyof typeof ports;
      const operationPorts = ports[key];
      if (!operationPorts) throw new Error(`postgres_skill_operation_port_missing:${id}`);
      this.bindings.set(id, bindSkillDefinition(definition, operationPorts));
    }
  }

  async execute(
    context: TrustedDomainContext,
    operationId: string,
    input: unknown
  ): Promise<DomainResult<unknown>> {
    const binding = this.bindings.get(operationId);
    if (!binding) throw new WorkspaceServerError("skill_domain_operation_not_found", 404);
    const result = await this.ledger.run({
      operationId,
      actorId: context.actorId,
      idempotencyKey: context.idempotencyKey,
      request: input,
      execute: () => binding.execute(context, input)
    });
    return result.value;
  }

  runClaimedOptimization(input: {
    run: SkillOptimizationRun;
    dataset: SkillOptimizationDataset;
    skillBody: string;
    skillId: string;
    sessionId?: string;
    workerId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    return this.service.runClaimedOptimization(input);
  }
}

function bindSkillDefinition(
  definition: (typeof skillDefinitions)[number][0],
  ports: unknown
): BoundOperationDefinition {
  return bindOperationDefinition(
    definition as Parameters<typeof bindOperationDefinition>[0],
    definition.createHandler(ports as never)
  );
}

function unavailablePorts(): Record<string, (...args: unknown[]) => Promise<never>> {
  return new Proxy({}, {
    get: () => async () => {
      throw new WorkspaceServerError("skill_domain_port_unavailable", 503);
    }
  }) as Record<string, (...args: unknown[]) => Promise<never>>;
}
