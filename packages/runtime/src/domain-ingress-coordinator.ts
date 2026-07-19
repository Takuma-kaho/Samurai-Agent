import { requireDomainCommandEntry, type DomainCommandInputSource } from "@samurai-agent/action-catalog";
import {
  stableHash,
  type AutomationJobRecord,
  type GatewayChannel,
  type JsonValue,
  type SupportedLocale
} from "@samurai-agent/core-schemas";

export interface DomainIngressCommandResult {
  result: unknown;
}

export interface DomainIngressDispatcher {
  run(input: {
    command_id: string;
    input_source: DomainCommandInputSource;
    idempotency_key?: string;
    payload: Record<string, unknown>;
  }, context?: DomainIngressExecutionContext): Promise<DomainIngressCommandResult>;
}

export interface DomainIngressExecutionContext {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface GatewayInboundInput {
  channel: GatewayChannel;
  source_identity: string;
  body: string;
  source_label?: string;
  account_id?: string;
  thread_id?: string;
  route?: string;
  metadata?: Record<string, JsonValue>;
  backend_id?: string;
  input_locale?: SupportedLocale;
  output_locale?: SupportedLocale;
}

export async function routeGatewayInbound<T>(dispatcher: DomainIngressDispatcher, input: GatewayInboundInput): Promise<T> {
  const externalMessageId = stringValue(input.metadata?.idempotency_key) || stringValue(input.metadata?.message_id);
  const idempotencyKey = externalMessageId || `gateway:${stableHash({
    channel: input.channel,
    source_identity: input.source_identity,
    account_id: input.account_id ?? null,
    thread_id: input.thread_id ?? null,
    body: input.body
  })}`;
  const command = requireDomainCommandEntry("gateway.inbound.route");
  const outcome = await dispatcher.run({
    command_id: command.id,
    input_source: "gateway_inbound",
    idempotency_key: idempotencyKey,
    payload: { ...input }
  });
  return outcome.result as T;
}

export async function runDueAutomation<T>(input: {
  dispatcher: DomainIngressDispatcher;
  jobs: AutomationJobRecord[];
  now: string;
  isLockedError(error: unknown): boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
}): Promise<T[]> {
  const command = requireDomainCommandEntry("automation.job.run");
  const results: T[] = [];
  for (const job of input.jobs) {
    assertIngressActive(input);
    try {
      const outcome = await input.dispatcher.run({
        command_id: command.id,
        input_source: "automation",
        idempotency_key: `automation:${job.id}:${job.next_run_at ?? input.now}`,
        payload: { job_id: job.id, now: input.now }
      }, { signal: input.signal, deadlineAt: input.deadlineAt });
      assertIngressActive(input);
      results.push(outcome.result as T);
    } catch (error) {
      if (input.isLockedError(error)) continue;
      throw error;
    }
  }
  return results;
}

function assertIngressActive(input: DomainIngressExecutionContext): void {
  if (input.signal?.aborted) throw new Error("domain_ingress_cancelled");
  if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) throw new Error("domain_ingress_deadline_exceeded");
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}
