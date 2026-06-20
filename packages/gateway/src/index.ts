import {
  createId,
  nowIso,
  type ActorIdentity,
  type InstructionSource,
  type MessageEnvelope,
  type SupportedLocale
} from "@samurai-agent/core-schemas";

export interface RouteSessionInput {
  source: MessageEnvelope["source"];
  identity: ActorIdentity;
  route?: string;
}

export function routeSession(input: RouteSessionInput): string {
  return `${input.source}:${input.identity}:${input.route ?? "main"}`;
}

export interface GatewayContext {
  source: "web" | "cron";
  actor_identity: ActorIdentity;
  instruction_source: InstructionSource;
  channel: "web" | "cron";
  session_key: string;
}

export const webGatewayContext: GatewayContext = {
  source: "web",
  actor_identity: "owner",
  instruction_source: "owner_instruction",
  channel: "web",
  session_key: "web:owner:main"
};

export const cronMemoryReviewGatewayContext: GatewayContext = {
  source: "cron",
  actor_identity: "owner_scheduled",
  instruction_source: "scheduled_context",
  channel: "cron",
  session_key: "cron:owner_scheduled:memory-review"
};

export function createWebEnvelope(userIntent: string, inputLocale: SupportedLocale = "ja", outputLocale: SupportedLocale = "ja"): MessageEnvelope {
  return createGatewayEnvelope(webGatewayContext, userIntent, inputLocale, outputLocale);
}

export function createCronMemoryReviewEnvelope(
  userIntent = "Run scheduled memory review.",
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja"
): MessageEnvelope {
  return createGatewayEnvelope(cronMemoryReviewGatewayContext, userIntent, inputLocale, outputLocale);
}

export function createGatewayEnvelope(
  context: GatewayContext,
  userIntent: string,
  inputLocale: SupportedLocale = "ja",
  outputLocale: SupportedLocale = "ja",
  metadata: Record<string, unknown> = {}
): MessageEnvelope {
  return {
    id: createId("envelope"),
    source: context.source,
    actor_identity: context.actor_identity,
    session_key: context.session_key,
    user_intent: userIntent,
    attachments: [],
    input_locale: inputLocale,
    output_locale: outputLocale,
    metadata: metadata as MessageEnvelope["metadata"],
    received_at: nowIso()
  };
}
